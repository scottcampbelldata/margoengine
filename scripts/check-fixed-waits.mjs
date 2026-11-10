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
// Playwright awaits Promise-valued waitForFunction predicates; those poll a condition rather than sleeping.
// The waits that were there when this check began are counted per file in scripts/fixed-waits-baseline.json; a file
// may not gain one, and when one goes the count must go down with it (`--update` writes the lower counts). Unit tests
// and helper-named sleeps joined on 2026-10-31, with what was there then.
//   node scripts/check-fixed-waits.mjs [--update]   (tests/check-fixed-waits.test.js runs the same check in verify)
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createScanner } from 'typescript/unstable/ast/scanner';
import { SyntaxKind } from 'typescript/unstable/ast';

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
 * Whether a loop body reads a list item by its counter, `eyes[i]` or `views.at(i)`: each pass then draws something
 * else (one eye, one view), so the loop walks the list and waits for nothing. Writing by the counter, `times[i] = `,
 * does not count: a wait loop may record each frame it waits through.
 */
function walks(body, counter) {
  const read = new RegExp(
    String.raw`\[\s*${counter}\s*\](?!\s*(?:[-+*/%&|^]|\*\*|<<|>>>?|\?\?|&&|\|\|)?=(?!=))|\.at\(\s*${counter}\s*\)`,
  );
  if (read.test(body)) return true;
  // A subset mask selects different input features each iteration, rather than drawing extra frames to get ready.
  const selectors = /\.filter\(\s*\(([^)]*)\)\s*=>\s*(\w+)\s*&\s*\(\s*1\s*<<\s*(\w+)\s*\)\s*\)/g;
  for (const selector of body.matchAll(selectors)) {
    const parameters = selector[1].split(',').map((name) => name.trim()),
      assignment = /\b(?:const|let)\s+(\w+)\s*=\s*[\w.]+\s*$/.exec(body.slice(0, selector.index));
    if (
      selector[2] === counter &&
      !parameters.includes(counter) &&
      parameters.includes(selector[3]) &&
      assignment &&
      new RegExp(`\\brender\\s*\\(\\s*${assignment[1]}\\s*[,)]`).test(body)
    )
      return true;
  }
  return false;
}

