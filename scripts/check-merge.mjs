// `npm run check:merge`: the pre-push check, with the work narrowed to what the change can affect (session rule 20:
// never narrow by skipping a test the change can affect; explicit full validation remains available).
//   npm run check:merge         the affected work only
//   npm run check:merge:full    everything; MARGO_FULL=1 does the same
//   node scripts/check-merge.mjs --steps=a,b   exactly those check:merge steps, whole, under the same heat watch (the
//                               selected light GPU checks on constrained machines)
//   node scripts/check-merge.mjs --plan [--files=a,b]    print the mode, the reason and the commands, run nothing
//                               (--files pretends those files changed; --base=<ref> diffs against that ref, not origin/main)
// Every changed file has a class (scripts/support/file-classes.mjs; tests/file-classes.test.js fails on a tracked file
// no class places). Everything runs for core, stage, shared or the umbrella (not when the umbrella only gains or loses
// `export * from` entries: umbrella-change.mjs), the root package.json, a lock file or
// .npmrc, build configuration, the check code (this file, affected-gpu.mjs, affected-packages.mjs,
// file-classes.mjs, verify.mjs and every file the build:packages chain reaches), a WGSL file outside a package, an
// unplaceable file or more than MAX_AFFECTED packages. A package file, its own package.json included, runs that
// package and its dependents. Any other script, test page, fixture or tool runs the steps whose closure holds it
// (stepClosure: the files each step's command, each verify command, each GPU test and each visual demo reach), and
// nothing beyond verify when no closure does. A change to the GPU package runner runs RUNNER_SMOKE
// (scripts/gpu-package-tests.mjs) plus what it affects.
// The steps are the ones in package.json `check:merge:steps`. Verify, the fresh clone, the site build and the
// quickstart always run; each GPU step runs only when its footprint (scripts/support/affected-gpu.mjs) meets the
// affected packages or holds a changed file, or runs on a narrowed list (visual demos, GPU test ids, WGSL package
// directories). The example type check (scripts/check-example-types.mjs) runs the example projects an affected package
// or a changed example file reaches, all of them in the full run. The package tarball test always runs, on the affected packages' README examples (the umbrella smoke
// test every time; whole when a file it runs changed), and the bundler matrix runs when a changed package is one it
// builds or imports, or a file it runs changed (scripts/support/affected-packages.mjs); the full run keeps both whole.
// The mode and the reason are printed first and written to test-results/check-merge.json. A step that fails while the
// Windows event log shows a GPU driver reset (scripts/support/driver-resets.mjs, bug 25) runs once more; the reset is
// printed and recorded with the step, and a second failure fails the run. A run that passed only that way says so: a
// "PASSED WITH A DRIVER RESET" line per step or GPU test, and `passedAfterDriverReset: true` in check-merge.json.
// Heat (machine profiles, MARGO_MACHINE_PROFILE, scripts/support/machine-profiles.json): on a profile with a heat watch
// every step that drives the GPU (all but NO_GPU_STEPS) runs under the same watch as the GPU package tests (runPlan in
// scripts/gpu-package-tests.mjs): at the stop temperature the step's process tree is ended, the run waits (bounded) for
// the resume temperature and runs that step again from its start, at most maxResumesPerStep times. check:gpu-packages
// watches each of its own tests and is not watched twice. Only a step the watch ended runs again; a step that fails on
// its own is a failure and is never rerun for heat. Each pause is a "PAUSED FOR HEAT during <step>" line; a stop it
// could not resume from ends the run as "PAUSED FOR HEAT: NOT RESUMED" with exit 75 (HEAT_EXIT), never a pass, a
// failure or a skip. The workstation profile (heat null) runs every step exactly as before.
// Side by side (--parallel or MARGO_CHECK_PARALLEL=1; --serial, MARGO_CHECK_SERIAL=1 and heat or split profiles stay one
// at a time): the same steps. Verify runs first and alone, the fresh-clone snapshot is taken right after it, then the
// rest beside each other in STEP_AFTER's order, the GPU suites each in their own slot (scripts/gpu-package-tests.mjs),
// and the timing tests last with nothing beside them. Each step's output goes to test-results/check-merge-logs/. The
// first failure stops the run, names the step and prints the end of its log. Compare a run with a serial one:
// node scripts/compare-check-runs.mjs --serial=<dir> --parallel=test-results
// Keep going (--keep-going or MARGO_CHECK_KEEP_GOING=1, passed on to check:gpu-packages): a failed step stops nothing, so
// one run finds every failure it can reach. Only a step that needs the failed one (STEP_AFTER) is not run. A failed verify
// is followed by one package build (packageBuild): every later step reads that build, the tarball test included, which must
// not build again beside them, and if it fails too nothing else can run. The run ends with the whole list and exit 1. Heat stops and the rerun after a driver reset work as they always do.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { exitOnHelp } from './support/help.mjs';
import { margoError } from '../packages/shared/errors.js';
import { describeResets, passedAfterResetLines, retryAfterDriverReset } from './support/driver-resets.mjs';
import { snapshot } from './fresh-clone-check.mjs';
import { HEAT_EXIT, pauseText, plan, runPlan, testId } from './gpu-package-tests.mjs';
import { keepGoingMode, parallelMode, runJobs, tailOf } from './support/parallel-run.mjs';
import { thermalSource } from './support/heat.mjs';
import { describeProfile, machineProfile } from './support/machine-profile.mjs';
import { runLimited } from './support/run-limited.mjs';
import {
  analyse,
  buildFootprints,
  buildCheckCode,
  loadWorkspaces,
  mentionIndex,
  scan,
  visualIds,
  wgslPackages,
} from './support/affected-gpu.mjs';
import { exampleClosure, matrixClosure, packageScopes } from './support/affected-packages.mjs';
import { changedUmbrellaReader, umbrellaChangeIsReexportOnly } from './support/umbrella-change.mjs';
import { PARALLEL, plantStale, SERIAL } from './verify.mjs';

