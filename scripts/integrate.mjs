// The one script that pushes to main (AGENTS.md, "Before every push to main"). One run lands one batch, then exits; the
// coordinator, a runner or Agent Factory starts it after each READY, every 30 min, or at 3 READY entries.
//   node scripts/integrate.mjs [--worktree=<path>] [--only=<branch>@<sha>] [--limit=<min>] [--wait-max=<min>]
// An agent declares a branch ready with a file private/queue/<branch>.ready in the main checkout, holding one line:
//   READY <sha>        or        READY <sha> fix
// A run, under test-results/land.lock (gpu-lock.mjs: heartbeat, hard limit, whole tree killed past it), and it stops
// itself, pushing nothing, the moment that lock entry is no longer the one it started under (a second integrator took
// over, or the wrapper died): exactly one integrator runs at a time.
// 1. Writes its run record private/queue/runs/<stamp>.json first, and keeps it current through every phase. Finishes any
//    earlier run that pushed and died before its record was complete (the push is on origin/main: it is recorded now, its
//    READY files go; or it is not: the entries stay READY). Commits on origin/main that no record covers (a hand push) are
//    written to landed.log as a hand-push line, so every commit on main is accounted for.
// 2. Reads the entries, fix entries first, then oldest first. --only pins one exact READY under the lock and leaves
//    unrelated entries untouched. Never more than 6 in a batch: the seventh and later go back at once,
//    loudly, with the banner. While private/queue/RED.json exists only fix entries are taken. RED.held.json is a RED set
//    aside on Scott's order: it holds nothing and is noted in the record.
// 3. Intake, per branch, before anything is built: the commit exists; it is not on main already; every commit's author
//    and committer are the noreply address; no commit message holds an em or en dash, a home-folder path, a secret or an
//    address outside the allowed ones; no added line holds a home-folder path or a secret; a `fix` commit changes a test
//    or names one with `Regression: <path>`; nothing touches a class stopped in private/control.json (a control file it
//    cannot read, or a tag it does not know, refuses the batch: a stop order is never skipped over a typo).
// 4. Rebases each branch onto origin/main in order, in its own detached worktree. A conflict sends that branch back and
//    the rest go on.
// 5. Tier 1, once on the batch tip, no GPU suite and nothing skippable by a flag or an environment variable: relink,
//    check:merge's plan, build, api:check (on the reports the branches committed), land-records --no-build
//    (its short basic-scene browser takes a GPU slot itself), verify on those records, then check:examples-types and
//    modern:test:packages narrowed by the plan. Every step has a hard limit; past it the whole tree is killed and the
//    record says it hung.
// 6. A failure names a branch directly: the output names a file or package a branch changed (or a package that depends on
//    one), or the batch has one branch. Every named branch goes back with the log and the gate runs again on the rest. A
//    failure that names nobody stops the run: every entry stays READY, the record names the step and the log, and nobody
//    is stepped out one at a time to find out (that took 28 minutes once). No rerun without a change.
// 7. Checks the lock, RED.json, control.json and every commit's identity once more, writes the record as "pushing",
//    pushes once, never forced, appends the landing to private/queue/landed.log, writes latest-landing.json and runs
//    --notify. If main moved meanwhile, the push is refused and every entry stays READY for the next run.
// A branch sent back is private/queue/sent-back/<branch>.json: the reason, the step and the log. Its .ready file is gone,
// and every READY file this script removes, for any reason, is one line of private/queue/queue.log and of the run record.
// private/queue/retirements/ journals each removal before moving READY to a tombstone, so a failed log write is recoverable.
// Everything git and every command go through `git` and `runStep`, so tests/integrate.test.js runs it all with neither.
// Exit: 0 landed, nothing queued or held by RED; 4 refused; 5 main moved; 6 nothing could land; 7 the lock was lost;
// 8 the record could not be written; 124 past the hard limit.
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { margoError } from '../packages/shared/errors.js';
import { mainCheckout } from './gpu-lock.mjs';
import { MAX_QUEUE, queueBanner } from './queue-limit.mjs';
import { demoSources, dependents, loadWorkspaces, workspaceOf } from './support/affected-gpu.mjs';
import { CLASSES, classify } from './support/file-classes.mjs';
import { exitOnHelp } from './support/help.mjs';
import { runLimited } from './support/run-limited.mjs';
import { demos } from './support/visual-demos.js';

const root = resolve(import.meta.dirname, '..');
const NAME = 'Scott Campbell';
/** The address every commit on main carries (AGENTS.md, docs/architecture/operational-playbook.md 2.6.2). */
export const EMAIL = '251750033+scottcampbelldata@users.noreply.github.com';
const IDENTITY = {
  GIT_AUTHOR_NAME: NAME,
  GIT_AUTHOR_EMAIL: EMAIL,
  GIT_COMMITTER_NAME: NAME,
  GIT_COMMITTER_EMAIL: EMAIL,
};
/** How many minutes one tier 1 step may take; the whole run's limit is --limit. */
export const STEP_MINUTES = 30;
export const DEFAULT_LIMIT_MINUTES = 170;
/** Factory may reuse an exact, clean pre-rebase verification for disjoint package work. */
const FACTORY_PROOF = /^([a-f0-9]{40}):([a-f0-9]{64})$/i;
/** Build-phase proof names the command digest so it cannot be mistaken for the full verify proof. */
const FACTORY_BUILD_PROOF = /^([a-f0-9]{40}):([a-f0-9]{64}):([a-f0-9]{64})$/i;
/** One explicit bootstrap for this process patch, never a general verification fallback. */
export const PROCESS_BUILD_COMMANDS = [
  'node scripts/worktree-node-modules.mjs',
  'npm run lint',
  'node --test tests/integrate.test.js',
];
export const PROCESS_BUILD_COMMAND_DIGEST = createHash('sha256')
  .update(PROCESS_BUILD_COMMANDS.join('\n'))
  .digest('hex');
/** How much of a failed step's log is read to name a branch (its end). */
const LOG_BYTES = 4 << 20;
/** How often the lock is checked while a step runs. */
const LOCK_POLL_MS = 15_000;
export { MAX_QUEUE };

/** Exit codes, by result. */
export const EXIT = {
  idle: 0,
  held: 0,
  landed: 0,
  refused: 4,
  moved: 5,
  nothing: 6,
  lost: 7,
  record: 8,
};

/** Where the queue's files live under a main checkout. */
export function queuePaths(main) {
  const dir = join(main, 'private', 'queue');
  return {
    dir,
    red: join(dir, 'RED.json'),
    redHeld: join(dir, 'RED.held.json'),
    landed: join(dir, 'landed.log'),
    latest: join(dir, 'latest-landing.json'),
    ledger: join(dir, 'queue.log'),
    retirements: join(dir, 'retirements'),
    runs: join(dir, 'runs'),
    sentBack: join(dir, 'sent-back'),
    logs: join(dir, 'logs'),
    control: join(main, 'private', 'control.json'),
  };
}

/** Parses one queue file. Returns `{ sha, fix }`, or null when it is not `READY <sha>` or `READY <sha> fix`. */
export function parseReady(text) {
  const match = /^READY\s+([0-9a-f]{7,40})(\s+fix)?\s*$/.exec(text.split(/\r?\n/)[0] ?? '');
  return match ? { sha: match[1], fix: Boolean(match[2]) } : null;
}

/**
 * The queue, in landing order: fix entries first, then oldest file first. Each is `{ branch, file, sha, fix }`; a file
 * that does not parse has `invalid: true`.
 */
export function readQueue(dir) {
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir)
    .filter((name) => name.endsWith('.ready'))
    .map((name) => {
      const file = join(dir, name),
        raw = readFileSync(file, 'utf8'),
        parsed = parseReady(raw);
      return {
        branch: name.slice(0, -6),
        file,
        raw,
        taken: parsed?.sha,
        mtime: statSync(file).mtimeMs,
        ...(parsed ?? { invalid: true }),
      };
    });
  const rank = (entry) => (entry.fix ? 0 : 1);
  return entries.sort((a, b) => rank(a) - rank(b) || a.mtime - b.mtime || a.branch.localeCompare(b.branch));
}

const DEMO_ROOTS = demos.flatMap((demo) => demoSources(demo) ?? []);
const DEMO_PATTERNS = [/^apps\//, /^examples\/gallery\//, /plaza/i];

/** Whether a repo-relative path belongs to a demo: a visual demo's sources, an app, the gallery, or anything Plaza. */
export function demoPath(file) {
  return DEMO_PATTERNS.some((re) => re.test(file)) || DEMO_ROOTS.some((r) => file === r || file.startsWith(`${r}/`));
}

/** The stopped tags in control.json, [] without the file. Throws INTEGRATE_CONTROL_INVALID on anything it cannot honour. */
export function readStopped(file) {
  if (!existsSync(file)) return [];
  let stopped;
  try {
    ({ stopped } = JSON.parse(readFileSync(file, 'utf8')));
  } catch (error) {
    throw margoError(
      'INTEGRATE_CONTROL_INVALID',
      `${file} is not JSON (${error.message}); fix it, nothing lands until then`,
    );
  }
  if (stopped === undefined) return [];
  const unknown = Array.isArray(stopped) ? stopped.filter((tag) => tag !== 'demos' && !(tag in CLASSES)) : [stopped];
  if (unknown.length)
    throw margoError(
      'INTEGRATE_CONTROL_INVALID',
      `${file} stops ${JSON.stringify(unknown)}; "stopped" is a list of "demos" or file classes (${Object.keys(CLASSES).join(', ')})`,
    );
  return stopped;
}

/** The paths that a stop order catches: `[{ file, tag }]`. */
export function stoppedHits(files, stopped, workspaces = []) {
  return files.flatMap((file) => {
    const cls = classify(file, { workspaces }).cls;
    return stopped.filter((tag) => (tag === 'demos' ? demoPath(file) : tag === cls)).map((tag) => ({ file, tag }));
  });
}

/** The commands check:merge's --plan output runs, by step name: `{ 'check:examples-types': command | null, ... }`. */
export function parsePlan(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s+(run|skip \(.*\))\s+(npm run (\S+).*)$/.exec(line);
    if (match) out[match[3]] = match[1] === 'run' ? match[2].trim() : null;
  }
  return out;
}

