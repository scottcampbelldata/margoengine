// Quality gate (`npm run quality`, part of `npm run verify` and CI): five ratchets over packages/, each against a
// checked-in baseline in scripts/quality/baselines/<gate>.json. A gate passes on what the baseline records and fails on
// anything new or worse, with the fix in the message. See docs/conventions.md, "Quality gate".
//   sizes        gzip budget per package entry and worker; static imports of another package's heavy entry (leaks)
//   duplicates   code blocks copied between packages; value re-exports of another package's API
//   tests        every package tested in verify; every public entry imported by a test
//   api          TSDoc on public exports; throws follow docs/conventions.md (via npm run hygiene)
//   clean-room   no three.js / Babylon / other engines in packages/**; no unlisted third-party dependency
// Needs `npm run build:packages` and current api/ reports (sizes and api read dist/).
// Options: --gate=a,b (run some), --update (write shrunk baselines), --update --reason="..." (accept growth, logged),
// --summary (print the biggest offenders), --details (write test-results/quality.json with every item and block).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { stalePackages } from './package-stamps.mjs';
import { apiGate } from './quality/api.js';
import { cleanRoomGate } from './quality/clean-room.js';
import { duplicatesGate } from './quality/duplicates.js';
import { packageList, repoFiles } from './quality/packages.js';
import { compare, readBaseline, staleTotal, updateBaseline } from './quality/ratchet.js';
import { sizesGate } from './quality/sizes.js';
import { testsGate } from './quality/tests-floor.js';

const root = resolve(import.meta.dirname, '..');
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const update = process.argv.includes('--update');
const reason = arg('reason');

const GATES = {
  sizes: {
    run: sizesGate,
    about:
      'gzip budget per entry/worker (measured + max(3%, 256 B)); leak items: static loads of another package heavy entry',
    fix: 'make the entry smaller or move the import behind import(); a deliberate growth needs --update --reason',
  },
  duplicates: {
    run: duplicatesGate,
    about:
      'duplicated lines per package pair (8-line normalised windows); reexport items: value re-exports across packages',
    fix: 'move the shared code into one package (or packages/shared) and import it',
  },
  tests: {
    run: testsGate,
    about: 'packages with no test in verify; public entries no test imports',
    fix: 'add a test under packages/<dir>/tests/ that imports the entry',
  },
  api: {
    run: apiGate,
    about: 'undocumented public exports (tsdoc), bare Error throws and throw messages that name no fix, per file',
    fix: 'add a /** */ comment; throw TypeError, RangeError or MargoError with a code; end the message with the fix',
  },
  'clean-room': {
    run: cleanRoomGate,
    about: 'three.js / Babylon / graphics-library mentions per file in packages/**; third-party runtime dependencies',
    fix: 'remove the mention or move the comparison to docs/ or benchmarks/; drop the dependency or write our own',
  },
};

const only = arg('gate')?.split(',');
// A bare gate name used to be ignored, so `sizes --update --reason=x` wrote every gate's baseline and accepted any failure.
const stray = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (stray) {
  console.error(`quality: unknown argument ${stray}; name a gate with --gate=${stray}`);
  process.exit(2);
}
if (reason && !only) {
  console.error('quality: --reason accepts growth, so it needs one gate; add --gate=<gate>');
  process.exit(2);
}
const started = performance.now();
const files = repoFiles(root);
const packages = packageList(root, files);
const report = {};
let failed = 0;
for (const [gate, def] of Object.entries(GATES)) {
  if (only && !only.includes(gate)) continue;
  const t0 = performance.now();
  const result = await def.run({ root, files, packages });
  const baseline = readBaseline(root, gate);
  const { worse, better } = compare(result.items, baseline, result.allowance);
  const ms = Math.round(performance.now() - t0);
  const count = Object.keys(result.items).length;
  report[gate] = { count, worse, better, items: result.items, ...result.details };
  if (process.argv.includes('--summary') && result.summary)
    console.log(`quality ${gate} biggest:\n${result.summary().join('\n')}`);
  if (update) {
    // Bug (2026-11-11): a lane rebased onto other lanes' size growth, kept its old dist of those packages, and
    // `--update` shrank their freshly raised budgets to the stale sizes (video/record 1,996 to 1,460), which failed
    // main for everyone. Budgets of packages whose dist does not match the checked-out sources stay as recorded.
    const stale = result.owner ? new Set(stalePackages(root)) : new Set();
    const frozen = (key) => stale.has(result.owner(key));
    const { grown } = updateBaseline(root, gate, def.about, result.items, baseline, {
      allowance: result.allowance,
      reason,
      frozen,
    });
    const kept = Object.keys(result.items).filter(frozen).length;
    console.log(
      `quality ${gate}: baseline written, ${count} items${grown.length ? `, ${grown.length} grown` : ''}` +
        (kept
          ? `; ${kept} items of ${stale.size} stale package build(s) kept as recorded (rebuild to update them)`
          : ''),
    );
    continue;
  }
  const sum = staleTotal(baseline);
  if (sum !== undefined) {
    failed++;
    console.error(
      `quality ${gate}: FAIL, the baseline total ${baseline.total} is not the sum of its items, ${sum} (a hand-settled merge). Fix: npm run quality -- --gate=${gate} --update.`,
    );
  }
  if (worse.length) {
    failed++;
    console.error(`quality ${gate}: FAIL, ${worse.length} new or worse (${count} items, ${ms} ms). Fix: ${def.fix}.`);
    for (const w of worse.slice(0, 25))
      console.error(`  ${w.key}: ${w.value}${w.limit === null ? ' (new)' : ` > ${w.limit}`}`);
    if (worse.length > 25) console.error(`  ... ${worse.length - 25} more (--details lists all)`);
    for (const w of worse.slice(0, 5))
      if (result.sides && w.key.includes(' | ')) console.error(`  ${w.key}: ${result.sides(w.key).join(' ~ ')}`);
  } else console.log(`quality ${gate}: ok, ${count} baselined items (${ms} ms)`);
  // Counts are exact, so an improvement must be locked in; byte budgets only suggest it.
  if (better.length && gate !== 'sizes') {
    failed++;
    console.error(
      `quality ${gate}: ${better.length} item(s) improved (${better
        .slice(0, 3)
        .map((b) => b.key)
        .join('; ')}); lock it in: npm run quality -- --gate=${gate} --update`,
    );
  } else if (better.length)
    console.log(`quality ${gate}: ${better.length} budgets can shrink (npm run quality -- --gate=${gate} --update)`);
}
if (process.argv.includes('--details')) {
  mkdirSync(join(root, 'test-results'), { recursive: true });
  writeFileSync(join(root, 'test-results/quality.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('Details: test-results/quality.json');
}
console.log(`quality: ${Math.round(performance.now() - started)} ms`);
if (failed) process.exitCode = 1;
