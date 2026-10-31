// Did a side-by-side check:merge do the same work as a serial one? Reads each run's test-results/check-merge.json and
// gpu-packages.json and fails unless: it really ran side by side, in the same mode as the serial run; every step the
// serial run ran passed; every suite label of the serial run is present and passed, none excluded or not run; and every
// timing test held the GPU exclusively with no suite beside it. Suites only the new run has are listed apart: they
// must pass too, and are not a difference in coverage.
//   node scripts/compare-check-runs.mjs --serial=<folder> [--parallel=test-results]
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { exitOnHelp } from './support/help.mjs';

const stepName = (command) => /^npm run (\S+)/.exec(command)?.[1] ?? command;
const overlaps = (a, b) => a.startedAt < b.endedAt && b.startedAt < a.endedAt;

/**
 * The difference between two runs: `{ ok, problems, newSuites, newTiming, suites, steps }`. Each argument is a parsed
 * JSON file: `serialMerge`, `serialGpu`, `parallelMerge`, `parallelGpu`. `newSuites` and `newTiming` hold labels only
 * the parallel run has.
 */
export function compareRuns({ serialMerge, serialGpu, parallelMerge, parallelGpu }) {
  const problems = [];
  if (serialMerge.parallel || serialGpu.parallel) problems.push('the serial files come from a side-by-side run');
  if (!parallelMerge.parallel) problems.push('check-merge.json of the new run is not from a side-by-side run');
  if (!parallelGpu.parallel) problems.push('gpu-packages.json of the new run is not from a side-by-side run');
  if (serialMerge.mode !== parallelMerge.mode)
    problems.push(`modes differ: serial ${serialMerge.mode}, new run ${parallelMerge.mode}; compare like with like`);

  const newSteps = new Map(parallelMerge.results.map((r) => [stepName(r.command), r]));
  for (const step of serialMerge.results) {
    if (step.skipped) continue;
    const name = stepName(step.command),
      seen = newSteps.get(name);
    if (!seen) problems.push(`step ${name} is missing`);
    else if (seen.skipped) problems.push(`step ${name} was skipped: ${seen.skipped}`);
    else if (!seen.ok) problems.push(`step ${name} did not pass${seen.notRun ? `: ${seen.notRun}` : ''}`);
  }

  const before = serialGpu.results.filter((r) => r.outcome !== 'excluded'),
    now = new Map(parallelGpu.results.map((r) => [r.label, r])),
    known = new Set(serialGpu.results.map((r) => r.label));
  for (const { label } of before) {
    const seen = now.get(label);
    if (!seen) problems.push(`suite ${label} is missing`);
  }
  for (const r of parallelGpu.results) {
    if (r.outcome === 'excluded') problems.push(`suite ${r.label} was excluded: ${r.reason}`);
    else if (r.outcome !== 'pass' || !r.ok)
      problems.push(`suite ${r.label}: ${r.outcome}${r.reason ? ` (${r.reason})` : ''}`);
  }

  const wasTiming = new Set(serialGpu.results.filter((r) => r.exclusive).map((r) => r.label));
  for (const r of parallelGpu.results) {
    if (!r.exclusive && !wasTiming.has(r.label)) continue;
    if (r.hold !== 'exclusive')
      problems.push(`timing suite ${r.label} held ${r.hold ?? 'no recorded hold'}, not exclusive`);
    const beside = parallelGpu.results.filter((o) => o !== r && o.startedAt && r.startedAt && overlaps(r, o));
    if (beside.length) problems.push(`timing suite ${r.label} ran beside ${beside.map((o) => o.label).join(', ')}`);
  }

  const fresh = parallelGpu.results.filter((r) => !known.has(r.label));
  return {
    ok: problems.length === 0,
    problems,
    newSuites: fresh.filter((r) => !r.exclusive).map((r) => r.label),
    newTiming: fresh.filter((r) => r.exclusive).map((r) => r.label),
    suites: before.length,
    steps: serialMerge.results.filter((r) => !r.skipped).length,
  };
}

export const USAGE = `usage: node scripts/compare-check-runs.mjs --serial=<folder> [--parallel=<folder>]

Compares a side-by-side check:merge with a serial one, from the check-merge.json and gpu-packages.json in each folder.

Options:
  --serial=<folder>          the serial run's test-results folder
  --parallel=<folder>        the new run's test-results folder (default test-results)
  -h, --help                 print this help and exit

Example:
  node scripts/compare-check-runs.mjs --serial=../margoengine-wt-lookat/test-results`;

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  exitOnHelp(USAGE);
  const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3),
    serial = arg('serial'),
    parallel = arg('parallel') ?? 'test-results';
  if (!serial) throw new TypeError('name the serial run: --serial=<its test-results folder>');
  const load = (dir, file) => JSON.parse(readFileSync(join(resolve(dir), file), 'utf8'));
  const result = compareRuns({
    serialMerge: load(serial, 'check-merge.json'),
    serialGpu: load(serial, 'gpu-packages.json'),
    parallelMerge: load(parallel, 'check-merge.json'),
    parallelGpu: load(parallel, 'gpu-packages.json'),
  });
  console.log(`compared ${result.steps} steps and ${result.suites} suites of the serial run`);
  if (result.newSuites.length) console.log(`new suites, not in the serial run: ${result.newSuites.join(', ')}`);
  if (result.newTiming.length) console.log(`new timing suites, not in the serial run: ${result.newTiming.join(', ')}`);
  for (const problem of result.problems) console.error(`DIFFERENT: ${problem}`);
  console.log(result.ok ? 'SAME WORK: every step and suite ran and passed' : `${result.problems.length} differences`);
  process.exitCode = result.ok ? 0 : 1;
}