const root = resolve(import.meta.dirname, '..');

/** Steps of `check:merge:steps` that use the GPU and can be narrowed. Every other step runs unchanged. */
export const GPU_STEPS = [
  'visual:check',
  'visual:compat',
  'visual:compat:budget',
  'check:views',
  'check:gpu-packages',
  'check:depth',
  'check:wgsl',
  'check:no-webgpu',
];
/** Steps known to need no GPU narrowing; a step in neither list fails the unit test so someone decides. */
export const PLAIN_STEPS = ['verify', 'check:fresh-clone', 'build:site', 'check:quickstart'];
/** Package-level steps (no GPU) that always run in some form and are narrowed by packageScopes. */
export const SCOPED_STEPS = ['check:examples-types', 'modern:test:packages', 'modern:test:bundlers'];

/** Steps that never drive the GPU: no heat watch. */
export const NO_GPU_STEPS = ['verify', 'check:fresh-clone'];
/** Steps that watch the heat themselves, per test (scripts/gpu-package-tests.mjs), so check:merge does not watch them. */
export const SELF_WATCHED_STEPS = ['check:gpu-packages'];
/** True when check:merge itself watches `name`'s heat on a heat profile: every step but the two lists above. */
export const heatWatched = (name) => !NO_GPU_STEPS.includes(name) && !SELF_WATCHED_STEPS.includes(name);
/** Hard limit for one heat-watched step, in minutes (the watch runs it with runLimited, which ends the tree at it). */
export const WATCHED_STEP_MINUTES = 120;

const stepName = (command) => /^npm run (\S+)/.exec(command)?.[1];

/** Changed files since the merge base with origin/main, committed or not, untracked included. Throws without git. */
export function changedFiles(cwd = root, base = 'origin/main') {
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });
  const mergeBase = git('merge-base', 'HEAD', base).trim();
  const lines = (text) => text.split('\0').filter(Boolean);
  const tracked = lines(git('diff', '--name-only', '--no-renames', '-z', mergeBase)),
    untracked = lines(git('ls-files', '--others', '--exclude-standard', '-z'));
  return { base: mergeBase, files: [...new Set([...tracked, ...untracked])] };
}

/**
 * Commands to run, in order: [{ command, skip?: reason }]. `decision` is analyse()'s result; `mode: 'full'` keeps every
 * step as written. `tests` are gpu-package-tests plan() entries; `workspaces` the package graph.
 */
export function planSteps({ steps, decision, tests, workspaces, testId, scope }) {
  if (decision.mode === 'full') return steps.map((command) => ({ command }));
  const hit = new Set(decision.hits);
  return steps.flatMap((command) => {
    const name = stepName(command),
      skip = (reason) => [{ command, skip: reason }],
      none = 'no affected package uses it';
    switch (name) {
      // The WebGL2 layer run compares the same demos (every demo imports the layer through its gate, so a change to the
      // layer reaches all of them); its extra demos (no visual baselines) run in the full check and the nightly.
      case 'visual:check':
      case 'visual:compat':
      case 'visual:compat:budget': {
        const ids = visualIds(decision.hits);
        return ids.length ? [{ command: `${command} --only=${ids.join(',')}` }] : skip(none);
      }
      case 'check:views':
        return hit.has('views') ? [{ command }] : skip(none);
      case 'check:depth':
        return hit.has('depth') ? [{ command }] : skip(none);
      case 'check:no-webgpu':
        return hit.has('no-webgpu') ? [{ command }] : skip(none);
      case 'check:gpu-packages': {
        const ids = tests.map(testId).filter((id) => hit.has(`gpu/${id}`));
        return ids.length ? [{ command: `${command} --select=${ids.join(',')}` }] : skip(none);
      }
      case 'check:wgsl': {
        if (hit.has('wgsl')) return [{ command }];
        const dirs = wgslPackages(workspaces, decision.affected);
        return dirs.length ? [{ command: `${command} -- --packages=${dirs.join(',')}` }] : skip(none);
      }
      case 'check:examples-types':
        if (!scope || scope.examples.all) return [{ command }];
        return scope.examples.ids.length
          ? [{ command: `${command} -- --projects=${scope.examples.ids.join(',')}` }]
          : skip(scope.examples.reason);
      case 'modern:test:packages':
        return scope && !scope.packages.full
          ? [{ command: `${command} -- --packages=${scope.packages.dirs.join(',')}` }]
          : [{ command }];
      case 'modern:test:bundlers':
        return !scope || scope.bundlers.run ? [{ command }] : skip(scope.bundlers.reason);
      default:
        return [{ command }];
    }
  });
}

