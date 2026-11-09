import test from 'node:test';
import assert from 'node:assert/strict';
import { Transitions } from '../dist/index.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
test('transition freezes previous scene once, advances progress, resizes and tears down', async () => {
  const h = optionalGPU(),
    effect = new Transitions();
  h.engine.use(effect);
  h.frame();
  effect.start('dissolve', 0.4);
  h.frame();
  assert.equal(h.counts.copies, 1);
  assert.equal(effect.progress, 0.25);
  h.frame();
  assert.equal(h.counts.copies, 1);
  for (const kind of ['wipe', 'radial', 'chromatic']) {
    effect.start(kind, 0.1);
    h.frame();
    assert.equal(effect.progress, 1);
  }
  assert.throws(() => effect.start('bad'), /Transition needs/);
  h.context.width = 64;
  h.frame();
  effect.onDeviceRestored(h.engine);
  h.frame();
  effect.dispose();
  assert.equal(h.engine.hasPlugin('transitions'), false);
  await null;
  assert.ok(h.resources.every((r) => r.destroyed));
});

test('capture formats reject non-float color and unsupported resolves before allocation', () => {
  for (const [format, samples] of [
    ['rgba8uint', 1],
    ['rgba8sint', 4],
    ['depth32float', 1],
    ['rgba32float', 4],
  ]) {
    const h = optionalGPU();
    const effect = new Transitions();
    h.engine.use(effect);
    effect.start();
    h.context.format = format;
    h.context.descriptor.multisample = { count: samples };
    const allocated = h.resources.length;
    assert.throws(() => h.engine.frameGraph.execute(h.context), TypeError, `${format} ${samples}x`);
    assert.equal(h.resources.length, allocated);
    assert.equal(effect.progress, 0);
    effect.dispose();
  }
});
