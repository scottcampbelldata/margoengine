// Wall-clock budgets in checks: an assert that reads a clock (performance.now, Date.now, hrtime) and compares what has
// passed against a fixed number. That measures the machine's other work as much as the code: packages/biomes/tests/
// climate.test.js asked for one tile in under 400 ms, measures about 30 ms alone, and read 714.8 ms during a landing
// with GPU jobs on the PC, which stopped the landing.
// Two honest forms replace it:
//  - A budget on how fast code is: read this thread's CPU time with cpuTimer() from scripts/support/cpu-budget.mjs,
//    which does not count waiting for a CPU. A budget that really is about wall time belongs in a bench.
//  - A bound on a wait, "the 30 s timeout did not run out": wall time is the subject, so the bound sits far from the
//    normal case, near the hang it tells apart, and says so with a `// wall-clock: <reason>` comment on the line or
//    the line above.
// Upper bounds only: a wait that must last at least so long (`>= 55`) cannot fail because the machine is busy. Polling
// for a condition against a deadline (`performance.now() < end`) is a wait for readiness, not a budget.
// What was left when this check began is counted per file in scripts/wall-budgets-baseline.json. A file may not gain
// one, and when one goes the count goes down with it (`--update` writes the lower counts).
//   node scripts/check-wall-budgets.mjs [--update]   (tests/check-wall-budgets.test.js runs the same check in verify)
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { checkFiles } from './check-fixed-waits.mjs';

const root = resolve(import.meta.dirname, '..');
const BASELINE = join(root, 'scripts/wall-budgets-baseline.json');

const CLOCK = String.raw`(?:performance\.now\(\)|Date\.now\(\)|process\.hrtime\.bigint\(\))`;
// `const ms = performance.now() - start`, `each = (Date.now() - t0) / 4`, `ms: Date.now() - begun`.
const ELAPSED = new RegExp(String.raw`\b(\w+)\s*[=:]\s*\(*\s*${CLOCK}\s*-\s*[\w.]+`, 'g');
// `assert.ok(performance.now() - start < 500`, `if (Date.now() - t0 > 20000) throw`.
const DIRECT = new RegExp(String.raw`${CLOCK}\s*-\s*[\w.]+\s*\)*\s*(?:/\s*[\d.]+\s*)?(<=?|>=?)\s*[\w.]+`, 'g');
// Elapsed time read through a variable: `ms < 1000`, or `if (ms > 1000) throw`.
const use = (names) => new RegExp(String.raw`(?<![.\w])(?:${names})\s*(<=?|>=?)\s*[\w.]+`, 'g');

const ASSERTS = /\b(?:assert(?:\.\w+)?|expect|ok)\s*\(/;
const FAILS = /\bthrow\b|\bfail\(|problems\.push|failures\.push/;

/**
 * The wall-clock budgets in `source`: [{ line, text }]. An upper bound on elapsed time, read straight from a clock or
 * through a variable that holds elapsed time, inside an assert or an `if` that fails the check. A
 * `wall-clock: <reason>` comment on the line or the line above allows it.
 */
export function wallBudgets(source) {
  const lines = source.split('\n'),
    code = source.replace(/^[ \t]*\/\/.*$/gm, (comment) => ' '.repeat(comment.length)),
    names = [...new Set([...code.matchAll(ELAPSED)].map((m) => m[1]))],
    lineOf = (index) => code.slice(0, index).split('\n').length,
    seen = new Set(),
    found = [];
  const allowed = (n) => /wall-clock:\s*\S/.test(lines[n - 1]) || (n > 1 && /wall-clock:\s*\S/.test(lines[n - 2]));
  const add = (m) => {
    const n = lineOf(m.index),
      line = lines[n - 1],
      inAssert = m[1][0] === '<' && ASSERTS.test(lines.slice(Math.max(0, n - 4), n).join('\n')),
      inIf = /\bif\s*\(/.test(line) && FAILS.test(lines.slice(n - 1, n + 1).join('\n'));
    if (seen.has(n) || allowed(n) || !(inAssert || inIf)) return;
    seen.add(n);
    found.push({ line: n, text: line.trim() });
  };
  for (const m of code.matchAll(DIRECT)) add(m);
  if (names.length) for (const m of code.matchAll(use(names.join('|')))) add(m);
  return found.sort((a, b) => a.line - b.line);
}

/** { file: [budgets] } for every check file with a wall-clock budget. */
export function scan() {
  const result = {};
  for (const file of checkFiles()) {
    // Its own test spells out what it must catch.
    if (file.endsWith('check-wall-budgets.test.js')) continue;
    const budgets = wallBudgets(readFileSync(join(root, file), 'utf8'));
    if (budgets.length) result[file] = budgets;
  }
  return result;
}

if (import.meta.url === `file:///${process.argv[1]?.replaceAll('\\', '/').replace(/^\//, '')}`) {
  const found = scan(),
    baseline = JSON.parse(readFileSync(BASELINE, 'utf8')),
    problems = [],
    lower = {};
  for (const [file, budgets] of Object.entries(found)) {
    const allowed = baseline.files[file] ?? 0;
    if (budgets.length > allowed)
      problems.push(
        `${file}: ${budgets.length} wall-clock budgets (baseline ${allowed}):\n${budgets.map((b) => `  ${b.line}: ${b.text}`).join('\n')}`,
      );
  }
  for (const [file, allowed] of Object.entries(baseline.files)) {
    // A file not in this tree yet (its branch is still in the landing queue) has nothing to compare.
    if (!existsSync(join(root, file))) continue;
    const now = found[file]?.length ?? 0;
    if (now < allowed) lower[file] = now;
  }
  if (process.argv.includes('--update')) {
    for (const [file, now] of Object.entries(lower)) {
      if (now) baseline.files[file] = now;
      else delete baseline.files[file];
    }
    writeFileSync(BASELINE, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(`wall-budgets baseline lowered for ${Object.keys(lower).length} files`);
  } else if (Object.keys(lower).length)
    problems.push(
      `fewer wall-clock budgets than the baseline in ${Object.keys(lower).join(', ')}: run node scripts/check-wall-budgets.mjs --update`,
    );
  if (problems.length) {
    console.error(
      `Wall-clock budgets in checks measure the machine's other work. For code speed use cpuTimer() from scripts/support/cpu-budget.mjs, or move the budget to a bench. For a bound on a wait, keep it far from normal and mark it // wall-clock: <reason>.\n${problems.join('\n')}`,
    );
    process.exit(1);
  }
  const total = Object.values(baseline.files).reduce((sum, n) => sum + n, 0);
  console.log(`wall-clock budgets: none new (${total} known in ${Object.keys(baseline.files).length} files)`);
}
