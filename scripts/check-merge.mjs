// `npm run check:merge`: the pre-push check, with the work narrowed to what the change can affect (session rule 20:
// never narrow by skipping a test the change can affect; the nightly full run is the backstop).
//   npm run check:merge         the affected work only
//   npm run check:merge:full    everything, as before (the nightly job: scripts/nightly-full.mjs); MARGO_FULL=1 does the same
//   node scripts/check-merge.mjs --plan [--files=a,b]    print the mode, the reason and the commands, run nothing
//                               (--files pretends those files changed; --base=<ref> diffs against that ref, not origin/main)
// Every changed file has a class (scripts/support/file-classes.mjs; tests/file-classes.test.js fails on a tracked file
// no class places). Everything runs for core, stage, shared or the umbrella, the root package.json, a lock file or
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
// directories). The package tarball test always runs, on the affected packages' README examples (the umbrella smoke
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
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { exitOnHelp } from './support/help.mjs';
import { describeResets, passedAfterResetLines, retryAfterDriverReset } from './support/driver-resets.mjs';
import { pauseText, runPlan } from './gpu-package-tests.mjs';
import { HEAT_EXIT } from './nightly-full.mjs';
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
import { matrixClosure, packageScopes } from './support/affected-packages.mjs';
import { PARALLEL, SERIAL } from './verify.mjs';

const root = resolve(import.meta.dirname, '..');

/** Steps of `check:merge:steps` that use the GPU and can be narrowed. Every other step runs unchanged. */
export const GPU_STEPS = [
  'visual:check',
  'check:views',
  'check:gpu-packages',
  'check:depth',
  'check:wgsl',
  'check:no-webgpu',
];
/** Steps known to need no GPU narrowing; a step in neither list fails the unit test so someone decides. */
export const PLAIN_STEPS = ['verify', 'check:fresh-clone', 'build:site', 'check:quickstart'];
/** Package-level steps (no GPU) that always run in some form and are narrowed by packageScopes. */
export const SCOPED_STEPS = ['modern:test:packages', 'modern:test:bundlers'];

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
      case 'visual:check': {
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
  };
}

/** The decision, the package-step scope and the planned commands for `files` (a full run when `env.MARGO_FULL` is 1). */
export function planFiles(ctx, files, env = {}) {
  const { workspaces, footprints, checkCode, smoke, mentions } = ctx;
  const decision = analyse({ files, workspaces, footprints, env, checkCode, smoke, mentions });
  return planDecision(ctx, decision, files);
}

function planDecision(ctx, decision, files) {
  const { steps, workspaces, tests, testId, browserFiles, matrix } = ctx;
  const scope = packageScopes({ decision, files, workspaces, browserFiles, closure: matrix });
  return { decision, scope, planned: planSteps({ steps, decision, tests, workspaces, testId, scope }) };
}

