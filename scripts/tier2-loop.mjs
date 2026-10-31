// Tier 2 (private/handoffs/forward-plan-2026-10-31.md, section 2): the full GPU check, after the push, on the newest main.
//   node scripts/tier2-loop.mjs [--once] [--limit=<min>] [--poll=<s>] [--worktree=<path>]
//   node scripts/tier2-loop.mjs suspects                  the commits of RED.json's range that reach the failed suite
//   node scripts/tier2-loop.mjs rerun [--candidate=<sha>] [--limit=<min>] [--worktree=<path>]
// The loop looks at origin/main and, when it moved past the last commit checked, runs check:merge:full with
// MARGO_CHECK_PARALLEL=1 in its own detached worktree, under test-results/tier2.lock so two loops never share it. Otherwise
// it idles. One commit is checked once: a failure is never rerun until main moves.
//   pass     local tag green/<sha>, which it pushes (the one push it does), and RED.json is removed
//   fail     private/queue/RED.json: every failed step and suite (the check runs with MARGO_CHECK_KEEP_GOING=1), the range since the last green tag, and when RED began
//   past the limit   the whole tree is killed and that counts as a failure, step "time limit"
//   heat stop        nothing failed, the run is incomplete: no record, and the same commit runs again
// `suspects` uses affected-gpu's footprints to pick the commits in the range that can reach the failed suite. `rerun` runs
// that one suite at a candidate (default the newest suspect) and at its parent in a second worktree of its own, and says
// which is to blame: failing here and passing at the parent makes the candidate the culprit.
// Everything git and every command go through `git` and `run`, so tests/tier2-loop.test.js runs it with neither.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { margoError } from '../packages/shared/errors.js';
import { GPU_STEPS, planContext, planSteps } from './check-merge.mjs';
import { mainCheckout } from './gpu-lock.mjs';
import { ensureWorktree, flag, gitIn, queuePaths, stepIn } from './integrate.mjs';
import { analyse } from './support/affected-gpu.mjs';
import { exitOnHelp } from './support/help.mjs';

const root = resolve(import.meta.dirname, '..');
/** The hard limit of one full check, in minutes (36 to 61 measured, serial). */
export const DEFAULT_LIMIT_MINUTES = 180;
/** The hard limit of one suite rerun, for each of the prepare and suite commands. */
export const DEFAULT_RERUN_MINUTES = 60;
const DEFAULT_POLL_SECONDS = 60;
const FULL_COMMAND = 'npm run check:merge:full';

const lines = (text) =>
  String(text ?? '')
    .split(/\r?\n/)
    .filter(Boolean);
const stepName = (command) => /^npm run (\S+)/.exec(command ?? '')?.[1];
const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

function must(git, ...args) {
  const result = git(args);
  if (result.status !== 0)
    throw margoError(
      'TIER2_GIT_FAILED',
      `git ${args.join(' ')} failed (${lines(result.stderr).at(-1) ?? `exit ${result.status}`}); fix the tier 2 worktree and start it again`,
    );
  return String(result.stdout ?? '').trim();
}

/**
 * What failed, from test-results/check-merge.json and gpu-packages.json: `{ step, suite, log, failures }`, the first failure
 * and, since the run keeps going, all of them as `{ step, suite, log }`. `suite` is the id of a failing GPU test
 * (`sky/test:browser`, `root/test:x`), null for any other step or when the file names none.
 */
export function failureFrom(merge, gpu) {
  const suites = (gpu?.results ?? [])
    .filter((r) => r.outcome === 'fail')
    .map((r) => r.label.replace(/ \[\d+\/\d+\].*$/, '').replace(' ', '/'));
  const failures = (merge?.results ?? [])
    .filter((r) => r.ok === false && !r.notRun)
    .flatMap((r) => {
      const step = stepName(r.command) ?? r.command,
        log = r.log ?? null;
      return step === 'check:gpu-packages' && suites.length
        ? [...new Set(suites)].map((suite) => ({ step, suite, log }))
        : [{ step, suite: null, log }];
    });
  return { ...(failures[0] ?? { step: 'unknown', suite: null, log: null }), failures };
}

/** The newest green tag's commit that `sha` contains, or null. */
export function lastGreen(git, sha) {
  const tag = lines(must(git, 'tag', '--list', 'green/*', '--merged', sha, '--sort=-creatordate'))[0];
  return tag ? must(git, 'rev-list', '-n', '1', tag) : null;
}

/** Commits of the range since the last green tag, oldest first, as `{ sha, subject }`. Empty when no green tag exists yet. */
function rangeCommits(git, from, to) {
  if (!from) return [];
  return lines(must(git, 'log', '--reverse', '--format=%H %s', `${from}..${to}`)).map((line) => ({
    sha: line.slice(0, line.indexOf(' ')),
    subject: line.slice(line.indexOf(' ') + 1),
  }));
}