/** One line for the log: the mode and why. */
export function describe(decision, base) {
  if (decision.mode === 'full') return `check:merge: FULL GPU run, because ${decision.reason}`;
  if (decision.mode === 'steps') return `check:merge: the named steps only, whole (${decision.reason})`;
  return `check:merge: AFFECTED GPU run vs ${base?.slice(0, 8) ?? 'origin/main'}: ${decision.reason}${
    decision.affected.length ? ` [${decision.affected.join(', ')}]` : ''
  }`;
}

/**
 * Everything a plan needs from the repository, read once: the steps, the package graph, the GPU tests, the footprints,
 * the check code files, the RUNNER_SMOKE footprint ids, the name lookup, and the two package-step inputs.
 */
export async function planContext(dir = root) {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')),
    workspaces = loadWorkspaces(dir),
    { plan, testId, PREPARE, RUNNER_SMOKE } = await import('./gpu-package-tests.mjs'),
    tests = plan(),
    footprints = buildFootprints({
      root: dir,
      workspaces,
      tests,
      scripts: manifest.scripts,
      verify: [...SERIAL, ...PARALLEL.flat()],
      prepare: PREPARE,
    });
  return {
    steps: manifest.scripts['check:merge:steps'].split(' && '),
    workspaces,
    tests,
    testId,
    footprints,
    checkCode: buildCheckCode(dir, workspaces, manifest.scripts),
    smoke: RUNNER_SMOKE.map((id) => `gpu/${id}`),
    mentions: mentionIndex(dir, footprints),
    browserFiles: scan(dir, ['tests/modern.html'], workspaces).files,
    matrix: matrixClosure(dir, workspaces),
    examples: exampleClosure(dir, workspaces),
  };
}

/** The decision, the package-step scope and the planned commands for `files` (a full run when `env.MARGO_FULL` is 1). */
export function planFiles(ctx, files, env = {}) {
  const { workspaces, footprints, checkCode, smoke, mentions, umbrellaReexport } = ctx;
  const decision = analyse({ files, workspaces, footprints, env, checkCode, smoke, mentions, umbrellaReexport });
  return planDecision(ctx, decision, files);
}

function planDecision(ctx, decision, files) {
  const { steps, workspaces, tests, testId, browserFiles, matrix, examples } = ctx;
  const scope = packageScopes({ decision, files, workspaces, browserFiles, closure: matrix, examples });
  return { decision, scope, planned: planSteps({ steps, decision, tests, workspaces, testId, scope }) };
}

/**
 * The plan for `--steps=<name>,<name>`: exactly those check:merge steps, in that order, whole (no narrowing), through
 * the same runner and heat watch as a full check:merge. A name that is not a step of `check:merge:steps` throws
 * CHECK_MERGE_STEP_UNKNOWN.
 */
export function stepsPlan(names, steps) {
  const known = steps.map(stepName),
    unknown = names.filter((name) => !known.includes(name));
  if (!names.length || unknown.length)
    throw margoError(
      'CHECK_MERGE_STEP_UNKNOWN',
      `--steps names ${unknown.length ? `${unknown.join(', ')}, not a check:merge step` : 'no step'}; use some of ${known.join(', ')}`,
    );
  return {
    decision: { mode: 'steps', reason: `--steps=${names.join(',')}`, affected: [] },
    planned: names.map((name) => ({ command: steps[known.indexOf(name)] })),
  };
}

/** The usual plan: the full run, or the steps the changed files can affect; printed with the mode and the reason. */
async function planRun(args) {
  const ctx = await planContext(),
    { workspaces, footprints } = ctx;
  const full = (reason) => ({ ...analyse({ files: [], workspaces, footprints, env: { MARGO_FULL: '1' } }), reason });
  let decision,
    base,
    files = [];
  if (args.includes('--full')) decision = full('--full (npm run check:merge:full)');
  else if (process.env.MARGO_FULL === '1') decision = full('MARGO_FULL=1');
  else {
    try {
      const given = args.find((a) => a.startsWith('--files='));
      const diff = given
        ? { files: given.slice(8).split(',').filter(Boolean) }
        : changedFiles(root, args.find((a) => a.startsWith('--base='))?.slice(7));
      base = diff.base;
      files = diff.files;
      const reader = changedUmbrellaReader(root, base ?? 'origin/main', { existsSync, readFileSync });
      ctx.umbrellaReexport = (file) => umbrellaChangeIsReexportOnly(file, reader.read, reader.usedBy);
      decision = planFiles(ctx, files, process.env).decision;
    } catch (error) {
      decision = full(`cannot diff against origin/main (${String(error.message).split('\n')[0]})`);
    }
  }
  const { scope, planned } = planDecision(ctx, decision, files);
  console.log(describe(decision, base));
  console.log(
    `  packages: ${scope.packages.full ? 'whole' : 'scoped'} (${scope.packages.reason}); bundlers: ${scope.bundlers.run ? 'run' : 'skip'} (${scope.bundlers.reason}); example types: ${scope.examples.all ? 'all' : scope.examples.ids.join(',') || 'none'} (${scope.examples.reason})`,
  );
  for (const { command, skip } of planned) console.log(`  ${skip ? `skip (${skip})` : 'run'}  ${command}`);
  return { decision, base, planned };
}

