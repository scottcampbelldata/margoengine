// The WebGL2 preview (@margoengine/webgl2-compat/preview) for visitors without WebGPU: a basic scene draws through it, and the features
// that need WebGPU refuse with a MargoError that names them. The real-browser half (navigator.gpu removed, pixels read
// back) is scripts/test-no-webgpu-browser.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, PbrMaterial, box } from '../packages/core/dist/index.js';
import { webglRenderer } from '../packages/webgl2-compat/dist/preview.js';
import { PostProcessing } from '../packages/creative/dist/post.js';
import { GPUParticles } from '../packages/creative/dist/particles.js';
import { SkyMoon } from '../packages/scenery/dist/sky.js';
import { Shadows } from '../packages/shadows/dist/index.js';
import { glDrawHarness } from './support/core-draw-gpu.js';

// `navigator.gpu` missing, or present with no adapter (a blocklisted GPU): both must reach the fallback.
const browsers = {
  'no navigator.gpu': { userAgent: 'test' },
  'no adapter': { userAgent: 'test', gpu: { requestAdapter: async () => null } },
};

async function previewEngine(t, navigator) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: navigator });
  t.after(() => {
    if (saved) Object.defineProperty(globalThis, 'navigator', saved);
    else delete globalThis.navigator;
  });
  const h = glDrawHarness(t);
  Object.assign(h.canvas, { clientWidth: 160, clientHeight: 120 });
  const engine = await Engine.create(h.canvas, { fallback: webglRenderer });
  t.after(() => engine.dispose());
  return { h, engine };
}

for (const [name, navigator] of Object.entries(browsers))
  test(`without WebGPU (${name}) a basic scene draws through the WebGL2 preview`, async (t) => {
    const { h, engine } = await previewEngine(t, navigator);
    assert.equal(engine.backend, 'webgl2');
    assert.match(engine.fallbackReason, /adapter unavailable/);
    assert.equal(engine.gpu, null);
    const uploads = [];
    h.gl.uniform4fv = (_location, value) => uploads.push([...value]);
    engine
      .createMesh()
      .setGeometry(box())
      .setMaterial(new PbrMaterial({ color: [1, 0, 0] }));
    engine
      .createMesh()
      .setGeometry(box(2, 1, 1))
      .setMaterial(new PbrMaterial({ color: [0, 0, 1] }))
      .setPosition([3, 0, 0]);
    engine.lighting.direction.set([0.3, 1, 0.2, 2]);
    h.draws.length = 0;
    engine.render();
    assert.equal(h.draws.length, 2, 'one instanced draw per mesh');
    assert.ok(
      h.draws.every((draw) => draw.args[0] === h.gl.TRIANGLES && draw.args[1] === 36),
      'each box draws its 36 indices',
    );
    assert.ok(
      uploads.some((value) => value.join() === [0.3, 1, 0.2, 2].map(Math.fround).join()),
      'the one directional light reaches the shader',
    );
  });

test('without WebGPU the features that need it refuse with a MargoError naming the feature', async (t) => {
  const { engine } = await previewEngine(t, browsers['no navigator.gpu']);
  const features = [
    ['PostProcessing', () => new PostProcessing()],
    ['VFX', () => new GPUParticles({ count: 16 })],
    ['Sky', () => new SkyMoon()],
    ['Shadows', () => new Shadows()],
  ];
  for (const [feature, make] of features)
    assert.throws(
      () => engine.use(make()),
      (error) =>
        error.name === 'MargoError' &&
        error.code === 'unsupported' &&
        error.message.startsWith(feature) &&
        /WebGPU/.test(error.message),
      feature,
    );
  // Core is frozen for v1.0.0: its two WebGPU-only calls keep their plain Error, which still names the cause.
  await assert.rejects(engine.pick(1, 1), /WebGPU required/);
  await assert.rejects(engine.rebootDevice(), /WebGPU required/);
  engine.render();
});