/**
 * One tier 2 pass. `run(command, { env, logFile, limitMs })` resolves to `{ ok, timedOut? }`; `results(worktree file)`
 * reads a JSON file of the worktree, null when there is none. `paths` is queuePaths() plus `state`. Returns `{ result, sha }`;
 * result is idle, pass, fail, timeout or heat.
 */
export async function cycle({
  git,
  run,
  paths,
  results,
  clearResults = () => {},
  limitMs,
  now = () => new Date(),
  log = console.log,
}) {
  must(git, 'fetch', '-q', 'origin');
  const sha = must(git, 'rev-parse', 'origin/main'),
    state = readJson(paths.state);
  if (state?.checked === sha) return { result: 'idle', sha };
  must(git, 'checkout', '-q', '-f', '--detach', sha);
  must(git, 'lfs', 'checkout');
  clearResults();
  const stamp = now().toISOString().replace(/[:.]/g, '-'),
    logDir = join(paths.dir, 'tier2-logs'),
    logFile = join(logDir, `${stamp}-${sha.slice(0, 12)}.log`);
  mkdirSync(logDir, { recursive: true });
  const linked = await run('node scripts/worktree-node-modules.mjs', { env: {}, logFile, limitMs: 10 * 60_000 });
  if (!linked.ok)
    throw margoError(
      'TIER2_SETUP_FAILED',
      `the node_modules links failed at ${sha}; see ${logFile}, fix it and start again`,
    );
  log(`tier2: ${FULL_COMMAND} at ${sha}`);
  const outcome = await run(FULL_COMMAND, {
    env: { MARGO_CHECK_PARALLEL: '1', MARGO_CHECK_KEEP_GOING: '1' },
    logFile,
    limitMs,
  });
  const merge = results('test-results/check-merge.json');
  if (!outcome.ok && !outcome.timedOut && merge?.heatStopped) {
    log(`tier2: stopped for heat at ${merge.heatStopped}, nothing failed; ${sha} runs again (log ${logFile})`);
    return { result: 'heat', sha };
  }
  const remember = () =>
    writeFileSync(paths.state, `${JSON.stringify({ checked: sha, at: now().toISOString() }, null, 2)}\n`);
  if (outcome.ok) {
    const tag = `green/${sha}`;
    if (git(['rev-parse', '-q', '--verify', `refs/tags/${tag}`]).status !== 0) must(git, 'tag', tag, sha);
    const pushed = git(['push', 'origin', `refs/tags/${tag}`]);
    rmSync(paths.red, { force: true });
    remember();
    if (pushed.status !== 0) {
      log(
        `tier2: PASS at ${sha}, but the tag did not reach GitHub (${lines(pushed.stderr).at(-1)}); run: git push origin refs/tags/${tag}`,
      );
      return { result: 'pass', sha, tagPushed: false };
    }
    log(`tier2: PASS at ${sha}, ${tag} pushed (log ${logFile})`);
    return { result: 'pass', sha, tagPushed: true };
  }
  const failure = outcome.timedOut
    ? { step: 'time limit', suite: null, log: null, failures: [] }
    : failureFrom(merge, results('test-results/gpu-packages.json'));
  const from = lastGreen(git, sha),
    earlier = readJson(paths.red),
    record = {
      sha,
      step: failure.step,
      suite: failure.suite,
      failures: failure.failures,
      range: { from, to: sha },
      commits: rangeCommits(git, from, sha),
      since: earlier?.since ?? now().toISOString(),
      at: now().toISOString(),
      log: logFile,
      stepLog: failure.log,
    };
  writeFileSync(paths.red, `${JSON.stringify(record, null, 2)}\n`);
  remember();
  log(`tier2: FAIL at ${sha}: ${failure.step}${failure.suite ? ` > ${failure.suite}` : ''}; ${paths.red} written`);
  return { result: outcome.timedOut ? 'timeout' : 'fail', sha, record };
}

/** The footprint ids a failure reaches, or null when any commit can cause it (a step with no footprint of its own). */
export function failureIds({ step, suite }, footprints) {
  if (suite) return [`gpu/${suite}`];
  const ids = Object.keys(footprints);
  if (/^visual:/.test(step ?? '')) return ids.filter((id) => id.startsWith('visual/'));
  if (step === 'check:gpu-packages') return ids.filter((id) => id.startsWith('gpu/'));
  const own = { 'check:views': 'views', 'check:depth': 'depth', 'check:no-webgpu': 'no-webgpu', 'check:wgsl': 'wgsl' }[
    step
  ];
  return own ? [own] : null;
}