async function main() {
  const args = process.argv.slice(2),
    only = args.find((a) => a.startsWith('--steps='));
  let decision, base, planned;
  if (only) {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    ({ decision, planned } = stepsPlan(
      only.slice(8).split(',').filter(Boolean),
      manifest.scripts['check:merge:steps'].split(' && '),
    ));
    console.log(describe(decision));
    for (const { command } of planned) console.log(`  run  ${command}`);
  } else ({ decision, base, planned } = await planRun(args));
  const profile = machineProfile(),
    thermal = profile.heat ? thermalSource() : null,
    sideBySide = parallelMode({ argv: args, env: process.env, profile }),
    keepGoing = keepGoingMode({ argv: args, env: process.env }),
    timingTests = plan()
      .filter((t) => t.exclusive)
      .map(testId),
    hasTiming = (command) => {
      const select = /--select=(\S+)/.exec(command)?.[1]?.split(',');
      return timingTests.some((id) => !select || select.includes(id));
    };
  console.log(`steps: ${sideBySide ? 'side by side' : 'one at a time'} (--parallel, --serial)`);
  // The GPU step reads this from its environment, whichever way it was asked for.
  if (keepGoing) {
    process.env.MARGO_CHECK_KEEP_GOING = '1';
    console.log('keep going: a failed step stops nothing; the run ends with every failure');
  }
  const builds = packageBuild({
      planned,
      build: async () =>
        (await runLimited('npm run build:packages', { cwd: root, limitMs: BUILD_MINUTES * 60_000 })).ok,
    }),
    { rebuild } = builds;
  if (sideBySide)
    for (const job of stepJobs(planned, hasTiming, { keepGoing }))
      console.log(
        `  ${job.label}${job.after.length ? `  after ${job.after.join(', ')}` : ''}${job.exclusive ? '  alone, last' : ''}`,
      );
  if (args.includes('--plan')) return;
  console.log(describeProfile(profile));
  // A heat profile that cannot read its temperature stops here, before verify, not at its first GPU step.
  if (thermal && thermal.read() === null)
    throw new Error(
      `machine profile ${profile.name} watches the temperature but the ${thermal.name} gives no reading; set MARGO_THERMAL_FILE to a file holding the current temperature (written within MARGO_THERMAL_MAX_AGE_S, default 60 s), or use a profile without a heat watch`,
    );
  if (thermal) console.log(`temperature from the ${thermal.name}`);
  const started = performance.now();
  const logDir = join(root, 'test-results/check-merge-logs');
  let cloneCommit;
  const parallelRun = () =>
    runStepsParallel(planned, {
      hasTiming,
      keepGoing,
      rebuild,
      logFor: (id) => join(logDir, `${id.replace(/[^\w.-]+/g, '_')}.log`),
      before: async () => {
        // --steps without verify: nothing has built yet, and the tarball test must not build beside the others.
        if (!(await builds.ensure())) throw new Error('npm run build:packages failed; fix the build first');
        if (!planned.some((p) => stepName(p.command) === 'check:fresh-clone' && !p.skip)) return;
        const scratch = mkdtempSync(join(tmpdir(), 'margo-snapshot-'));
        try {
          cloneCommit = snapshot(scratch);
        } finally {
          rmSync(scratch, { recursive: true, force: true });
        }
      },
      run: async (command, name, signal, logFile) => {
        const env = { ...process.env, MARGO_CHECK_PARALLEL: '1', ...builds.stepEnv(name) };
        if (name === 'check:fresh-clone' && cloneCommit) env.MARGO_FRESH_CLONE_COMMIT = cloneCommit;
        if (logFile) {
          mkdirSync(logDir, { recursive: true });
          writeFileSync(logFile, `=== ${command}\n`);
        }
        const result = await runLimited(command, {
          cwd: root,
          env,
          limitMs: WATCHED_STEP_MINUTES * 60_000,
          label: command,
          signal,
          logFile,
        });
        if (result.message) console.error(`\nHUNG: ${result.message}`);
        builds.finished(name, result);
        return result;
      },
    });
  const {
    results,
    failed,
    heatStopped,
    failures = [],
  } = sideBySide
    ? await parallelRun()
    : await runSteps(planned, {
        profile,
        keepGoing,
        rebuild,
        read: thermal?.read,
        run: async (command, name, signal) => {
          // verify builds every package; the tarball test then reuses that build instead of building again. The stale-file
          // check still holds: verify plants marker files in two dist folders before its build, and no pack may contain them.
          const env = { ...process.env, ...builds.stepEnv(name) };
          // A heat-watched step runs with runLimited, which ends its whole tree when the watch aborts; any other step runs
          // as it always has.
          const result = signal
            ? await runLimited(command, {
                cwd: root,
                env,
                limitMs: WATCHED_STEP_MINUTES * 60_000,
                label: command,
                signal,
              })
            : { status: spawnSync(command, { cwd: root, shell: true, stdio: 'inherit', env }).status };
          if (!signal) result.ok = result.status === 0;
          if (result.message) console.error(`\nHUNG: ${result.message}`);
          builds.finished(name, result);
          return result;
        },
      });
  // The tests check:gpu-packages ran again after a reset, or paused for heat, from the file it just wrote, so the
  // summary names them.
  const gpuStep = results.find((r) => stepName(r.command) === 'check:gpu-packages' && (r.ok || r.heatNotResumed));
  if (gpuStep) {
    const inner = JSON.parse(readFileSync(join(root, 'test-results/gpu-packages.json'), 'utf8')).results,
      resetTests = gpuStep.ok ? inner.filter((r) => r.driverReset) : [],
      heatTests = inner.filter((r) => r.pauses?.length || r.outcome === 'heat-not-resumed');
    if (resetTests.length)
      gpuStep.driverResetTests = resetTests.map(({ label, ok, driverReset }) => ({
        label,
        ok,
        driverReset: { resets: driverReset.resets, rerunOk: driverReset.rerunOk },
      }));
    if (heatTests.length)
      gpuStep.heatTests = heatTests.map(({ label, outcome, reason, pauses }) => ({ label, outcome, reason, pauses }));
  }
  // Which suites inside the GPU step failed, so the list at the end is the whole list.
  const gpuRecord = join(root, 'test-results/gpu-packages.json');
  for (const failure of failures)
    if (stepName(failure.step) === 'check:gpu-packages' && existsSync(gpuRecord))
      failure.suites = JSON.parse(readFileSync(gpuRecord, 'utf8'))
        .results.filter((r) => r.outcome === 'fail')
        .map((r) => r.label);
  const seconds = Math.round((performance.now() - started) / 1000),
    { passedAfterDriverReset, pausedForHeat, lines } = summary({ results, failed, heatStopped, seconds, failures });
  mkdirSync(join(root, 'test-results'), { recursive: true });
  writeFileSync(
    join(root, 'test-results/check-merge.json'),
    `${JSON.stringify({ parallel: sideBySide, mode: decision.mode, reason: decision.reason, affected: decision.affected, profile: profile.name, passedAfterDriverReset, pausedForHeat, heatStopped: heatStopped ?? null, seconds, results }, null, 2)}\n`,
  );
  console.log(`\n${describe(decision, base)}; ${describeProfile(profile)}\n${lines.join('\n')}`);
  process.exitCode = failed ? 1 : heatStopped ? HEAT_EXIT : 0;
  if (sideBySide) {
    for (const failure of failures) console.error(failureReport(failure));
    const logs = results.filter((r) => r.log);
    if (logs.length)
      console.log(
        `\nStep logs (GPU suites: test-results/gpu-suites):\n${logs.map((r) => `  ${r.command}: ${r.log}`).join('\n')}`,
      );
  }
}

