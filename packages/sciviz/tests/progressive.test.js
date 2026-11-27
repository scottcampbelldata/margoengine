import assert from 'node:assert/strict';
import test from 'node:test';
import { ProgressiveRendering, progressiveRendering } from '../dist/progressive.js';
import { ProgressivePolicy } from '../src/progressive-policy.ts';

test('progressive policy reduces both dimensions and samples, settles, refines and resets', () => {
  const p = new ProgressivePolicy({});
  const initial = p.next(true);
  assert.deepEqual(initial, { moving: true, progress: 0, resolutionScale: 0.5, sampleScale: 0.25 });
  assert.deepEqual(p.next(false), initial);
  assert.deepEqual(p.next(false), initial);
  let last = initial;
  for (let i = 1; i <= 8; i++) {
    const next = p.next(false);
    assert.equal(next.progress, i / 8);
    assert.ok(next.resolutionScale > last.resolutionScale);
    assert.ok(next.sampleScale > last.sampleScale);
    last = next;
  }
  assert.deepEqual(last, { moving: false, progress: 1, resolutionScale: 1, sampleScale: 1 });
  assert.deepEqual(p.next(true), initial);
});

test('budget feedback is bounded, responds to over/under budget and cannot prevent resting convergence', () => {
  const p = new ProgressivePolicy({ frameBudgetMs: 10, settleFrames: 0, refinementFrames: 2 });
  for (let i = 0; i < 30; i++) p.feedback(100);
  assert.deepEqual(p.next(true), { moving: true, progress: 0, resolutionScale: 0.25, sampleScale: 0.125 });
  assert.equal(p.next(false).progress, 0.5);
  assert.equal(p.next(false).sampleScale, 1);
  for (let i = 0; i < 30; i++) p.feedback(1);
  assert.equal(p.next(true).resolutionScale, 0.5);
  assert.equal(p.next(true).sampleScale, 0.25);
  const before = p.next(true);
  p.feedback(10);
  assert.deepEqual(p.next(true), before, 'deadband keeps stable quality');
});

test('invalid options and feedback reject before engine mutation', () => {
  for (const options of [
    { frameBudgetMs: 0 },
    { frameBudgetMs: Infinity },
    { movingResolution: 0 },
    { movingSamples: NaN },
    { minResolution: 0.8 },
    { minSamples: 0.9 },
    { settleFrames: 1.1 },
    { refinementFrames: 0 },
    { refinementFrames: 121 },
  ]) {
    assert.throws(() => new ProgressivePolicy(options), RangeError);
  }
  const p = new ProgressivePolicy({ movingResolution: 0.1, movingSamples: 0.05 });
  assert.equal(p.options.minResolution, 0.1);
  for (const latency of [0, -1, NaN, Infinity]) assert.throws(() => p.feedback(latency), RangeError);
  assert.equal(typeof progressiveRendering, 'function');
});

test('controller is an optional engine plugin with disposable ownership and no global side effects', () => {
  let plugin;
  const passes = [],
    renderer = { device: {}, samplingScale: 1, add() {}, remove() {} };
  const engine = {
    gpu: renderer.device,
    hasPlugin: () => !!plugin,
    use(p) {
      plugin = p;
      p.setup(this);
      p.registerPasses({ add: (pass) => passes.push(pass) });
    },
    // One scene, as on an engine without extra scenes: the controller is in it while it is attached.
    sceneOf: (p) => (p === plugin ? {} : undefined),
    removePlugin() {
      plugin?.dispose();
      plugin = undefined;
    },
  };
  renderer.engine = engine;
  const controller = new ProgressiveRendering({ engine, renderer });
  assert.equal(plugin, controller);
  assert.deepEqual(
    passes.map((p) => p.order),
    [-10000, 10000],
  );
  assert.throws(() => new ProgressiveRendering({ engine, renderer }), { code: 'state' });
  controller.recordFrameTime(30);
  renderer.samplingScale = 0.1;
  controller.onDeviceRestored();
  assert.equal(renderer.samplingScale, 1);
  controller[Symbol.dispose]();
  controller.dispose();
  assert.equal(plugin, undefined);
  assert.throws(() => controller.recordFrameTime(1), { code: 'state' });
  // An engine feature attaches with the static factory, like every other package feature.
  const attached = ProgressiveRendering.attach({ engine, renderer }, { settleFrames: 1 });
  assert.ok(attached instanceof ProgressiveRendering);
  assert.equal(plugin, attached);
  attached.dispose();
  assert.equal(plugin, undefined);
});

test('a view no longer drawn releases its reduced target at the next frame, like other per-view state', (t) => {
  const usage = globalThis.GPUTextureUsage;
  globalThis.GPUTextureUsage = { TEXTURE_BINDING: 4, RENDER_ATTACHMENT: 16 };
  t.after(() => {
    globalThis.GPUTextureUsage = usage;
  });
  const destroyed = new Set(),
    texture = (size, format) => ({
      width: size[0],
      height: size[1],
      format,
      createView: () => ({}),
      destroy() {
        destroyed.add(this);
      },
    });
  const device = { createTexture: ({ size, format }) => texture(size, format) },
    renderer = { device, samplingScale: 1, add() {}, remove() {} },
    passes = [];
  let plugin;
  const engine = {
    gpu: device,
    hasPlugin: () => !!plugin,
    use(p) {
      plugin = p;
      p.setup(this);
      p.registerPasses({ add: (pass) => passes.push(pass) });
    },
    sceneOf: (p) => (p === plugin ? {} : undefined),
    removePlugin() {
      plugin = undefined;
    },
  };
  renderer.engine = engine;
  const controller = new ProgressiveRendering({ engine, renderer }),
    begin = passes.find((p) => p.order === -10000);
  const made = [],
    create = device.createTexture;
  device.createTexture = (d) => {
    const t = create(d);
    made.push(t);
    return t;
  };
  const draw = (id) =>
    begin.execute({
      backend: 'webgpu',
      device,
      camera: { matrix: new Float32Array(16), position: [0, 0, 0] },
      width: 64,
      height: 64,
      format: 'rgba8unorm',
      descriptor: { depthStencil: { format: 'depth24plus' } },
      color: {},
      depth: {},
      view: { id, viewport: [0, 0, 64, 64], index: 0, count: 1 },
    });
  draw('removed');
  const removed = made.splice(0);
  assert.equal(removed.length, 2);
  controller.onPreUpdate(1 / 60);
  draw('kept');
  controller.onPreUpdate(1 / 60);
  draw('kept');
  // A pick (zero delta) is not a frame and does not release anything.
  controller.onPreUpdate(0);
  assert.ok(
    removed.every((t) => destroyed.has(t)),
    'the removed view no longer holds GPU memory',
  );
  assert.ok(made.every((t) => !destroyed.has(t)), 'the view still drawn keeps its target');
  controller.dispose();
  assert.ok(made.every((t) => destroyed.has(t)));
});
