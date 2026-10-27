// Fixed waits in GPU and browser checks: a loop of N frames, `waitForTimeout(ms)` or `setTimeout(resolve, ms)` that
// stands in for "the pipelines compiled", "the meshes arrived" or "the page drew". Five checks failed on an Intel Arc
// 140V that way (docs/known-bugs.md): its driver compiles and its CPU meshes more slowly than this PC, so 20 frames or
// 300 ms were not enough there. Wait for the readiness itself instead (scripts/support/gpu-ready.js waitForPipelines,
// a package's own stats such as VoxelRenderer's `pending` and `compiling`, a draw that returns whether it drew).
// A wait that really is about time (an animation clock, a debounce, a settle period the test measures) carries a
// `// fixed-wait: <reason>` comment on its line or the line above.
// The waits that were there when this check began are counted per file in scripts/fixed-waits-baseline.json; a file
// may not gain one, and when one goes the count must go down with it (`--update` writes the lower counts).
//   node scripts/check-fixed-waits.mjs [--update]   (tests/check-fixed-waits.test.js runs the same check in verify)
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const BASELINE = join(root, 'scripts/fixed-waits-baseline.json');

/** Folders never scanned: dependencies, builds, benchmarks (their warm-up frames are part of the measurement). */
const SKIP =
  /(^|\/)(node_modules|dist|build|\.git|\.claude|private|test-results|site|bench|benchmarks|[^/]*-benchmarks|vendor|third_party)(\/|$)/;

/** Files that run or drive a GPU or browser check: test folders and the browser test drivers in scripts/. */
export function isCheckFile(path) {
  const p = path.replaceAll('\\', '/');
  if (SKIP.test(p) || !/\.(html|js|mjs|ts)$/.test(p) || /\.test\.js$|\.d\.ts$/.test(p)) return false;
  if (/(^|\/)bench[^/]*$/i.test(p) || /benchmark/i.test(p)) return false;
  return /(^|\/)(tests?)\//.test(p) || /^scripts\/[^/]*(browser|test|check|visual|modern)[^/]*\.(js|mjs)$/.test(p);
}

// A counted loop: `for (let i = 0; i < 20; i++)` (the bound a number, nothing else in the condition).
const FRAME_LOOP = /for\s*\(\s*let\s+(\w+)\s*=\s*0\s*;\s*\1\s*<\s*(\d+)\s*;\s*\1\s*\+\+\s*\)/g;
// Drawing or waiting for a frame.
const FRAME_WORK = /\brender\s*\(|requestAnimationFrame|\bframes?\s*\(|\bnextFrame\s*\(/;
// A sleep: `waitForTimeout(ms)`, `setTimeout(resolve, ms)` or `setTimeout(() => resolve(), ms)`.
const SLEEP = /waitForTimeout\s*\(\s*(\d+)\s*\)|setTimeout\s*\(\s*(?:\w+|\(\)\s*=>\s*\w+\(\))\s*,\s*(\d+)\s*\)/g;
/** Sleeps shorter than this are poll intervals inside a loop that checks a condition, not a wait on their own. */
export const MIN_SLEEP_MS = 50;

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
 * MIN_SLEEP_MS or more. A `fixed-wait: <reason>` comment on the line or the line above allows it.
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
    const ms = Number(m[1] ?? m[2]),
      n = lineOf(m.index);
    if (ms >= MIN_SLEEP_MS && !allowed(n)) found.push({ line: n, kind: 'ms', text: lines[n - 1].trim() });
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

/** { file: [waits] } for every check file with a fixed wait. */
export function scan() {
  const result = {};
  for (const file of walk(root).sort()) {
    const waits = fixedWaits(readFileSync(join(root, file), 'utf8'));
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
      `Fixed waits in GPU or browser checks. Wait for readiness instead (scripts/support/gpu-ready.js), or mark a wait that is really about time with // fixed-wait: <reason>.\n${problems.join('\n')}`,
    );
    process.exit(1);
  }
  const total = Object.values(baseline.files).reduce((s, n) => s + n, 0);
  console.log(`fixed waits: none new (${total} known in ${Object.keys(baseline.files).length} files, being removed)`);
}