/** Hard limit for the one package build after a failed verify, in minutes. */
export const BUILD_MINUTES = 30;

/**
 * Who has built the packages in this run. `build:packages` empties each dist folder before writing it, so it must never
 * run beside a step that reads dist: a build in the side-by-side lane left core/dist/extension.js missing for 261 ms and
 * build:site failed in that gap, taking every GPU step with it. So verify's build, or the one build after a failed verify,
 * is the only one, and the tarball test packs it (MARGOENGINE_PACKAGE_TEST_PREBUILT). Markers go in before either build,
 * since a verify that failed before its build planted none. `build()` resolves true when the packages built.
 */
export function packageBuild({ planned, build, plant = plantStale }) {
  const packs = planned.some((p) => stepName(p.command) === 'modern:test:packages' && !p.skip);
  let built = false;
  const rebuild = async () => {
    if (packs) plant();
    built = await build();
    return built;
  };
  return {
    rebuild,
    /** Before the side-by-side lane: true when the tarball test has a build to pack, or does not run. */
    ensure: async () => built || !packs || rebuild(),
    /** The variables a step runs with. */
    stepEnv: (name) => ({
      ...(name === 'verify' && packs && { MARGOENGINE_PLANT_STALE: '1' }),
      ...(name === 'modern:test:packages' && built && { MARGOENGINE_PACKAGE_TEST_PREBUILT: '1' }),
    }),
    finished: (name, result) => {
      if (name === 'verify' && result.ok) built = true;
    },
  };
}

/** What the end of a run prints for one failure. Verify has no step log: its output went to the run's own output. */
export function failureReport({ step, log }) {
  return log
    ? `\nFAILED: ${step}\nlog: ${log}\n${tailOf(log)}`
    : `\nFAILED: ${step}\nits output is above, in this run's log`;
}