/** Follow lexically scoped local helpers, retaining the existing conservative textual wait detection. */
function controls(source) {
  const scopes = [{ start: 0, end: source.length, parent: null }],
    stack = [scopes[0]],
    scanner = createScanner(true);
  let code = source;
  if (/^\s*</.test(source)) {
    let end = 0;
    code = '';
    for (const m of source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
      const start = m.index + m[0].indexOf('>') + 1;
      code += ' '.repeat(start - end) + m[1];
      end = start + m[1].length;
    }
    code += ' '.repeat(source.length - end);
  }
  scanner.setText(code);
  let previousEnd = -1,
    previous,
    braces = 0;
  const templates = [];
  for (let kind = scanner.scan(); kind !== SyntaxKind.EndOfFile; kind = scanner.scan()) {
    if (kind === SyntaxKind.SlashToken && (!previous || /^(?:[=([{,:;!?]|=>|return|throw|case|yield)$/.test(previous)))
      kind = scanner.reScanSlashToken();
    if (kind === SyntaxKind.CloseBraceToken && templates.at(-1) === braces) {
      kind = scanner.reScanTemplateToken(false);
      if (kind === SyntaxKind.TemplateTail) templates.pop();
    } else if (kind === SyntaxKind.OpenBraceToken) braces++;
    else if (kind === SyntaxKind.CloseBraceToken) braces--;
    if (kind === SyntaxKind.TemplateHead) templates.push(braces);
    previous = scanner.getTokenText();
    if (scanner.getTokenEnd() <= previousEnd) throw Error(`Fixed-wait scanner stopped at ${previousEnd}`);
    previousEnd = scanner.getTokenEnd();
    if (kind === SyntaxKind.OpenBraceToken) {
      const scope = { start: scanner.getTokenStart(), end: source.length, parent: stack.at(-1) };
      scopes.push(scope);
      stack.push(scope);
    } else if (kind === SyntaxKind.CloseBraceToken && stack.length > 1) stack.pop().end = scanner.getTokenEnd();
  }
  const scopeAt = (index) => scopes.findLast((s) => s.start <= index && index < s.end),
    helpers = [];
  const declarations =
    /(?:\b(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>\s*|\b(?:async\s+)?function\s+(\w+)\s*\([^)]*\)\s*)/g;
  for (const m of source.matchAll(declarations))
    helpers.push({ name: m[1] ?? m[2], scope: scopeAt(m.index), body: bodyAt(source, m.index + m[0].length) });
  const bodyOf = (name, index) => {
    for (let scope = scopeAt(index); scope; scope = scope.parent) {
      const helper = helpers.find((h) => h.name === name && h.scope === scope);
      if (helper) return helper.body;
    }
    return '';
  };
  const terminates = (body) => /\.kill\s*\(/.test(body) && !/\b(?:resolve|done)\s*\(/.test(body);
  return {
    timer(index) {
      const tail = source.slice(index),
        named = /^setTimeout\s*\(\s*(\w+)\s*,/.exec(tail);
      if (named) {
        const body = bodyOf(named[1], index);
        if (terminates(body)) return true;
        // Both a success predicate and a rejecting wall-clock deadline are required for a self-scheduled poll.
        return (
          new RegExp(`setTimeout\\s*\\(\\s*${named[1]}\\s*,`).test(body) &&
          /\bif\s*\(/.test(body) &&
          /\breturn\s+resolve\s*\(/.test(body) &&
          /\breject\s*\(/.test(body) &&
          /Date\.now\(\)/.test(body)
        );
      }
      const then = /^(?:delay|sleep|wait)\(\s*[\d_]+\s*\)\.then\(\s*\(\)\s*=>\s*/.exec(tail);
      if (!then) return false;
      const body = bodyAt(source, index + then[0].length);
      return terminates(body.replace(/\b(\w+)\(\)/g, (call, name) => bodyOf(name, index) || call));
    },
    steps(body, index) {
      return [...body.matchAll(/\b(\w+)\s*\(/g)].some((m) =>
        /\brender\s*\([^)]*delta\s*:\s*(?!0\s*[,}])[^,}\s]/.test(bodyOf(m[1], index)),
      );
    },
  };
}

/**
 * The fixed waits in `source`: [{ line, kind, text }]. `frames`: a counted loop of 2 or more whose body draws or
 * waits for a frame (a body that times itself with performance.now() is a measurement, and one that renders with a
 * non-zero delta steps time; one that reads a list item by its counter walks the list, one eye or view a pass; all
 * three pass). `ms`: a sleep of
 * MIN_SLEEP_MS or more, excluding bounded condition polls and process-kill deadlines. A `fixed-wait: <reason>` comment on the line or the line above allows either. Promise-valued waitForFunction predicates are awaited by Playwright and are not fixed waits.
 */
export function fixedWaits(source) {
  const lines = source.split('\n'),
    found = [],
    lineOf = (index) => source.slice(0, index).split('\n').length;
  let control;
  const getControl = () => (control ??= controls(source));
  const allowed = (n) => /fixed-wait:\s*\S/.test(lines[n - 1]) || (n > 1 && /fixed-wait:\s*\S/.test(lines[n - 2]));
  for (const m of source.matchAll(FRAME_LOOP)) {
    if (Number(m[2]) < 2) continue;
    const body = bodyAt(source, m.index + m[0].length),
      n = lineOf(m.index);
    // Frames that advance time (a delta other than 0) step a simulation or animation; those are counts by design.
    const steps = /delta\s*:\s*(?!0\s*[,}])[^,}\s]/.test(body) || getControl().steps(body, m.index);
    if (FRAME_WORK.test(body) && !steps && !walks(body, m[1]) && !/performance\.now\(\)/.test(body) && !allowed(n))
      found.push({ line: n, kind: 'frames', text: lines[n - 1].trim() });
  }
  for (const m of source.matchAll(SLEEP)) {
    const ms = Number((m[1] ?? m[2] ?? m[3] ?? m[4]).replaceAll('_', '')),
      n = lineOf(m.index);
    if (ms >= MIN_SLEEP_MS && !allowed(n) && !getControl().timer(m.index))
      found.push({ line: n, kind: 'ms', text: lines[n - 1].trim() });
  }
  return found.sort((a, b) => a.line - b.line);
}

/**
 * Every check file git tracks under `base`, as paths from there, sorted. Tracked files only: what a change can bring
 * to main is what git holds, and a helper's scratch build in a git-ignored folder (.lane/, .mutation/) is not part of
 * it, so it must not fail the check for anyone. A tracked file deleted in the working tree has nothing to read.
 */
export const checkFiles = (base = root) =>
  execFileSync('git', ['ls-files', '-z'], { cwd: base, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0')
    .filter((file) => isCheckFile(file) && existsSync(join(base, file)))
    .sort();

/** { file: [waits] } for every check file with a fixed wait. */
export function scan(base = root) {
  const result = {};
  for (const file of checkFiles(base)) {
    const waits = fixedWaits(readFileSync(join(base, file), 'utf8')).filter(
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
