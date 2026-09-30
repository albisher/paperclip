import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { constants } from "node:fs";
import { access, mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { githubBrokerEnvironment, githubLauncherSource } from "./github-launcher.js";

const exec = promisify(execFile);
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/**
 * The harness itself runs under a managed launcher, so a bare `git` on PATH
 * would re-enter it and re-negotiate credentials against the live broker. Every
 * launcher directory on PATH is detected by its own diagnostic marker and
 * excluded, which works whether or not the harness advertises one by name.
 */
async function hostGit() {
  const entries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const managed: string[] = [];
  let git: string | null = null;
  for (const entry of entries) {
    const candidate = path.join(entry, "git");
    let present = false;
    let isLauncher = false;
    try {
      await access(candidate, constants.X_OK);
      present = true;
      isLauncher = (await readFile(candidate)).subarray(0, 4096).toString("utf8").includes("Paperclip:");
    } catch { present = false; }
    if (!present) continue;
    if (isLauncher) managed.push(entry);
    else if (!git) git = candidate;
  }
  if (!git) throw new Error("no real git on PATH");
  return { git, path: entries.filter(entry => !managed.includes(entry)).join(path.delimiter) };
}

/**
 * A Git environment with no inherited identity, credential, or config override.
 * The harness's own run bearer is dropped too: the launcher prefers a bridge or
 * API token over the capability for the Authorization header, and these tests
 * are about which token authenticates a push report.
 */
function hostEnv(pathValue: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: pathValue };
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^(GIT_CONFIG_(?:COUNT|PARAMETERS|KEY_\d+|VALUE_\d+)|GIT_AUTHOR_.*|GIT_COMMITTER_.*|GIT_ASKPASS|GIT_SSH_COMMAND|GH_TOKEN|GITHUB_TOKEN|GH_CONFIG_DIR|PAPERCLIP_API_KEY|PAPERCLIP_GITHUB_BRIDGE_TOKEN|PAPERCLIP_GITHUB_BROKER_TOKEN|PAPERCLIP_GITHUB_BROKER_URL)$/.test(key)) {
      env[key] = value;
    }
  }
  return env;
}

interface PushReport { sha: string; repo: string; branch: string; remote: string | null; deleted: boolean }

/** A broker that answers credential resolution and records every push report. */
async function broker() {
  const reports: PushReport[] = [];
  const requests: Array<{ url: string; authorization: string; capability: string; body: string }> = [];
  let rejectReports = false;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({
        url: req.url ?? "",
        authorization: String(req.headers.authorization ?? ""),
        capability: String(req.headers["x-paperclip-github-capability"] ?? ""),
        body,
      });
      res.setHeader("content-type", "application/json");
      if (req.url === "/runtime-tools/github/credentials") {
        res.end(JSON.stringify({ status: "available", env: {} }));
        return;
      }
      if (req.url === "/runtime-tools/github/push-report") {
        if (rejectReports) { res.writeHead(500); res.end("{}"); return; }
        reports.push(JSON.parse(body));
        res.writeHead(201); res.end(JSON.stringify({ id: "activity-1" }));
        return;
      }
      res.writeHead(404); res.end("{}");
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close(error => error ? reject(error) : resolve());
  }));
  const { port } = server.address() as { port: number };
  return {
    reports,
    requests,
    url: `http://127.0.0.1:${port}`,
    rejectReports(value: boolean) { rejectReports = value; },
  };
}

/**
 * A working tree whose origin is a hosted URL, backed by a local bare repository
 * through `insteadOf`. The launcher therefore sees the same kind of URL rewrite
 * the real GitHub launcher applies, and the push is a real ref update.
 */
