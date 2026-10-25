import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../packages/core/dist/index.js';
import { sceneSamples } from '../packages/core/dist/quality.js';

// exactSize: the backbuffer keeps the requested size (no device-pixel-ratio resize) and the scene is single-sampled.
// The GPU side (exact readback, no MSAA edges) is checked by npm run check:views (the exact section).
const fallback = () => ({ backend: 'webgl2', add() {}, remove() {}, dispose() {}, render() {} });
const canvas = (width = 300, height = 150) => ({
  width,
  height,
  clientWidth: 1280,
  clientHeight: 720,
  getContext: () => null,
});

test('exactSize sets the backbuffer once and frames never resize it to the CSS size', async (t) => {
  const previous = globalThis.devicePixelRatio;
  globalThis.devicePixelRatio = 2;
  t.after(() => (globalThis.devicePixelRatio = previous));
  const target = canvas(),
    engine = await Engine.create(target, { backend: 'webgl2', fallback, exactSize: [320, 180] });
  try {
    assert.deepEqual([target.width, target.height], [320, 180]);
    engine.render();
    assert.deepEqual([target.width, target.height], [320, 180], 'no CSS x pixel-ratio resize');
    assert.equal(sceneSamples(engine), 1, 'single-sampled');
    target.width = 64; // the caller resizes by setting the attributes
    engine.render();
    assert.equal(target.width, 64);
  } finally {
    engine.dispose();
  }
  const own = canvas(48, 24),
    kept = await Engine.create(own, { backend: 'webgl2', fallback, exactSize: true });
  try {
    kept.render();
    assert.deepEqual([own.width, own.height], [48, 24], 'true keeps the canvas attributes');
  } finally {
    kept.dispose();
  }
  const resized = canvas(),
    normal = await Engine.create(resized, { backend: 'webgl2', fallback });
  try {
    normal.render();
    assert.notDeepEqual([resized.width, resized.height], [300, 150], 'without exactSize the CSS size wins');
  } finally {
    normal.dispose();
  }
});

test('an invalid exactSize is a RangeError linked to its help entry', async () => {
  for (const exactSize of [[0, 10], [10.5, 10], [10], [9000, 10]])
    await assert.rejects(
      Engine.create(canvas(), { backend: 'webgl2', fallback, exactSize }),
      (error) =>
        error instanceof RangeError &&
        error.message === 'Invalid exactSize; see https://margoengine.com/errors#pixel-exact',
    );
});
