// Fixed waits in GPU and browser checks: a loop of N frames, `waitForTimeout(ms)` or `setTimeout(resolve, ms)` that
// stands in for "the pipelines compiled", "the meshes arrived" or "the page drew". Five checks failed on an Intel Arc
// 140V that way (docs/known-bugs.md): its driver compiles and its CPU meshes more slowly than this PC, so 20 frames or
// 300 ms were not enough there. Wait for the readiness itself instead (scripts/support/gpu-ready.js waitForPipelines,
// a package's own stats such as VoxelRenderer's `pending` and `compiling`, a draw that returns whether it drew).
// The same in unit tests (*.test.js, added 2026-10-31): half a second's sleep before an assert stands in for "the process
// has gone", and a promise raced against two seconds for "the lock came"; both pass on a quiet machine and fail under
// an 8-way run. Poll the condition instead, with a long bound that only a real failure reaches. (Counted frame loops in
// a unit test step a mock, so only sleeps count there.)
// A wait that really is about time (an animation clock, a debounce, a settle period the test measures, a check that
// nothing happens) carries a `// fixed-wait: <reason>` comment on its line or the line above.
// The opposite slip counts too: Playwright's page.waitForFunction does not await its predicate, so an async predicate
// returns a promise, which is truthy, and the wait ends at once whatever the condition says (tests/catalog.test.js read
// the clipboard that way, 2026-10-31). No comment allows it: such a wait never has a reason to exist.
// The waits that were there when this check began are counted per file in scripts/fixed-waits-baseline.json; a file
// may not gain one, and when one goes the count must go down with it (`--update` writes the lower counts). Unit tests
// and helper-named sleeps joined on 2026-10-31, with what was there then.
//   node scripts/check-fixed-waits.mjs [--update]   (tests/check-fixed-waits.test.js runs the same check in verify)
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const BASELINE = join(root, 'scripts/fixed-waits-baseline.json');

/** Folders never scanned: dependencies, builds, benchmarks (their warm-up frames are part of the measurement). */
const SKIP =
  /(^|\/)(node_modules|dist|build|\.git|\.claude|private|test-results|site|bench|benchmarks|[^/]*-benchmarks|vendor|third_party)(\/|$)/;

/** Files that run or drive a check: test folders, unit tests included, and the browser test drivers in scripts/. */
export function isCheckFile(path) {
  const p = path.replaceAll('\\', '/');
  if (SKIP.test(p) || !/\.(html|js|mjs|ts)$/.test(p) || /\.d\.ts$|check-fixed-waits\.test\.js$/.test(p)) return false;
  if (/(^|\/)bench[^/]*$/i.test(p) || /benchmark/i.test(p)) return false;
  return (
    /(^|\/)(tests?)\//.test(p) ||
    /^scripts\/[^/]*(browser|test|check|visual|modern|quickstart)[^/]*\.(js|mjs)$/.test(p) ||
    /^(packages|examples)\/[^/]+\/scripts\/[^/]*(browser|test|check)[^/]*\.(js|mjs)$/.test(p)
  );
}