/**
 * Runs the planned steps in order and stops at the first failure or unresumed heat stop. Resolves `{ results, failed?,
 * heatStopped? }`: `failed` is the failing command, `heatStopped` the command a heat stop ended for good. Each result is
 * `{ command, ok, seconds, driverReset?, pauses?, heatNotResumed? }`, or `{ command, skipped }` for a skipped step.
 * `run(command, name, signal?)` runs one command and resolves `{ ok, status?, aborted? }`; given a `signal` it must end
 * the command's process tree when the signal aborts and resolve `aborted: true`.
 * On a profile with `heat`, every heatWatched step runs through runPlan (scripts/gpu-package-tests.mjs, the same code
 * as the GPU package tests) with `read` (degrees C or null): the step reruns from its start only when the heat watch
 * ended it (runPlan reruns on `aborted` with a stop reason, never on a plain failure), at most maxResumesPerStep times,
 * and every pause is kept in `pauses`. check:gpu-packages watches itself; its exit 75 (HEAT_EXIT) is its unresumed heat
 * stop. A failing step runs once more after a logged GPU driver reset (`retry`, bug 25). With `keepGoing` a failure does
 * not stop the run: a step that needs a failed one (STEP_AFTER) gets `notRun`, a failed verify is followed by `rebuild()`
 * (false ends the run), `failed` stays the first failure and `failures` lists them all as `{ step, log? }`.
 */
export async function runSteps(
  planned,
  {
    profile,
    read = () => null,
    run,
    log = console.log,
    pollMs,
    retry = retryAfterDriverReset,
    keepGoing = false,
    rebuild,
  },
) {
  const results = [],
    failures = [],
    blocked = new Set(),
    done = (extra = {}) => ({ results, failures, ...(failures.length && { failed: failures[0].step }), ...extra });
  for (const { command, skip } of planned) {
    if (skip) {
      results.push({ command, skipped: skip });
      continue;
    }
    const needs = (STEP_AFTER[stepName(command)] ?? []).find((step) => blocked.has(step));
    if (needs) {
      blocked.add(stepName(command));
      results.push({ command, ok: false, notRun: `it needs ${needs}, which did not pass` });
      continue;
    }
    log(`\n=== ${command}`);
    const name = stepName(command),
      t0 = performance.now();
    // A step that fails while the Windows event log shows a GPU driver reset runs once more, printed and recorded
    // (bug 25). check:gpu-packages does this per test itself, so a reset there costs one test, not the whole step. A
    // step the heat watch ended goes back to runPlan as it is: the heat pause, not a reset, explains it.
    const withReset = async (signal) => {
      const first = await run(command, name, signal);
      if (first.ok || first.aborted) return first;
      let used = false;
      return retry(command, async () => (used ? run(command, name, signal) : ((used = true), first)));
    };
    let outcome;
    if (name === 'check:gpu-packages') {
      const r = await run(command, name);
      outcome = {
        ok: r.ok,
        ...(r.status === HEAT_EXIT && {
          heatNotResumed: `it stopped for heat and did not resume (exit ${HEAT_EXIT}); its summary names the tests`,
        }),
      };
    } else if (profile.heat && heatWatched(name)) {
      const [r] = await runPlan([{ label: command }], {
        profile,
        read,
        pollMs,
        log,
        runStep: (_, signal) => withReset(signal),
      });
      outcome = {
        ok: r.outcome === 'pass',
        driverReset: r.driverReset,
        ...(r.pauses.length && { pauses: r.pauses }),
        ...(r.outcome === 'heat-not-resumed' && { heatNotResumed: r.reason }),
      };
    } else outcome = await withReset();
    const { ok, driverReset, pauses, heatNotResumed } = outcome;
    results.push({
      command,
      ok,
      seconds: Math.round((performance.now() - t0) / 100) / 10,
      ...(driverReset && { driverReset: { resets: driverReset.resets, rerunOk: driverReset.rerunOk } }),
      ...(pauses && { pauses }),
      ...(heatNotResumed && { heatNotResumed }),
    });
    if (heatNotResumed) return done({ heatStopped: command });
    if (ok) continue;
    failures.push({ step: command });
    if (!keepGoing) return done();
    if (stepName(command) !== 'verify') blocked.add(stepName(command));
    else if (!(await rebuild())) {
      log('keep going: verify failed and the packages do not build, so nothing else can run');
      return done();
    }
  }
  return done();
}

/**
 * What needs what when the steps run side by side, from the serial order: a GPU step reads what build:site made (site/dist,
 * catalog pages, records), and the bundler matrix installs what the tarball test packed.
 */
export const STEP_AFTER = {
  'build:site': ['verify'],
  'check:examples-types': ['verify'],
  'check:fresh-clone': ['verify'],
  'check:quickstart': ['verify'],
  'modern:test:packages': ['verify'],
  'modern:test:bundlers': ['modern:test:packages'],
  ...Object.fromEntries(GPU_STEPS.map((step) => [step, ['build:site']])),
};

/** The id of the last part of check:gpu-packages: its timing tests, after every other step, with nothing beside them. */
export const TIMING_JOB = 'check:gpu-packages:timing';

