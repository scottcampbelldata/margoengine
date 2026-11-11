// KB4278c: on the WebGL2 layer's 8-bit (ldr) tier the TAA history is stored at 8 bits per channel, and the
// tier-packages browser page measured 90.4% (TAA) and 92.1% (TAAUpscale) of pixels more than 2 levels off the reference
// (half-float tier: 0% and 0.024%). Both refuse that tier before allocating, at attach and at device restoration, as
// Bloom, SSAO, DOF and PostStack do.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TAA } from '../dist/index.js';
import { TAAUpscale } from '../dist/upscale.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

const refusal = (error) =>
  error.code === 'unsupported' && /TAA history.*half-float.*ldr.*https:\/\//.test(error.message);

for (const [name, Effect] of [
  ['TAA', TAA],
  ['TAAUpscale', TAAUpscale],
]) {
  test(`${name} refuses the ldr tier before allocating`, () => {
    const h = optionalGPU(),
      effect = new Effect();
    h.engine.gpu.adapter = { capabilities: { tier: 'ldr' } };
    const before = { ...h.counts };
    assert.throws(() => h.engine.use(effect), refusal);
    assert.deepEqual(h.counts, before, 'refusal creates no GPU object');
    assert.equal(h.engine.hasPlugin(effect.name), false);
    effect.dispose();
  });

  test(`${name} attaches on full and half-float, and a restore onto ldr releases, detaches and refuses`, () => {
    for (const tier of ['full', 'half-float']) {
      const h = optionalGPU(),
        effect = new Effect();
      h.engine.gpu.adapter = { capabilities: { tier } };
      h.engine.use(effect);
      assert.equal(h.engine.hasPlugin(effect.name), true);
      const owned = h.resources.filter((r) => !r.destroyed);
      assert.ok(owned.length > 0, 'setup allocated its uniforms');
      h.engine.gpu.adapter.capabilities.tier = 'ldr';
      const buffers = h.counts.buffers,
        textures = h.counts.textures;
      assert.throws(() => effect.onDeviceRestored(h.engine), refusal);
      assert.equal(h.counts.buffers, buffers, 'restoration allocates no buffer');
      assert.equal(h.counts.textures, textures, 'restoration allocates no texture');
      assert.ok(
        owned.every((r) => r.destroyed),
        'old resources released before refusal',
      );
      assert.equal(h.engine.hasPlugin(effect.name), false, 'the refused effect leaves the engine');
      assert.doesNotThrow(() => effect.onDeviceRestored(h.engine), 'no second restore error');
      effect.dispose();
    }
  });
}
