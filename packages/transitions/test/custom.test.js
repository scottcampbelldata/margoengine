import test from 'node:test';
import assert from 'node:assert/strict';
import { createCustomTransition } from '../dist/custom.js';
import { Transitions } from '../dist/index.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
const wgsl =
  'fn transition(a:texture_2d<f32>,b:texture_2d<f32>,uv:vec2f,p:f32)->vec4f{return mix(sample(a,uv),sample(b,uv),p*p);}';
function harness() {
  const h = optionalGPU();
  h.engine.gpu.pushErrorScope = () => {};
  h.engine.gpu.popErrorScope = async () => null;
  h.engine.gpu.createPipelineLayout = (d) => d;
  h.engine.gpu.createShaderModule = (d) => ({ ...d, getCompilationInfo: async () => ({ messages: [] }) });
  h.engine.gpu.createRenderPipelineAsync = async (d) => h.engine.gpu.createRenderPipeline(d);
  return h;
}
test('custom entry validates before attaching, runs capture, restores and disposes', async () => {
  const h = harness();
  const effect = await createCustomTransition(h.engine, wgsl);
  h.frame();
  effect.start('wipe', 1);
  for (const duration of [0, -1, NaN, Infinity, 1e30]) assert.throws(() => effect.start('wipe', duration), RangeError);
  for (const displacement of [-1, NaN, Infinity, 1e30])
    assert.throws(() => effect.start('wipe', 1, displacement), RangeError);
  h.frame();
  assert.equal(effect.progress, 0.1);
  assert.match(effect.pipeline.fragment.module.code, /p\*p/);
  effect.onDeviceRestored(h.engine);
  assert.equal(effect.progress, 1, 'lost outgoing image must not be blended after device restoration');
  h.frame();
  effect.dispose();
  effect.dispose();
  await null;
  assert.ok(h.resources.every((r) => r.destroyed));
  assert.throws(
    () => effect.start(),
    (e) => e.code === 'disposed',
  );
});
test('bad source, fallback, cancellation and late disposal never attach', async () => {
  for (const value of ['', ' ', null, 0, 'x'.repeat(65537)]) {
    const h = harness();
    await assert.rejects(createCustomTransition(h.engine, value), TypeError);
    assert.equal(h.engine.plugins.size, 0);
  }
  const h = harness();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(createCustomTransition(h.engine, wgsl, { signal: controller.signal }), { name: 'AbortError' });
  h.engine.gpu.createShaderModule = () => ({
    getCompilationInfo: async () => ({ messages: [{ type: 'error', message: 'invalid' }] }),
  });
  await assert.rejects(createCustomTransition(h.engine, wgsl), (e) => e.code === 'failed' && /https:/.test(e.message));
  h.engine.gpu = undefined;
  await assert.rejects(
    createCustomTransition(h.engine, wgsl),
    (e) => e.code === 'unsupported' && /https:/.test(e.message),
  );
  assert.equal(h.engine.plugins.size, 0);
  const late = harness();
  late.engine.gpu.createRenderPipelineAsync = async () => {
    late.engine.disposed = true;
    return {};
  };
  await assert.rejects(createCustomTransition(late.engine, wgsl), (e) => e.code === 'state');
  assert.equal(late.engine.plugins.size, 0);
});
test('abort during compilation removes its listener and prevents attachment', async () => {
  const h = harness();
  const controller = new AbortController();
  let complete;
  h.engine.gpu.createShaderModule = () => ({
    getCompilationInfo: () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  });
  const pending = createCustomTransition(h.engine, wgsl, { signal: controller.signal });
  controller.abort(new Error('cancel shader'));
  await assert.rejects(pending, /cancel shader/);
  complete({ messages: [] });
  await null;
  assert.equal(h.engine.plugins.size, 0);
  assert.equal(h.resources.length, 0);
});
test('restoration cancels built-in history and fallback errors include help', () => {
  const h = harness();
  const effect = new Transitions();
  h.engine.use(effect);
  h.frame();
  effect.start();
  h.frame();
  effect.onDeviceRestored(h.engine);
  assert.equal(effect.progress, 1);
  effect.dispose();
  assert.throws(
    () => new Transitions().setup({}),
    (e) => e.code === 'unsupported' && /https:/.test(e.message),
  );
});

test('abort after attachment does not cancel shader execution or detach the effect', async () => {
  const h = harness();
  const controller = new AbortController();
  const effect = await createCustomTransition(h.engine, wgsl, { signal: controller.signal });
  h.frame();
  effect.start();
  controller.abort();
  h.frame();
  assert.equal(effect.progress, 0.1);
  assert.equal(h.engine.plugins.get(effect.name), effect);
  effect.dispose();
});