/**
 * Side-by-side jobs for the planned steps, after verify: `{ id, label, command, step, after, exclusive? }`. The GPU suites
 * split in two so that nothing else, CPU work included, runs beside a timing test: `--phase=shared` in the lane,
 * `--phase=timing` last, when `hasTiming(command)` says the selection holds one. Skipped steps have no job. With
 * `keepGoing` the timing part needs only what the shared part needs: being exclusive it still runs last, and a failed shared
 * suite says nothing about a timing test.
 */
export function stepJobs(planned, hasTiming = () => true, { keepGoing = false } = {}) {
  const run = planned.filter((p) => !p.skip && stepName(p.command) !== 'verify'),
    names = new Set(run.map((p) => stepName(p.command)));
  const jobs = run.map(({ command }) => {
    const name = stepName(command),
      gpu = name === 'check:gpu-packages',
      after = (STEP_AFTER[name] ?? []).filter((d) => names.has(d));
    if (!(name in STEP_AFTER))
      throw margoError(
        'CHECK_MERGE_STEP_UNPLACED',
        `${name} is a check:merge step with no entry in STEP_AFTER; say what it reads so it runs after that`,
      );
    return { id: name, label: name, step: command, command: gpu ? `${command} --phase=shared` : command, after };
  });
  const gpu = run.find((p) => stepName(p.command) === 'check:gpu-packages');
  if (gpu && hasTiming(gpu.command))
    jobs.push({
      id: TIMING_JOB,
      label: TIMING_JOB,
      step: gpu.command,
      command: `${gpu.command} --phase=timing`,
      after: keepGoing ? (STEP_AFTER['check:gpu-packages'] ?? []).filter((d) => names.has(d)) : ['check:gpu-packages'],
      exclusive: true,
    });
  return jobs;
}

/**
 * Runs the planned steps side by side: verify first and alone (it builds and plants the stale markers), then `before()`,
 * then stepJobs. Resolves like runSteps, in the planned order, one result per step; a step that did not get to finish has
 * `notRun`. `run(command, name, signal, logFile)` as in runSteps; `logFor(name)` names a step's log. The first failure
 * stops the rest. A step that fails during a GPU driver reset runs once more (`retry`), as in the serial path. `keepGoing`
 * and `rebuild` as in runSteps; `failures` lists every failure as `{ step, log? }`.
 */
export async function runStepsParallel(
  planned,
  {
    run,
    logFor,
    before = () => {},
    hasTiming,
    retry = retryAfterDriverReset,
    log = console.log,
    keepGoing = false,
    rebuild,
  },
) {
  const results = new Map(),
    failures = [],
    t0 = performance.now(),
    verify = planned.find((p) => stepName(p.command) === 'verify' && !p.skip);
  const attempt = async (command, name, signal, logFile) => {
    const first = await run(command, name, signal, logFile);
    if (first.ok || first.aborted) return first;
    let used = false;
    return retry(command, async () => (used ? run(command, name, signal, logFile) : ((used = true), first)));
  };
  const elapsed = (from) => Math.round((performance.now() - from) / 100) / 10;
  if (verify) {
    log(`\n=== ${verify.command}`);
    const r = await attempt(verify.command, 'verify');
    results.set(verify.command, { command: verify.command, ok: r.ok, seconds: elapsed(t0) });
    if (!r.ok) {
      failures.push({ step: verify.command });
      if (!keepGoing || !(await rebuild())) {
        if (keepGoing) log('keep going: verify failed and the packages do not build, so nothing else can run');
        return { results: [...results.values()], failed: verify.command, failures };
      }
    }
  }
  await before();
  const jobs = stepJobs(planned, hasTiming, { keepGoing });
  log(`\nside by side: ${jobs.map((j) => j.label).join(', ')}`);
  const done = await runJobs(jobs, {
    limit: jobs.length || 1,
    keepGoing,
    log: (line) => log(line),
    run: async (job, signal) => {
      log(`start  ${job.label}`);
      const name = stepName(job.command),
        logFile = logFor(job.id),
        r = await attempt(job.command, name, signal, logFile);
      log(`${r.ok ? 'pass' : r.aborted ? 'ended' : 'FAIL'}   ${job.label}`);
      return { ...r, log: logFile };
    },
  });
  // Both parts of the GPU suites are one step of the plan: it passed when both did.
  for (const job of done) {
    const had = results.get(job.step),
      seconds = job.startedAt ? Math.round((job.endedAt - job.startedAt) / 100) / 10 : 0;
    results.set(job.step, {
      command: job.step,
      ok: job.ok && (had?.ok ?? true),
      seconds: seconds + (had?.seconds ?? 0),
      log: had?.log ?? job.log ?? logFor(job.id),
      ...(job.outcome === 'not-run' && { notRun: job.reason }),
      ...(job.driverReset && { driverReset: { resets: job.driverReset.resets, rerunOk: job.driverReset.rerunOk } }),
    });
  }
  const ordered = planned.map(({ command, skip }) =>
    skip ? { command, skipped: skip } : (results.get(command) ?? { command, ok: false, notRun: 'never started' }),
  );
  for (const job of done) if (job.outcome === 'fail') failures.push({ step: job.step, log: job.log });
  return {
    results: ordered,
    failures,
    ...(failures.length && { failed: failures[0].step, failedLog: failures[0].log }),
  };
}

