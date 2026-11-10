import test from 'node:test';
import assert from 'node:assert/strict';
import { Bloom, SSAO, GTAO, PostStack } from '../dist/index.js';
import { harness } from './support.js';

test('Bloom.encodeImage refuses LDR before creating its image pipelines or textures', () => {
  const h = harness(),
    bloom = new Bloom();
  h.gpu.device.adapter = { capabilities: { tier: 'ldr' } };
  h.gpu.device.limits = { maxTextureDimension2D: 16 };
  const context = { device: h.gpu.device, encoder: h.gpu.encoder, width: 4, height: 4 };
  const log = h.gpu.record(() =>
    assert.throws(
      () => bloom.encodeImage(context, {}, {}),
      (error) => error.code === 'unsupported' && /Bloom HDR processing.*half-float.*ldr/.test(error.message),
    ),
  );
  assert.deepEqual(log, [], 'an unattached image effect refuses before any GPU call');
  assert.equal(h.live().length, 0);
  bloom.dispose();
});

for (const [name, Effect, stacked] of [
  ['Bloom', Bloom, false],
  ['SSAO', SSAO, false],
  ['GTAO', GTAO, true],
]) {
  test(`${name} refuses LDR before allocating, including restoration; full and half-float stay usable`, () => {
    const low = harness(),
      refused = new Effect();
    low.engine.gpu.adapter = { capabilities: { tier: 'ldr' } };
    const log = low.gpu.record(() =>
      assert.throws(
        () => low.engine.use(stacked ? new PostStack([refused]) : refused),
        (error) => error.code === 'unsupported' && /half-float.*ldr.*https:\/\//.test(error.message),
      ),
    );
    assert.deepEqual(log, [], 'refusal makes no GPU calls');
    assert.equal(low.live().length, 0);
    assert.equal(low.engine.hasPlugin(refused.name), false);

    for (const tier of ['full', 'half-float']) {
      const h = harness(),
        effect = new Effect(),
        plugin = stacked ? new PostStack([effect]) : effect;
      h.engine.gpu.adapter = { capabilities: { tier } };
      h.engine.use(plugin);
      h.frame();
      const owned = h.live();
      assert.ok(owned.length > 0);
      h.engine.gpu.adapter.capabilities.tier = 'ldr';
      const restoration = h.gpu.record(() => {
        // Core attempts every plugin callback even when an earlier callback refuses.
        if (stacked)
          assert.throws(
            () => plugin.onDeviceRestored(),
            (error) => error.code === 'unsupported',
          );
        if (stacked)
          assert.doesNotThrow(() => effect.onDeviceRestored(h.engine), 'detached children do not report another error');
        else
          assert.throws(
            () => effect.onDeviceRestored(h.engine),
            (error) => error.code === 'unsupported',
          );
      });
      assert.ok(
        !restoration.some((entry) => ['buffer', 'texture'].includes(entry[0])),
        'restoration allocates nothing',
      );
      assert.ok(
        owned.every((resource) => resource.destroyed),
        'old resources released before refusal',
      );
      assert.equal(h.live().length, 0);
      assert.equal(h.engine.hasPlugin(plugin.name), false);
      assert.equal(h.engine.hasPlugin(effect.name), false);
      for (let i = 0; i < 3; i++) assert.doesNotThrow(() => h.frame(), 'later frames bypass the detached effect');
      assert.equal(h.live().length, 0, 'later frames create no effect resources');
      assert.doesNotThrow(() => plugin.onDeviceRestored(h.engine), 'no second restore error');
      plugin.dispose();
    }
  });
}
