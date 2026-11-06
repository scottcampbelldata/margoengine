import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, Stage } from '@margoengine/stage';
import { createHeadlessStage, HeadlessStage } from '../dist/stage.js';

/** Stands in for `Engine.create`, so these tests need no GPU; the browser check runs the real one. */
function fakeEngine(canvas) {
  const plugins = [],
    log = [];
  return {
    log,
    canvas,
    onError: undefined,
    camera: { fitToBoundingBox: (_min, _max, options) => log.push(['fit', options.aspect]) },
    scene: { meshes: new Map() },
    frames: new Set(),
    onFrame(callback) {
      this.frames.add(callback);
      return () => this.frames.delete(callback);
    },
    use(plugin) {
      plugins.push(plugin);
      plugin.setup?.(this);
      return this;
    },
    render(options) {
      log.push(['render', options?.delta]);
    },
    dispose() {
      for (const plugin of plugins) plugin.dispose?.();
    },
  };
}
const gpu = { requestAdapter: async () => null };
const stubEngine = (t, seen = {}) =>
  t.mock.method(Engine, 'create', async (canvas, options) => {
    seen.options = options;
    return (seen.engine = fakeEngine(canvas));
  });

test('createHeadlessStage gives a Stage on a stand-in canvas, on WebGPU, with no frame loop', async (t) => {
  const seen = {};
  stubEngine(t, seen);
  const onError = () => {},
    stage = await createHeadlessStage({ gpu, width: 320, height: 200, onError, startupTimeout: 5 });
  assert.ok(stage instanceof Stage && stage instanceof HeadlessStage);
  assert.deepEqual(seen.options, { startupTimeout: 5, backend: 'webgpu' });
  assert.equal(stage.engine.onError, onError);
  assert.deepEqual([stage.canvas.width, stage.canvas.height], [320, 200]);
  assert.equal(navigator.gpu.requestAdapter !== undefined, true);
  assert.deepEqual(seen.engine.log, [], 'nothing draws until asked');
  stage.dispose();
});

test('dispose restores the globals, by the stage, by using, or by the engine', async (t) => {
  stubEngine(t);
  (await createHeadlessStage({ gpu, width: 1, height: 1 })).dispose();
  assert.equal(navigator.gpu, undefined);
  assert.equal('GPUBufferUsage' in globalThis, false);
  {
    using stage = await createHeadlessStage({ gpu, width: 1, height: 1 });
    assert.ok(stage.signal);
    assert.ok('GPUBufferUsage' in globalThis);
  }
  assert.equal('GPUBufferUsage' in globalThis, false);
  (await createHeadlessStage({ gpu, width: 1, height: 1 })).engine.dispose();
  assert.equal('GPUBufferUsage' in globalThis, false);
});

test('a stage disposed first leaves the globals to one still alive', async (t) => {
  stubEngine(t);
  const first = await createHeadlessStage({ gpu, width: 1, height: 1 }),
    second = await createHeadlessStage({ gpu, width: 1, height: 1 });
  first.dispose();
  first.dispose();
  assert.ok('GPUBufferUsage' in globalThis, 'a double dispose must not count twice');
  assert.ok(navigator.gpu);
  second.dispose();
  assert.equal('GPUBufferUsage' in globalThis, false);
});

test('stages alive at once must share a gpu', async (t) => {
  stubEngine(t);
  const stage = await createHeadlessStage({ gpu, width: 1, height: 1 });
  await assert.rejects(createHeadlessStage({ gpu: { requestAdapter: async () => null }, width: 1, height: 1 }), {
    code: 'state',
  });
  stage.dispose();
});

test('a failed start leaves nothing installed', async (t) => {
  t.mock.method(Engine, 'create', async () => {
    throw new Error('no adapter');
  });
  await assert.rejects(createHeadlessStage({ gpu, width: 1, height: 1 }), /no adapter/);
  assert.equal(navigator.gpu, undefined);
  await assert.rejects(createHeadlessStage({ gpu, width: 0, height: 1 }), RangeError);
  await assert.rejects(createHeadlessStage({ width: 1, height: 1 }), TypeError, 'no gpu and no navigator.gpu');
  await assert.rejects(createHeadlessStage({ gpu, width: 1, height: 1, onError: 1 }), TypeError);
  assert.equal(navigator.gpu, undefined);
});

test('step runs onTick callbacks, then draws with that delta', async (t) => {
  const seen = {};
  stubEngine(t, seen);
  using stage = await createHeadlessStage({ gpu, width: 1, height: 1 });
  const ticks = [],
    remove = stage.onTick((delta) => {
      ticks.push(delta);
      seen.engine.log.push(['tick']);
    });
  stage.step(0.25);
  stage.step();
  assert.deepEqual(ticks, [0.25, 0]);
  assert.deepEqual(seen.engine.log, [['tick'], ['render', 0.25], ['tick'], ['render', 0]]);
  remove();
  stage.step(1);
  assert.equal(ticks.length, 2);
});

test('step runs engine.onFrame callbacks, so a package that drives itself from them advances', async (t) => {
  const seen = {};
  stubEngine(t, seen);
  using stage = await createHeadlessStage({ gpu, width: 1, height: 1 });
  const frames = [],
    remove = stage.engine.onFrame((engine, delta) => {
      frames.push([engine, delta]);
      seen.engine.log.push(['frame']);
    });
  stage.onTick(() => seen.engine.log.push(['tick']));
  assert.equal(seen.engine.frames.size, 1, 'core keeps it too, for engine.start() on a page');
  stage.step(0.5);
  assert.deepEqual(frames, [[seen.engine, 0.5]]);
  assert.deepEqual(seen.engine.log, [['tick'], ['frame'], ['render', 0.5]]);
  remove();
  assert.equal(seen.engine.frames.size, 0);
  stage.step(1);
  assert.equal(frames.length, 1);
});

test('fit sees the image size as the CSS size, and the canvas keeps none after', async (t) => {
  // A stand-in canvas has clientWidth 0, so Stage.fit alone would fit every image as if it were square. The browser
  // check runs the real fit against a page.
  stubEngine(t);
  const sizes = [],
    fit = t.mock.method(Stage.prototype, 'fit', function () {
      sizes.push([this.canvas.clientWidth, this.canvas.clientHeight]);
    });
  using stage = await createHeadlessStage({ gpu, width: 400, height: 100 });
  const meshes = [];
  stage.fit(meshes);
  assert.equal(fit.mock.calls[0].arguments[0], meshes);
  stage.resize(100, 200);
  stage.fit();
  assert.deepEqual(sizes, [
    [400, 100],
    [100, 200],
  ]);
  assert.deepEqual([stage.canvas.clientWidth, stage.canvas.clientHeight], [0, 0], 'core must keep width and height');
});

test('a failing fit still clears the CSS size', async (t) => {
  stubEngine(t);
  t.mock.method(Stage.prototype, 'fit', () => {
    throw new Error('no bounds');
  });
  using stage = await createHeadlessStage({ gpu, width: 4, height: 2 });
  assert.throws(() => stage.fit([]), /no bounds/);
  assert.equal(stage.canvas.clientWidth, 0);
});

test('importing the entry sets nothing', () => {
  assert.equal(navigator.gpu, undefined);
});
