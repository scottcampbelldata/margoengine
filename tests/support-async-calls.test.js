// Bug 70 follow-up: the react extras browser test, reworked for bug 70 to retake its screenshot until the scene is
// drawn, called `decodePNG` from tests/support/png.js without `await`. The helper is
// async, so the "picture" was a Promise; reading its pixels threw `Cannot read properties of undefined` on the first
// sample and check:merge failed before any frame was judged. This finds every call to an async helper exported by
// tests/support or scripts/support that is not awaited, returned or handed to a Promise combinator. A promise kept in a
// variable counts as awaited when `await <variable>` follows inside the block that declares the variable: the run
// limit in scripts/rust-kernel-tests.mjs sets `ended = endTree(pid)` in a timer and its exit handler awaits `ended`.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import test from 'node:test';

const root = new URL('..', import.meta.url);
const SUPPORT = /^(?:tests|scripts)\/support\/[^/]+\.m?js$/;
const ASYNC_EXPORT = /^export\s+(?:async\s+function\s+([A-Za-z_$][\w$]*)|const\s+([A-Za-z_$][\w$]*)\s*=\s*async\b)/gm;
const IMPORT = /import\s*\{([^}]*)\}\s*from\s*['"](\.{1,2}\/[^'"]+)['"]/g;
// What may stand right before a call whose promise is used: awaited, returned, the body of an arrow function, yielded,
// handed to assert.rejects, or an element of the array handed to a Promise combinator.
const SETTLED_BEFORE =
  /(?:\bawait|\breturn|=>|\byield|\bassert\.(?:rejects|doesNotReject)\()\s*$|\bPromise\.(?:all|allSettled|race|any)\(\s*\[[^\]]*$/;
// What may follow the call's closing parenthesis instead: a handler chained on the promise.
const SETTLED_AFTER = /^\s*\.(?:then|catch|finally)\(/;
const DEFINITION = /\bfunction\s*\*?\s*$/;
// The variable a call's promise is assigned to, as in `x = helper(` or `const x = helper(` (not `==`, `+=` or `.x =`).
const ASSIGNED = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*=\s*$/;

/** The names a support file exports as async functions. */
export function asyncExports(source) {
  return [...source.matchAll(ASYNC_EXPORT)].map((match) => match[1] ?? match[2]);
}

/** Local names that `file` binds, by relative import, to async exports of each support file in `helpers`. */
export function importedAsync(file, source, helpers) {
  const local = [];
  for (const [, list, from] of source.matchAll(IMPORT)) {
    const names = helpers.get(posix.normalize(posix.join(posix.dirname(file), from)));
    if (!names) continue;
    for (const item of list.split(',')) {
      const [name, alias] = item.trim().split(/\s+as\s+/);
      if (names.includes(name)) local.push(alias ?? name);
    }
  }
  return local;
}

/** Calls of `names` in `source` whose promise is dropped, as `file:line name`. */
export function unawaitedCalls(file, source, names) {
  const found = [];
  for (const name of names) {
    const CALL = new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}\\s*\\(`, 'g');
    for (const match of source.matchAll(CALL)) {
      if (inComment(source, match.index) || inString(source, match.index)) continue;
      const before = source.slice(Math.max(0, match.index - 400), match.index);
      if (DEFINITION.test(before) || SETTLED_BEFORE.test(before)) continue;
      if (SETTLED_AFTER.test(source.slice(closing(source, match.index + match[0].length)))) continue;
      if (awaitedLater(source, match.index, before)) continue;
      found.push(`${file}:${source.slice(0, match.index).split('\n').length} ${name}`);
    }
  }
  return found;
}

/**
 * Whether `at` is inside a quoted string on its line, where a helper's name followed by `(` is a label or a message,
 * not a call: tests/process-kill.test.js labels its cases 'endTree(child)', and tests/check-downloads.test.js says
 * "with pinnedFiles (scripts/support/pinned-files.mjs)" in an assert message.
 */
function inString(source, at) {
  const line = source.slice(source.lastIndexOf('\n', at - 1) + 1, at);
  return /['"`]/.test(line.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, ''));
}

/**
 * Whether `at` is inside a comment, where a helper's name followed by `(` is prose, not a call: after `//` outside a
 * string on its line, or inside a block comment. scripts/check-dev-servers.mjs explains in a comment that "probe()
 * fails a server", and the checker read that as a dropped promise.
 */
function inComment(source, at) {
  const opened = source.lastIndexOf('/*', at),
    shut = source.lastIndexOf('*/', at);
  if (opened >= 0 && opened > shut && !/['"`]/.test(source.slice(source.lastIndexOf('\n', opened) + 1, opened)))
    return true;
  const line = source.slice(source.lastIndexOf('\n', at - 1) + 1, at);
  return /\/\//.test(line.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, ''));
}

/**
 * Whether the call at `at` assigns its promise to a variable that is awaited or returned after the call (plainly, or
 * with a `.then`, `.catch` or `.finally` chained on it), inside the innermost enclosing block that declares that
 * variable (its function, for a `let` at the top of the function). A returned promise is the caller's to settle, as
 * scripts/lib/browser.mjs's close returns `closing` or `closing.catch(...)`.
 */
function awaitedLater(source, at, before) {
  const name = ASSIGNED.exec(before)?.[1];
  if (!name) return false;
  const AWAITED = new RegExp(
    `\\b(?:await|return)\\s+${name.replace(/\$/g, '\\$')}(?:(?![\\w$.(\\[])|\\s*\\.(?:then|catch|finally)\\()`,
  );
  for (const [open, close] of enclosingBlocks(source, at))
    if (declares(ownText(source.slice(open + 1, close)), name)) return AWAITED.test(source.slice(at, close));
  return false;
}

/** [open, close] brace indices of each block around `at`, innermost first, then the whole file as [-1, length]. */
function enclosingBlocks(source, at) {
  const blocks = [];
  let depth = 0;
  for (let i = at - 1; i >= 0; i--) {
    if (source[i] === '}') depth++;
    else if (source[i] === '{') {
      if (depth > 0) depth--;
      else blocks.push([i, closing(source, i + 1, '{', '}') - 1]);
    }
  }
  return [...blocks, [-1, source.length]];
}

/** A block's own text: every nested `{...}` group emptied, so a nested function's declarations do not count. */
function ownText(text) {
  for (let last; last !== text; ) [last, text] = [text, text.replace(/\{[^{}]*\}/g, '')];
  return text;
}

/** Whether `text` declares `name` with `let`, `const` or `var`, as any declarator of the statement. */
function declares(text, name) {
  for (const match of text.matchAll(/\b(?:let|var|const)\s+/g)) {
    let depth = 0,
      start = match.index + match[0].length;
    for (let i = start; i <= text.length; i++) {
      const char = text[i] ?? ';';
      if (char === '(' || char === '[') depth++;
      else if (char === ')' || char === ']') depth--;
      // A declarator ends at a comma or semicolon outside brackets, or at the `)` that closes a `for (...)` head.
      if (depth > 0 || (depth === 0 && char !== ',' && char !== ';')) continue;
      if (/^\s*([A-Za-z_$][\w$]*)/.exec(text.slice(start, i))?.[1] === name) return true;
      if (char !== ',') break;
      start = i + 1;
    }
  }
  return false;
}

/** The index just past the bracket (a parenthesis by default) that closes the one opened right before `from`. */
function closing(source, from, open = '(', close = ')') {
  let depth = 1,
    at = from;
  while (at < source.length && depth > 0) {
    const char = source[at++];
    if (char === open) depth++;
    else if (char === close) depth--;
  }
  return at;
}

/** Every tracked script that drops the promise of an async support helper. */
export function unawaitedSupportCalls(read = (file) => readFileSync(new URL(file, root), 'utf8')) {
  const files = execFileSync('git', ['ls-files', '*.js', '*.mjs'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 })
    .split('\n')
    .filter((file) => file && !/(^|\/)node_modules\/|(^|\/)dist\//.test(file));
  const helpers = new Map(
    files
      .filter((file) => SUPPORT.test(file))
      .map((file) => [file, asyncExports(read(file))])
      .filter(([, names]) => names.length),
  );
  const found = [];
  for (const file of files) {
    const source = read(file);
    if (!source.includes('/support/') && !SUPPORT.test(file)) continue;
    const local = importedAsync(file, source, helpers);
    if (local.length) found.push(...unawaitedCalls(file, source, local));
  }
  return found;
}

test('every call to an async support helper is awaited (bug 70)', () => {
  const found = unawaitedSupportCalls();
  assert.deepEqual(found, [], `these calls drop the helper's promise; add \`await\`:\n  ${found.join('\n  ')}`);
});

test('the checker finds an unawaited decodePNG and accepts the awaited forms', () => {
  assert.deepEqual(asyncExports('export async function decodePNG(bytes) {}\nexport const headless = async () => 1;'), [
    'decodePNG',
    'headless',
  ]);
  const helpers = new Map([['tests/support/png.js', ['decodePNG']]]);
  const source = [
    "import { decodePNG as decode } from '../../../tests/support/png.js';",
    'const a = decode(',
    '  await page.screenshot(),',
    ');',
    'const b = await decode(bytes);',
    'const c = () => decode(bytes);',
    'const d = await Promise.all([decode(x), decode(y)]);',
    'function e() { return decode(bytes); }',
    'await assert.rejects(decode(new Uint8Array(1)), /Invalid/);',
    'decode(bytes).then((image) => use(image));',
    'decode(bytes);',
  ].join('\n');
  const file = 'packages/react/scripts/x.js';
  assert.deepEqual(importedAsync(file, source, helpers), ['decode']);
  assert.deepEqual(importedAsync('elsewhere/x.js', source, helpers), []);
  assert.deepEqual(unawaitedCalls(file, source, ['decode']), [`${file}:2 decode`, `${file}:11 decode`]);
});

// Regression (992f6fd6a1): a comment in scripts/check-dev-servers.mjs that says "probe() fails a server" failed this
// gate as a dropped promise. Prose in comments is not a call; a real dropped call on a line with a URL string still is.
test('a helper named in a comment is not a call, and a dropped call beside a URL string is still found', () => {
  const source = [
    "import { probe } from './support/dev-server.mjs';",
    '// probe() fails a server that exits',
    '/* every server goes through',
    '   probe() first */',
    "const page = 'http://127.0.0.1/'; probe(page);",
    'run(); // then probe(page) once more',
    'probe(page);',
  ].join('\n');
  assert.deepEqual(unawaitedCalls('scripts/x.mjs', source, ['probe']), [
    'scripts/x.mjs:5 probe',
    'scripts/x.mjs:7 probe',
  ]);
});

// Regression: a case label 'endTree(child)' in tests/process-kill.test.js and an assert message naming
// "pinnedFiles (scripts/...)" in tests/check-downloads.test.js failed this gate as dropped promises.
test('a helper named inside a string is not a call, and a dropped call after a string still is', () => {
  const source = [
    "import { endTree } from './support/shutdown.mjs';",
    "const cases = [['endTree(child)', async (c) => await endTree(c)]];",
    "assert.ok(x, 'a check ends with endTree (scripts/support/shutdown.mjs)');",
    "const label = 'x'; endTree(child);",
  ].join('\n');
  assert.deepEqual(unawaitedCalls('tests/x.test.js', source, ['endTree']), ['tests/x.test.js:4 endTree']);
});

test('the checker accepts a promise kept in a variable and awaited later in its function, and nothing looser', () => {
  const source = [
    "import { endTree } from './support/shutdown.mjs';",
    'function run(child, limitMs) {',
    '  return new Promise((done) => {',
    '    let timedOut = false,',
    '      ended = Promise.resolve([]);',
    '    const timer = setTimeout(() => {',
    '      timedOut = true;',
    '      ended = endTree(child.pid);',
    '    }, limitMs);',
    '    const finish = async (code) => {',
    '      clearTimeout(timer);',
    '      await ended;',
    '      done(code);',
    '    };',
    "    child.once('exit', finish);",
    '  });',
    '}',
    'function kept(pid) {',
    '  const stopping = endTree(pid);',
    '  log(stopping);',
    '}',
    'function elsewhere(pid) {',
    '  let gone;',
    '  gone = endTree(pid);',
    '}',
    'async function other() {',
    '  let gone;',
    '  await gone;',
    '}',
    'async function ready(pid) {',
    '  const quick = endTree(pid);',
    '  await quick.unused;',
    '  const later = endTree(pid);',
    '  await later;',
    '}',
    'function handed(pid, host) {',
    '  const closing = endTree(pid);',
    '  if (!host) return closing;',
    '  return closing.catch(() => {});',
    '}',
    'function chained(pid) {',
    '  const quiet = endTree(pid);',
    '  quiet.catch(() => {});',
    '}',
  ].join('\n');
  const file = 'scripts/x.mjs';
  // Line 8 is accepted (declared on line 5, awaited on line 12 in the same function); 19 is never awaited, 24 is
  // awaited only in another function, 31 only has a property of it awaited. Line 37 is returned (plainly and with a
  // catch chained), so its caller settles it; 42 has a catch chained but is neither awaited nor returned.
  assert.deepEqual(unawaitedCalls(file, source, ['endTree']), [
    `${file}:19 endTree`,
    `${file}:24 endTree`,
    `${file}:31 endTree`,
    `${file}:42 endTree`,
  ]);
});