/**
 * The commits of a RED record that can reach what failed, oldest first, as `{ sha, subject, why }`: `analyse` of the commit's
 * files meets the failure's footprint ids, or runs everything. A failure with no footprint keeps every commit.
 */
export function suspectCommits({ git, ctx, red }) {
  const ids = failureIds(red, ctx.footprints),
    { workspaces, footprints, checkCode, smoke, mentions } = ctx;
  return red.commits.flatMap((commit) => {
    if (!ids) return [{ ...commit, why: `${red.step} has no footprint` }];
    const files = lines(must(git, 'diff-tree', '--no-commit-id', '--name-only', '--no-renames', '-r', commit.sha)),
      decision = analyse({ files, workspaces, footprints, checkCode, smoke, mentions });
    if (decision.mode === 'full') return [{ ...commit, why: decision.reason }];
    const hit = ids.find((id) => decision.hits.includes(id));
    return hit ? [{ ...commit, why: `reaches ${hit}` }] : [];
  });
}

/** The commands that rerun one failure at a checkout: `{ prepare: [...], command }`. */
export function rerunCommands(ctx, { step, suite }) {
  const prepare = ['node scripts/worktree-node-modules.mjs', 'npm run build:packages'];
  if (suite) {
    const decision = { mode: 'affected', reason: suite, changed: [], affected: [], hits: [`gpu/${suite}`] },
      planned = planSteps({ ...ctx, decision }).find((p) => stepName(p.command) === 'check:gpu-packages');
    if (planned.skip)
      throw margoError(
        'TIER2_SUITE_UNKNOWN',
        `${suite} is not a GPU test of this commit; list them with node scripts/gpu-package-tests.mjs --list`,
      );
    return { prepare, command: planned.command };
  }
  const command = ctx.steps.find((c) => stepName(c) === step);
  if (!command)
    throw margoError(
      'TIER2_SUITE_UNKNOWN',
      `"${step}" is no check:merge step, so it has no one command to rerun; find the commit by hand from the range in RED.json`,
    );
  if (GPU_STEPS.includes(step) && step !== 'check:gpu-packages') prepare.push('npm run build:site');
  return { prepare, command };
}

/**
 * Reruns one failure at `candidate` and at its parent. Returns `{ candidate, parent, candidateOk, parentOk, verdict }`.
 * verdict: culprit (fails here, passes at the parent), not-reproduced (passes at both) or older (fails at both).
 */
export async function rerunSuite({ git, run, commands, candidate, logDir, limitMs, log = console.log }) {
  const parent = must(git, 'rev-parse', `${candidate}^`);
  mkdirSync(logDir, { recursive: true });
  const at = async (sha) => {
    must(git, 'checkout', '-q', '-f', '--detach', sha);
    must(git, 'lfs', 'checkout');
    const logFile = join(logDir, `rerun-${sha.slice(0, 12)}.log`);
    for (const command of commands.prepare) {
      const ready = await run(command, { env: {}, logFile, limitMs });
      if (!ready.ok)
        throw margoError('TIER2_SETUP_FAILED', `${command} failed at ${sha} before the suite ran; see ${logFile}`);
    }
    log(`tier2: ${commands.command} at ${sha}`);
    return (await run(commands.command, { env: {}, logFile, limitMs })).ok;
  };
  const candidateOk = await at(candidate),
    parentOk = await at(parent),
    verdict = candidateOk ? (parentOk ? 'not-reproduced' : 'older') : parentOk ? 'culprit' : 'older';
  return { candidate, parent, candidateOk, parentOk, verdict };
}

export const USAGE = `usage: node scripts/tier2-loop.mjs [options]
       node scripts/tier2-loop.mjs suspects
       node scripts/tier2-loop.mjs rerun [--candidate=<sha>] [--limit=<min>] [--worktree=<path>]

Runs check:merge:full (side by side) on the newest origin/main in a detached worktree, whenever main has moved. A pass
makes and pushes the tag green/<sha> and clears private/queue/RED.json; a failure writes RED.json.
"suspects" prints the commits of RED.json's range that reach the failed suite. "rerun" runs that suite at a candidate
(default the newest suspect) and its parent, and says which is to blame.

Options:
  --once                     one pass, then exit (exit 1 on a failure)
  --limit=<min>              hard limit of one check, tree killed past it (default ${DEFAULT_LIMIT_MINUTES}; rerun: ${DEFAULT_RERUN_MINUTES} per command)
  --poll=<s>                 seconds between looks at origin/main (default ${DEFAULT_POLL_SECONDS})
  --worktree=<path>          its detached worktree (default <main checkout>-wt-tier2, rerun: <main checkout>-wt-tier2-rerun)
  --candidate=<sha>          rerun: the commit to test (default the newest suspect)
  --suite=<id>               suspects, rerun: another failed suite of RED.json's list
  -h, --help                 print this help and exit

Example:
  node scripts/tier2-loop.mjs --once`;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** The loop, or one pass: each pass under test-results/tier2.lock, its limit the check's plus room to record the result. */