/**
 * Which branches a failure can be pinned on, from a failed step's output. A branch is `direct` when the output names a
 * file it changed or a package it changed, else `dependent` when a named package depends on one it changed. Returns the
 * first group with anyone in it, or `{ branches: [], named: false }` when the output names none of them.
 */
export function suspects(text, batch, workspaces = []) {
  const named = new Set();
  for (const match of text.matchAll(/@margoengine\/([a-z0-9-]+)/g)) named.add(`@margoengine/${match[1]}`);
  for (const match of text.matchAll(/\b(packages|examples|apps)[\\/]([a-z0-9-]+)\b/g)) {
    const owner = workspaces.find((w) => w.dir === `${match[1]}/${match[2]}`);
    if (owner) named.add(owner.name);
  }
  const plain = text.replaceAll('\\', '/'),
    changed = (branch) => [...new Set(branch.paths.map((file) => workspaceOf(workspaces, file)?.name).filter(Boolean))];
  const direct = batch.filter(
    (branch) => branch.paths.some((file) => plain.includes(file)) || changed(branch).some((name) => named.has(name)),
  );
  if (direct.length) return { branches: direct, named: true };
  const dependent = batch.filter((branch) =>
    [...dependents(workspaces, changed(branch))].some((name) => named.has(name)),
  );
  return dependent.length ? { branches: dependent, named: true } : { branches: [], named: false };
}

const lines = (text) =>
  String(text ?? '')
    .split(/\r?\n/)
    .filter(Boolean);

/** Runs `git` and returns its trimmed output; throws what it said on a failure. */
function must(git, ...args) {
  const result = git(args);
  if (result.status !== 0) {
    throw margoError(
      'INTEGRATE_GIT_FAILED',
      `git ${args.join(' ')} failed (${lines(result.stderr).at(-1) ?? `exit ${result.status}`}); fix the integrator worktree, nothing was pushed by this step`,
    );
  }
  return String(result.stdout ?? '').trim();
}

const noreply = (email) => email === EMAIL;

/** The root dependency names a branch's package.json adds over its merge base (none when either side will not parse). */
function addedDependencies(git, entry) {
  const names = (rev) => {
    const shown = git(['show', `${rev}:package.json`]);
    if (shown.status !== 0) return null;
    try {
      const manifest = JSON.parse(shown.stdout);
      return Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
    } catch {
      return null;
    }
  };
  const before = names(entry.from),
    after = names(entry.sha);
  return before && after ? after.filter((name) => !before.includes(name)) : [];
}

/** The names worktree-node-modules.mjs lists after "Missing:" when the main checkout's install is older. */
export const missingFromLog = (tail) =>
  (/Missing: ([^\n]+)/.exec(tail)?.[1] ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);

/**
 * Fast-forwards the main checkout to origin/main after a push. Never resets, stashes or retries: a checkout that cannot
 * move (another branch, or local changes in the way) stays as it is. Returns the line that says what happened.
 */
export function syncMainCheckout(mainGit) {
  const branch = mainGit(['symbolic-ref', '-q', '--short', 'HEAD']);
  if (branch.status !== 0 || String(branch.stdout).trim() !== 'main')
    return 'the main checkout is behind origin/main: it is not on main, so it was left alone; update it by hand';
  const moved = mainGit(['merge', '--ff-only', 'origin/main']);
  if (moved.status === 0) return 'the main checkout fast-forwarded to origin/main';
  const why = lines(moved.stderr).at(-1) ?? `exit ${moved.status}`;
  return `the main checkout is behind origin/main: it could not fast-forward (${why}); its own changes were not touched; update it by hand`;
}

/**
 * Reuse Factory's exact committed verification only when a clean rebase preserved every file in the
 * reviewed branch and upstream changed no package/build input. The combined tree is still not an
 * independently verified release tip; the landing receipt says so explicitly.
 */
export function reusableFactoryProof({ git, base, batch, tip, proof }) {
  const refused = (reason) => ({ ok: false, reason });
  const scope = proof?.scope ?? 'release';
  if (scope !== 'release' && scope !== 'build') return refused('Factory proof scope is unknown');
  if (!/^[a-f0-9]{40}$/i.test(proof?.head ?? '') || !/^[a-f0-9]{64}$/i.test(proof?.fingerprint ?? ''))
    return refused('Factory proof head or input fingerprint is invalid');
  if (scope === 'build' && !/^[a-f0-9]{64}$/i.test(proof?.commandDigest ?? ''))
    return refused('Factory build proof command digest is invalid');
  if (batch.length !== 1) return refused('proof reuse requires one exact READY branch');
  const [entry] = batch;
  if (entry.sha?.toLowerCase() !== proof.head || !entry.from || !entry.rebased || entry.rebased !== tip)
    return refused('the reviewed branch or rebased tip differs from the Factory proof');
  const upstreamPaths = lines(must(git, 'diff', '--name-only', '--no-renames', entry.from, base));
  const branchPaths = entry.paths || [];
  const branchSet = new Set(branchPaths);
  const overlap = upstreamPaths.filter((file) => branchSet.has(file));
  if (overlap.length) return refused(`upstream changed reviewed paths: ${overlap.slice(0, 5).join(', ')}`);
  // Main may advance in records, docs, or the integrator itself while a package branch is reviewed.
  // Source, package dependencies, root checks and other tests invalidate this narrow proof reuse.
  const unrelatedUpstream = upstreamPaths.filter(
    (file) =>
      !/^(?:docs\/api-surface\.md$|examples\/package-benchmarks\/results\/(?:basic-scene-network|entry-sizes)\.json$|scripts\/integrate\.mjs$|tests\/integrate\.test\.js$)/.test(
        file,
      ),
  );
  if (unrelatedUpstream.length)
    return refused(`upstream changed build or test inputs: ${unrelatedUpstream.slice(0, 5).join(', ')}`);
  const changedReviewed = branchPaths.length
    ? lines(must(git, 'diff', '--name-only', '--no-renames', entry.sha, tip, '--', ...branchPaths))
    : [];
  if (changedReviewed.length)
    return refused(`rebase changed reviewed file bytes: ${changedReviewed.slice(0, 5).join(', ')}`);
  return {
    ok: true,
    status: scope === 'build' ? 'reused_factory_build_proof' : 'reused_factory_proof',
    scope,
    sourceHead: proof.head,
    sourceFingerprint: proof.fingerprint,
    ...(scope === 'build' && { commandDigest: proof.commandDigest }),
    rebasedTip: tip,
    branch: entry.branch,
    reviewedPaths: branchPaths,
    upstreamPaths,
    combinedTreeVerified: false,
    releaseGate:
      scope === 'build' ? 'full-verification-and-combined-tree-pending' : 'combined-tree-verification-pending',
  };
}

const isTestFile = (file) => /(^|\/)tests?\//.test(file) || /\.test\.[^/]*$/.test(file);

/**
 * The bug-fix gate. A commit whose subject starts with `fix` (a scope or `!` may follow) must change a test file or carry a
 * body line `Regression: <repo path>` naming a test that exists. `commits` is `[{ sha, message, files, exists(path) }]`;
 * returns the sha and reason of the first commit that does neither, or null.
 */
export function fixWithoutTest(commits) {
  for (const { sha, message, files, exists } of commits) {
    const [subject = '', ...body] = message.split(/\r?\n/);
    if (!/^fix(\([^)]*\))?!?:/i.test(subject.trim())) continue;
    if (files.some(isTestFile)) continue;
    const named = body.map((line) => /^Regression:\s*(\S+)\s*$/.exec(line)?.[1]).filter(Boolean);
    if (named.some((path) => exists(path))) continue;
    return {
      sha,
      reason: named.length
        ? `fix commit ${sha.slice(0, 9)} names "Regression: ${named[0]}" but no such file exists`
        : `fix commit ${sha.slice(0, 9)} "${subject.trim()}" changes no test and has no "Regression: <repo path>" body line; add the test that fails without the fix, or type the commit something other than fix`,
    };
  }
  return null;
}

/**
 * Text that must never reach main: a home folder, a secret, or an address at a domain of Scott's own. In added lines only a
 * home folder that holds a name counts, since a README has to be able to say where a tool keeps its config under the
 * reader's home; a commit message has no such need and refuses both.
 */
