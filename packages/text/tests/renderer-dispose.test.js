import test from 'node:test';
import assert from 'node:assert/strict';
import { nodeLifetimeAdapter } from '../../../tests/support/owner-lifetime-node.js';
import { Font, Text, TextRenderer } from '../dist/index.js';

test('disposing a TextRenderer directly also removes it from its engine, so the next frame does not run it', async () => {
  const adapter = await nodeLifetimeAdapter(), host = await adapter.create(), { engine } = host;
  engine.gpu.createPipelineLayout ??= () => ({});
  engine.gpu.queue.writeTexture ??= () => {};
  engine.gpu.limits.maxTextureArrayLayers ??= 256;
  engine.gpu.limits.maxTextureDimension2D ??= 8192;
  const font = Object.assign(Object.create(Font.prototype), {
    revision: 0, glyph: () => undefined, advance: (s) => s.length * 0.5, kerning: () => 0, metrics: () => ({ ascent: 0.8, descent: 0.2 }),
  });
  try {
    const renderer = TextRenderer.attach(engine);
    renderer.add(new Text({ text: 'abc', font }));
    await host.render([{ id: 'a', scene: engine.scene, camera: engine.camera, pixels: true, viewport: [0, 0, 32, 32], scissor: [0, 0, 16, 32] }]);
    renderer.dispose();
    assert.equal(engine.sceneOf(renderer), undefined);
    assert.equal(engine.plugins.has(renderer.name), false);
    await host.render([{ id: 'a', scene: engine.scene, camera: engine.camera, pixels: true, viewport: [0, 0, 32, 32], scissor: [0, 0, 16, 32] }]);
    renderer.dispose();
  } finally {
    engine.dispose();
    adapter.close();
  }
});
