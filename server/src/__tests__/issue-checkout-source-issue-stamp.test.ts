import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";
import {
  CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
  observeCrossIssueInfluence,
} from "../services/cross-issue-influence-limit.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("issue checkout stamps the run source issue", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-checkout-source-issue-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCheckoutFixtures() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueIds = [randomUUID(), randomUUID()];
    const runId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `E${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Checkout Coder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values(
      issueIds.map((issueId, index) => ({
        id: issueId,
        companyId,
        title: `Checkout issue ${index}`,
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
      })),
    );
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running" });
    return { companyId, agentId, runId, issueIds };
  }

  async function setRunContext(runId: string, contextSnapshot: Record<string, unknown> | null) {
    await db
      .update(heartbeatRuns)
      .set({ contextSnapshot })
      .where(eq(heartbeatRuns.id, runId));
  }

  async function readRunContext(runId: string) {
    const [run] = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId));
    return run?.contextSnapshot ?? null;
  }

  function gateCall(input: {
    companyId: string;
    runId: string;
    agentId: string;
    targetIssueId: string;
  }) {
    return observeCrossIssueInfluence(db, {
      ...input,
      kind: "comment",
      now: CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
    });
  }

  it("attributes an issue-less wake to the issue it checks out so its own writes pass the gate", async () => {
    const { companyId, agentId, runId, issueIds } = await seedCheckoutFixtures();
    const [sourceIssueId] = issueIds;
    await setRunContext(runId, { trigger: "heartbeat_timer" });

    // Before checkout the wake carries no source issue, so every issue write
    // from this run fails closed with ETQ-489's 403.
    await expect(gateCall({ companyId, runId, agentId, targetIssueId: sourceIssueId }))
      .rejects.toMatchObject({
        status: 403,
        details: { code: "cross_issue_influence_run_context_required" },
      });

    const checkedOut = await issueService(db).checkout(
      sourceIssueId,
      agentId,
      ["todo", "in_progress"],
      runId,
    );

    expect(checkedOut.checkoutRunId).toBe(runId);
    // Checkout stamps the snapshot and keeps the wake's own fields intact.
    await expect(readRunContext(runId)).resolves.toEqual({
      trigger: "heartbeat_timer",
      issueId: sourceIssueId,
    });

    // A write to the issue the run checked out is not cross-issue influence:
    // the gate stays silent instead of refusing it.
    await expect(
      gateCall({ companyId, runId, agentId, targetIssueId: sourceIssueId }),
    ).resolves.toBeNull();
  }, 20_000);

  it("keeps a run scoped to one issue out of a second issue it checks out", async () => {
    const { companyId, agentId, runId, issueIds } = await seedCheckoutFixtures();
    const [sourceIssueId, targetIssueId] = issueIds;
    await setRunContext(runId, { issueId: sourceIssueId });

    await issueService(db).checkout(targetIssueId, agentId, ["todo", "in_progress"], runId);

    // The existing scope wins: checking out a second issue must not silently
    // re-attribute the run, so the write to the other issue stays a counted
    // cross-issue influence while the run's own issue stays silent.
    await expect(readRunContext(runId)).resolves.toEqual({ issueId: sourceIssueId });
    await expect(gateCall({ companyId, runId, agentId, targetIssueId }))
      .resolves.toMatchObject({ allowed: true, count: 1 });

    const [observation] = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.runId, runId),
        eq(activityLog.action, "issue.cross_issue_influence_observed"),
      ));
    expect(observation?.details).toMatchObject({ sourceIssueId, targetIssueId });

    // Once the run spends its budget on other issues, the write to issue B is
    // refused with the cap the route turns into a 429.
    await db.insert(activityLog).values(
      Array.from({ length: 19 }, () => ({
        companyId,
        actorType: "agent" as const,
        actorId: agentId,
        agentId,
        runId,
        action: "issue.cross_issue_influence_observed",
        entityType: "issue",
        entityId: targetIssueId,
      })),
    );
    await expect(gateCall({ companyId, runId, agentId, targetIssueId }))
      .resolves.toMatchObject({ allowed: false, count: 21 });
    await expect(gateCall({ companyId, runId, agentId, targetIssueId: sourceIssueId }))
      .resolves.toBeNull();
  }, 20_000);

  it("leaves a task-scoped run attributed to its task when it checks out an issue", async () => {
    const { companyId, agentId, runId, issueIds } = await seedCheckoutFixtures();
    const [sourceIssueId] = issueIds;
    await setRunContext(runId, { taskId: randomUUID() });

    await issueService(db).checkout(sourceIssueId, agentId, ["todo", "in_progress"], runId);

    // Task attribution is not checkout attribution: the snapshot keeps its
    // taskId and the issue write stays a counted cross-issue influence.
    await expect(readRunContext(runId)).resolves.toEqual({
      taskId: expect.any(String),
    });
    await expect(gateCall({ companyId, runId, agentId, targetIssueId: sourceIssueId }))
      .resolves.toMatchObject({ allowed: true, count: 1 });
  }, 20_000);
});
