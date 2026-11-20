// `npm run check:core-stress`: the core and stage stress check (docs/architecture/operational-playbook.md, "Core and
// stage stress check") as a check:merge class check. It runs the same two files as the core and stage package tests,
// tests/deep-core-stress.test.js and packages/stage/tests/stress.test.js, with 1,000 seeds per family instead of the
// package tests' 30 or 40, so it proves something the package tests do not: the seeds the fast gate never reaches.
// Every seed is deterministic; the whole run has a hard limit of 10 minutes (it takes about half a minute).
//   node scripts/core-stress.mjs [--runs=<n>]   seeds per family (default 1000)
import { resolve } from 'node:path';
import { showHelp } from './support/help.mjs';
import { runLimited } from './support/run-limited.mjs';

if (
  !showHelp(`npm run check:core-stress [-- --runs=<n>]
  Runs the core and stage stress families (tests/deep-core-stress.test.js, packages/stage/tests/stress.test.js)
  with <n> seeds each (default 1000). MARGO_STRESS_SEED=<seed> replays one seed.`)
) {
  const root = resolve(import.meta.dirname, '..');
  const runs = process.argv.find((arg) => arg.startsWith('--runs='))?.slice('--runs='.length) ?? '1000';
  if (!/^[1-9]\d*$/.test(runs)) throw new RangeError(`--runs must be a positive integer, got ${runs}`);
  const files = ['tests/deep-core-stress.test.js', 'packages/stage/tests/stress.test.js'];
  const result = await runLimited(`node --test ${files.join(' ')}`, {
    cwd: root,
    env: { ...process.env, MARGO_STRESS_RUNS: runs },
    limitMs: 10 * 60_000,
    label: 'check:core-stress',
  });
  if (result.timedOut) console.error(result.message);
  process.exitCode = result.ok ? 0 : 1;
}
