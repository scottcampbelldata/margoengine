// `npm run check:xr-runs`: what real headsets and phones have run. Reads docs/xr-device-runs/*.json, the records
// `@margoengine/xr/device-check` writes, and prints which routes are proven.
//   node scripts/check-xr-runs.mjs             fails on a malformed record, or on a known-bugs entry out of step
//   node scripts/check-xr-runs.mjs --release   also fails while any route has no real run
// A record is proof only when the browser's own navigator.xr ran it and a person confirmed what they saw.
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkXRRun, xrRunGaps, XR_RUN_TARGETS } from '../packages/shared/xr-run.js';

/** The known-bugs heading that stays open until every route is proven. */
export const OPEN_HEADING = '### WebXR: no run on a real headset or AR phone';

/** The records of `folder`: {file, run} per JSON file. */
export function readRuns(folder) {
  return readdirSync(folder)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((file) => ({ file, run: JSON.parse(readFileSync(join(folder, file), 'utf8')) }));
}

/** What the records prove: `problems` (what cannot stand), and per route the first proving file or the gaps. */
export function judge(runs, knownBugs) {
  const problems = [];
  for (const { file, run } of runs)
    for (const problem of checkXRRun(run))
      problems.push(`${file}: ${problem}; rerun it with @margoengine/xr/device-check`);
  const usable = runs.filter(({ run }) => !checkXRRun(run).length),
    targets = XR_RUN_TARGETS.map((target) => {
      const proof = usable.find(({ run }) => !xrRunGaps(run, target).length);
      return {
        target,
        proof: proof?.file,
        gaps: proof ? [] : usable.map(({ file, run }) => `${file}: ${xrRunGaps(run, target).join(', ')}`),
      };
    }),
    open = targets.filter((entry) => !entry.proof),
    listed = knownBugs.includes(OPEN_HEADING);
  if (open.length && !listed)
    problems.push(`docs/known-bugs.md has no "${OPEN_HEADING}" entry and ${open.length} routes have no run; add it`);
  if (!open.length && listed) problems.push(`Every route has a real run; remove "${OPEN_HEADING}" from known-bugs.md`);
  return { problems, targets, open };
}

async function main() {
  const root = resolve(import.meta.dirname, '..'),
    { problems, targets, open } = judge(
      readRuns(join(root, 'docs/xr-device-runs')),
      readFileSync(join(root, 'docs/known-bugs.md'), 'utf8'),
    );
  for (const { target, proof, gaps } of targets) {
    console.log(`${proof ? 'PROVEN ' : 'NOT RUN'} ${target.id}: ${proof ?? `needs ${target.needs}`}`);
    for (const gap of gaps) console.log(`        ${gap}`);
  }
  if (process.argv.includes('--release') && open.length)
    problems.push(`${open.length} routes have no real run: open examples/xr-device-check on each device`);
  for (const problem of problems) console.error(problem);
  if (problems.length) process.exit(1);
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
