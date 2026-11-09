import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { blendRepeatRoot, blendRepeatScene } from '../scripts/reference-rendering/blend-repeat-scene.mjs';

const root = blendRepeatRoot();

test('the default fixture cache is beside the checkout on every platform and an explicit override wins', () => {
  assert.equal(blendRepeatRoot({}), resolve(fileURLToPath(new URL('../../engine-bench/batch-160', import.meta.url))));
  const override = resolve('test-results', 'blend-cache');
  assert.equal(blendRepeatRoot({ MARGO_ENGINE_BENCH: override }), join(override, 'batch-160'));
});

test('raw blend regression preserves every uint32-indexed fixture triangle and its fixed input bytes', {
  timeout: 90000,
}, async () => {
  const data = await blendRepeatScene(root);
  assert.equal(data.inputSha256, '5df4403a5b26fdd82f8582681deccd77ba9928c8175407de69e38da4c46fe519');
  assert.equal(data.vertices.length, 3840 * 20);
  assert.equal(data.indices.length, 3840);
  assert.equal(data.indices.at(-1), 3839);
  assert.deepEqual(data.vertices.slice(0, 3), [0, 0, 0.05000000074505806]);
  assert.deepEqual(data.vertices.slice(20, 23), [0.006897612474858761, 0, 0.04952194169163704]);
  assert.ok(data.vertices.every(Number.isFinite));
});

test('concurrent fixture downloads publish complete verified bytes without overwriting an existing input', {
  timeout: 90000,
}, async (t) => {
  await blendRepeatScene(root);
  const bytes = readFileSync(join(root, 'IORTestGrid', 'IORTestGrid.glb')),
    workspaceResults = resolve('test-results');
  mkdirSync(workspaceResults, { recursive: true });
  const temporary = mkdtempSync(join(workspaceResults, 'blend-repeat-'));
  assert.ok(temporary.startsWith(workspaceResults + sep));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  t.mock.method(globalThis, 'fetch', async () => new Response(bytes));
  const [a, b] = await Promise.all([blendRepeatScene(temporary), blendRepeatScene(temporary)]);
  assert.equal(a.inputSha256, b.inputSha256);
  assert.deepEqual(readdirSync(join(temporary, 'IORTestGrid')), ['IORTestGrid.glb']);
  assert.deepEqual(readFileSync(join(temporary, 'IORTestGrid', 'IORTestGrid.glb')), bytes);
});
