import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveTransitions } from '../dist/live.js';
import { FrameGraph } from '@margoengine/core/extension';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
function harness() {
  const h = optionalGPU(),
    e = h.engine;
  e.canvas = { width: 8, height: 4 };
  e.disposed = false;
  e.scenes = new Set();
  e.gpu.limits.maxTextureDimension2D = 4096;
  e.createScene = (name) => {
    const s = {
      name,
      plugins: new Map(),
      frameGraph: new FrameGraph(),
      use(p) {
        this.plugins.set(p.name, p);
        p.setup(e);
        this.frameGraph.withOwner(p.name, () => p.registerPasses?.(this.frameGraph));
      },
      removePlugin(name) {
        const p = this.plugins.get(name);
        this.plugins.delete(name);
        this.frameGraph.removeOwner(name);
        p?.dispose();
      },
      dispose() {
        e.scenes.delete(this);
        for (const n of this.plugins.keys()) this.removePlugin(n);
      },
    };
    e.scenes.add(s);
    return s;
  };
  e.sceneOf = (p) => [...e.scenes].find((s) => s.plugins.get(p.name) === p);
  e.render = ({ delta, views }) => {
    for (const v of views) {
      for (const p of v.scene.plugins.values()) p.onPreUpdate?.(delta);
      h.context.delta = delta;
      v.scene.frameGraph.execute(h.context);
    }
  };
  const before = e.createScene('before'),
    after = e.createScene('after');
  return { ...h, before, after };
}
test('both scenes update once per frame, resize and restoration preserve progress; disposal borrows scenes', async () => {
  const h = harness();
  let a = 0,
    b = 0;
  h.before.plugins.set('animate', { onPreUpdate: (d) => (a += d) });
  h.after.plugins.set('animate', { onPreUpdate: (d) => (b += d) });
  const effect = LiveTransitions.attach(h.engine, h.before, h.after);
  effect.start(1);
  effect.render({ delta: 0.25 });
  assert.equal(effect.progress, 0.25);
  assert.equal(a, 0.25);
  assert.equal(b, 0.25);
  assert.equal(h.counts.copies ?? 0, 0, 'live images are not frozen copies');
  const images = [...effect.images];
  h.engine.canvas.width = 7;
  effect.render({ delta: 0.25 });
  assert.equal(effect.progress, 0.5);
  assert.ok(images.every((t) => t.destroyed));
  effect.onDeviceRestored(h.engine);
  assert.equal(effect.progress, 0.5);
  effect.render({ delta: 0.25 });
  assert.equal(effect.progress, 0.75);
  assert.equal(a, 0.75);
  assert.equal(b, 0.75);
  effect[Symbol.dispose]();
  effect.dispose();
  assert.equal(h.engine.scenes.size, 2);
  assert.ok(h.engine.scenes.has(h.before) && h.engine.scenes.has(h.after));
  assert.throws(
    () => effect.render(),
    (e) => e.code === 'disposed',
  );
  assert.throws(
    () => effect.start(),
    (e) => e.code === 'disposed',
  );
  await null;
  assert.ok(h.resources.every((r) => r.destroyed));
});
test('invalid scenes, cameras, duration, frame delta and dimensions reject before changing state', () => {
  const h = harness();
  for (const pair of [
    [h.before, h.before],
    [{}, h.after],
  ])
    assert.throws(() => LiveTransitions.attach(h.engine, ...pair), TypeError);
  assert.throws(() => LiveTransitions.attach(h.engine, h.before, h.after, { beforeCamera: {} }), TypeError);
  const effect = LiveTransitions.attach(h.engine, h.before, h.after);
  effect.start();
  for (const n of [0, -1, NaN, Infinity, 1e30]) assert.throws(() => effect.start(n), RangeError);
  for (const n of [-1, NaN, Infinity, 1e30]) assert.throws(() => effect.render({ delta: n }), RangeError);
  for (const n of [0, -1, NaN, Infinity, 4097]) {
    h.engine.canvas.width = n;
    assert.throws(() => effect.render(), RangeError);
  }
  assert.equal(effect.progress, 0);
  assert.equal(effect.images.length, 0);
  h.engine.canvas.width = 8;
  h.before.dispose();
  assert.throws(
    () => effect.render(),
    (e) => e.code === 'state' && /https:/.test(e.message),
  );
  effect.dispose();
  h.engine.gpu = null;
  assert.throws(
    () => LiveTransitions.attach(h.engine, h.before, h.after),
    (e) => e.code === 'unsupported' && /https:/.test(e.message),
  );
});
test('partial image allocation failure releases owned images and allows a later valid frame', async () => {
  const h = harness(),
    effect = LiveTransitions.attach(h.engine, h.before, h.after),
    create = h.engine.gpu.createTexture;
  let n = 0;
  const error = new Error('allocation');
  h.engine.gpu.createTexture = (d) => {
    if (++n === 2) throw error;
    return create(d);
  };
  assert.throws(
    () => effect.render(),
    (e) => e === error,
  );
  assert.equal(effect.images.length, 0);
  assert.ok(h.resources.filter((r) => r.width).every((r) => r.destroyed));
  h.engine.gpu.createTexture = create;
  effect.render();
  effect.dispose();
  await null;
  assert.ok(h.resources.every((r) => r.destroyed));
});
test('output targets reject invalid shapes, missing usage and capture feedback without advancing', () => {
  const h = harness(),
    effect = LiveTransitions.attach(h.engine, h.before, h.after);
  effect.start();
  effect.render();
  const valid = {
    width: 8,
    height: 4,
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
    sampleCount: 1,
    dimension: '2d',
    depthOrArrayLayers: 1,
  };
  for (const patch of [{ usage: 0 }, { sampleCount: 4 }, { dimension: '3d' }, { depthOrArrayLayers: 2 }])
    assert.throws(() => effect.render({ delta: 0.5, target: { ...valid, ...patch } }), TypeError);
  const capture = effect.images[0];
  Object.assign(capture, { sampleCount: 1, dimension: '2d', depthOrArrayLayers: 1 });
  assert.throws(() => effect.render({ delta: 0.5, target: capture }), TypeError);
  assert.equal(effect.progress, 0);
  effect.output.dispose();
  assert.throws(
    () => effect.render(),
    (e) => e.code === 'disposed',
  );
  assert.equal(h.engine.scenes.size, 2);
});
