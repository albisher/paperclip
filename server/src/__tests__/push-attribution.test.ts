import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { activityRoutes } from "../routes/activity.js";
import { runtimeConnectionIntentRoutes } from "../routes/connection-intents.js";
import { createRuntimeToolsToken } from "../runtime-tools-token.js";
import { errorHandler } from "../middleware/index.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const vault = vi.hoisted(() => ({
  resolveUserSecretValue: vi.fn(async () => "test-token"),
  resolveSecretValue: vi.fn(async () => "test-dedicated-token"),
}));
vi.mock("../services/secrets.js", () => ({ secretService: () => vault }));

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("push attribution", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>,
    db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "test-push-attribution-signing-secret");
    database = await startEmbeddedPostgresTestDatabase("paperclip-push-attribution-");
    db = createDb(database.connectionString);
  }, 30_000);
  afterAll(async () => {
    await database?.cleanup();
    vi.unstubAllEnvs();
  }, 60_000);

  async function seed() {
    const companyId = randomUUID(),
      agentId = randomUUID(),
      runId = randomUUID(),
      issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: companyId, issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Platform", role: "engineer", adapterType: "codex_local",
    });
    await db.insert(issues).values({ id: issueId, companyId, title: "Push audit" });
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId, status: "running", contextSnapshot: { issueId },
    });
    return { companyId, agentId, runId, issueId };
  }

  function apps(input: Awaited<ReturnType<typeof seed>>) {
    const runtime = express();
    runtime.use(express.json());
    runtime.use(runtimeConnectionIntentRoutes(db));
    runtime.use(errorHandler);
    const board = express();
    board.use(express.json());
    board.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = {
        type: "board",
        userId: "user-1",
        companyIds: [input.companyId],
        source: "local_implicit",
        isInstanceAdmin: true,
      };
      next();
    });
    board.use("/api", activityRoutes(db));
    board.use(errorHandler);
    return { runtime, board };
  }

  function capability(input: Awaited<ReturnType<typeof seed>>, overrides: Record<string, unknown> = {}) {
    return createRuntimeToolsToken({
      agentId: input.agentId,
      companyId: input.companyId,
      runId: input.runId,
      responsibleUserId: "user-1",
      scope: "github_credentials",
      ...overrides,
    })!.token;
  }

  const SHA = "1a2b3c4d5e6f70819a2b3c4d5e6f70819a2b3c4d";
  const rowsFor = (companyId: string) =>
    db.select().from(activityLog).where(and(
      eq(activityLog.action, "git.push"), eq(activityLog.companyId, companyId),
    ));

  it("writes one git.push row carrying the run, the agent, and the pushed commit", async () => {
    const input = await seed();
    const { runtime, board } = apps(input);
    const token = capability(input);
    const response = await request(runtime)
      .post("/runtime-tools/github/push-report")
      .set("Authorization", `Bearer ${token}`)
      .set("Sec-Fetch-Mode", "cors")
      .send({ sha: SHA, repo: "acme/widgets", branch: "feat/ETQ-460", remote: "origin" });

    expect(response.status).toBe(201);
    expect(response.headers["cache-control"]).toBe("no-store");
    const rows = await rowsFor(input.companyId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      companyId: input.companyId,
      actorType: "agent",
      actorId: input.agentId,
      agentId: input.agentId,
      runId: input.runId,
      entityType: "git_repository",
      entityId: "acme/widgets",
      details: { sha: SHA, repo: "acme/widgets", branch: "feat/ETQ-460", remote: "origin", deleted: false },
    });

    // The acceptance bullet names this endpoint: the action must be readable
    // from the company activity feed, not only from the table.
    const feed = await request(board).get(`/api/companies/${input.companyId}/activity`);
    expect(feed.status).toBe(200);
    expect(Array.isArray(feed.body)).toBe(true);
    const actions = (feed.body as Array<{ action: string }>).map(row => row.action);
    expect(actions).toContain("git.push");
  });

  it("records a ref deletion without a commit and never stores credential material", async () => {
    const input = await seed();
    const { runtime } = apps(input);
    const response = await request(runtime)
      .post("/runtime-tools/github/push-report")
      .set("Authorization", `Bearer ${capability(input)}`)
      .send({
        sha: null,
        repo: "acme/widgets",
        branch: "refs/heads/doomed",
        remote: "origin",
        deleted: true,
        token: "ghs_must_not_persist",
        authorization: "Bearer must-not-persist",
      });

    expect(response.status).toBe(201);
    const [row] = await rowsFor(input.companyId);
    expect(row?.details).toEqual({
      sha: null, repo: "acme/widgets", branch: "doomed", remote: "origin", deleted: true,
    });
    expect(JSON.stringify(row)).not.toMatch(/must_not_persist|must-not-persist/);
  });

  it("refuses a browser session, a foreign scope, a foreign agent, and a finished run", async () => {
    const input = await seed();
    const { runtime } = apps(input);
    const post = (body: unknown) => request(runtime)
      .post("/runtime-tools/github/push-report")
      .set("Authorization", `Bearer ${capability(input)}`)
      .send(body as object);
    const valid = { sha: SHA, repo: "acme/widgets", branch: "main" };

    for (const header of ["Origin", "Cookie", "Sec-Fetch-Site"]) {
      const denied = await post(valid).set(header, header === "Cookie" ? "session=test" : "http://127.0.0.1");
      expect(denied.status, header).toBe(403);
    }
    expect(
      (
        await request(runtime)
          .post("/runtime-tools/github/push-report")
          .set("Authorization", `Bearer ${createRuntimeToolsToken({
            agentId: input.agentId, companyId: input.companyId, runId: input.runId,
            responsibleUserId: "user-1", scope: "connection_intents",
          })!.token}`)
          .send(valid)
      ).status,
    ).toBe(401);
    expect(
      (
        await request(runtime)
          .post("/runtime-tools/github/push-report")
          .set("Authorization", `Bearer ${capability(input, { agentId: randomUUID() })}`)
          .send(valid)
      ).status,
    ).toBe(403);

    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, input.runId));
    expect((await post(valid)).status).toBe(403);
    expect(await rowsFor(input.companyId)).toHaveLength(0);
  });

  it("rejects a malformed identity instead of recording something unverifiable", async () => {
    const input = await seed();
    const { runtime } = apps(input);
    const post = (body: unknown) => request(runtime)
      .post("/runtime-tools/github/push-report")
      .set("Authorization", `Bearer ${capability(input)}`)
      .send(body as object);
    for (const body of [
      { sha: "not-a-sha", repo: "acme/widgets", branch: "main" },
      { sha: SHA, repo: "https://ghs_token@github.com/acme/widgets.git", branch: "main" },
      { sha: SHA, repo: "widgets", branch: "main" },
      { sha: SHA, repo: "acme/widgets", branch: "main\nrm -rf /" },
      { repo: "acme/widgets", branch: "main" },
      { sha: SHA, repo: "acme/widgets" },
    ]) {
      expect((await post(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(await rowsFor(input.companyId)).toHaveLength(0);
  });
});