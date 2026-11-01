// The one script that pushes to main (AGENTS.md; private/handoffs/forward-plan-2026-10-31.md, sections 1 to 3). One run
// lands one batch, then exits; the coordinator or a runner starts it every 30 min or at 3 READY entries.
//   node scripts/integrate.mjs [--worktree=<path>] [--limit=<min>] [--wait-max=<min>]
// An agent declares a branch ready with a file private/queue/<branch>.ready in the main checkout, holding one line:
//   READY <sha>        or        READY <sha> fix
// A run, under test-results/land.lock (gpu-lock.mjs: heartbeat, hard limit, whole tree killed past it):
// 1. Reads the entries, fix entries first. While private/queue/RED.json exists only fix entries are taken.
// 2. Refuses the whole batch, pushing nothing, when it touches a class stopped in private/control.json
//    ({ "stopped": ["demos"] }: "demos" is demoPath below, any other tag a file class of file-classes.mjs). A control
//    file it cannot read, or a tag it does not know, also refuses: a stop order is never skipped over a typo.
// 3. Rebases each branch onto origin/main in order, in its own detached worktree. A conflict sends that branch back and
//    the rest go on.
// 4. Tier 1, once on the batch tip, no GPU suite: build, api:check (on the reports the branches committed), then
//    land-records --no-build (its short basic-scene browser takes a GPU slot itself), then verify on those records, then
//    check:examples-types and modern:test:packages narrowed by check:merge's own plan. Records come before verify
//    because verify reads them: a new package has no entry-sizes row until they are measured, and a generated file both
//    sides changed keeps main's copy on the rebase.
// 5. A failure names one branch (the failing output names a package or file of it), which goes back with the log, and
//    tier 1 runs again on the rest. When the output cannot name one, the last candidate steps out: if that cures it, it
//    was the one and goes back; if not, it stays READY for the next batch and the next candidate steps out.
// 6. Checks RED.json and control.json once more, checks every commit's identity, pushes once, never forced, and appends
//    the batch's commits and logs to private/queue/landed.log. If main moved meanwhile, the push is refused and every
//    entry stays READY for the next run.
// A branch sent back is private/queue/sent-back/<branch>.json: the reason, the step and the log. Its .ready file is gone.
// Everything git and every command go through `git` and `runStep`, so tests/integrate.test.js runs it all with neither.
// Exit: 0 landed, nothing queued or held by RED; 4 refused; 5 main moved; 6 nothing could land; 124 past the hard limit.
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { margoError } from '../packages/shared/errors.js';
import { mainCheckout } from './gpu-lock.mjs';
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
const TAIL_LINES = 80;