/**
 * The end of a run: the GPU resets and heat pauses it met, then "PASSED", "FAILED at <step>", "PAUSED FOR HEAT: NOT
 * RESUMED at <step>" (exit 75: nothing failed, but the run is incomplete), or, when it passed only because a step or
 * a check:gpu-packages test passed on its rerun after a logged GPU driver reset, one "PASSED WITH A DRIVER RESET"
 * warning per such step and a last line that says so; `passedAfterDriverReset` is then true (check-merge.json). A
 * step the heat watch stopped and ran again gets a "PAUSED FOR HEAT during <step>" line with each pause, and a pass
 * after one ends "PASSED AFTER A HEAT PAUSE"; `pausedForHeat` is then true. A pass after a rerun still passes, a
 * failed rerun has already failed the run. More than one of `failures` (a keep-going run) adds a line per failure and per
 * step that did not get to run.
 */
export function summary({ results, failed, heatStopped, seconds, failures = [] }) {
  const lines = [];
  if (failures.length > 1 || failures[0]?.suites?.length)
    lines.push(
      'FAILURES:',
      ...failures.map(({ step, suites }) => `  FAILED  ${step}${suites?.length ? `: ${suites.join(', ')}` : ''}`),
    );
  // Whatever the number of failures: a step that did not run proved nothing.
  for (const { command, notRun } of results) if (notRun) lines.push(`  NOT RUN  ${command}  (${notRun})`);
  for (const { command, driverReset } of results)
    if (driverReset)
      lines.push(
        `GPU RESET during ${command}: ${describeResets(driverReset.resets)}; the rerun ${driverReset.rerunOk ? 'passed' : 'failed'}`,
      );
  const heatLine = (where, pauses) =>
    `PAUSED FOR HEAT during ${where} ${pauses.length === 1 ? 'once' : `${pauses.length} times`}: ${pauses.map(pauseText).join('; ')}`;
  let paused = 0;
  for (const { command, pauses, heatNotResumed, heatTests } of results) {
    if (pauses?.length) {
      paused++;
      lines.push(
        `${heatLine(command, pauses)}. The heat watch stopped it, so it ran again from its start: a stopped step is rerun, a failed one never is`,
      );
    }
    for (const t of heatTests ?? []) {
      if (t.pauses?.length) {
        paused++;
        lines.push(heatLine(`${command} > ${t.label}`, t.pauses));
      }
      if (t.outcome === 'heat-not-resumed')
        lines.push(`PAUSED FOR HEAT: NOT RESUMED ${command} > ${t.label} (${t.reason})`);
    }
    if (heatNotResumed) lines.push(`PAUSED FOR HEAT: NOT RESUMED ${command} (${heatNotResumed})`);
  }
  const warnings =
    failed || heatStopped
      ? []
      : passedAfterResetLines(
          results,
          results.filter((r) => r.driverResetTests).map((r) => ({ step: r.command, results: r.driverResetTests })),
        );
  lines.push(...warnings);
  const reruns = `${warnings.length} rerun${warnings.length > 1 ? 's' : ''} after a GPU driver reset`,
    heatReruns = `${paused} step${paused > 1 ? 's' : ''} stopped by the heat watch and run again from the start`;
  lines.push(
    failed
      ? `FAILED at ${failed} in ${seconds} s`
      : heatStopped
        ? `PAUSED FOR HEAT: NOT RESUMED at ${heatStopped} in ${seconds} s: no step failed, but the run is incomplete (exit ${HEAT_EXIT}); rerun it when the machine is cool, or on a profile that can take the load`
        : warnings.length && paused
          ? `PASSED WITH A DRIVER RESET AND A HEAT PAUSE in ${seconds} s: ${reruns}, ${heatReruns}, see above`
          : warnings.length
            ? `PASSED WITH A DRIVER RESET in ${seconds} s: ${reruns}, see above`
            : paused
              ? `PASSED AFTER A HEAT PAUSE in ${seconds} s: ${heatReruns}, see above`
              : `PASSED in ${seconds} s`,
  );
  return { passedAfterDriverReset: warnings.length > 0, pausedForHeat: paused > 0, lines };
}

export const USAGE = `usage: node scripts/check-merge.mjs [options]

The full pre-merge check, narrowed to the packages the change affects (npm run check:merge).

Options:
  --full                     run every GPU step, no narrowing (npm run check:merge:full; or MARGO_FULL=1)
  --base=<ref>               compare against this ref instead of origin/main
  --files=<a>,<b>            treat exactly these files as the change
  --parallel                 run steps and GPU suites side by side (or MARGO_CHECK_PARALLEL=1)
  --serial                   one at a time, whatever else is set (or MARGO_CHECK_SERIAL=1)
  --keep-going               a failed step stops nothing; the run ends with every failure and exit 1 (or MARGO_CHECK_KEEP_GOING=1)
  -h, --help                 print this help and exit

Example:
  node scripts/check-merge.mjs --base=origin/main`;

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  exitOnHelp(USAGE);
  await main();
}
