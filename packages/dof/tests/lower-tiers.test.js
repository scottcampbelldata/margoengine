import test from 'node:test';
import assert from 'node:assert/strict';
import { DOF } from '../dist/index.js';
import { gpuHarness } from '../../../tests/support/postfx-gpu.js';

const refused = (error) =>
  error.code === 'unsupported' && /DOF HDR processing.*half-float.*ldr.*https:\/\//.test(error.message);

for (const temporal of [false, true]) {
  test(`DOF temporal=${temporal} refuses LDR before attachment or allocation and new effects can attach to half-float`, () => {
    const h = gpuHarness(),
      effect = new DOF({ temporal });
    h.engine.gpu.adapter = { capabilities: { tier: 'ldr' } };
    assert.throws(() => h.engine.use(effect), refused);
    assert.equal(h.resources.length, 0);
    assert.equal(h.pipelines.length, 0);
    assert.equal(h.engine.hasPlugin(effect.name), false);
    h.engine.gpu.adapter.capabilities.tier = 'half-float';
    const accepted = new DOF({ temporal });
    h.engine.use(accepted);
    h.frame();
    assert.ok(h.resources.length > 0);
    accepted.dispose();
    assert.ok(h.resources.every((resource) => resource.destroyed));
  });

  for (const tier of ['full', 'half-float']) {
    test(`DOF temporal=${temporal} releases ${tier} resources before refusing LDR restoration`, () => {
      const h = gpuHarness();
      h.engine.gpu.adapter = { capabilities: { tier } };
      const effect = DOF.attach(h.engine, { temporal });
      h.frame();
      const resources = [...h.resources],
        pipelines = h.pipelines.length;
      assert.ok(resources.length > 0);
      h.engine.gpu.adapter.capabilities.tier = 'ldr';
      assert.throws(() => effect.onDeviceRestored(h.engine), refused);
      assert.equal(h.resources.length, resources.length, 'restoration allocates no buffers or textures');
      assert.equal(h.pipelines.length, pipelines, 'restoration creates no pipelines');
      assert.ok(resources.every((resource) => resource.destroyed));
      assert.equal(effect.outputTexture, undefined);
      assert.equal(effect.depthTexture, undefined);
      assert.equal(h.engine.hasPlugin(effect.name), false, 'refused effect detaches');
      for (let i = 0; i < 3; i++)
        assert.doesNotThrow(() => h.frame(), 'later frames render without the refused effect');
      assert.equal(h.context.color, h.originalColor);
      assert.equal(h.context.depth, h.originalDepth);
      assert.doesNotThrow(
        () => effect.onDeviceRestored(h.engine),
        'a disposed effect cannot emit a second restore error',
      );
      effect.dispose();
    });
  }
}
