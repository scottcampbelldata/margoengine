// Bug 70 follow-up: the react extras browser test, reworked for bug 70 to retake its screenshot until the scene is
// drawn, called `decodePNG` from tests/support/png.js without `await`. The helper is
// async, so the "picture" was a Promise; reading its pixels threw `Cannot read properties of undefined` on the first
// sample and check:merge failed before any frame was judged. This finds every call to an async helper exported by
// tests/support or scripts/support that is not awaited, returned or handed to a Promise combinator.
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
      const before = source.slice(Math.max(0, match.index - 400), match.index);
      if (DEFINITION.test(before) || SETTLED_BEFORE.test(before)) continue;
      if (SETTLED_AFTER.test(source.slice(closing(source, match.index + match[0].length)))) continue;
      found.push(`${file}:${source.slice(0, match.index).split('\n').length} ${name}`);
    }
  }
  return found;
}

/** The index just past the parenthesis that closes the one opened right before `from`. */
function closing(source, from) {
  let depth = 1,
    at = from;
  while (at < source.length && depth > 0) {
    const char = source[at++];
    if (char === '(') depth++;
    else if (char === ')') depth--;
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