const NAMED_HOME = /(?:[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"']+|\/(?:Users|home)\/[^/\s"']+)/;
const HOME_PATH = new RegExp(`${NAMED_HOME.source}|%USERPROFILE%|\\$HOME\\b|~[\\\\/]\\.?[\\w-]+`);
const SECRET = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/,
  /\bey[A-Za-z0-9_-]{20,}\.ey[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/,
];
const ADDRESS = /\b[\w.+-]+@([\w-]+(?:\.[\w-]+)+)\b/g;
/** Domains an address in a commit message may use besides the noreply address itself. */
const ADDRESS_DOMAINS = ['users.noreply.github.com', 'anthropic.com', 'example.com', 'example.invalid'];

/**
 * What a commit message must not carry: an em or en dash, a home-folder path, a secret, or an address that is neither the
 * noreply one nor at an allowed domain. Returns the first problem as text, or null.
 */
/** The en dash and the em dash, by code point: neither may appear in a commit message (nor in this file). */
const DASHES = new RegExp(`[${String.fromCodePoint(0x2013)}${String.fromCodePoint(0x2014)}]`);

export function messageProblem(message) {
  if (DASHES.test(message)) return 'holds an em or en dash; write it again with plain punctuation';
  if (HOME_PATH.test(message)) return 'names a home folder; leave paths like that out of the message';
  if (SECRET.some((re) => re.test(message))) return 'looks like it holds a secret; take it out and rotate it';
  for (const [whole, domain] of message.matchAll(ADDRESS))
    if (whole !== EMAIL && !ADDRESS_DOMAINS.includes(domain.toLowerCase()))
      return `carries the address ${whole}; only ${EMAIL} and ${ADDRESS_DOMAINS.join(', ')} may appear`;
  return null;
}

/**
 * The first added line of a diff that must not reach main: a home-folder path, a secret, or an address at a domain of
 * Scott's own. `diff` is `git diff --unified=0` text. Returns `{ line, problem }`, or null.
 */
export function contentProblem(diff) {
  for (const line of String(diff ?? '').split(/\r?\n/)) {
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    const text = line.slice(1);
    if (NAMED_HOME.test(text)) return { line: text.trim(), problem: 'a home-folder path' };
    if (SECRET.some((re) => re.test(text))) return { line: text.trim(), problem: 'what looks like a secret' };
    for (const [whole, domain] of text.matchAll(ADDRESS))
      if (whole !== EMAIL && /scott/i.test(domain)) return { line: text.trim(), problem: `the address ${whole}` };
  }
  return null;
}

/**
 * The environment tier 1 steps run with: the caller's, less every MARGO* and MARGOENGINE* variable that is not the lock
 * code's own (MARGO_GPU_*), so nothing a caller exports can narrow, skip, cache or widen a step; then `extra` and the
 * noreply identity.
 */
export function stepEnv(base, extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(base))
    if (!/^MARGO/i.test(key) || /^MARGO_GPU_/.test(key)) env[key] = value;
  return { ...env, ...extra, ...IDENTITY };
}

/** Writes JSON to `file` whole: the text goes to a sibling first, then takes the name, so a reader never sees half of it. */
function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, file);
}

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

/** Every landed.log line, oldest first. A corrupt or unreadable record blocks further landings. */
export function readLanded(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw margoError('INTEGRATE_RECORD_FAILED', `cannot read landing record ${file} (${error.message})`);
  }
  return lines(text).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw margoError(
        'INTEGRATE_RECORD_FAILED',
        `landing record ${file} has invalid JSON on line ${index + 1} (${error.message})`,
      );
    }
  });
}

/** Who runs this: enough for a stranger to ask the right person or machine. */
function runner() {
  let user = null;
  try {
    user = userInfo().username;
  } catch {}
  return {
    user,
    host: hostname(),
    pid: process.pid,
    ppid: process.ppid,
    cwd: process.cwd(),
    argv: process.argv.slice(1),
    node: process.version,
    factoryJob: process.env.AGENT_FACTORY_JOB ?? null,
  };
}

/**
 * The run record: one JSON file per run under private/queue/runs/, written when the run starts and again after every
 * phase, so a stranger can read what happened and a crash leaves the phase it reached. `save` throws
 * INTEGRATE_RECORD_FAILED when the file cannot be written: nothing is pushed on a record that cannot be kept.
 */
function openRecord(paths, stamp, now, by) {
  const file = join(paths.runs, `${stamp}.json`);
  const record = {
    id: stamp,
    file,
    schema: 2,
    startedAt: now().toISOString(),
    by,
    state: 'running',
    ledger: [],
    batch: [],
    attempts: [],
  };
  const save = () => {
    record.updatedAt = now().toISOString();
    try {
      writeJson(file, record);
    } catch (error) {
      throw margoError(
        'INTEGRATE_RECORD_FAILED',
        `the run record ${file} could not be written (${error.message}); nothing lands until it can`,
      );
    }
  };
  save();
  return { record, save };
}

/**
 * Lands one batch. `git(args)` resolves to `{ status, stdout, stderr }`, `runStep(command, { env, logFile, limitMs,
 * signal })` to `{ ok, timedOut?, aborted?, seconds? }` and writes its output to logFile. `paths` is queuePaths(); `now()` a
 * Date; `holding()` null while this run still holds the landing lock, else why not; `notify(landing)` runs after a landing.
 * Returns `{ result, exit, line, record, landed?, sentBack }`; result is idle, held, refused, moved, nothing, lost,
 * record or landed.
 */
