// `npm run check:merge`: the pre-push check, with the GPU work narrowed to what the change affects.
//   npm run check:merge         the affected GPU tests only (core, stage, shared, build and check scripts, package.json
//                               and lock files, an unclassifiable file, or more than MAX_AFFECTED packages run all)
//   npm run check:merge:full    everything, as before (the nightly job: scripts/nightly-full.mjs); MARGO_FULL=1 does the same
//   node scripts/check-merge.mjs --plan [--files=a,b]    print the mode, the reason and the commands, run nothing
//                               (--files pretends those files changed; --base=<ref> diffs against that ref, not origin/main)
// The steps are the ones in package.json `check:merge:steps`. Non-GPU steps (verify, the site build, the package
// tarball test, the bundler matrix) always run; each GPU step runs only when its footprint (scripts/support/
// affected-gpu.mjs) meets the affected packages, or runs on a narrowed list (visual demos, GPU test ids, WGSL
// package directories). The mode and the reason are printed first and written to test-results/check-merge.json.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { analyse, buildFootprints, loadWorkspaces, visualIds, wgslPackages } from './support/affected-gpu.mjs';

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
export const PLAIN_STEPS = ['verify', 'build:site', 'modern:test:packages', 'modern:test:bundlers'];

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
export function planSteps({ steps, decision, tests, workspaces, testId }) {
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
  let decision, base;
  if (args.includes('--full')) decision = full('--full (npm run check:merge:full)');
  else if (process.env.MARGO_FULL === '1') decision = full('MARGO_FULL=1');
  else {
    try {
      const given = args.find((a) => a.startsWith('--files='));
      const diff = given
        ? { files: given.slice(8).split(',').filter(Boolean) }
        : changedFiles(root, args.find((a) => a.startsWith('--base='))?.slice(7));
      base = diff.base;
      decision = analyse({ files: diff.files, workspaces, footprints, env: process.env });
    } catch (error) {
      decision = full(`cannot diff against origin/main (${String(error.message).split('\n')[0]})`);
    }
  }
  const planned = planSteps({ steps, decision, tests, workspaces, testId });
  console.log(describe(decision, base));
  for (const { command, skip } of planned) console.log(`  ${skip ? `skip (${skip})` : 'run'}  ${command}`);
  if (args.includes('--plan')) return;
  const results = [],
    started = performance.now();
  let failed;
  for (const { command, skip } of planned) {
    if (skip) {
      results.push({ command, skipped: skip });
      continue;
    }
    console.log(`\n=== ${command}`);
    const t0 = performance.now(),
      { status } = spawnSync(command, { cwd: root, shell: true, stdio: 'inherit' });
    results.push({ command, ok: status === 0, seconds: Math.round((performance.now() - t0) / 100) / 10 });
    if (status !== 0) {
      failed = command;
      break;
    }
  }
  const seconds = Math.round((performance.now() - started) / 1000);
  mkdirSync(join(root, 'test-results'), { recursive: true });
  writeFileSync(
    join(root, 'test-results/check-merge.json'),
    `${JSON.stringify({ mode: decision.mode, reason: decision.reason, affected: decision.affected, seconds, results }, null, 2)}\n`,
  );
  console.log(`\n${describe(decision, base)}\n${failed ? `FAILED at ${failed}` : 'PASSED'} in ${seconds} s`);
  if (failed) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