async function main() {
  const args = process.argv.slice(2),
    ctx = await planContext(),
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
      decision = planFiles(ctx, files, process.env).decision;
    } catch (error) {
      decision = full(`cannot diff against origin/main (${String(error.message).split('\n')[0]})`);
    }
  }
  const { scope, planned } = planDecision(ctx, decision, files);
  console.log(describe(decision, base));
  console.log(
    `  packages: ${scope.packages.full ? 'whole' : 'scoped'} (${scope.packages.reason}); bundlers: ${scope.bundlers.run ? 'run' : 'skip'} (${scope.bundlers.reason})`,
  );
  for (const { command, skip } of planned) console.log(`  ${skip ? `skip (${skip})` : 'run'}  ${command}`);
  if (args.includes('--plan')) return;
  const profile = machineProfile(),
    thermal = profile.heat ? thermalSource() : null;
  console.log(describeProfile(profile));
  // A heat profile that cannot read its temperature stops here, before verify, not at its first GPU step.
  if (thermal && thermal.read() === null)
    throw new Error(
      `machine profile ${profile.name} watches the temperature but the ${thermal.name} gives no reading; set MARGO_THERMAL_FILE to a file holding the current temperature (written within MARGO_THERMAL_MAX_AGE_S, default 60 s), or use a profile without a heat watch`,
    );
  if (thermal) console.log(`temperature from the ${thermal.name}`);
  let built = false;
  const started = performance.now();
  const { results, failed, heatStopped } = await runSteps(planned, {
    profile,
    read: thermal?.read,
    run: async (command, name, signal) => {
      // verify builds every package; the tarball test then reuses that build instead of building again. The stale-file
      // check still holds: verify plants marker files in two dist folders before its build, and no pack may contain them.
      const env = { ...process.env };
      if (name === 'verify' && planned.some((p) => stepName(p.command) === 'modern:test:packages'))
        env.MARGOENGINE_PLANT_STALE = '1';
      if (name === 'modern:test:packages' && built) env.MARGOENGINE_PACKAGE_TEST_PREBUILT = '1';
      // A heat-watched step runs with runLimited, which ends its whole tree when the watch aborts; any other step runs
      // as it always has.
      const result = signal
        ? await runLimited(command, { cwd: root, env, limitMs: WATCHED_STEP_MINUTES * 60_000, label: command, signal })
        : { status: spawnSync(command, { cwd: root, shell: true, stdio: 'inherit', env }).status };
      if (!signal) result.ok = result.status === 0;
      if (result.message) console.error(`\nHUNG: ${result.message}`);
      if (name === 'verify' && result.ok) built = true;
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
  const seconds = Math.round((performance.now() - started) / 1000),
    { passedAfterDriverReset, pausedForHeat, lines } = summary({ results, failed, heatStopped, seconds });
  mkdirSync(join(root, 'test-results'), { recursive: true });
  writeFileSync(
    join(root, 'test-results/check-merge.json'),
    `${JSON.stringify({ mode: decision.mode, reason: decision.reason, affected: decision.affected, profile: profile.name, passedAfterDriverReset, pausedForHeat, heatStopped: heatStopped ?? null, seconds, results }, null, 2)}\n`,
  );
  console.log(`\n${describe(decision, base)}; ${describeProfile(profile)}\n${lines.join('\n')}`);
  process.exitCode = failed ? 1 : heatStopped ? HEAT_EXIT : 0;
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
 * stop. A failing step runs once more after a logged GPU driver reset (`retry`, bug 25).
 */
export async function runSteps(
  planned,
  { profile, read = () => null, run, log = console.log, pollMs, retry = retryAfterDriverReset },
) {
  const results = [];
  for (const { command, skip } of planned) {
    if (skip) {
      results.push({ command, skipped: skip });
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
    if (heatNotResumed) return { results, heatStopped: command };
    if (!ok) return { results, failed: command };
  }
  return { results };
}

/**
 * The end of a run: the GPU resets and heat pauses it met, then "PASSED", "FAILED at <step>", "PAUSED FOR HEAT: NOT
 * RESUMED at <step>" (exit 75: nothing failed, but the run is incomplete), or, when it passed only because a step or
 * a check:gpu-packages test passed on its rerun after a logged GPU driver reset, one "PASSED WITH A DRIVER RESET"
 * warning per such step and a last line that says so; `passedAfterDriverReset` is then true (check-merge.json). A
 * step the heat watch stopped and ran again gets a "PAUSED FOR HEAT during <step>" line with each pause, and a pass
 * after one ends "PASSED AFTER A HEAT PAUSE"; `pausedForHeat` is then true. A pass after a rerun still passes, a
 * failed rerun has already failed the run.
 */
export function summary({ results, failed, heatStopped, seconds }) {
  const lines = [];
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
  -h, --help                 print this help and exit

Example:
  node scripts/check-merge.mjs --base=origin/main`;

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  exitOnHelp(USAGE);
  await main();
}