async function workspace(remoteHost = "acme") {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-push-attribution-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const host = await hostGit();
  const HOST_ENV = hostEnv(host.path);
  const managed = path.join(root, "managed");
  const repo = path.join(root, "repo");
  const hosted = path.join(root, "remote");
  await mkdir(managed);
  await mkdir(repo);
  await mkdir(hosted, { recursive: true });
  await writeFile(path.join(managed, "git"), githubLauncherSource(), { mode: 0o700 });
  const bare = path.join(hosted, "remote.git");
  await exec(host.git, ["init", "--bare", "--initial-branch=main", bare], { env: HOST_ENV });
  await exec(host.git, ["init", "--initial-branch=main", repo], { env: HOST_ENV });
  await exec(host.git, ["-C", repo, "config", "user.name", "Agent"], { env: HOST_ENV });
  await exec(host.git, ["-C", repo, "config", "user.email", "agent@example.test"], { env: HOST_ENV });
  await exec(host.git, ["-C", repo, "remote", "add", "origin", `https://github.com/${remoteHost}/widgets.git`], { env: HOST_ENV });
  await exec(host.git, ["-C", repo, "config", `url.${bare}.insteadOf`, `https://github.com/${remoteHost}/widgets.git`], { env: HOST_ENV });
  // An upstream makes the argument-free push form resolve to this branch, the
  // same way an agent's working copy normally is set up.
  await exec(host.git, ["-C", repo, "config", "branch.main.remote", "origin"], { env: HOST_ENV });
  await exec(host.git, ["-C", repo, "config", "branch.main.merge", "refs/heads/main"], { env: HOST_ENV });
  const env: NodeJS.ProcessEnv = {
    ...HOST_ENV,
    ...githubBrokerEnvironment({ GH_TOKEN: "ambient-host-token" }, { url: "http://127.0.0.1:1", token: "" }),
    PATH: `${managed}:${host.path}`,
  };
  const git = (...args: string[]) => exec(path.join(managed, "git"), args, { cwd: repo, env });
  return { root, repo, managed, bare, git, env };
}