async function loop(args, home, paths) {
  const worktree = resolve(flag(args, 'worktree', `${home}-wt-tier2`)),
    limit = Number(flag(args, 'limit', DEFAULT_LIMIT_MINUTES));
  if (!(limit > 0)) throw new RangeError(`--limit must be a positive number of minutes, got ${flag(args, 'limit')}`);
  ensureWorktree(worktree);
  if (args.includes('--locked')) {
    const { result } = await cycle({
      git: gitIn(worktree),
      run: stepIn(worktree),
      paths,
      limitMs: limit * 60_000,
      results: (file) => readJson(join(worktree, file)),
      clearResults: () => {
        for (const file of ['check-merge.json', 'gpu-packages.json'])
          rmSync(join(worktree, 'test-results', file), { force: true });
      },
    });
    process.exitCode = result === 'fail' || result === 'timeout' ? 1 : 0;
    return;
  }
  const git = gitIn(worktree),
    poll = Number(flag(args, 'poll', DEFAULT_POLL_SECONDS)) * 1000;
  for (;;) {
    must(git, 'fetch', '-q', 'origin');
    const tip = must(git, 'rev-parse', 'origin/main');
    if (readJson(paths.state)?.checked !== tip) {
      const held = spawnSync(
        process.execPath,
        [
          join(root, 'scripts', 'gpu-lock.mjs'),
          'run',
          `--max=${limit + 15}`,
          '--wait-max=1',
          '--owner=tier2',
          '--',
          'node',
          'scripts/tier2-loop.mjs',
          '--locked',
          `--limit=${limit}`,
          `--worktree=${worktree}`,
        ],
        {
          cwd: root,
          stdio: 'inherit',
          env: { ...process.env, MARGO_GPU_LOCK: join(home, 'test-results', 'tier2.lock') },
        },
      );
      if (args.includes('--once')) {
        process.exitCode = held.status ?? 1;
        return;
      }
    } else if (args.includes('--once')) {
      console.log(`tier2: idle, ${tip} is already checked`);
      return;
    }
    await sleep(poll);
  }
}

async function helpers(verb, args, home, paths) {
  const record = readJson(paths.red);
  if (!record)
    throw margoError('TIER2_NOT_RED', `${paths.red} is missing or unreadable; ${verb} works from a RED record`);
  // RED.json names the first failure; --suite picks another of its list.
  const red = { ...record, suite: flag(args, 'suite', record.suite) };
  const worktree = resolve(flag(args, 'worktree', `${home}-wt-tier2-rerun`));
  ensureWorktree(worktree);
  const git = gitIn(worktree);
  must(git, 'checkout', '-q', '-f', '--detach', red.sha);
  const ctx = await planContext(worktree),
    list = suspectCommits({ git, ctx, red });
  if (verb === 'suspects') {
    for (const { sha, subject, why } of list) console.log(`${sha} ${subject} (${why})`);
    if (!list.length)
      console.log(
        `no commit in the range reaches ${red.suite ?? red.step}; bisect ${red.range.from}..${red.range.to} with that one suite`,
      );
    return;
  }
  const candidate = flag(args, 'candidate', list.at(-1)?.sha);
  if (!candidate)
    throw margoError(
      'TIER2_NO_CANDIDATE',
      'no suspect commit in the range and no --candidate=<sha>; name a commit to rerun at',
    );
  const outcome = await rerunSuite({
    git,
    run: stepIn(worktree),
    candidate,
    logDir: join(paths.dir, 'tier2-logs'),
    limitMs: Number(flag(args, 'limit', DEFAULT_RERUN_MINUTES)) * 60_000,
    commands: rerunCommands(ctx, red),
  });
  console.log(JSON.stringify(outcome, null, 2));
  process.exitCode = outcome.verdict === 'culprit' ? 0 : 3;
}

async function main() {
  const args = process.argv.slice(2),
    home = mainCheckout(root),
    paths = { ...queuePaths(home), state: join(queuePaths(home).dir, 'tier2-state.json') };
  mkdirSync(paths.dir, { recursive: true });
  if (args[0] === 'suspects' || args[0] === 'rerun') await helpers(args[0], args, home, paths);
  else await loop(args, home, paths);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  exitOnHelp(USAGE);
  try {
    await main();
  } catch (error) {
    console.error(`tier2: ${error.message}`);
    process.exitCode = 1;
  }
}
