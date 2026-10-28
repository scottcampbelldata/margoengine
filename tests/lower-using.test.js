// The `using` lowering for Node 22 (scripts/lib/lower-using.mjs, bug 39 level 2): the same scenarios run through the
// lowering (Oxc's transform plus the repository's helper, scripts/lib/using-ctx.mjs) on every Node, and natively where
// the runtime parses `using` (Node 24 and later), and must log the same events. On Node 22 the native half cannot run;
// the test says so in its output and checks that the hook is registered there instead, so neither half is left out
// without a word.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { transformWithOxc } from 'vite';
import { nativeUsing } from '../scripts/lib/lower-using.mjs';
import { USING } from '../scripts/lib/lower-using-hooks.mjs';

const helper = pathToFileURL(resolve(import.meta.dirname, '../scripts/lib/using-ctx.mjs')).href;

/** Each scenario's body runs inside `async function run(log, res)`; `res(name, kind)` makes a logged resource. */
const SCENARIOS = {
  'reverse order': `{ using a = res('a'); using b = res('b'); using c = res('c'); log.push('body'); }`,
  'null and undefined are skipped': `{ using a = null; using b = undefined; using c = res('c'); log.push('body'); }`,
  'a value without Symbol.dispose throws a TypeError at the declaration': `
    try { using a = res('a'); using b = {}; log.push('not reached'); }
    catch (error) { log.push(error.constructor.name); }`,
  'a body error and a dispose error chain as SuppressedError': `
    try { using a = res('a', 'throw'); throw new Error('body'); }
    catch (error) { log.push(error.name, error.error.message, error.suppressed.message); }`,
  'two dispose errors nest': `
    try { using a = res('a', 'throw'); using b = res('b', 'throw'); }
    catch (error) { log.push(error.name, error.error.message, error.suppressed.message); }`,
  'one dispose error alone is rethrown as it is': `
    try { using a = res('a', 'throw'); log.push('body'); }
    catch (error) { log.push(error.name, error.message); }`,
  'early return disposes': `
    const f = () => { using a = res('a'); return 'value'; };
    log.push(f());`,
  'each loop iteration disposes its own resource': `
    for (const name of ['x', 'y']) { using r = res(name); if (name === 'y') break; log.push('after ' + name); }`,
  'for (using ... of ...) disposes each value': `
    for (using r of [res('p'), res('q')]) log.push('saw ' + r.name);`,
  'await using awaits async disposal in reverse order, sync ones included': `
    { await using a = res('a', 'async'); using b = res('b'); await using c = res('c', 'async'); log.push('body'); }
    log.push('after');`,
  'await using falls back to Symbol.dispose': `{ await using a = res('a'); log.push('body'); } log.push('after');`,
  'await using null still awaits': `
    let settled = false; Promise.resolve().then(() => { settled = true; });
    { await using a = null; }
    log.push('awaited ' + settled);`,
  'an async dispose rejection reaches the caller': `
    try { await using a = res('a', 'reject'); log.push('body'); }
    catch (error) { log.push(error.message); }`,
};

const moduleSource = (body) => `export async function run(log, res) {\n${body}\n}\n`;
const resources = (log) => (name, kind) => {
  const r = { name };
  if (kind === 'async' || kind === 'reject')
    r[Symbol.asyncDispose] = async () => {
      await null;
      log.push(`async dispose ${name}`);
      if (kind === 'reject') throw new Error(`reject ${name}`);
    };
  else
    r[Symbol.dispose] = () => {
      log.push(`dispose ${name}`);
      if (kind === 'throw') throw new Error(`throw ${name}`);
    };
  return r;
};
const runModule = async (source) => {
  const { run } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const log = [];
  await run(log, resources(log));
  return log;
};
const lowered = async (body) => {
  const { code } = await transformWithOxc(moduleSource(body), 'scenario.js', { target: 'es2024', lang: 'js' });
  assert.match(code, /usingCtx/, 'the transform lowered nothing');
  return code.replace('@oxc-project/runtime/helpers/usingCtx', helper);
};

/** What each scenario must log (the spec's order of events). */
const EXPECTED = {
  'reverse order': ['body', 'dispose c', 'dispose b', 'dispose a'],
  'null and undefined are skipped': ['body', 'dispose c'],
  'a value without Symbol.dispose throws a TypeError at the declaration': ['dispose a', 'TypeError'],
  'a body error and a dispose error chain as SuppressedError': ['dispose a', 'SuppressedError', 'throw a', 'body'],
  'two dispose errors nest': ['dispose b', 'dispose a', 'SuppressedError', 'throw a', 'throw b'],
  'one dispose error alone is rethrown as it is': ['body', 'dispose a', 'Error', 'throw a'],
  'early return disposes': ['dispose a', 'value'],
  'each loop iteration disposes its own resource': ['after x', 'dispose x', 'dispose y'],
  'for (using ... of ...) disposes each value': ['saw p', 'dispose p', 'saw q', 'dispose q'],
  'await using awaits async disposal in reverse order, sync ones included': [
    'body',
    'async dispose c',
    'dispose b',
    'async dispose a',
    'after',
  ],
  'await using falls back to Symbol.dispose': ['body', 'dispose a', 'after'],
  'await using null still awaits': ['awaited true'],
  'an async dispose rejection reaches the caller': ['body', 'async dispose a', 'reject a'],
};

for (const [name, body] of Object.entries(SCENARIOS))
  test(`lowered: ${name}`, async () => {
    assert.deepEqual(await runModule(await lowered(body)), EXPECTED[name]);
  });

for (const [name, body] of Object.entries(SCENARIOS))
  test(`native: ${name}`, async (t) => {
    if (!nativeUsing) {
      // Node 22 cannot parse the native form; the lowered half above is what runs the repository's tests here.
      t.diagnostic(`Node ${process.version} has no native \`using\`; the lowered form was checked instead`);
      return;
    }
    assert.deepEqual(await runModule(moduleSource(body)), EXPECTED[name]);
  });

test('the hook is registered exactly where the runtime lacks `using`', async () => {
  let parses = true;
  try {
    new Function('{ using resource = null; }');
  } catch {
    parses = false;
  }
  assert.equal(nativeUsing, parses);
  const [major] = process.versions.node.split('.').map(Number);
  assert.equal(nativeUsing, major >= 24, `Node ${process.version}: native \`using\` is expected from Node 24`);
});

test('the prefilter finds declarations and the transform leaves prose alone', async () => {
  assert.ok(USING.test('{ using handle = open(); }'));
  assert.ok(USING.test('  await using r = g();'));
  assert.ok(!USING.test('const using = 1; x.using = 2;'));
  const { code } = await transformWithOxc('// using the cache\nexport const a = 1;\n', 'a.js', {
    target: 'es2024',
    lang: 'js',
  });
  assert.doesNotMatch(code, /usingCtx/);
});
