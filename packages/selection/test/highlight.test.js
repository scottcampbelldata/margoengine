import assert from 'node:assert/strict';
import test from 'node:test';
import { Selection } from '../dist/index.js';
import { Highlight } from '../dist/highlight.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
test('highlight validates mutable styles and its mask-only path needs no distance-field compute', () => {
  for (const options of [
    { radius: 0 },
    { radius: 65 },
    { glowOpacity: NaN },
    { fillOpacity: -1 },
    { color: [1, 2, 0] },
    { outerGlow: 1 },
  ])
    assert.throws(() => new Highlight(options), RangeError);
  const h = optionalGPU(),
    effect = new Highlight(),
    mesh = { id: 2 };
  h.engine.meshes.set(2, mesh);
  h.engine.use(effect);
  effect.set([mesh]);
  h.frame();
  assert.equal(h.counts.compute, 0, 'a mask-only consumer must not dispatch JFA');
  const groups = h.counts.groups,
    views = h.counts.views;
  h.frame();
  assert.equal(h.counts.groups, groups, 'steady frames reuse bind groups');
  assert.equal(h.counts.views, views, 'steady frames reuse target views');
  effect.options.radius = 0;
  assert.throws(() => h.frame(), RangeError);
  effect.options.radius = 8;
  effect.onDeviceRestored(h.engine);
  h.frame();
  effect.set([]);
  h.frame();
  effect.dispose();
  effect.dispose();
  assert.equal(h.engine.plugins.size, 0);
  assert.throws(() => effect.set([mesh]), /disposed/);
});

test('a mask consumer with default Selection options does not allocate or dispatch distance fields', () => {
  class Mask extends Selection {
    constructor() {
      super();
      this.outlineVisible = false;
    }
  }
  const h = optionalGPU(),
    mask = new Mask(),
    mesh = { id: 2 };
  h.engine.meshes.set(2, mesh);
  h.engine.use(mask);
  mask.set([mesh]);
  h.frame();
  assert.equal(h.counts.compute, 0);
  assert.ok(mask.maskTexture);
  mask.dispose();
});
