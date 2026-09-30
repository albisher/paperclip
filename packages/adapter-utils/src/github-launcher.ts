/** Standalone source is staged unchanged on local, SSH, and sandbox runtimes. No secrets in files. */
export function githubLauncherSource(): string {
  return String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const directory = path.dirname(fs.realpathSync(process.argv[1]));
const program = path.basename(process.argv[1]);
const originalPath = (process.env.PATH || '').split(path.delimiter).filter(p => {
  try { return fs.realpathSync(p) !== directory; } catch { return true; }
});
const executable = originalPath.map(p => path.join(p, program)).find(p => {
  try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; }
});
if (!['git', 'gh'].includes(program) || !executable) {
  process.stderr.write('Paperclip: requested GitHub command is not installed.\n');
  process.exit(127);
}
// Attribution reads refs and reports identifiers that are already public in the
// repository's own history. It never reads, stores, or forwards a credential.
const ATTRIBUTION_TIMEOUT_MS = 5000;
const PUSH_FLAGS_WITH_VALUE = ['-o', '--push-option', '--receive-pack', '--exec', '--repo'];
const GLOBAL_FLAGS_WITH_VALUE = ['-C', '-c', '--config-env', '--exec-path', '--git-dir', '--namespace', '--super-prefix', '--work-tree'];
function gitValue(executable, env, args) {
  const result = spawnSync(executable, args, { env, encoding: 'utf8', timeout: ATTRIBUTION_TIMEOUT_MS });
  return result.status === 0 ? String(result.stdout || '').trim() : null;
}
// "git -C <dir> push" and "git --no-pager push" name the subcommand after
// global options, so the operands cannot be read from index 1.
function subcommandIndex(args) {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--') return index + 1;
    if (!arg.startsWith('-')) return index;
    if (GLOBAL_FLAGS_WITH_VALUE.includes(arg)) index++;
  }
  return -1;
}
// Only a real remote update is auditable. A rehearsal or a failed push
// published nothing, so reporting either would invent a record.
function describePush(program, args) {
  const at = program === 'git' ? subcommandIndex(args) : -1;
  if (at === -1 || args[at] !== 'push') return null;
  const operands = [];
  let deleted = false;
  for (let index = at + 1; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--') continue;
    if (arg === '--dry-run' || arg === '-n') return null;
    if (arg === '--delete' || arg === '-d') { deleted = true; continue; }
    if (PUSH_FLAGS_WITH_VALUE.includes(arg)) { index++; continue; }
    if (arg.startsWith('-')) continue;
    operands.push(arg);
  }
  if (operands.length === 0) return { remote: null, refspecs: [], deleted };
  return { remote: operands[0], refspecs: operands.slice(1), deleted };
}
function refspecTarget(refspec, deleted) {
  const colon = refspec.indexOf(':');
  const source = colon === -1 ? refspec : refspec.slice(0, colon);
  const target = (colon === -1 ? refspec : refspec.slice(colon + 1)) || source;
  if (!target) return { branch: null, source: null, deleted: true };
  const kind = target.startsWith('refs/tags/') ? 'tags' : 'heads';
  return {
    branch: target.replace(/^refs\/(?:heads|tags)\//, ''),
    source: source ? (source === 'HEAD' || source.startsWith('refs/') ? source : 'refs/' + kind + '/' + source) : null,
    deleted: deleted || !source,
  };
}
// owner/name for a hosted remote. A local path has no owner, and deriving one
// from directory names would put a fabricated repository in the audit trail.
function repoSlug(remoteUrl) {
  const value = String(remoteUrl || '').trim();
  if (!value || /^(?:\/|\.{1,2}\/|~)/.test(value) || value.startsWith('file://')) return null;
  let host = null;
  let remotePath = null;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) {
    let parsed;
    try { parsed = new URL(value); } catch { return null; }
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(parsed.protocol)) return null;
    // Any userinfo in the URL is an access secret, never repository identity.
    host = parsed.hostname;
    remotePath = parsed.pathname;
  } else {
    const scp = value.match(/^(?:[^/@]+@)?([^/:]+):(.+)$/);
    if (!scp) return null;
    host = scp[1];
    remotePath = scp[2];
  }
  const segments = String(remotePath || '').replace(/\/+$/, '').replace(/\.git$/, '').split('/').filter(Boolean);
  if (segments.length < 2) return null;
  const owner = segments[segments.length - 2];
  const name = segments[segments.length - 1];
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(owner) || !/^[A-Za-z0-9._-]{1,100}$/.test(name)) return null;
  return { host: host, repo: owner + '/' + name };
}
// The canonical configured URL, not the transport-rewritten one: a rewritten
// URL answers "how were the bytes moved" and loses the repository identity.
function remoteTarget(executable, env, remote, branch) {
  const named = remote || gitValue(executable, env, ['config', '--get', 'branch.' + branch + '.remote']);
  if (!named || named === '.') return null;
  const isLocation = named.includes('://') || named.includes('@') || named.startsWith('/')
    || named.startsWith('.') || named.startsWith('~') || /^[A-Za-z0-9._-]+:[^/]/.test(named);
  if (isLocation) return { name: null, url: named };
  const url = gitValue(executable, env, ['config', '--get', 'remote.' + named + '.pushurl'])
    || gitValue(executable, env, ['config', '--get', 'remote.' + named + '.url'])
    || gitValue(executable, env, ['remote', 'get-url', '--push', named]);
  return url ? { name: named, url: url } : null;
}
async function attributePush(env, executable, push) {
  const failed = (code) => process.stderr.write('Paperclip: GitHub ' + code + '; the push succeeded but has no audit record.\n');
  let branch = null;
  let sha = null;
  let deleted = push.deleted;
  if (push.refspecs.length > 0) {
    const target = refspecTarget(push.refspecs[0], push.deleted);
    if (!target.branch) return;
    branch = target.branch;
    deleted = target.deleted;
    sha = target.source ? gitValue(executable, env, ['rev-parse', '--verify', '--quiet', target.source]) : null;
  } else {
    // push.default=simple publishes the checked-out branch; a detached HEAD
    // makes the push itself fail, so there is nothing to attribute.
    const current = gitValue(executable, env, ['symbolic-ref', '--quiet', 'HEAD']);
    if (!current || !current.startsWith('refs/heads/')) return;
    branch = current.replace(/^refs\/heads\//, '');
    sha = gitValue(executable, env, ['rev-parse', '--verify', '--quiet', current]);
  }
  if (!branch || (!sha && !deleted)) return;
  const target = remoteTarget(executable, env, push.remote, branch);
  const slug = target ? repoSlug(target.url) : null;
  if (!slug) return;
  const base = env.PAPERCLIP_GITHUB_BROKER_URL || env.PAPERCLIP_API_URL;
  const capability = env.PAPERCLIP_GITHUB_BROKER_TOKEN;
  if (!base || !capability) { failed('push_attribution_capability_missing'); return; }
  try {
    const url = base.replace(/\/+$/, '').replace(/\/api$/, '') + '/runtime-tools/github/push-report';
    const response = await fetch(url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(ATTRIBUTION_TIMEOUT_MS),
      headers: { authorization: 'Bearer ' + (env.PAPERCLIP_GITHUB_BRIDGE_TOKEN || env.PAPERCLIP_API_KEY || capability),
        'x-paperclip-github-capability': capability, 'content-type': 'application/json' },
      // Field by field: an audit row is built from named identifiers only, so no
      // transport artifact can ride along in it.
      body: JSON.stringify({ sha: sha, repo: slug.repo, branch: branch, remote: target.name, deleted: deleted === true }),
    });
    await response.arrayBuffer();
    if (!response.ok) failed('push_attribution_rejected');
  } catch { failed('push_attribution_unreachable'); }
}
async function main() {
  let env = { ...process.env };
  const diagnostic = (code) => process.stderr.write('Paperclip: GitHub ' + code + '; continuing without managed credentials.\n');
  const configRoot = env.GH_CONFIG_DIR || os.tmpdir();
  // A missing/unwritable scratch directory must not break local Git. The
  // fallback deliberately cannot load the host's gh authentication files.
  let configDirectory = path.join(directory, 'unavailable-gh-config');
  let configReady = false;
  try {
    fs.mkdirSync(configRoot, { recursive: true, mode: 0o700 });
    configDirectory = fs.mkdtempSync(path.join(configRoot, 'paperclip-github-operation-'));
    fs.chmodSync(configDirectory, 0o700);
    configReady = true;
    process.once('exit', () => { try { fs.rmSync(configDirectory, { recursive: true, force: true }); } catch {} });
  } catch { diagnostic('configuration_directory_unavailable'); }
  {
    for (const key of Object.keys(env)) {
      if (/^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|PAPERCLIP_GIT_TOKEN|GIT_AUTHOR_.*|GIT_COMMITTER_.*|GIT_CONFIG_.*|GIT_ASKPASS|SSH_ASKPASS|SSH_AUTH_SOCK|GIT_SSH.*)$/.test(key)) delete env[key];
    }
    Object.assign(env, {
      GH_CONFIG_DIR: configDirectory, SSH_AUTH_SOCK: '',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      // The inherited identity was deleted above. Empty identity env values
      // override even explicit repository/command config and break local commits.
      // Require configured identity instead of guessing the OS user's details.
      GIT_CONFIG_COUNT: '5', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
      GIT_CONFIG_KEY_1: 'url.https://github.com/.insteadOf', GIT_CONFIG_VALUE_1: 'git@github.com:',
      GIT_CONFIG_KEY_2: 'url.https://github.com/.insteadOf', GIT_CONFIG_VALUE_2: 'ssh://git@github.com/',
      GIT_CONFIG_KEY_3: 'core.askPass', GIT_CONFIG_VALUE_3: '',
      GIT_CONFIG_KEY_4: 'user.useConfigOnly', GIT_CONFIG_VALUE_4: 'true',
    });
    const base = env.PAPERCLIP_GITHUB_BROKER_URL || env.PAPERCLIP_API_URL;
    try {
    let response;
    if (base && env.PAPERCLIP_GITHUB_BROKER_TOKEN) {
      const url = base.replace(/\/+$/, '').replace(/\/api$/, '') + '/runtime-tools/github/credentials';
      for (let attempt = 0; attempt < 30; attempt++) {
        response = await fetch(url, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
          headers: { authorization: 'Bearer ' + (env.PAPERCLIP_GITHUB_BRIDGE_TOKEN || env.PAPERCLIP_API_KEY || env.PAPERCLIP_GITHUB_BROKER_TOKEN),
            'x-paperclip-github-capability': env.PAPERCLIP_GITHUB_BROKER_TOKEN, 'content-type': 'application/json' },
          body: '{}',
        });
        if (response.status !== 409) break;
        await response.arrayBuffer();
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      if (!response.ok) {
        diagnostic(response.status === 401 || response.status === 403 ? 'capability_rejected' : 'broker_response_unavailable');
      } else {
      const result = await response.json();
      if (result.status === 'unavailable') {
        const reason = typeof result.reason === 'string'
          ? result.reason.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 500)
          : 'Check the GitHub connection in Paperclip';
        process.stderr.write('Paperclip: GitHub access unavailable: ' + reason + '. Continuing without GitHub credentials.\n');
      }
      if (result.status === 'available' && configReady) {
        for (const [key, value] of Object.entries(result.env || {})) {
          if (/^(GH_TOKEN|GITHUB_TOKEN|PAPERCLIP_GIT_TOKEN|GIT_TERMINAL_PROMPT|GIT_AUTHOR_(NAME|EMAIL)|GIT_COMMITTER_(NAME|EMAIL)|GIT_CONFIG_COUNT|GIT_CONFIG_(KEY|VALUE)_\d+)$/.test(key) && typeof value === 'string') env[key] = value;
        }
      }
      }
    } else { diagnostic('capability_missing'); }
    } catch { diagnostic('broker_transport_unavailable'); }
  }
  // Only this invocation and its children inherit the captured credential.
  // Its Git children use the real binary, so steering cannot split a gh operation.
  env.PATH = originalPath.join(path.delimiter);
  // Nested shell aliases must not reload the parent launcher profile and
  // recapture a newer identity. All ordinary descendants stay in this operation.
  env.ZDOTDIR = configDirectory;
  env.BASH_ENV = '/dev/null';
  env.GIT_SSH_COMMAND = 'ssh -F /dev/null -o IdentityAgent=none -o IdentitiesOnly=yes -o IdentityFile=none -o BatchMode=yes';
  const arguments_ = process.argv.slice(2);
  const push = describePush(program, arguments_);
  const child = spawn(executable, arguments_, { env, stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
  const outcome = await new Promise((resolve) => {
    child.once('error', () => { process.stderr.write('Paperclip: GitHub command could not start.\n'); resolve({ code: 1 }); });
    child.once('exit', (code, signal) => resolve({ code: code === null ? 128 : code, signal: signal || null }));
  });
  // The completed push is the only moment the published object is knowable.
  if (push && outcome.code === 0 && !outcome.signal) await attributePush(env, executable, push);
  process.exitCode = outcome.code;
}
main().catch(() => { process.stderr.write('Paperclip: GitHub launcher_setup_failed.\n'); process.exitCode = 1; });
`;
}

/** Override inherited credentials even when adapters merge the host environment later. */
export function githubBrokerEnvironment(input: Record<string, unknown>, broker: { url: string; token: string }): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) if (typeof value === "string") env[key] = value;
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "PAPERCLIP_GIT_TOKEN", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "GIT_CONFIG_COUNT", "PAPERCLIP_GITHUB_OPERATION_ACTIVE"]) env[key] = "";
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key)) env[key] = "";
  }
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_SYSTEM = "/dev/null";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_ASKPASS = "";
  env.SSH_ASKPASS = "";
  env.GIT_SSH_COMMAND = "ssh -F /dev/null -o IdentityAgent=none -o IdentitiesOnly=yes -o IdentityFile=none -o BatchMode=yes";
  env.SSH_AUTH_SOCK = "";
  env.PAPERCLIP_GITHUB_BROKER_URL = broker.url;
  env.PAPERCLIP_GITHUB_BROKER_TOKEN = broker.token;
  return env;
}