export async function integrate({
  git,
  mainGit = null,
  runStep,
  paths,
  workspaces = [],
  now = () => new Date(),
  log = console.log,
  stepMinutes = STEP_MINUTES,
  holding = () => null,
  lockPollMs = LOCK_POLL_MS,
  only = null,
  factoryProof = null,
  buildCheck = null,
  notify = null,
  by = runner(),
}) {
  const stamp = now().toISOString().replace(/[:.]/g, '-'),
    logDir = join(paths.logs, stamp);
  let record, save;
  try {
    ({ record, save } = openRecord(paths, stamp, now, by));
  } catch (error) {
    log(`integrate: RECORD: ${error.message}`);
    return { result: 'record', exit: EXIT.record, line: error.message, record: null, sentBack: [] };
  }
  const sentBack = [];
  /** Move the exact READY file aside first, so an interrupted ledger write can restore it on the next run. */
  const retire = (entry, action, reason, extra = {}) => {
    const id = randomUUID(),
      metaFile = join(paths.retirements, `${id}.json`),
      tombstone = join(paths.retirements, `${id}.ready`);
    let moved = false,
      removed = false,
      kept = null;
    try {
      mkdirSync(paths.retirements, { recursive: true });
      writeJson(metaFile, {
        id,
        branch: entry.branch,
        file: entry.file,
        tombstone,
        run: record.id,
        action,
        state: 'prepared',
        at: now().toISOString(),
      });
      try {
        renameSync(entry.file, tombstone);
        moved = true;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        kept = 'the READY file was already absent';
        writeJson(metaFile, {
          id,
          branch: entry.branch,
          file: entry.file,
          tombstone,
          run: record.id,
          action,
          state: 'absent',
          at: now().toISOString(),
        });
      }
      if (moved) {
        const raw = readFileSync(tombstone, 'utf8'),
          parsed = parseReady(raw),
          exact =
            typeof entry.raw === 'string' ? raw === entry.raw : Boolean(entry.taken && parsed?.sha === entry.taken);
        if (exact) {
          removed = true;
        } else {
          // The producer changed READY after intake. An exclusive hard link restores it without overwriting a newer file.
          linkSync(tombstone, entry.file);
          rmSync(tombstone);
          moved = false;
          kept = parsed
            ? `a newer READY ${parsed.sha} stays for the next run`
            : 'a changed READY stays for the next run';
        }
      }
    } catch (error) {
      throw margoError(
        'INTEGRATE_RECORD_FAILED',
        `READY retirement ${id} could not be prepared (${error.message}); recover ${metaFile} before another landing`,
      );
    }
    const line = {
      at: now().toISOString(),
      run: record.id,
      retirementId: id,
      branch: entry.branch,
      sha: entry.sha ?? entry.taken ?? null,
      action,
      reason,
      ...extra,
      removed,
      ...(kept && { kept }),
    };
    try {
      mkdirSync(dirname(paths.ledger), { recursive: true });
      appendFileSync(paths.ledger, `${JSON.stringify(line)}\n`);
      record.ledger.push(line);
      writeJson(metaFile, {
        id,
        branch: entry.branch,
        file: entry.file,
        tombstone,
        run: record.id,
        action,
        state: 'recorded',
        line,
      });
      if (moved) rmSync(tombstone, { force: true });
    } catch (error) {
      throw margoError(
        'INTEGRATE_RECORD_FAILED',
        `READY retirement ${id} could not be recorded (${error.message}); ${metaFile} and its tombstone are kept for recovery`,
      );
    }
    return line;
  };
  /** Restore a READY moved by a failed retirement, or finish one whose ledger append succeeded. */
  const recoverRetirements = () => {
    if (!existsSync(paths.retirements)) return;
    let recorded = new Set();
    if (existsSync(paths.ledger)) {
      try {
        recorded = new Set(
          readFileSync(paths.ledger, 'utf8')
            .split(/\r?\n/)
            .filter(Boolean)
            .map((line) => JSON.parse(line).retirementId)
            .filter(Boolean),
        );
      } catch (error) {
        throw margoError(
          'INTEGRATE_RECORD_FAILED',
          `cannot read ${paths.ledger} for READY recovery (${error.message})`,
        );
      }
    }
    for (const name of readdirSync(paths.retirements).filter((file) => file.endsWith('.json'))) {
      const metaFile = join(paths.retirements, name),
        meta = readJson(metaFile);
      if (
        !meta ||
        meta.id !== name.slice(0, -5) ||
        dirname(meta.file ?? '') !== paths.dir ||
        meta.tombstone !== join(paths.retirements, `${meta.id}.ready`)
      )
        throw margoError('INTEGRATE_RECORD_FAILED', `invalid READY retirement journal ${metaFile}`);
      const tombstoneExists = existsSync(meta.tombstone);
      if (meta.state === 'absent' && !tombstoneExists) continue;
      if (meta.state === 'restored' && !tombstoneExists) continue;
      if (meta.state === 'recorded' && !recorded.has(meta.id))
        throw margoError(
          'INTEGRATE_RECORD_FAILED',
          `READY retirement ${meta.id} is missing from ${paths.ledger}; reconcile its journal before landing`,
        );
      if (meta.state === 'recorded' || recorded.has(meta.id)) {
        if (tombstoneExists) rmSync(meta.tombstone, { force: true });
        if (meta.state !== 'recorded')
          writeJson(metaFile, { ...meta, state: 'recorded', recoveredAt: now().toISOString() });
        continue;
      }
      if (meta.state !== 'prepared' && meta.state !== 'restored')
        throw margoError('INTEGRATE_RECORD_FAILED', `unknown READY retirement state in ${metaFile}`);
      if (tombstoneExists) {
        if (existsSync(meta.file)) {
          const moved = statSync(meta.tombstone, { bigint: true }),
            restored = statSync(meta.file, { bigint: true });
          if (moved.dev !== restored.dev || moved.ino === 0n || moved.ino !== restored.ino)
            throw margoError(
              'INTEGRATE_RECORD_FAILED',
              `READY changed during recovery; ${meta.tombstone} is preserved and must be reconciled with ${meta.file}`,
            );
        } else {
          linkSync(meta.tombstone, meta.file);
        }
        rmSync(meta.tombstone);
        log(`integrate: restored ${meta.file} after interrupted READY retirement ${meta.id}`);
      } else if (!existsSync(meta.file)) {
        throw margoError(
          'INTEGRATE_RECORD_FAILED',
          `READY retirement ${meta.id} has neither its original file nor its tombstone; inspect ${metaFile}`,
        );
      }
      writeJson(metaFile, { ...meta, state: 'restored', recoveredAt: now().toISOString() });
    }
  };
  const sendBack = (entry, reason, step = 'intake', logFile = null) => {
    mkdirSync(paths.sentBack, { recursive: true });
    writeFileSync(
      join(paths.sentBack, `${entry.branch}.json`),
      `${JSON.stringify({ branch: entry.branch, sha: entry.sha ?? null, at: now().toISOString(), run: record.id, step, reason, log: logFile }, null, 2)}\n`,
    );
    retire(entry, 'sent-back', reason, { step, log: logFile });
    sentBack.push({ branch: entry.branch, sha: entry.sha ?? null, step, reason, log: logFile });
    log(`integrate: ${entry.branch} goes back: ${reason}${logFile ? ` (log ${logFile})` : ''}`);
  };
  const finish = (result, line, extra = {}) => {
    record.state = result === 'landed' ? 'landed' : 'done';
    record.result = result;
    record.exit = EXIT[result];
    record.line = line;
    record.finishedAt = now().toISOString();
    Object.assign(record, extra.stillReady ? { stillReady: extra.stillReady } : {});
    save();
    log(`integrate: RECORD: ${record.file}`);
    log(`integrate: ${result.toUpperCase()}: ${line}`);
    return { result, exit: EXIT[result], line, record, sentBack, ...extra };
  };
  const lockLost = () => {
    const why = holding();
    if (!why) return null;
    return finish('lost', `${why}; this run stops here and pushes nothing; every entry stays READY`);
  };

  try {
    return await land();
  } catch (error) {
    if (error.code === 'INTEGRATE_RECORD_FAILED') {
      log(`integrate: RECORD: ${error.message}`);
      return { result: 'record', exit: EXIT.record, line: error.message, record, sentBack };
    }
    // A run that reached the push stays "pushing": that state is what makes the next run look at origin/main and finish
    // the landing's record, and a crash after the push must not hide a landing.
    if (record.state !== 'pushing') record.state = 'crashed';
    record.error = error.message;
    try {
      save();
    } catch {}
    throw error;
  }

  async function land() {
    const unlocked = lockLost();
    if (unlocked) return unlocked;
    recoverRetirements();
    let batch = readQueue(paths.dir);
    if (buildCheck === 'process' && (batch.length !== 1 || !only))
      return finish(
        'refused',
        'the process bootstrap needs one exact READY file and --only; no queue entry was changed',
      );
    if (only) {
      const selected = batch.find((entry) => entry.branch === only.branch);
      if (!selected || selected.invalid || selected.sha?.toLowerCase() !== only.sha)
        return finish(
          'refused',
          `--only ${only.branch}@${only.sha} no longer matches its exact READY file; no queue entry was changed`,
        );
      const unrelatedRecovery = pendingRuns().find(
        ({ earlier }) =>
          !Array.isArray(earlier.entries) ||
          earlier.entries.length !== 1 ||
          earlier.entries[0].branch !== only.branch ||
          earlier.entries[0].sha !== only.sha,
      );
      if (unrelatedRecovery)
        return finish(
          'refused',
          `earlier run ${unrelatedRecovery.earlier.id} needs recovery before --only can land; no queue entry was changed`,
        );
      batch = [selected];
    }
    record.queue = batch.map(({ branch, sha, fix, invalid, mtime }) => ({
      branch,
      sha: sha ?? null,
      fix: Boolean(fix),
      invalid: Boolean(invalid),
      readyAt: new Date(mtime).toISOString(),
    }));
    record.redHeld = existsSync(paths.redHeld);
    if (record.redHeld)
      log(`integrate: ${paths.redHeld} exists: a RED set aside on Scott's order; it holds nothing and stays as it is`);
    for (const entry of batch.filter((e) => e.invalid))
      sendBack(entry, `the file does not read "READY <sha>" or "READY <sha> fix"; write it again`);
    batch = batch.filter((entry) => !entry.invalid);
    if (batch.length > MAX_QUEUE) {
      const extra = batch.slice(MAX_QUEUE);
      log(
        queueBanner(
          batch.length,
          `${extra.map((e) => e.branch).join(', ')} came after the ${MAX_QUEUE}th and go back now. Start nothing new.`,
        ),
      );
      for (const [i, entry] of extra.entries())
        sendBack(
          entry,
          `NEVER MORE THAN ${MAX_QUEUE} IN THE QUEUE: this READY was number ${MAX_QUEUE + i + 1}; write READY again after a landing`,
        );
      batch = batch.slice(0, MAX_QUEUE);
      record.overLimit = extra.map((e) => e.branch);
    }
    if (!batch.length && !sentBack.length && !pendingRuns().length) return finish('idle', 'nothing is READY');

    must(git, 'fetch', '-q', 'origin');
    const base = must(git, 'rev-parse', 'origin/main');
    record.base = base;
    record.unlanded = unlandedNames(git, batch);
    if (record.unlanded.length > MAX_QUEUE)
      log(
        queueBanner(
          record.unlanded.length,
          `Unlanded: ${record.unlanded.join(', ')}. This run lands; nothing else starts.`,
        ),
      );
    recoverPushed(base);
    const mainIssue = accountForMain(base);
    if (mainIssue) return finish('refused', mainIssue);
    // A recovery retires the entries of the landing it finished; anything else that vanished since the queue was read
    // was not this run's doing, and is said so.
    batch = batch.filter((entry) => {
      if (existsSync(entry.file)) return true;
      if (!record.ledger.some((line) => line.branch === entry.branch && line.action === 'landed'))
        log(
          `integrate: ${entry.file} vanished while this run started; not this run's doing, so it is not recorded here`,
        );
      return false;
    });
    save();

    if (!batch.length)
      return finish(
        sentBack.length ? 'nothing' : 'idle',
        sentBack.length ? 'every entry went back' : 'nothing is READY',
      );
    const red = existsSync(paths.red);
    record.red = red;
    if (red) batch = batch.filter((entry) => entry.fix);
    if (!batch.length) return finish('held', `main is RED (${paths.red}) and no READY entry is marked fix`);

    const known = [];
    for (const entry of batch) {
      const resolved = git(['rev-parse', '--verify', '-q', `${entry.sha}^{commit}`]);
      if (resolved.status !== 0) {
        sendBack(entry, `no commit ${entry.sha} in this clone; commit it, then write READY again`);
        continue;
      }
      entry.sha = String(resolved.stdout).trim();
      if (git(['merge-base', '--is-ancestor', entry.sha, base]).status === 0) {
        retire(entry, 'already-on-main', `${entry.sha} is already on main; its READY entry is removed`);
        log(`integrate: ${entry.branch} is already on main; its READY entry is removed`);
        continue;
      }
      entry.from = must(git, 'merge-base', entry.sha, base);
      const problem = intakeProblem(entry);
      if (problem) {
        sendBack(entry, problem);
        continue;
      }
      entry.paths = lines(must(git, 'diff', '--name-only', '--no-renames', entry.from, entry.sha));
      known.push(entry);
    }
    batch = known;
    if (
      buildCheck === 'process' &&
      (batch.length !== 1 ||
        batch[0].paths.some((file) => !['scripts/integrate.mjs', 'tests/integrate.test.js'].includes(file)))
    )
      return finish(
        'refused',
        'the process bootstrap only accepts scripts/integrate.mjs and tests/integrate.test.js in one READY commit; no checks ran and every READY entry remains',
      );
    record.batch = batch.map(({ branch, sha, fix, from, paths: files }) => ({
      branch,
      ready: sha,
      fix: Boolean(fix),
      from,
      files: files.length,
      rebased: null,
    }));
    save();
    if (!batch.length) return finish(sentBack.length ? 'nothing' : 'idle', 'no branch left to land');

    // Before anything is rebased or built, and again before the push: a stop order may come while the gate runs.
    const stop = refusedByStop(batch);
    if (stop) return stop;

    let attempt = 0,
      gate = null;
    mkdirSync(logDir, { recursive: true });
    while (batch.length) {
      const lost = lockLost();
      if (lost) return lost;
      attempt++;
      batch = assemble({ git, base, batch, sendBack });
      for (const entry of batch) record.batch.find((b) => b.branch === entry.branch).rebased = entry.rebased;
      if (!batch.length) break;
      const tip = must(git, 'rev-parse', 'HEAD');
      const steps = [];
      record.attempts.push({ attempt, tip, branches: batch.map((e) => e.branch), steps });
      save();
      let proofReuse = null;
      if (factoryProof) {
        proofReuse = reusableFactoryProof({ git, base, batch, tip, proof: factoryProof });
        if (!proofReuse.ok) {
          record.factoryProofReuse = {
            status: 'refused',
            reason: proofReuse.reason,
            scope: factoryProof.scope ?? 'release',
            sourceHead: factoryProof.head,
            sourceFingerprint: factoryProof.fingerprint,
            ...(factoryProof.commandDigest && { commandDigest: factoryProof.commandDigest }),
            rebasedTip: tip,
          };
          save();
          return finish(
            'refused',
            `Factory ${factoryProof.scope === 'build' ? 'build' : 'verification'} proof cannot be reused: ${proofReuse.reason}; no tests were run and every READY entry remains`,
          );
        }
        record.factoryProofReuse = proofReuse;
        save();
      }
      gate = await tierOne({
        git,
        runStep,
        logDir,
        attempt,
        stepMinutes,
        log,
        steps,
        save,
        holding,
        lockPollMs,
        factoryProofReuse: proofReuse,
        buildCheck,
      });
      if (gate.ok) break;
      if (gate.lost)
        return finish('lost', `${gate.lost}; this run stops here and pushes nothing; every entry stays READY`);
      const blamed = blame(gate, batch);
      if (!blamed.branches.length) {
        record.unblamed = { attempt, step: gate.step, log: gate.log };
        return finish(
          'nothing',
          `${gate.step} failed on the batch tip (${gate.timedOut ? 'hung past its limit, tree killed' : 'see the log'}) and its output names no branch of ${batch.map((e) => e.branch).join(', ')}; nobody is stepped out to find it; every entry stays READY; read ${gate.log} and fix the cause, or take the branch that owns it out`,
          { stillReady: batch.map((e) => e.branch) },
        );
      }
      for (const entry of blamed.branches) sendBack(entry, blamed.reason(entry), gate.step, gate.log);
      batch = batch.filter((entry) => !blamed.branches.includes(entry));
      gate = null;
    }
    if (!gate?.ok) return finish('nothing', 'nothing passed tier 1');

    const late = refusedByStop(batch);
    if (late) return late;
    if (existsSync(paths.red) && !batch.every((entry) => entry.fix))
      return finish('held', `main went RED during the gate (${paths.red}); the batch stays READY`);
    const tip = must(git, 'rev-parse', 'HEAD');
    const strangers = lines(must(git, 'log', '--format=%ae %ce', `${base}..${tip}`)).filter(
      (line) => line !== `${EMAIL} ${EMAIL}`,
    );
    if (strangers.length)
      return finish(
        'refused',
        `${strangers.length} commit(s) do not carry ${EMAIL} as author and committer; nothing was pushed`,
      );
    const lost = lockLost();
    if (lost) return lost;

    const landing = {
      at: now().toISOString(),
      run: record.id,
      from: base,
      to: tip,
      branches: batch.map(({ branch, sha, fix, rebased }) => ({ branch, sha, landedAs: rebased, ...(fix && { fix }) })),
      commits: lines(must(git, 'log', '--format=%H %s', `${base}..${tip}`)),
      tier1: gate.steps.map(
        ({ step, ok, log: file, seconds, status, sourceHead, sourceFingerprint, commandDigest }) => ({
          step,
          ok,
          log: file ?? null,
          seconds: seconds ?? 0,
          ...(status && { status }),
          ...(sourceHead && { sourceHead }),
          ...(sourceFingerprint && { sourceFingerprint }),
          ...(commandDigest && { commandDigest }),
        }),
      ),
      ...(record.factoryProofReuse?.ok && { factoryProofReuse: record.factoryProofReuse }),
      ...((record.factoryProofReuse?.scope === 'build' || buildCheck === 'process') && {
        verificationScope: 'build',
        releaseGate: 'full-verification-and-combined-tree-pending',
        ...(buildCheck === 'process' && {
          processBuildCheck: { source: 'integrator', tip, commandDigest: PROCESS_BUILD_COMMAND_DIGEST },
        }),
        releaseDebt: [
          'Tier 0 full verify and affected GPU check',
          'Tier 1 relink, plan, build, API check, generated records, full verify, example types and package tests',
          'entry-sizes.json and basic-scene-network.json refresh',
          'Tier 2 uncached full GPU and browser check on the landed main tip',
        ],
      }),
      attempts: attempt,
      sentBack: sentBack.map(({ branch, step, reason, log: file }) => ({ branch, step, reason, log: file })),
      by: { user: by.user, host: by.host, pid: by.pid },
    };
    record.push = { tip, state: 'pushing', at: landing.at };
    record.landing = landing;
    record.state = 'pushing';
    record.entries = batch.map(({ branch, file, taken, sha, raw }) => ({ branch, file, taken, sha, raw }));
    save();
    const pushed = git(['push', 'origin', 'HEAD:refs/heads/main']);
    if (pushed.status !== 0) {
      record.push.state = 'rejected';
      record.push.stderr = lines(pushed.stderr).slice(-5);
      return finish(
        'moved',
        `the push was refused (${lines(pushed.stderr).at(-1) ?? 'no reason given'}); every entry stays READY for the next run`,
      );
    }
    record.push.state = 'pushed';
    return await concludeLanding(landing, batch);
  }

  /** The earlier runs that wrote "pushing" and never finished their record. */
  function pendingRuns() {
    if (!existsSync(paths.runs)) return [];
    return readdirSync(paths.runs)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => ({ file: join(paths.runs, name), earlier: readJson(join(paths.runs, name)) }))
      .filter(({ earlier }) => earlier?.state === 'pushing' && earlier.push?.tip && earlier.id !== record.id);
  }

  /**
   * What the run has pushed is on main: records it in landed.log, retires the entries, writes the notice, syncs the main
   * checkout and runs `notify`. The landed.log line comes first: the push is irreversible, so its record is the one thing
   * that must not be lost, and a line already there (a recovery) is not written twice.
   */
  async function concludeLanding(landing, entries) {
    const synced = mainGit ? syncMainCheckout(mainGit) : null;
    if (synced) log(`integrate: ${synced}`);
    const line = { ...landing, ...(synced && { mainCheckout: synced }) };
    if (!readLanded(paths.landed).some((entry) => entry.run === landing.run && entry.to === landing.to)) {
      try {
        appendFileSync(paths.landed, `${JSON.stringify(line)}\n`);
      } catch (error) {
        throw margoError(
          'INTEGRATE_RECORD_FAILED',
          `${paths.landed} could not be appended after the push of ${landing.to} (${error.message}); the run record ${record.file} says "pushing" and the next run finishes this landing's record`,
        );
      }
    }
    for (const entry of entries) {
      retire(entry, 'landed', `landed on main at ${landing.to}`);
      rmSync(join(paths.sentBack, `${entry.branch}.json`), { force: true });
    }
    try {
      writeJson(paths.latest, line);
    } catch (error) {
      log(`integrate: ${paths.latest} could not be written (${error.message}); the landing is in ${paths.landed}`);
    }
    record.push.state = 'landed';
    record.state = 'landed';
    save();
    if (notify) {
      try {
        await notify(line);
        record.notified = true;
      } catch (error) {
        record.notified = `failed: ${error.message}`;
        log(
          `integrate: the landing notice failed (${error.message}); the landing itself is recorded in ${paths.landed}`,
        );
      }
    }
    return finish('landed', `${landing.to} on main: ${landing.branches.map((entry) => entry.branch).join(', ')}`, {
      landed: landing.branches,
      tip: landing.to,
      ...(synced && { mainCheckout: synced }),
    });
  }

  /**
   * An earlier run wrote "pushing" and never finished its record. Its push either reached origin/main (the tip is an
   * ancestor of the base now: its landing is recorded now and its entries retired) or did not (the record says so and the
   * entries stay READY). Nothing lands twice: an entry already on main is retired at intake.
   */
  function recoverPushed(base) {
    for (const { file, earlier } of pendingRuns()) {
      const onMain = git(['merge-base', '--is-ancestor', earlier.push.tip, base]).status === 0;
      log(
        `integrate: run ${earlier.id} pushed ${earlier.push.tip} and never finished its record; the push ${onMain ? 'is' : 'is not'} on origin/main`,
      );
      (record.recovered ??= []).push({ run: earlier.id, tip: earlier.push.tip, onMain });
      if (onMain) {
        const entries = (earlier.entries ?? []).map((e) => ({ ...e }));
        const landing = { ...earlier.landing, run: earlier.id, to: earlier.push.tip };
        const synced = mainGit ? syncMainCheckout(mainGit) : null;
        const line = { ...landing, ...(synced && { mainCheckout: synced }), recoveredBy: record.id };
        if (!readLanded(paths.landed).some((entry) => entry.run === earlier.id && entry.to === earlier.push.tip))
          appendFileSync(paths.landed, `${JSON.stringify(line)}\n`);
        for (const entry of entries) {
          retire(entry, 'landed', `landed on main at ${earlier.push.tip} by run ${earlier.id}, recorded now`);
          rmSync(join(paths.sentBack, `${entry.branch}.json`), { force: true });
        }
        earlier.push.state = 'landed';
        earlier.state = 'landed';
        earlier.recoveredBy = record.id;
      } else {
        earlier.push.state = 'not on main';
        earlier.state = 'done';
        earlier.result = 'moved';
        earlier.exit = EXIT.moved;
        earlier.line = `the push of ${earlier.push.tip} never reached origin/main; every entry stayed READY (recorded by run ${record.id})`;
        earlier.recoveredBy = record.id;
      }
      writeJson(file, earlier);
    }
  }

  /** Record linear hand pushes; a rewritten origin/main needs explicit reconciliation before a new landing. */
  function accountForMain(base) {
    const last = readLanded(paths.landed)
      .filter((entry) => typeof entry.to === 'string')
      .at(-1);
    if (!last || last.to === base) return null;
    const linear = git(['merge-base', '--is-ancestor', last.to, base]).status === 0;
    if (!linear)
      return `origin/main ${base} does not descend from the last recorded landing ${last.to}; reconcile rewritten history before landing`;
    const line = {
      kind: 'hand-push',
      at: now().toISOString(),
      run: record.id,
      from: last.to,
      to: base,
      commits: lines(must(git, 'log', '--format=%H %s', `${last.to}..${base}`)),
    };
    record.handPush = line;
    log(
      `integrate: origin/main holds ${line.commits.length} commit(s) no landing recorded (${last.to.slice(0, 9)}..${base.slice(0, 9)}); written to ${paths.landed} as a hand push`,
    );
    appendFileSync(paths.landed, `${JSON.stringify(line)}\n`);
    return null;
  }

  /** Why a branch cannot enter the batch, or null: identity, messages, content, the fix gate. */
  function intakeProblem(entry) {
    const commits = lines(must(git, 'log', '--no-merges', '--format=%H %ae %ce', `${entry.from}..${entry.sha}`)).map(
      (line) => {
        const [sha, author, committer] = line.split(' ');
        return { sha, author, committer };
      },
    );
    for (const { sha, author, committer } of commits) {
      if (!noreply(author) || !noreply(committer))
        return `commit ${sha.slice(0, 9)}'s ${noreply(author) ? 'committer' : 'author'} is not the noreply address; rewrite it to ${EMAIL} before READY`;
    }
    const detailed = commits.map(({ sha }) => ({
      sha,
      message: must(git, 'log', '-1', '--format=%B', sha),
      files: lines(must(git, 'diff-tree', '--no-commit-id', '--name-only', '-r', '--no-renames', sha)),
      exists: (path) => git(['cat-file', '-e', `${entry.sha}:${path}`]).status === 0,
    }));
    for (const { sha, message } of detailed) {
      const problem = messageProblem(message);
      if (problem) return `commit ${sha.slice(0, 9)}'s message ${problem}`;
    }
    const content = contentProblem(must(git, 'diff', '--no-renames', '--unified=0', entry.from, entry.sha));
    if (content)
      return `an added line holds ${content.problem} ("${content.line.slice(0, 80)}"); nothing like that reaches main`;
    return fixWithoutTest(detailed)?.reason ?? null;
  }

  function refusedByStop(entries) {
    const hits = stoppedHits([...new Set(entries.flatMap((e) => e.paths))], readStopped(paths.control), workspaces);
    if (!hits.length) return null;
    const who = entries.filter((e) => hits.some((hit) => e.paths.includes(hit.file))).map((e) => e.branch);
    record.stopped = hits;
    return finish(
      'refused',
      `${[...new Set(hits.map((hit) => hit.tag))].join(', ')} stopped in ${paths.control}; ${who.join(', ')} touch ${hits[0].file}${hits.length > 1 ? ` and ${hits.length - 1} more` : ''}; nothing was pushed; take those READY entries out, or lift the stop`,
      { hits },
    );
  }

  /** The branches a failed gate names, and the reason each goes back. `{ branches, reason(entry) }`. */
  function blame(failed, batch) {
    let text = '';
    try {
      const size = statSync(failed.log).size,
        whole = readFileSync(failed.log, 'utf8');
      text = size > LOG_BYTES ? whole.slice(-LOG_BYTES) : whole;
    } catch {}
    if (failed.step === 'relink') {
      // A stale install in the main checkout fails every branch alike; only the one whose package.json adds the
      // dependency can cure it, so only that one goes back.
      const missing = missingFromLog(text),
        culprits = batch.filter((entry) => addedDependencies(git, entry).some((name) => missing.includes(name)));
      if (culprits.length)
        return {
          branches: culprits,
          reason: (entry) =>
            `its package.json adds ${addedDependencies(git, entry)
              .filter((name) => missing.includes(name))
              .join(
                ', ',
              )}, which the main checkout has not installed; run npm install in the main checkout, then write READY again`,
        };
    }
    const hung = failed.timedOut ? ` (it hung past ${stepMinutes} min and its process tree was killed)` : '';
    const found = suspects(text, batch, workspaces);
    if (found.branches.length)
      return {
        branches: found.branches,
        reason: () =>
          `${failed.step} failed on the batch tip${hung} and its output names ${found.branches.length === 1 ? 'this branch' : `these ${found.branches.length} branches`}`,
      };
    if (batch.length === 1)
      return {
        branches: batch,
        reason: () => `${failed.step} failed on the batch tip${hung} with this branch alone in it`,
      };
    return { branches: [], reason: () => '' };
  }
}

