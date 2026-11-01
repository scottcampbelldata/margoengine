// bench/suites/size.mjs, the Plaza case (fdb4f46a2): the build keeps main.ts's export, and a build that lost the page's
// code fails instead of passing a budget it no longer checks. vite is replaced, so nothing is built and no GPU is used.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test, { mock } from 'node:test';
import { gzipSync } from 'node:zlib';

const configs = [];
let code = '';
const fakeBuild = async (config) => {
  configs.push(config);
  return { output: [{ type: 'chunk', fileName: 'main.js', isEntry: true, imports: [], code }] };
};
mock.module('vite', { namedExports: { build: fakeBuild } });
const suite = (await import('../bench/suites/size.mjs')).default;

const plaza = async () => {
  const found = (await suite.cases({ external: {}, engines: [] })).find((c) => c.id === 'demo-plaza');
  assert.ok(found, 'the size suite has a Plaza case');
  return found;
};
/** Code that gzips to about `bytes` (random latin1 text barely compresses). */
const codeOf = (bytes) => {
  let text = randomBytes(bytes).toString('latin1');
  while (gzipSync(text).length > bytes) text = text.slice(0, Math.floor(text.length * 0.95));
  return text;
};

test('the Plaza build keeps the entry exports, so index.html can still call start()', async () => {
  code = codeOf(120_000);
  configs.length = 0;
  await (await plaza()).run();
  const rollup = configs.at(-1).build.rollupOptions;
  assert.equal(rollup.preserveEntrySignatures, 'strict');
  assert.match(rollup.input, /examples.voxel-sandbox.src.main.ts$/);
});

test('a Plaza build that lost the page code fails; a whole page passes', async () => {
  code = codeOf(4_634);
  await assert.rejects((await plaza()).run(), /lost the page's code/);
  code = codeOf(120_000);
  const { values } = await (await plaza()).run();
  assert.ok(values.eagerGzip > 75_000 && values.eagerGzip <= 150_227);
  code = codeOf(160_000);
  await assert.rejects((await plaza()).run(), /over its budget/);
});