// A counted loop: `for (let i = 0; i < 20; i++)` (the bound a number, nothing else in the condition).
const FRAME_LOOP = /for\s*\(\s*let\s+(\w+)\s*=\s*0\s*;\s*\1\s*<\s*(\d+)\s*;\s*\1\s*\+\+\s*\)/g;
// Drawing or waiting for a frame.
const FRAME_WORK = /\brender\s*\(|requestAnimationFrame|\bframes?\s*\(|\bnextFrame\s*\(/;
// A sleep: `waitForTimeout(ms)`, `setTimeout(resolve, ms)`, `setTimeout(() => resolve(), ms)`, a test's helper
// `sleep(ms)`, `wait(ms)` or `delay(ms)`, or a promise raced against a time and expected to win, `settled(p, ms)`
// (one that expects 'waiting' checks that nothing happens: mark it).
const SLEEP =
  /waitForTimeout\s*\(\s*([\d_]+)\s*\)|setTimeout\s*\(\s*(?:\w+|\(\)\s*=>\s*\w+\(\))\s*,\s*([\d_]+)\s*\)|\b(?:sleep|wait|delay)\(\s*([\d_]+)\s*\)|\bsettled\(.*?,\s*([\d_]+)\s*\)/g;
/** Sleeps shorter than this are poll intervals inside a loop that checks a condition, not a wait on their own. */
export const MIN_SLEEP_MS = 50;
// An async predicate given to waitForFunction, on one line or split over several: a wait that ends at once.
const ASYNC_PREDICATE = /\bwaitForFunction\s*\(\s*async\b/g;

/** The loop body after a `for (...)` header ending at `from`: the braced block or the single statement. */
function bodyAt(source, from) {
  let i = from;
  while (/\s/.test(source[i] ?? '')) i++;
  if (source[i] !== '{') return source.slice(i, source.indexOf(';', i) + 1 || undefined);
  for (let depth = 0, j = i; j < source.length; j++) {
    depth += source[j] === '{' ? 1 : source[j] === '}' ? -1 : 0;
    if (depth === 0) return source.slice(i, j + 1);
  }
  return source.slice(i);
}

/**
 * The fixed waits in `source`: [{ line, kind, text }]. `frames`: a counted loop of 2 or more whose body draws or
 * waits for a frame (a body that times itself with performance.now() is a measurement, and one that renders with a
 * non-zero delta steps time; both pass). `ms`: a sleep of
 * MIN_SLEEP_MS or more. A `fixed-wait: <reason>` comment on the line or the line above allows either. `async
 * predicate`: a waitForFunction that cannot wait; no comment allows it.
 */
export function fixedWaits(source) {
  const lines = source.split('\n'),
    found = [],
    lineOf = (index) => source.slice(0, index).split('\n').length;
  const allowed = (n) => /fixed-wait:\s*\S/.test(lines[n - 1]) || (n > 1 && /fixed-wait:\s*\S/.test(lines[n - 2]));
  for (const m of source.matchAll(FRAME_LOOP)) {
    if (Number(m[2]) < 2) continue;
    const body = bodyAt(source, m.index + m[0].length),
      n = lineOf(m.index);
    // Frames that advance time (a delta other than 0) step a simulation or animation; those are counts by design.
    const steps = /delta\s*:\s*(?!0\s*[,}])[^,}\s]/.test(body);
    if (FRAME_WORK.test(body) && !steps && !/performance\.now\(\)/.test(body) && !allowed(n))
      found.push({ line: n, kind: 'frames', text: lines[n - 1].trim() });
  }
  for (const m of source.matchAll(SLEEP)) {
    const ms = Number((m[1] ?? m[2] ?? m[3] ?? m[4]).replaceAll('_', '')),
      n = lineOf(m.index);
    if (ms >= MIN_SLEEP_MS && !allowed(n)) found.push({ line: n, kind: 'ms', text: lines[n - 1].trim() });
  }
  for (const m of source.matchAll(ASYNC_PREDICATE)) {
    const n = lineOf(m.index);
    found.push({ line: n, kind: 'async predicate', text: lines[n - 1].trim() });
  }
  return found.sort((a, b) => a.line - b.line);
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name),
      rel = relative(root, path).replaceAll('\\', '/');
    if (SKIP.test(rel)) continue;
    if (entry.isDirectory()) walk(path, out);
    else if (isCheckFile(rel)) out.push(rel);
  }
  return out;
}

/** Every check file in the tree, as repository paths, sorted. */
export const checkFiles = () => walk(root).sort();

/** { file: [waits] } for every check file with a fixed wait. */
export function scan() {
  const result = {};
  for (const file of checkFiles()) {
    const waits = fixedWaits(readFileSync(join(root, file), 'utf8')).filter(
      (wait) => wait.kind !== 'frames' || !file.endsWith('.test.js'),
    );
    if (waits.length) result[file] = waits;
  }
  return result;
}

if (import.meta.url === `file:///${process.argv[1]?.replaceAll('\\', '/').replace(/^\//, '')}`) {
  const found = scan(),
    baseline = JSON.parse(readFileSync(BASELINE, 'utf8')),
    problems = [],
    lower = {};
  for (const [file, waits] of Object.entries(found)) {
    const allowed = baseline.files[file] ?? 0;
    if (waits.length > allowed)
      problems.push(
        `${file}: ${waits.length} fixed waits (baseline ${allowed}):\n${waits.map((w) => `  ${w.line}: ${w.kind}: ${w.text}`).join('\n')}`,
      );
  }
  for (const [file, allowed] of Object.entries(baseline.files)) {
    // A file not in this tree yet has nothing to compare.
    if (!existsSync(join(root, file))) continue;
    const now = found[file]?.length ?? 0;
    if (now < allowed) lower[file] = now;
  }
  if (process.argv.includes('--update')) {
    for (const [file, now] of Object.entries(lower)) if (now) baseline.files[file] = now;
    for (const file of Object.keys(lower)) if (!lower[file]) delete baseline.files[file];
    writeFileSync(BASELINE, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(`fixed-waits baseline lowered for ${Object.keys(lower).length} files`);
  } else if (Object.keys(lower).length)
    problems.push(
      `fewer fixed waits than the baseline in ${Object.keys(lower).join(', ')}: run node scripts/check-fixed-waits.mjs --update`,
    );
  if (problems.length) {
    console.error(
      `Fixed waits in checks. Wait for readiness instead (scripts/support/gpu-ready.js, or poll the condition in a unit test), or mark a wait that is really about time with // fixed-wait: <reason>.\n${problems.join('\n')}`,
    );
    process.exit(1);
  }
  const total = Object.values(baseline.files).reduce((s, n) => s + n, 0);
  console.log(`fixed waits: none new (${total} known in ${Object.keys(baseline.files).length} files, being removed)`);
}