describe("managed push attribution", () => {
  it("reports the pushed commit, repository, and branch exactly once", async () => {
    const hub = await broker();
    const space = await workspace();
    Object.assign(space.env, githubBrokerEnvironment({}, { url: hub.url, token: "run-capability" }));
    await space.git("commit", "--allow-empty", "-m", "Shipped work");
    const pushed = (await space.git("rev-parse", "HEAD")).stdout.trim();
    await space.git("push", "origin", "main");

    expect(hub.reports).toEqual([
      { sha: pushed, repo: "acme/widgets", branch: "main", remote: "origin", deleted: false },
    ]);
    expect(hub.reports[0]!.sha).toMatch(/^[0-9a-f]{40}$/);
    const report = hub.requests.find(request => request.url === "/runtime-tools/github/push-report");
    expect(report?.capability).toBe("run-capability");
    expect(report?.authorization).toBe("Bearer run-capability");
  });

  it("reports the object pushed through an explicit refspec and the default branch", async () => {
    const hub = await broker();
    const space = await workspace();
    Object.assign(space.env, githubBrokerEnvironment({}, { url: hub.url, token: "run-capability" }));
    await space.git("commit", "--allow-empty", "-m", "First");
    await space.git("push", "origin", "HEAD:refs/heads/release/2026-09");
    await space.git("commit", "--allow-empty", "-m", "Second");
    await space.git("push");

    expect(hub.reports.map(report => report.branch)).toEqual(["release/2026-09", "main"]);
    expect(hub.reports.map(report => report.sha)).toEqual([
      (await space.git("rev-parse", "HEAD~1")).stdout.trim(),
      (await space.git("rev-parse", "HEAD")).stdout.trim(),
    ]);
    expect(hub.reports.every(report => report.repo === "acme/widgets")).toBe(true);
  });

  it("records a ref deletion without inventing a commit", async () => {
    const hub = await broker();
    const space = await workspace();
    Object.assign(space.env, githubBrokerEnvironment({}, { url: hub.url, token: "run-capability" }));
    await space.git("commit", "--allow-empty", "-m", "First");
    await space.git("push", "origin", "main");
    await space.git("push", "origin", "HEAD:refs/heads/doomed");
    await space.git("push", "origin", ":refs/heads/doomed");

    expect(hub.reports).toHaveLength(3);
    expect(hub.reports[2]).toEqual({
      sha: null, repo: "acme/widgets", branch: "doomed", remote: "origin", deleted: true,
    });
  });

  it("reports a push whose subcommand follows global Git options", async () => {
    const hub = await broker();
    const space = await workspace();
    Object.assign(space.env, githubBrokerEnvironment({}, { url: hub.url, token: "run-capability" }));
    await space.git("commit", "--allow-empty", "-m", "First");
    const pushed = (await space.git("rev-parse", "HEAD")).stdout.trim();
    await space.git("-C", space.repo, "--no-pager", "push", "origin", "main");

    expect(hub.reports).toEqual([
      { sha: pushed, repo: "acme/widgets", branch: "main", remote: "origin", deleted: false },
    ]);
  });

  it("leaves no record for a rehearsal, a failed push, or a non-push command", async () => {
    const hub = await broker();
    const space = await workspace();
    Object.assign(space.env, githubBrokerEnvironment({}, { url: hub.url, token: "run-capability" }));
    await space.git("commit", "--allow-empty", "-m", "First");
    await space.git("push", "--dry-run", "origin", "main");
    await space.git("push", "origin", "does-not-exist").then(
      () => expect.unreachable("a refspec matching nothing must fail"),
      () => undefined,
    );
    await space.git("push", "origin", "main");
    await space.git("log", "-1", "--format=%H");

    expect(hub.reports).toHaveLength(1);
    expect(hub.reports[0]!.branch).toBe("main");
  });

  it("does not fabricate a repository for a local path remote or a credentialed URL", async () => {
    const hub = await broker();
    const space = await workspace();
    Object.assign(space.env, githubBrokerEnvironment({}, { url: hub.url, token: "run-capability" }));
    await space.git("commit", "--allow-empty", "-m", "First");
    await space.git("push", space.bare, "main");
    expect(hub.reports).toHaveLength(0);

    // A URL whose userinfo holds a token must yield an owner/name, never itself.
    await space.git("remote", "set-url", "origin", "https://x-access-token:ghs_secret@github.com/acme/widgets.git");
    await space.git("config", "--unset", `url.${space.bare}.insteadOf`);
    await space.git("push", "origin", "main").then(
      () => expect.unreachable("a push without transport credentials must fail"),
      () => undefined,
    );
    expect(hub.reports).toHaveLength(0);
  });

  it("never carries credential material into the report and keeps the push successful when it fails", async () => {
    const hub = await broker();
    const space = await workspace();
    Object.assign(space.env, githubBrokerEnvironment({ GH_TOKEN: "ambient-host-token" }, { url: hub.url, token: "run-capability" }));
    await space.git("commit", "--allow-empty", "-m", "First");
    hub.rejectReports(true);
    const result = await space.git("push", "origin", "main");

    // A push that succeeded must not fail because its audit write did not land.
    expect(result.stderr).toContain("push_attribution_rejected");
    expect(result.stderr).not.toMatch(/ambient-host-token|run-capability/);
    expect(hub.reports).toHaveLength(0);
    expect((await space.git("rev-parse", "HEAD")).stdout.trim()).toMatch(/^[0-9a-f]{40}$/);
  });

  it("says so when no run capability can attribute the push", async () => {
    const hub = await broker();
    const space = await workspace();
    Object.assign(space.env, githubBrokerEnvironment({}, { url: hub.url, token: "" }));
    await space.git("commit", "--allow-empty", "-m", "First");
    const result = await space.git("push", "origin", "main");

    expect(result.stderr).toContain("push_attribution_capability_missing");
    expect(hub.reports).toHaveLength(0);
  });
});