/** The unlanded names git and the queue know: every local branch but main, every READY file, once. */
function unlandedNames(git, batch) {
  const refs = git(['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
  const branches = refs.status === 0 ? lines(refs.stdout) : [];
  return [...new Set([...branches, ...batch.map((e) => e.branch)])].filter((name) => name !== 'main').sort();
}

/** Rebases the batch onto `base`, in order, in the worktree. A conflict sends that branch back and the rest go on. */
function assemble({ git, base, batch, sendBack }) {
  git(['rebase', '--abort']);
  must(git, 'checkout', '-q', '-f', '--detach', base);
  let tip = base;
  const kept = [];
  for (const entry of batch) {
    const result = git(['rebase', '-q', '--onto', tip, entry.from, entry.sha]);
    if (result.status === 0) {
      tip = must(git, 'rev-parse', 'HEAD');
      entry.rebased = tip;
      kept.push(entry);
      continue;
    }
    const files = lines(git(['diff', '--name-only', '--diff-filter=U']).stdout);
    git(['rebase', '--abort']);
    must(git, 'checkout', '-q', '-f', '--detach', tip);
    sendBack(
      entry,
      `conflict on the rebase onto main${files.length ? ` in ${files.join(', ')}` : ''}; rebase it onto origin/main and write READY again`,
      'rebase',
    );
  }
  return kept;
}

/**
 * Tier 1 on the worktree's HEAD, each step once, in this order: relink, check:merge's plan, build, api:check,
 * the records, verify, then the narrowed example types and package test. The build looks like a repeat of verify's and
 * stays: the records measure built packages, and verify must also prove its own build with the stale files planted.
 * The lock is checked before each step and every `lockPollMs` while one runs: lost, the step's tree is killed. Each step
 * goes into `steps` as it runs and `save()` keeps the record current. Returns `{ ok, step?, log?, timedOut?, lost?, steps }`.
 */
async function tierOne({
  git,
  runStep,
  logDir,
  attempt,
  stepMinutes,
  log,
  steps,
  save,
  holding,
  lockPollMs,
  factoryProofReuse = null,
  buildCheck = null,
}) {
  const limitMs = stepMinutes * 60_000;
  if (factoryProofReuse?.scope === 'build') {
    // Factory has a clean, successful, owner-selected focused proof at the exact READY commit. The disjoint-rebase
    // guard above proved that the reviewed files are byte-identical on this tip. Rerunning the broad landing gate
    // would repeat its build and run size benchmarks and a GPU browser through land-records on an unfinished package.
    steps.push({
      step: 'factory-build-proof',
      ok: null,
      log: null,
      seconds: 0,
      status: 'reused_factory_build_proof',
      sourceHead: factoryProofReuse.sourceHead,
      sourceFingerprint: factoryProofReuse.sourceFingerprint,
      commandDigest: factoryProofReuse.commandDigest,
    });
    for (const name of [
      'relink',
      'plan',
      'build',
      'api:check',
      'land-records',
      'verify',
      'check:examples-types',
      'modern:test:packages',
    ])
      steps.push({ step: name, ok: null, log: null, seconds: 0, status: 'deferred_owner_build_phase' });
    log(
      `integrate: focused Factory build proof at ${factoryProofReuse.sourceHead} accepted after a disjoint rebase; no Tier 1 command was rerun; generated size/network records and full release verification remain pending`,
    );
    save();
    return { ok: true, steps };
  }
  const step = async (name, command, env = {}) => {
    const why = holding();
    if (why) return { ok: false, lost: why, steps };
    const logFile = join(logDir, `${attempt}-${name.replace(/[^\w.-]+/g, '_')}.log`);
    const entry = { step: name, command, startedAt: new Date().toISOString(), ok: null, log: logFile };
    steps.push(entry);
    save();
    log(`integrate: attempt ${attempt}: ${command}`);
    const controller = new AbortController();
    let lost = null;
    const watch = setInterval(() => {
      lost ??= holding();
      if (lost) controller.abort();
    }, lockPollMs);
    const t0 = performance.now();
    let result;
    try {
      result = await runStep(command, { env, logFile, limitMs, signal: controller.signal });
    } finally {
      clearInterval(watch);
    }
    entry.ok = Boolean(result.ok);
    entry.seconds = result.seconds ?? Math.round((performance.now() - t0) / 100) / 10;
    entry.timedOut = Boolean(result.timedOut);
    if (lost) entry.aborted = lost;
    save();
    if (lost) return { ok: false, lost, step: name, log: logFile, steps };
    if (result.timedOut)
      log(`integrate: ${name} hung past ${stepMinutes} min; its process tree was killed (log ${logFile})`);
    return result.ok ? null : { ok: false, step: name, log: logFile, timedOut: entry.timedOut, steps };
  };
  if (buildCheck === 'process') {
    for (const [index, command] of PROCESS_BUILD_COMMANDS.entries()) {
      const failed = await step(['relink', 'lint', 'process-tests'][index], command);
      if (failed) return failed;
    }
    for (const name of [
      'plan',
      'build',
      'api:check',
      'land-records',
      'verify',
      'check:examples-types',
      'modern:test:packages',
    ])
      steps.push({ step: name, ok: null, log: null, seconds: 0, status: 'deferred_owner_build_phase' });
    log(
      `integrate: process bootstrap checked exact rebased tip with digest ${PROCESS_BUILD_COMMAND_DIGEST}; full release verification remains pending`,
    );
    save();
    return { ok: true, steps };
  }
  must(git, 'lfs', 'checkout');
  const failed =
    (await step('relink', 'node scripts/worktree-node-modules.mjs')) ??
    (await step('plan', 'node scripts/check-merge.mjs --plan --base=origin/main')) ??
    (await step('build', 'npm run build:packages')) ??
    // Before the records rewrite them, or a branch that changed exports without api:update would pass unseen.
    (await step('api:check', 'npm run api:check')) ??
    // One records commit, which also refreshes the llms files a README made stale; verify then reads all of it.
    (await step('land-records', 'node scripts/land-records.mjs --no-build')) ??
    // Factory already ran this exact committed branch; a reusable proof is recorded, never called a new pass.
    (factoryProofReuse ? null : await step('verify', 'npm run verify', { MARGOENGINE_PLANT_STALE: '1' }));
  if (failed) return failed;
  if (factoryProofReuse) {
    steps.push({
      step: 'verify',
      ok: null,
      log: null,
      seconds: 0,
      status: 'reused_factory_proof',
      sourceHead: factoryProofReuse.sourceHead,
      sourceFingerprint: factoryProofReuse.sourceFingerprint,
    });
    log(
      `integrate: verify reused Factory proof at ${factoryProofReuse.sourceHead}; the rebased combined tip was not retested`,
    );
    save();
  }
  const planLog = steps.find((entry) => entry.step === 'plan').log,
    plan = parsePlan(readFileSync(planLog, 'utf8'));
  for (const [name, env] of [
    ['check:examples-types', {}],
    ['modern:test:packages', { MARGOENGINE_PACKAGE_TEST_PREBUILT: '1' }],
  ]) {
    // A step the plan skips says so. One it does not mention is a plan this script cannot read, never a pass.
    if (!(name in plan)) {
      log(`integrate: the plan in ${planLog} does not mention ${name}; a step is never skipped by silence`);
      return { ok: false, step: 'plan', log: planLog, steps };
    }
    if (!plan[name]) continue;
    if (factoryProofReuse) {
      steps.push({
        step: name,
        ok: null,
        log: null,
        seconds: 0,
        status: 'deferred_owner_build_phase',
      });
      log(`integrate: ${name} deferred by owner for the build phase; Factory did not run this check`);
      save();
      continue;
    }
    const bad = await step(name, plan[name], env);
    if (bad) return bad;
  }
  // The checks rewrite the size records; the committed ones are what lands, and the next attempt wants a clean tree.
  git(['checkout', '--', 'examples/package-benchmarks/results']);
  return { ok: true, steps };
}

/** Makes or validates the detached integration worktree without discarding another checkout's files. */
export function ensureWorktree(path, cwd = root) {
  const command = (at, args) =>
    spawnSync('git', ['-C', at, ...args], { encoding: 'utf8', timeout: 30_000, maxBuffer: 1 << 20 });
  if (!existsSync(join(path, '.git'))) {
    const made = spawnSync('git', ['worktree', 'add', '-q', '--detach', path, 'origin/main'], {
      cwd,
      encoding: 'utf8',
      timeout: 30_000,
    });
    if (made.status !== 0)
      throw margoError(
        'INTEGRATE_GIT_FAILED',
        `git worktree add ${path} failed (${lines(made.stderr).at(-1)}); pass another --worktree=<path>`,
      );
  }
  const top = command(path, ['rev-parse', '--show-toplevel']),
    common = command(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
    expected = command(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const sameLocation = (left, right) => {
    const a = statSync(left, { bigint: true }),
      b = statSync(right, { bigint: true });
    if (a.dev === b.dev && a.ino !== 0n && a.ino === b.ino) return true;
    return (
      realpathSync(left).replaceAll('\\', '/').toLowerCase() === realpathSync(right).replaceAll('\\', '/').toLowerCase()
    );
  };
  if (
    top.status !== 0 ||
    common.status !== 0 ||
    expected.status !== 0 ||
    !sameLocation(String(top.stdout).trim(), path) ||
    !sameLocation(String(common.stdout).trim(), String(expected.stdout).trim())
  )
    throw margoError(
      'INTEGRATE_WORKTREE_INVALID',
      `${path} is not a linked worktree of this Margo checkout; choose another --worktree path`,
    );
  const branch = command(path, ['symbolic-ref', '-q', '--short', 'HEAD']);
  if (branch.status === 0)
    throw margoError(
      'INTEGRATE_WORKTREE_INVALID',
      `${path} has branch ${String(branch.stdout).trim()} checked out; use a detached worktree`,
    );
  const status = command(path, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (status.status !== 0 || String(status.stdout).trim())
    throw margoError(
      'INTEGRATE_WORKTREE_DIRTY',
      `${path} has tracked or untracked changes; preserve or clean them before integration (nothing was reset)`,
    );
}

/** Remove only a clean worktree whose fresh path this integrator generated beside the main checkout. */
export function removeManagedWorktree(path, home) {
  const prefix = `${home}-wt-integrator-`;
  if (!path.startsWith(prefix) || !/^[a-f0-9-]{36}$/i.test(path.slice(prefix.length)))
    throw margoError('INTEGRATE_WORKTREE_INVALID', `${path} is not a managed integrator worktree`);
  if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink())
    throw margoError('INTEGRATE_WORKTREE_INVALID', `managed worktree ${path} changed its path`);
  ensureWorktree(path, home);
  const removed = spawnSync('git', ['worktree', 'remove', '--force', path], {
    cwd: home,
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (removed.status !== 0)
    throw margoError(
      'INTEGRATE_GIT_FAILED',
      `managed worktree ${path} could not be removed (${lines(removed.stderr).at(-1)})`,
    );
}

/** The `git` for integrate(): runs in `cwd`, with the noreply identity and a 15 minute limit. */
export function gitIn(cwd, env = process.env) {
  return (args) =>
    spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 1 << 28,
      timeout: 15 * 60_000,
      env: { ...env, ...IDENTITY },
    });
}

/** The `runStep` for integrate(): the whole tree of a step is killed past its limit or when `signal` aborts (run-limited.mjs). */
export function stepIn(cwd, base = process.env) {
  return (command, { env, logFile, limitMs, signal }) =>
    runLimited(command, { cwd, env: stepEnv(base, env), limitMs, label: command, logFile, signal });
}

/**
 * Whether this process still runs under the landing lock entry it started under: `lockDir` is the lock folder (the parent
 * of MARGO_GPU_LOCK_NESTED under gpu-lock.mjs `run`). Returns a `holding()` for integrate(): null while the entry still
 * holds the token read at the start, else why not. A second integrator that took the lock over writes its own token.
 */
export function lockWatch(lockDir) {
  const file = join(lockDir, 'exclusive.json'),
    token = readJson(file)?.token ?? null;
  if (!token) return () => `no landing lock entry in ${lockDir}: this run is not under the lock`;
  return () => {
    const entry = readJson(file);
    if (!entry) return `the landing lock entry ${file} is gone (the lock wrapper died or the entry was reclaimed)`;
    if (entry.token !== token)
      return `another integrator holds the landing lock now (${entry.owner ?? 'unknown'}, pid ${entry.pid ?? '?'}, since ${entry.takenAt ?? '?'})`;
    return null;
  };
}

/** A flag's value from the arguments, or `fallback`. */
export const flag = (args, name, fallback) =>
  args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;

/** Factory pins a landing to one flat branch and its full READY commit. */
export function parseOnly(value) {
  if (value == null) return null;
  const match = /^([A-Za-z0-9][A-Za-z0-9._-]{0,119})@([a-f0-9]{40})$/i.exec(value);
  if (!match) throw margoError('INTEGRATE_TARGET_INVALID', '--only requires <flat-branch>@<full-40-character-sha>');
  return { branch: match[1], sha: match[2].toLowerCase() };
}

/** Parse mutually exclusive Factory proof modes before taking the landing lock. */
export function parseFactoryProofFlags({ full = null, build = null, only = null } = {}) {
  if (full !== null && build !== null)
    throw margoError('INTEGRATE_FACTORY_PROOF_INVALID', 'Factory full and build proofs are mutually exclusive');
  if (full === null && build === null) return null;
  const match = full !== null ? FACTORY_PROOF.exec(full) : FACTORY_BUILD_PROOF.exec(build);
  if (!match)
    throw margoError(
      'INTEGRATE_FACTORY_PROOF_INVALID',
      full !== null
        ? 'Factory full proof must be <full40sha>:<sha256-fingerprint>'
        : 'Factory build proof must be <full40sha>:<sha256-fingerprint>:<sha256-command-digest>',
    );
  const proof = {
    scope: build !== null ? 'build' : 'release',
    head: match[1].toLowerCase(),
    fingerprint: match[2].toLowerCase(),
    ...(build !== null && { commandDigest: match[3].toLowerCase() }),
  };
  if (!only || only.sha !== proof.head)
    throw margoError('INTEGRATE_FACTORY_PROOF_INVALID', 'Factory proof must name the exact --only READY commit');
  return proof;
}

export const USAGE = `usage: node scripts/integrate.mjs [options]

Lands one batch of the READY branches in private/queue/ to main: intake, rebase, tier 1 once, records, one push, never
forced. Only this script pushes to main. An agent queues a branch with a file private/queue/<branch>.ready holding
"READY <sha>", or "READY <sha> fix" for the fix of a RED main. Takes test-results/land.lock; exactly one run at a time.
Non-interactive: nothing is read from stdin, every answer is in the run record and on stdout.

Options:
  --worktree=<path>          use this detached worktree; without it, a fresh managed worktree is made for each run
  --only=<branch>@<sha>      land only this exact READY branch and full 40-character commit
  --reuse-factory-proof=<sha>:<fingerprint>
                             reuse successful clean Factory verification for the exact --only commit
                             only when reviewed paths survive a disjoint rebase; records skipped tests
                             honestly and leaves combined-tip/release verification pending
  --reuse-factory-build-proof=<sha>:<fingerprint>:<command-digest>
                             reuse an owner-selected clean focused build proof for the exact --only commit
                             only after the same disjoint-rebase guard; no Tier 1 check or benchmark is rerun
                             full verification and generated size/network records remain release debt
  --build-check=process        one-time exact-tip process bootstrap for an integrator-only READY commit;
                             runs relink, lint and integrator unit tests under the landing lock
  --limit=<min>              hard limit of the whole run, tree killed past it (default ${DEFAULT_LIMIT_MINUTES})
  --wait-max=<min>           how long to wait for another integrator (default 5)
  --notify=<command>         run after a landing with the landing's JSON file as its one argument (2 min limit)
  -h, --help                 print this help and exit

Exit codes: 0 landed, nothing queued, or held by RED; 4 refused by a stop order or an identity; 5 main moved under the
push; 6 nothing could land; 7 the landing lock was lost; 8 the run record could not be written; 124 past the limit.

Output: lines "integrate: <what>"; "integrate: RECORD: <file>" names the run record; the last line is
"integrate: <LANDED|IDLE|HELD|REFUSED|MOVED|NOTHING|LOST|RECORD>: <why>".
Files: private/queue/runs/<stamp>.json (one per run: who, queue, intake, every step with its log and seconds, the push),
private/queue/landed.log (one JSON line per landing or hand push), private/queue/latest-landing.json (the last landing),
private/queue/queue.log (every READY file removed, with its reason), private/queue/sent-back/<branch>.json.

Example:
  node scripts/integrate.mjs --limit=120 --notify="node scripts/my-watcher.mjs"`;

async function main() {
  const args = process.argv.slice(2),
    home = mainCheckout(root),
    worktree = resolve(flag(args, 'worktree', `${home}-wt-integrator-${randomUUID()}`)),
    only = parseOnly(flag(args, 'only', null)),
    factoryProof = parseFactoryProofFlags({
      full: flag(args, 'reuse-factory-proof', null),
      build: flag(args, 'reuse-factory-build-proof', null),
      only,
    }),
    buildCheck = flag(args, 'build-check', null),
    notifyCommand = flag(args, 'notify', null),
    managed = args.includes('--managed-worktree') || !args.some((arg) => arg.startsWith('--worktree='));
  if (buildCheck !== null && buildCheck !== 'process')
    throw margoError('INTEGRATE_BUILD_CHECK_INVALID', '--build-check accepts only process');
  if (buildCheck && (factoryProof || !only))
    throw margoError('INTEGRATE_BUILD_CHECK_INVALID', '--build-check=process requires --only and no Factory proof');
  if (!args.includes('--locked')) {
    // Under the landing lock, as every landing was: gpu-lock.mjs gives it the heartbeat, the limit and the tree kill, and
    // points the GPU work inside at the GPU lock.
    const held = spawnSync(
      process.execPath,
      [
        join(root, 'scripts', 'gpu-lock.mjs'),
        'run',
        `--max=${flag(args, 'limit', DEFAULT_LIMIT_MINUTES)}`,
        `--wait-max=${flag(args, 'wait-max', 5)}`,
        '--owner=integrator',
        '--',
        'node',
        'scripts/integrate.mjs',
        '--locked',
        `--worktree=${worktree}`,
        ...(managed ? ['--managed-worktree'] : []),
        ...(only ? [`--only=${only.branch}@${only.sha}`] : []),
        ...(factoryProof
          ? [
              factoryProof.scope === 'build'
                ? `--reuse-factory-build-proof=${factoryProof.head}:${factoryProof.fingerprint}:${factoryProof.commandDigest}`
                : `--reuse-factory-proof=${factoryProof.head}:${factoryProof.fingerprint}`,
            ]
          : []),
        ...(buildCheck ? [`--build-check=${buildCheck}`] : []),
        ...(notifyCommand ? [`--notify=${notifyCommand}`] : []),
      ],
      { cwd: root, stdio: 'inherit', env: { ...process.env, MARGO_GPU_LOCK: join(home, 'test-results', 'land.lock') } },
    );
    process.exitCode = held.status ?? 1;
    return;
  }
  ensureWorktree(worktree);
  const nested = process.env.MARGO_GPU_LOCK_NESTED,
    holding = nested
      ? lockWatch(dirname(nested))
      : () => 'MARGO_GPU_LOCK_NESTED is not set: this run is not under the landing lock';
  const paths = queuePaths(home);
  const notify = notifyCommand
    ? async (landing) => {
        const logFile = join(paths.logs, `${landing.run}-notify.log`);
        const ran = await runLimited(`${notifyCommand} "${paths.latest}"`, {
          cwd: home,
          env: stepEnv(process.env),
          limitMs: 2 * 60_000,
          label: notifyCommand,
          logFile,
        });
        console.log(`integrate: notify ${ran.ok ? 'ran' : `failed (log ${logFile})`}: ${notifyCommand}`);
      }
    : null;
  const out = await integrate({
    git: gitIn(worktree),
    mainGit: gitIn(home),
    runStep: stepIn(worktree),
    paths,
    workspaces: loadWorkspaces(root),
    holding,
    only,
    factoryProof,
    buildCheck,
    notify,
  });
  if (managed) {
    try {
      removeManagedWorktree(worktree, home);
    } catch (error) {
      console.log(`integrate: managed worktree ${worktree} was preserved (${error.message})`);
    }
  }
  process.exitCode = out.exit;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  exitOnHelp(USAGE);
  try {
    await main();
  } catch (error) {
    console.error(`integrate: ${error.message}`);
    process.exitCode = 1;
  }
}