/** Where the queue's files live under a main checkout. */
export function queuePaths(main) {
  const dir = join(main, 'private', 'queue');
  return {
    dir,
    red: join(dir, 'RED.json'),
    landed: join(dir, 'landed.log'),
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
        parsed = parseReady(readFileSync(file, 'utf8'));
      return {
        branch: name.slice(0, -6),
        file,
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
 * Which branches a failure can be pinned on, from the end of its log. A branch is `direct` when the log names a file it
 * changed or a package it changed, else `dependent` when a named package depends on one it changed. Returns the first
 * group with anyone in it, or the whole batch (`named: false`) when the log names none of them.
 */
export function suspects(tail, batch, workspaces = []) {
  const named = new Set();
  for (const match of tail.matchAll(/@margoengine\/([a-z0-9-]+)/g)) named.add(`@margoengine/${match[1]}`);
  for (const match of tail.matchAll(/\b(packages|examples|apps)[\\/]([a-z0-9-]+)\b/g)) {
    const owner = workspaces.find((w) => w.dir === `${match[1]}/${match[2]}`);
    if (owner) named.add(owner.name);
  }
  const text = tail.replaceAll('\\', '/'),
    changed = (branch) => [...new Set(branch.paths.map((file) => workspaceOf(workspaces, file)?.name).filter(Boolean))];
  const direct = batch.filter(
    (branch) => branch.paths.some((file) => text.includes(file)) || changed(branch).some((name) => named.has(name)),
  );
  if (direct.length) return { branches: direct, named: true };
  const dependent = batch.filter((branch) =>
    [...dependents(workspaces, changed(branch))].some((name) => named.has(name)),
  );
  return dependent.length ? { branches: dependent, named: true } : { branches: batch, named: false };
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

/**
 * Removes an entry's READY file only if it still holds the sha this run took. A helper may have written a newer READY
 * while the run was going; that one stays for the next run.
 */
function dropReady(entry) {
  if (entry.taken) {
    let now = null;
    try {
      now = parseReady(readFileSync(entry.file, 'utf8'));
    } catch {
      return;
    }
    if (now && now.sha !== entry.taken) return;
  }
  rmSync(entry.file, { force: true });
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
 * Lands one batch. `git(args)` resolves to `{ status, stdout, stderr }`, `runStep(command, { env, logFile, limitMs })` to
 * `{ ok, timedOut? }` and writes its output to logFile. `paths` is queuePaths(); `now()` a Date. Returns `{ result, exit,
 * line, landed?, sentBack? }`; result is idle, held, refused, moved, nothing or landed.
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
}) {
  const stamp = now().toISOString().replace(/[:.]/g, '-'),
    sentBack = [],
    logDir = join(paths.logs, stamp);
  const sendBack = (entry, reason, step = 'intake', logFile = null) => {
    mkdirSync(paths.sentBack, { recursive: true });
    writeFileSync(
      join(paths.sentBack, `${entry.branch}.json`),
      `${JSON.stringify({ branch: entry.branch, sha: entry.sha ?? null, at: now().toISOString(), step, reason, log: logFile }, null, 2)}\n`,
    );
    dropReady(entry);
    sentBack.push({ branch: entry.branch, step, reason, log: logFile });
    log(`integrate: ${entry.branch} goes back: ${reason}${logFile ? ` (log ${logFile})` : ''}`);
  };
  const report = (result, exit, line, extra = {}) => {
    log(`integrate: ${result.toUpperCase()}: ${line}`);
    return { result, exit, line, sentBack, ...extra };
  };

  let batch = readQueue(paths.dir);
  for (const entry of batch.filter((e) => e.invalid))
    sendBack(entry, `the file does not read "READY <sha>" or "READY <sha> fix"; write it again`);
  batch = batch.filter((entry) => !entry.invalid);
  if (!batch.length && !sentBack.length) return report('idle', 0, 'nothing is READY');
  const red = existsSync(paths.red);
  if (red) batch = batch.filter((entry) => entry.fix);
  if (!batch.length)
    return report(
      red ? 'held' : 'nothing',
      red ? 0 : 6,
      red ? `main is RED (${paths.red}) and no READY entry is marked fix` : 'every entry went back',
    );

  must(git, 'fetch', '-q', 'origin');
  const base = must(git, 'rev-parse', 'origin/main');
  const known = [];
  for (const entry of batch) {
    const resolved = git(['rev-parse', '--verify', '-q', `${entry.sha}^{commit}`]);
    if (resolved.status !== 0) {
      sendBack(entry, `no commit ${entry.sha} in this clone; commit it, then write READY again`);
      continue;
    }
    entry.sha = String(resolved.stdout).trim();
    if (git(['merge-base', '--is-ancestor', entry.sha, base]).status === 0) {
      log(`integrate: ${entry.branch} is already on main; its READY entry is removed`);
      dropReady(entry);
      continue;
    }
    entry.from = must(git, 'merge-base', entry.sha, base);
    const authors = lines(must(git, 'log', '--format=%ae', `${entry.from}..${entry.sha}`)).filter((e) => !noreply(e));
    if (authors.length) {
      sendBack(entry, `a commit's author is not the noreply address; rewrite it to ${EMAIL} before READY`);
      continue;
    }
    const commits = lines(must(git, 'log', '--no-merges', '--format=%H', `${entry.from}..${entry.sha}`)).map((sha) => ({
      sha,
      message: must(git, 'log', '-1', '--format=%B', sha),
      files: lines(must(git, 'diff-tree', '--no-commit-id', '--name-only', '-r', '--no-renames', sha)),
      exists: (path) => git(['cat-file', '-e', `${entry.sha}:${path}`]).status === 0,
    }));
    const untested = fixWithoutTest(commits);
    if (untested) {
      sendBack(entry, untested.reason);
      continue;
    }
    entry.paths = lines(must(git, 'diff', '--name-only', '--no-renames', entry.from, entry.sha));
    known.push(entry);
  }
  batch = known;
  if (!batch.length)
    return report(sentBack.length ? 'nothing' : 'idle', sentBack.length ? 6 : 0, 'no branch left to land');

  // Before anything is rebased or built, and again before the push: a stop order may come while the gate runs.
  const refused = (entries) => {
    const hits = stoppedHits([...new Set(entries.flatMap((e) => e.paths))], readStopped(paths.control), workspaces);
    if (!hits.length) return null;
    const who = entries.filter((e) => hits.some((hit) => e.paths.includes(hit.file))).map((e) => e.branch);
    return report(
      'refused',
      4,
      `${[...new Set(hits.map((hit) => hit.tag))].join(', ')} stopped in ${paths.control}; ${who.join(', ')} touch ${hits[0].file}${hits.length > 1 ? ` and ${hits.length - 1} more` : ''}; nothing was pushed; take those READY entries out, or lift the stop`,
      { hits },
    );
  };
  const stop = refused(batch);
  if (stop) return stop;

  const held = [];
  let suspect = null,
    attempt = 0,
    gate;
  mkdirSync(logDir, { recursive: true });
  while (batch.length) {
    attempt++;
    const rebased = assemble({ git, base, batch, sendBack });
    batch = rebased.batch;
    if (!batch.length) break;
    gate = await tierOne({ git, runStep, logDir, attempt, stepMinutes, log });
    if (gate.ok) {
      if (suspect) sendBack(suspect.entry, `tier 1 passed once it left: ${suspect.why}`, suspect.step, suspect.log);
      suspect = null;
      break;
    }
    if (suspect) {
      log(`integrate: ${suspect.entry.branch} was not the cause; it stays READY for the next batch`);
      held.push(suspect.entry);
      suspect = null;
    }
    const tail = lines(readFileSync(gate.log, 'utf8')).slice(-TAIL_LINES).join('\n');
    if (gate.step === 'relink') {
      // A stale install in the main checkout fails every branch alike; only the one whose package.json adds the
      // dependency can cure it, so only that one goes back, at once.
      const missing = missingFromLog(tail),
        culprits = batch.filter((entry) => addedDependencies(git, entry).some((name) => missing.includes(name)));
      if (culprits.length) {
        for (const entry of culprits) {
          const added = addedDependencies(git, entry).filter((name) => missing.includes(name));
          sendBack(
            entry,
            `its package.json adds ${added.join(', ')}, which the main checkout has not installed; run npm install in the main checkout, then write READY again`,
            'relink',
            gate.log,
          );
        }
        batch = batch.filter((entry) => !culprits.includes(entry));
        gate = null;
        continue;
      }
    }
    const found = suspects(tail, batch, workspaces),
      why = `${gate.step} failed on the batch tip`;
    if (found.branches.length === 1) {
      sendBack(found.branches[0], why, gate.step, gate.log);
      batch = batch.filter((entry) => entry !== found.branches[0]);
    } else {
      const entry = found.branches.at(-1);
      log(
        `integrate: ${why}; the output names ${found.named ? 'several branches' : 'none'}; ${entry.branch} steps out`,
      );
      suspect = { entry, why, step: gate.step, log: gate.log };
      batch = batch.filter((other) => other !== entry);
    }
    gate = null;
  }
  // The last one in a batch that never passed: it failed alone, so a remaining suspect stays READY with the others.
  if (suspect) held.push(suspect.entry);
  if (!gate?.ok)
    return report(
      'nothing',
      6,
      `nothing passed tier 1${held.length ? `; still READY: ${held.map((e) => e.branch).join(', ')}` : ''}`,
    );

  const late = refused(batch);
  if (late) return late;
  if (existsSync(paths.red) && !batch.every((entry) => entry.fix))
    return report('held', 0, `main went RED during the gate (${paths.red}); the batch stays READY`);
  const tip = must(git, 'rev-parse', 'HEAD');
  const strangers = lines(must(git, 'log', '--format=%ae %ce', `${base}..${tip}`)).filter(
    (line) => line !== `${EMAIL} ${EMAIL}`,
  );
  if (strangers.length)
    return report(
      'refused',
      4,
      `${strangers.length} commit(s) do not carry ${EMAIL} as author and committer; nothing was pushed`,
    );
  const pushed = git(['push', 'origin', 'HEAD:refs/heads/main']);
  if (pushed.status !== 0)
    return report(
      'moved',
      5,
      `the push was refused (${lines(pushed.stderr).at(-1) ?? 'no reason given'}); every entry stays READY for the next run`,
    );
  const synced = mainGit ? syncMainCheckout(mainGit) : null;
  if (synced) log(`integrate: ${synced}`);
  const landed = batch.map(({ branch, sha, fix }) => ({ branch, sha, ...(fix && { fix }) }));
  appendFileSync(
    paths.landed,
    `${JSON.stringify({
      at: now().toISOString(),
      from: base,
      to: tip,
      branches: landed,
      commits: lines(must(git, 'log', '--format=%H %s', `${base}..${tip}`)),
      tier1: gate.logs,
      sentBack: sentBack.map((entry) => entry.branch),
      stillReady: held.map((entry) => entry.branch),
      ...(synced && { mainCheckout: synced }),
    })}\n`,
  );
  for (const entry of batch) dropReady(entry);
  return report('landed', 0, `${tip} on main: ${landed.map((entry) => entry.branch).join(', ')}`, {
    landed,
    tip,
    ...(synced && { mainCheckout: synced }),
  });
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
  return { batch: kept, tip };
}

/**
 * Tier 1 on the worktree's HEAD, each step once: relink, check:merge's plan, build, api:check, the records, verify,
 * the narrowed example types and package test. The build looks like a repeat of verify's and stays: the records measure
 * built packages, and verify must also prove its own build with the stale files planted. Returns `{ ok, step?, log?, logs }`.
 */
async function tierOne({ git, runStep, logDir, attempt, stepMinutes, log }) {
  const logs = [],
    limitMs = stepMinutes * 60_000;
  const step = async (name, command, env = {}) => {
    const logFile = join(logDir, `${attempt}-${name.replace(/[^\w.-]+/g, '_')}.log`);
    log(`integrate: attempt ${attempt}: ${command}`);
    const result = await runStep(command, { env, logFile, limitMs });
    logs.push({ step: name, ok: result.ok, log: logFile });
    return result.ok ? null : { ok: false, step: name, log: logFile, logs };
  };
  must(git, 'lfs', 'checkout');
  const failed =
    (await step('relink', 'node scripts/worktree-node-modules.mjs')) ??
    (await step('plan', 'node scripts/check-merge.mjs --plan --base=origin/main')) ??
    (await step('build', 'npm run build:packages')) ??
    // Before the records rewrite them, or a branch that changed exports without api:update would pass unseen.
    (await step('api:check', 'npm run api:check')) ??
    // One records commit, which also refreshes the llms files a README made stale; verify then reads all of it.
    (await step('land-records', 'node scripts/land-records.mjs --no-build')) ??
    // The stale files check:merge plants before verify's build, which the package test then proves no pack contains.
    (await step('verify', 'npm run verify', { MARGOENGINE_PLANT_STALE: '1' }));
  if (failed) return failed;
  const plan = parsePlan(readFileSync(logs.find((entry) => entry.step === 'plan').log, 'utf8'));
  for (const [name, env] of [
    ['check:examples-types', {}],
    ['modern:test:packages', { MARGOENGINE_PACKAGE_TEST_PREBUILT: '1' }],
  ]) {
    if (!plan[name]) continue;
    const bad = await step(name, plan[name], env);
    if (bad) return bad;
  }
  // The checks rewrite the size records; the committed ones are what lands, and the next attempt wants a clean tree.
  git(['checkout', '--', 'examples/package-benchmarks/results']);
  return { ok: true, logs };
}

/** Makes a detached worktree at `path` from origin/main when it does not exist yet. */
export function ensureWorktree(path, cwd = root) {
  if (existsSync(join(path, '.git'))) return;
  const made = spawnSync('git', ['worktree', 'add', '-q', '--detach', path, 'origin/main'], { cwd, encoding: 'utf8' });
  if (made.status !== 0)
    throw margoError(
      'INTEGRATE_GIT_FAILED',
      `git worktree add ${path} failed (${lines(made.stderr).at(-1)}); pass another --worktree=<path>`,
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

/** The `runStep` for integrate(): the whole tree of a step is killed past its limit (run-limited.mjs). */
export function stepIn(cwd, base = process.env) {
  return (command, { env, logFile, limitMs }) =>
    runLimited(command, { cwd, env: { ...base, ...env, ...IDENTITY }, limitMs, label: command, logFile });
}

/** A flag's value from the arguments, or `fallback`. */
export const flag = (args, name, fallback) =>
  args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;

export const USAGE = `usage: node scripts/integrate.mjs [options]

Lands one batch of the READY branches in private/queue/ to main: rebase, tier 1 once, records, one push, never forced.
Only this script pushes to main. An agent queues a branch with a file private/queue/<branch>.ready holding
"READY <sha>", or "READY <sha> fix" for the fix of a RED main. Takes test-results/land.lock.

Options:
  --worktree=<path>          its detached worktree (default <main checkout>-wt-integrator, made when missing)
  --limit=<min>              hard limit of the whole run, tree killed past it (default ${DEFAULT_LIMIT_MINUTES})
  --wait-max=<min>           how long to wait for another integrator (default 5)
  -h, --help                 print this help and exit

Exit codes: 0 landed, nothing queued, or held by RED; 4 refused by a stop order; 5 main moved; 6 nothing could land;
124 past the limit.

Example:
  node scripts/integrate.mjs --limit=120`;

async function main() {
  const args = process.argv.slice(2),
    home = mainCheckout(root),
    worktree = resolve(flag(args, 'worktree', `${home}-wt-integrator`));
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
      ],
      { cwd: root, stdio: 'inherit', env: { ...process.env, MARGO_GPU_LOCK: join(home, 'test-results', 'land.lock') } },
    );
    process.exitCode = held.status ?? 1;
    return;
  }
  ensureWorktree(worktree);
  const { exit } = await integrate({
    git: gitIn(worktree),
    mainGit: gitIn(home),
    runStep: stepIn(worktree),
    paths: queuePaths(home),
    workspaces: loadWorkspaces(root),
  });
  process.exitCode = exit;
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
