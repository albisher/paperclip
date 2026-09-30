import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";
import { badRequest, forbidden } from "../errors.js";
import { logActivity } from "./activity-log.js";

/**
 * A push report is an audit claim, not a credential request. It carries no
 * secret material, so `details` is rebuilt from an explicit allowlist instead of
 * echoing the request body: a caller cannot smuggle a token into the audit trail
 * by adding an extra field.
 */
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const REPO_PART_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const BRANCH_PATTERN = /^[A-Za-z0-9._/-]{1,255}$/;
const REMOTE_PATTERN = /^[A-Za-z0-9._/-]{1,100}$/;

function cleanString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // Control characters would corrupt the one-line audit rendering and can hide
  // a whole forged record behind them.
  const cleaned = value.replace(/[\x00-\x1f\x7f]/g, "").trim();
  return cleaned.length > 0 ? cleaned : null;
}

/** `owner/name` only. A URL, userinfo, or host would be either noise or a leak. */
function parseRepo(value: unknown): string {
  const cleaned = cleanString(value);
  if (!cleaned) throw badRequest("A push report requires a repository");
  const parts = cleaned.split("/");
  if (parts.length !== 2) throw badRequest("Repository must be an owner/name slug");
  const [owner, name] = parts as [string, string];
  if (!REPO_PART_PATTERN.test(owner) || !REPO_PART_PATTERN.test(name)) {
    throw badRequest("Repository must be an owner/name slug");
  }
  return `${owner}/${name}`;
}

function parseBranch(value: unknown): string | null {
  const cleaned = cleanString(value);
  if (!cleaned) return null;
  if (!BRANCH_PATTERN.test(cleaned)) throw badRequest("Branch name is invalid");
  return cleaned.replace(/^refs\/(?:heads|tags)\//, "");
}

function parseRemote(value: unknown): string | null {
  const cleaned = cleanString(value);
  if (!cleaned) return null;
  if (!REMOTE_PATTERN.test(cleaned)) throw badRequest("Remote name is invalid");
  return cleaned;
}

export interface PushReportInput {
  companyId: string;
  agentId: string;
  runId: string;
  sha: unknown;
  repo: unknown;
  branch?: unknown;
  remote?: unknown;
  deleted?: unknown;
}

export interface PushReportRecord extends Record<string, unknown> {
  sha: string | null;
  repo: string;
  branch: string | null;
  remote: string | null;
  deleted: boolean;
}

/** A ref deletion has no resulting commit, so it records the branch without one. */
export function parsePushReport(input: PushReportInput): PushReportRecord {
  const deleted = input.deleted === true;
  const sha = cleanString(input.sha)?.toLowerCase() ?? null;
  if (sha !== null && !SHA_PATTERN.test(sha)) throw badRequest("Commit SHA must be 40 hex characters");
  if (sha === null && !deleted) throw badRequest("A push report requires a commit SHA");
  const record: PushReportRecord = {
    sha,
    repo: parseRepo(input.repo),
    branch: parseBranch(input.branch),
    remote: parseRemote(input.remote),
    deleted,
  };
  if (record.branch === null && !deleted) throw badRequest("A push report requires a branch");
  return record;
}

/**
 * The capability token is bearer-readable, so an attribution claim must be
 * rechecked against the run row. A finished, cancelled, or foreign run cannot
 * add a `git.push` row, exactly as it cannot acquire credentials.
 */
async function assertLiveRun(
  db: Db,
  input: { companyId: string; agentId: string; runId: string },
) {
  const [run] = await db
    .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.id, input.runId),
        eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.agentId, input.agentId),
      ),
    );
  if (!run || run.status !== "running") throw forbidden("Push attribution requires this agent's active run");
  return run;
}

export async function recordPushAttribution(db: Db, input: PushReportInput) {
  const record = parsePushReport(input);
  await assertLiveRun(db, input);
  const activity = await logActivity(db, {
    companyId: input.companyId,
    actorType: "agent",
    actorId: input.agentId,
    action: "git.push",
    entityType: "git_repository",
    entityId: record.repo,
    agentId: input.agentId,
    runId: input.runId,
    issueId: null,
    details: record,
  });
  return { id: activity.id, ...record };
}