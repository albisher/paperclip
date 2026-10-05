import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests,
  agents,
  approvals,
  companies,
  createDb,
  heartbeatRuns,
  issueApprovals,
  issueRecoveryActions,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres review attention tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue review attention", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-review-attention-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 30_000);

  afterEach(async () => {
    await db.delete(issueThreadInteractions);
    await db.delete(issueApprovals);
    await db.delete(approvals);
    await db.delete(issueRecoveryActions);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Review Attention Co",
      issuePrefix: "RVA",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Review Agent",
      role: "engineer",
      status: "idle",
    });
    return { companyId, agentId };
  }

  async function insertReview(input: {
    companyId: string;
    agentId: string;
    identifier: string;
    assigneeUserId?: string | null;
    executionState?: Record<string, unknown> | null;
    monitorNextCheckAt?: Date | null;
    executionPolicy?: Record<string, unknown> | null;
  }) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId: input.companyId,
      identifier: input.identifier,
      title: input.identifier,
      status: "in_review",
      priority: "medium",
      assigneeAgentId: input.assigneeUserId ? null : input.agentId,
      assigneeUserId: input.assigneeUserId ?? null,
      executionState: input.executionState ?? null,
      monitorNextCheckAt: input.monitorNextCheckAt ?? null,
      executionPolicy: input.executionPolicy ?? null,
    });
    return id;
  }

  it("surfaces a pathless agent-owned review as stalled and a same-agent recovery wake does not cover", async () => {
    const { companyId, agentId } = await seed();
    const issueId = await insertReview({ companyId, agentId, identifier: "RVA-1" });

    let row = (await svc.list(companyId, { status: "in_review" })).find((issue) => issue.id === issueId);
    expect(row?.reviewAttention).toMatchObject({
      state: "stalled",
      paths: [],
    });
    expect(row?.reviewAttention?.reason).toContain("no participant, interaction, approval");

    const recoveryIdempotencyKey = `issue_review_path_lost:${issueId}:fingerprint`;
    const recoveryWake = {
      companyId,
      agentId,
      source: "automation",
      reason: "issue_review_path_lost",
      status: "queued",
      payload: { issueId },
      idempotencyKey: recoveryIdempotencyKey,
    };
    await db.insert(agentWakeupRequests).values(recoveryWake);
    await expect(db.insert(agentWakeupRequests).values(recoveryWake)).rejects.toMatchObject({
      cause: {
        code: "23505",
        constraint_name: "agent_wakeup_requests_review_path_recovery_idempotency_uq",
      },
    });

    // The recovery wake is sent to the assignee themselves, so the only
    // legal responder is the assignee — the wake is a self-review path and
    // must not flip state to `covered`. The issue stays stalled with the
    // self-review marker preserved.
    row = (await svc.list(companyId, { status: "in_review" })).find((issue) => issue.id === issueId);
    expect(row?.reviewAttention).toMatchObject({
      state: "stalled",
      paths: [expect.objectContaining({ kind: "queued_wake", selfReview: true })],
    });
    expect(row?.reviewAttention?.reason).toMatch(/self-review/i);
  });

  it("reports every healthy non-self review path as covered", async () => {
    const { companyId, agentId } = await seed();
    const otherAgentId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId,
      companyId,
      name: "Peer Reviewer",
      role: "engineer",
      status: "idle",
    });
    const interactionIssueId = await insertReview({ companyId, agentId, identifier: "RVA-2" });
    const humanOnlyInteractionIssueId = await insertReview({ companyId, agentId, identifier: "RVA-2H" });
    const approvalIssueId = await insertReview({ companyId, agentId, identifier: "RVA-3" });
    const monitorIssueId = await insertReview({
      companyId,
      agentId,
      identifier: "RVA-4",
      monitorNextCheckAt: new Date(Date.now() + 60_000),
      executionPolicy: { monitor: { maxAttempts: 3 } },
    });
    const humanIssueId = await insertReview({
      companyId,
      agentId,
      identifier: "RVA-5",
      assigneeUserId: "board-user",
    });
    const participantIssueId = await insertReview({
      companyId,
      agentId,
      identifier: "RVA-6",
      executionState: { status: "pending", currentParticipant: { type: "agent", agentId: otherAgentId } },
    });
    const activeRunIssueId = await insertReview({ companyId, agentId, identifier: "RVA-7" });
    const recoveryIssueId = await insertReview({ companyId, agentId, identifier: "RVA-8" });

    // Healthy non-self interaction has an addressee different from the assignee,
    // so the assignee is not the sole legal responder.
    await db.insert(issueThreadInteractions).values({
      companyId,
      issueId: interactionIssueId,
      kind: "request_confirmation",
      status: "pending",
      continuationPolicy: "wake_assignee",
      addresseeAgentId: otherAgentId,
      payload: { version: 1, prompt: "Approve?" },
    });
    await db.insert(issueThreadInteractions).values({
      companyId,
      issueId: humanOnlyInteractionIssueId,
      kind: "request_confirmation",
      status: "pending",
      continuationPolicy: "wake_assignee",
      requestedResolverPolicy: "human_only",
      effectiveResolverPolicy: "human_only",
      resolverPolicyProvenance: "explicit",
      effectiveResolverPolicySource: "requested",
      payload: { version: 1, prompt: "Human review?" },
    });
    const approvalId = randomUUID();
    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "request_board_approval",
      status: "pending",
      payload: { title: "Review" },
    });
    await db.insert(issueApprovals).values({ companyId, issueId: approvalIssueId, approvalId });
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId: otherAgentId,
      status: "running",
      contextSnapshot: { issueId: activeRunIssueId },
    });
    await db.insert(issueRecoveryActions).values({
      companyId,
      sourceIssueId: recoveryIssueId,
      kind: "missing_disposition",
      status: "active",
      ownerType: "agent",
      ownerAgentId: otherAgentId,
      cause: "review_path_lost",
      fingerprint: "review-path",
      evidence: {},
      nextAction: "Restore review path",
    });

    const rows = await svc.list(companyId, { status: "in_review" });
    const byId = new Map(rows.map((row) => [row.id, row.reviewAttention]));
    const expectedKinds = new Map([
      [interactionIssueId, "interaction"],
      [humanOnlyInteractionIssueId, "interaction"],
      [approvalIssueId, "approval"],
      [monitorIssueId, "monitor"],
      [humanIssueId, "human_reviewer"],
      [participantIssueId, "execution_participant"],
      [activeRunIssueId, "active_run"],
      [recoveryIssueId, "recovery"],
    ]);

    for (const [issueId, kind] of expectedKinds) {
      expect(byId.get(issueId), kind).toMatchObject({
        state: "covered",
        paths: expect.arrayContaining([expect.objectContaining({ kind })]),
      });
    }
    expect(byId.get(interactionIssueId)?.paths).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "interaction", responder: "Peer Reviewer" }),
    ]));
    expect(byId.get(humanOnlyInteractionIssueId)?.paths).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "interaction", responder: "Board" }),
    ]));
  });

  it("treats a pending anyone-policy interaction with no addressee as self-review and stalls", async () => {
    const { companyId, agentId } = await seed();
    const selfInteractionIssueId = await insertReview({ companyId, agentId, identifier: "RVA-SELF-1" });
    const selfRunIssueId = await insertReview({ companyId, agentId, identifier: "RVA-SELF-2" });
    const selfWakeIssueId = await insertReview({ companyId, agentId, identifier: "RVA-SELF-3" });

    await db.insert(issueThreadInteractions).values({
      companyId,
      issueId: selfInteractionIssueId,
      kind: "request_confirmation",
      status: "pending",
      continuationPolicy: "wake_assignee",
      payload: { version: 1, prompt: "Self-approve?" },
    });
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      status: "running",
      contextSnapshot: { issueId: selfRunIssueId },
    });
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      reason: "issue_review_path_lost",
      status: "queued",
      payload: { issueId: selfWakeIssueId },
      idempotencyKey: `issue_review_path_lost:${selfWakeIssueId}:fingerprint`,
    });

    const rows = await svc.list(companyId, { status: "in_review" });
    const byId = new Map(rows.map((row) => [row.id, row.reviewAttention]));
    const selfInteraction = byId.get(selfInteractionIssueId);
    const selfRun = byId.get(selfRunIssueId);
    const selfWake = byId.get(selfWakeIssueId);

    expect(selfInteraction).toMatchObject({ state: "stalled" });
    expect(selfInteraction?.paths).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "interaction", selfReview: true }),
    ]));
    expect(selfInteraction?.reason).toMatch(/self-review/i);

    expect(selfRun).toMatchObject({ state: "stalled" });
    expect(selfRun?.paths).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "active_run", selfReview: true }),
    ]));

    expect(selfWake).toMatchObject({ state: "stalled" });
    expect(selfWake?.paths).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "queued_wake", selfReview: true }),
    ]));
  });

  it("covers a self-review interaction once a non-self review path appears (silent expiry recovery)", async () => {
    const { companyId, agentId } = await seed();
    const otherAgentId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId,
      companyId,
      name: "Board Reviewer",
      role: "engineer",
      status: "idle",
    });
    const issueId = await insertReview({ companyId, agentId, identifier: "RVA-MIX-1" });

    await db.insert(issueThreadInteractions).values({
      companyId,
      issueId,
      kind: "request_confirmation",
      status: "pending",
      continuationPolicy: "wake_assignee",
      payload: { version: 1, prompt: "Self?" },
    });
    let row = (await svc.list(companyId, { status: "in_review" })).find((issue) => issue.id === issueId);
    expect(row?.reviewAttention).toMatchObject({ state: "stalled" });

    // Add a human-only board card on the same issue — the non-self path now
    // exists alongside the self-review one, so coverage is restored.
    await db.insert(issueThreadInteractions).values({
      companyId,
      issueId,
      kind: "request_confirmation",
      status: "pending",
      continuationPolicy: "wake_assignee",
      requestedResolverPolicy: "human_only",
      effectiveResolverPolicy: "human_only",
      resolverPolicyProvenance: "explicit",
      effectiveResolverPolicySource: "requested",
      payload: { version: 1, prompt: "Board approval?" },
    });
    row = (await svc.list(companyId, { status: "in_review" })).find((issue) => issue.id === issueId);
    expect(row?.reviewAttention).toMatchObject({ state: "covered" });
    expect(row?.reviewAttention?.paths).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "interaction", selfReview: true }),
      expect.objectContaining({ kind: "interaction", responder: "Board" }),
    ]));
    // Non-self paths omit the `selfReview` field; assert one of each kind.
    const coveredInteractions = row?.reviewAttention?.paths.filter((path) => path.kind === "interaction") ?? [];
    expect(coveredInteractions.some((path) => path.selfReview === true)).toBe(true);
    expect(coveredInteractions.some((path) => path.responder === "Board" && path.selfReview === undefined)).toBe(true);

    // Withdraw the board card (simulate expiry). Only the self path remains,
    // so coverage drops and the surface shows the assignee-self trap.
    await db.update(issueThreadInteractions)
      .set({ status: "expired" })
      .where(and(
        eq(issueThreadInteractions.issueId, issueId),
        eq(issueThreadInteractions.effectiveResolverPolicy, "human_only"),
      ));
    row = (await svc.list(companyId, { status: "in_review" })).find((issue) => issue.id === issueId);
    expect(row?.reviewAttention).toMatchObject({ state: "stalled" });
    expect(row?.reviewAttention?.paths).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "interaction", selfReview: true }),
    ]));

    // Adding an addressee to the original self-review interaction (someone other
    // than the assignee) restores coverage without withdrawing the self path.
    // The schema defaults `effectiveResolverPolicy` to `"anyone"` when omitted,
    // so filter on resolver policy rather than null.
    await db.update(issueThreadInteractions)
      .set({ addresseeAgentId: otherAgentId })
      .where(and(
        eq(issueThreadInteractions.issueId, issueId),
        eq(issueThreadInteractions.status, "pending"),
        eq(issueThreadInteractions.effectiveResolverPolicy, "anyone"),
      ));
    row = (await svc.list(companyId, { status: "in_review" })).find((issue) => issue.id === issueId);
    expect(row?.reviewAttention).toMatchObject({ state: "covered" });
    expect(row?.reviewAttention?.paths).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "interaction", responder: "Board Reviewer" }),
    ]));
  });

  it("treats a stale wake request from the assignee as self-review", async () => {
    const { companyId, agentId } = await seed();
    const issueId = await insertReview({ companyId, agentId, identifier: "RVA-WAKE" });
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      reason: "issue_review_path_lost",
      status: "queued",
      payload: { issueId },
      idempotencyKey: `issue_review_path_lost:${issueId}:stale-wake`,
    });

    const row = (await svc.list(companyId, { status: "in_review" })).find((issue) => issue.id === issueId);
    expect(row?.reviewAttention).toMatchObject({ state: "stalled" });
    expect(row?.reviewAttention?.paths).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "queued_wake", selfReview: true }),
    ]));
  });

  it("does not let a transiently skipped recovery consume its fingerprint", async () => {
    const { companyId, agentId } = await seed();
    const idempotencyKey = `issue_review_path_lost:${randomUUID()}:fingerprint`;
    const baseWake = {
      companyId,
      agentId,
      source: "automation",
      reason: "issue_review_path_lost",
      payload: {},
      idempotencyKey,
    };

    await db.insert(agentWakeupRequests).values({
      ...baseWake,
      status: "skipped",
      finishedAt: new Date(),
    });

    await expect(db.insert(agentWakeupRequests).values({
      ...baseWake,
      status: "queued",
    })).resolves.toBeDefined();
  });
});
