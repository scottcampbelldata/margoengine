// `npm run check:merge`: the pre-push check, with the GPU work narrowed to what the change affects.
//   npm run check:merge         the affected GPU tests only (core, stage, shared, build and check scripts, package.json
//                               and lock files, an unclassifiable file, or more than MAX_AFFECTED packages run all)
//   npm run check:merge:full    everything, as before (the nightly job: scripts/nightly-full.mjs); MARGO_FULL=1 does the same
//   node scripts/check-merge.mjs --plan [--files=a,b]    print the mode, the reason and the commands, run nothing
//                               (--files pretends those files changed; --base=<ref> diffs against that ref, not origin/main)
// The steps are the ones in package.json `check:merge:steps`. Verify and the site build always run; each GPU step runs
// only when its footprint (scripts/support/affected-gpu.mjs) meets the affected packages, or runs on a narrowed list
// (visual demos, GPU test ids, WGSL package directories). The package tarball test always runs, on the affected
// packages' README examples (the umbrella smoke test every time), and the bundler matrix runs when a changed package is
// one it builds or imports (scripts/support/affected-packages.mjs); the full run keeps both whole. The mode and the
// reason are printed first and written to test-results/check-merge.json. A step that fails while the Windows event log
// shows a GPU driver reset (scripts/support/driver-resets.mjs, bug 25) runs once more; the reset is printed and recorded
// with the step, and a second failure fails the run. A run that passed only that way says so: a "PASSED WITH A DRIVER
// RESET" line per step or GPU test, and `passedAfterDriverReset: true` in check-merge.json.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describeResets, passedAfterResetLines, retryAfterDriverReset } from './support/driver-resets.mjs';
import { analyse, buildFootprints, loadWorkspaces, scan, visualIds, wgslPackages } from './support/affected-gpu.mjs';
import { matrixClosure, packageScopes } from './support/affected-packages.mjs';

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

async function main() {
  const args = process.argv.slice(2),
    manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')),
    steps = manifest.scripts['check:merge:steps'].split(' && '),
    workspaces = loadWorkspaces(root),
    { plan, testId } = await import('./gpu-package-tests.mjs'),
    tests = plan(),
    footprints = buildFootprints({ root, workspaces, tests, scripts: manifest.scripts });
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
      decision = analyse({ files: diff.files, workspaces, footprints, env: process.env });
    } catch (error) {
      decision = full(`cannot diff against origin/main (${String(error.message).split('\n')[0]})`);
    }
  }
  const scope = packageScopes({
    decision,
    files,
    workspaces,
    browserFiles: scan(root, ['tests/modern.html'], workspaces).files,
    closure: matrixClosure(root, workspaces),
  });
  const planned = planSteps({ steps, decision, tests, workspaces, testId, scope });
  console.log(describe(decision, base));
  console.log(
    `  packages: ${scope.packages.full ? 'whole' : 'scoped'} (${scope.packages.reason}); bundlers: ${scope.bundlers.run ? 'run' : 'skip'} (${scope.bundlers.reason})`,
  );
  for (const { command, skip } of planned) console.log(`  ${skip ? `skip (${skip})` : 'run'}  ${command}`);
  if (args.includes('--plan')) return;
  const results = [],
    started = performance.now();
  let failed,
    built = false;
  for (const { command, skip } of planned) {
    if (skip) {
      results.push({ command, skipped: skip });
      continue;
    }
    console.log(`\n=== ${command}`);
    // verify builds every package; the tarball test then reuses that build instead of building again. The stale-file
    // check still holds: verify plants marker files in two dist folders before its build, and no pack may contain them.
    const name = stepName(command),
      env = { ...process.env };
    if (name === 'verify' && planned.some((p) => stepName(p.command) === 'modern:test:packages'))
      env.MARGOENGINE_PLANT_STALE = '1';
    if (name === 'modern:test:packages' && built) env.MARGOENGINE_PACKAGE_TEST_PREBUILT = '1';
    // A step that fails while the Windows event log shows a GPU driver reset runs once more, printed and recorded
    // (bug 25). check:gpu-packages does this per test itself, so a reset there costs one test, not the whole step.
    const t0 = performance.now(),
      runStep = async () => ({
        ok: spawnSync(command, { cwd: root, shell: true, stdio: 'inherit', env }).status === 0,
      }),
      { ok, driverReset } =
        name === 'check:gpu-packages' ? await runStep() : await retryAfterDriverReset(command, runStep);
    if (name === 'verify' && ok) built = true;
    // The tests check:gpu-packages ran again after a reset, from the file it just wrote, so the summary names them.
    const resetTests =
      name === 'check:gpu-packages' && ok
        ? JSON.parse(readFileSync(join(root, 'test-results/gpu-packages.json'), 'utf8')).results.filter(
            (r) => r.driverReset,
          )
        : [];
    results.push({
      command,
      ok,
      seconds: Math.round((performance.now() - t0) / 100) / 10,
      ...(driverReset && { driverReset: { resets: driverReset.resets, rerunOk: driverReset.rerunOk } }),
      ...(resetTests.length && {
        driverResetTests: resetTests.map(({ label, ok, driverReset }) => ({
          label,
          ok,
          driverReset: { resets: driverReset.resets, rerunOk: driverReset.rerunOk },
        })),
      }),
    });
    if (!ok) {
      failed = command;
      break;
    }
  }
  const seconds = Math.round((performance.now() - started) / 1000),
    { passedAfterDriverReset, lines } = summary({ results, failed, seconds });
  mkdirSync(join(root, 'test-results'), { recursive: true });
  writeFileSync(
    join(root, 'test-results/check-merge.json'),
    `${JSON.stringify({ mode: decision.mode, reason: decision.reason, affected: decision.affected, passedAfterDriverReset, seconds, results }, null, 2)}\n`,
  );
  console.log(`\n${describe(decision, base)}\n${lines.join('\n')}`);
  if (failed) process.exitCode = 1;
}

/**
 * The end of a run: the GPU resets it met, then "PASSED", "FAILED at <step>", or, when it passed only because a step
 * or a check:gpu-packages test passed on its rerun after a logged GPU driver reset, one "PASSED WITH A DRIVER RESET"
 * warning per such step and a last line that says so; `passedAfterDriverReset` is then true (check-merge.json). The
 * exit code does not change: a pass after a rerun passes, a failed rerun has already failed the run.
 */
export function summary({ results, failed, seconds }) {
  const lines = [];
  for (const { command, driverReset } of results)
    if (driverReset)
      lines.push(
        `GPU RESET during ${command}: ${describeResets(driverReset.resets)}; the rerun ${driverReset.rerunOk ? 'passed' : 'failed'}`,
      );
  const warnings = failed
    ? []
    : passedAfterResetLines(
        results,
        results.filter((r) => r.driverResetTests).map((r) => ({ step: r.command, results: r.driverResetTests })),
      );
  lines.push(...warnings);
  lines.push(
    failed
      ? `FAILED at ${failed} in ${seconds} s`
      : warnings.length
        ? `PASSED WITH A DRIVER RESET in ${seconds} s: ${warnings.length} rerun${warnings.length > 1 ? 's' : ''} after a GPU driver reset, see above`
        : `PASSED in ${seconds} s`,
  );
  return { passedAfterDriverReset: warnings.length > 0, lines };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
