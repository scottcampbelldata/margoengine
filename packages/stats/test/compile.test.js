import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Stats } from '../dist/index.js';
import { PipelineCompiles } from '../dist/compile.js';

// A clock the test moves by hand, and a device whose calls take `cost` of it.
function rig(t) {
  const rig = {
    now: 1000,
    cost: 0,
    device: {
      createShaderModule: (d) => (rig.spend(), { label: d.label ?? '' }),
      createRenderPipeline: () => (rig.spend(), {}),
      createComputePipeline: () => (rig.spend(), {}),
      createRenderPipelineAsync: () =>
        new Promise((resolve, reject) => {
          rig.settle = (error) => (error ? reject(error) : resolve({ async: true }));
        }),
      createComputePipelineAsync: async () => ({}),
    },
    spend() {
      rig.now += rig.cost;
    },
  };
  t.mock.method(performance, 'now', () => rig.now);
  return rig;
}

test('every compile call is recorded with its kind, label and time, and results pass through', (t) => {
  const r = rig(t),
    compiles = new PipelineCompiles();
  compiles.track(r.device);
  r.cost = 5;
  const module = r.device.createShaderModule({ label: 'water', code: '' });
  r.cost = 7;
  r.device.createRenderPipeline({ vertex: { module } });
  r.device.createComputePipeline({ label: 'skin', compute: { module } });
  r.device.createRenderPipeline({});
  assert.equal(module.label, 'water');
  const { compiles: records, count, blockingMilliseconds } = compiles.toJSON();
  assert.deepEqual(
    records.map((record) => [record.kind, record.label, record.milliseconds, record.blocking]),
    [
      ['shader', 'water', 5, true],
      ['render', 'water', 7, true],
      ['compute', 'skin', 7, true],
      ['render', '', 7, true],
    ],
  );
  assert.equal(count, 4);
  assert.equal(blockingMilliseconds, 26);
  compiles.dispose();
});

test('an async pipeline runs until its promise settles and does not count as blocking', async (t) => {
  const r = rig(t),
    compiles = new PipelineCompiles();
  compiles.track(r.device);
  const pending = r.device.createRenderPipelineAsync({ label: 'late' });
  assert.equal(compiles.toJSON().compiles[0].milliseconds, null);
  r.now += 40;
  r.settle();
  assert.deepEqual(await pending, { async: true });
  const [record] = compiles.toJSON().compiles;
  assert.equal(record.milliseconds, 40);
  assert.equal(record.blocking, false);
  assert.equal(compiles.blockingMilliseconds, 0);
  compiles.dispose();
});

test('a failed compile keeps its error and is marked failed', async (t) => {
  const r = rig(t),
    compiles = new PipelineCompiles(),
    boom = new Error('bad shader');
  r.device.createComputePipeline = () => {
    throw boom;
  };
  compiles.track(r.device);
  assert.throws(() => r.device.createComputePipeline({ label: 'sync' }), boom);
  const pending = r.device.createRenderPipelineAsync({ label: 'async' });
  r.settle(boom);
  await assert.rejects(pending, boom);
  assert.deepEqual(
    compiles.toJSON().compiles.map((record) => record.failed),
    [true, true],
  );
  compiles.dispose();
});

test('a slow frame names the compiles near it, blocking first, then longest', (t) => {
  const r = rig(t),
    compiles = new PipelineCompiles(),
    heard = [];
  compiles.track(r.device);
  compiles.onHitch((hitch) => heard.push(hitch));
  r.now += 16;
  compiles.frame(16);
  r.device.createRenderPipelineAsync({ label: 'background' });
  r.cost = 3;
  r.device.createRenderPipeline({ label: 'short' });
  r.cost = 30;
  r.device.createRenderPipeline({ label: 'long' });
  r.now += 7;
  const hitch = compiles.frame(40);
  assert.deepEqual(
    hitch.compiles.map((record) => record.label),
    ['long', 'short', 'background'],
  );
  assert.equal(hitch.frame, 2);
  assert.equal(hitch.at, r.now);
  assert.equal(hitch.compiles[2].milliseconds, null, 'still running when the frame ended');
  assert.deepEqual(heard, [hitch]);
  compiles.dispose();
});

test('a call in the frame before a slow frame is named, one two frames before is not', (t) => {
  const r = rig(t),
    compiles = new PipelineCompiles();
  compiles.track(r.device);
  r.device.createRenderPipeline({ label: 'old' });
  r.now += 16;
  compiles.frame(16);
  r.now += 8;
  r.device.createRenderPipeline({ label: 'near' });
  r.now += 8;
  compiles.frame(16);
  r.now += 50;
  assert.deepEqual(
    compiles.frame(50).compiles.map((record) => record.label),
    ['near'],
  );
  compiles.dispose();
});

test('a slow frame with no compile near it is no hitch, and the threshold itself is not over it', (t) => {
  const r = rig(t),
    compiles = new PipelineCompiles({ hitchMilliseconds: 20 });
  compiles.track(r.device);
  r.device.createRenderPipeline({ label: 'old' });
  r.now += 500;
  assert.equal(compiles.frame(100), null);
  r.device.createRenderPipeline({ label: 'new' });
  r.now += 20;
  assert.equal(compiles.frame(20), null);
  assert.equal(compiles.frames, 2);
  compiles.dispose();
});

test('records and hitches stop at capacity and the count goes on', (t) => {
  const r = rig(t),
    compiles = new PipelineCompiles({ capacity: 2 });
  compiles.track(r.device);
  for (let i = 0; i < 5; i++) {
    r.device.createRenderPipeline({ label: 'p' + i });
    r.now += 50;
    compiles.frame(50);
  }
  const report = compiles.toJSON();
  assert.deepEqual(
    report.compiles.map((record) => record.label),
    ['p3', 'p4'],
  );
  assert.equal(report.count, 5);
  assert.equal(report.hitches.length, 2);
  assert.deepEqual(
    JSON.parse(JSON.stringify(report)).hitches[1].compiles.map((record) => record.label),
    ['p3', 'p4'],
  );
  compiles.dispose();
});

test('stacks keep the caller, and are off by default', (t) => {
  const r = rig(t),
    compiles = new PipelineCompiles({ stacks: true }),
    plain = new PipelineCompiles();
  compiles.track(r.device);
  function namedCaller() {
    r.device.createRenderPipeline({});
  }
  namedCaller();
  assert.match(compiles.toJSON().compiles[0].stack, /namedCaller/);
  compiles.dispose();
  plain.track(r.device);
  namedCaller();
  assert.equal('stack' in plain.toJSON().compiles[0], false);
  plain.dispose();
});

test('dispose gives the device its calls back, but leaves a wrapper added later', (t) => {
  const r = rig(t),
    { createRenderPipeline } = r.device,
    compiles = new PipelineCompiles();
  compiles.track(r.device);
  const later = () => {};
  r.device.createShaderModule = later;
  compiles.dispose();
  compiles.dispose();
  assert.equal(r.device.createRenderPipeline, createRenderPipeline);
  assert.equal(r.device.createShaderModule, later);
  assert.throws(() => compiles.frame(16), { code: 'disposed' });
  assert.throws(() => compiles.track(r.device), { code: 'disposed' });
});

test('attach follows the engine: its device, its frames, a restored device, and removal', (t) => {
  const r = rig(t),
    fresh = { ...r.device },
    callbacks = new Set(),
    engine = {
      gpu: r.device,
      use(plugin) {
        engine.plugin = plugin;
        plugin.setup(engine);
      },
      onFrame(callback) {
        callbacks.add(callback);
        return () => callbacks.delete(callback);
      },
      sceneOf(plugin) {
        return engine.plugin === plugin ? engine : undefined;
      },
      removePlugin(name) {
        engine.removed = name;
        if (engine.plugin?.name === name) engine.plugin = undefined;
      },
    },
    step = (delta) => callbacks.forEach((callback) => callback(engine, delta)),
    { createRenderPipeline } = r.device,
    compiles = PipelineCompiles.attach(engine);
  assert.throws(() => compiles.setup(engine), { code: 'attached' });
  step(0);
  r.now += 16;
  step(0.016);
  assert.equal(compiles.frames, 1);
  r.device.createRenderPipeline({ label: 'first' });
  r.now += 60;
  step(0.06);
  assert.equal(compiles.toJSON().hitches.length, 1);

  r.device.createRenderPipeline({ label: 'paused' });
  r.now += 5000;
  step(0);
  r.now += 16;
  step(0.016);
  assert.equal(compiles.toJSON().hitches.length, 1, 'the pause is no frame');
  assert.equal(compiles.frames, 3);

  engine.gpu = fresh;
  compiles.onDeviceRestored(engine);
  assert.equal(r.device.createRenderPipeline, createRenderPipeline, 'the old device is let go');
  fresh.createRenderPipeline({ label: 'restored' });
  assert.equal(compiles.toJSON().compiles.at(-1).label, 'restored');

  compiles.dispose();
  assert.equal(engine.removed, 'pipeline-compiles');
  assert.equal(callbacks.size, 0);
});

test('a WebGL engine has no device to follow and still attaches', (t) => {
  rig(t);
  const engine = {
      gpu: null,
      use(plugin) {
        engine.plugin = plugin;
        plugin.setup(engine);
      },
      onFrame: () => () => {},
      sceneOf(plugin) {
        return engine.plugin === plugin ? engine : undefined;
      },
      removePlugin() {
        engine.plugin = undefined;
      },
    },
    compiles = PipelineCompiles.attach(engine);
  assert.equal(compiles.count, 0);
  compiles.dispose();
});

test('options and frames are checked', () => {
  assert.throws(() => new PipelineCompiles({ hitchMilliseconds: 0 }), RangeError);
  assert.throws(() => new PipelineCompiles({ capacity: 0 }), RangeError);
  assert.throws(() => new PipelineCompiles({ capacity: 1.5 }), RangeError);
  assert.throws(() => new PipelineCompiles({ stacks: 1 }), TypeError);
  const compiles = new PipelineCompiles();
  assert.throws(() => compiles.frame(0), RangeError);
  assert.throws(() => compiles.frame(16, NaN), RangeError);
  compiles.dispose();
});

test('view shows the totals and the newest hitch in the panel until dispose', (t) => {
  const r = rig(t),
    dom = new JSDOM('<body></body>');
  dom.window.HTMLCanvasElement.prototype.getContext = () => null;
  const stats = new Stats({ parent: dom.window.document.body }),
    compiles = new PipelineCompiles();
  compiles.track(r.device);
  r.device.createRenderPipeline({ label: 'water' });
  r.now += 40;
  compiles.frame(40);
  compiles.view(stats).view(stats);
  assert.match(stats.element.textContent, /Compiles 1, 1 hitches/);
  assert.match(stats.element.textContent, /Last 40\.0 ms: water/);
  compiles.dispose();
  assert.doesNotMatch(stats.element.textContent, /Compiles/);
  stats.dispose();
  dom.window.close();
});

// The engine compiles its startup pipelines inside Engine.create, before anything can attach to it.
test('trackNext sees compiles made before the tracker joins the engine, and leaves the adapter as it found it', async (t) => {
  const saved = globalThis.GPUAdapter;
  t.after(() => (globalThis.GPUAdapter = saved));
  const device = { createShaderModule: () => ({}), createRenderPipeline: () => ({}), createComputePipeline: () => ({}),
    createRenderPipelineAsync: async () => ({}), createComputePipelineAsync: async () => ({}) };
  class Adapter {
    async requestDevice() {
      return device;
    }
  }
  const original = Adapter.prototype.requestDevice;
  globalThis.GPUAdapter = Adapter;
  const compiles = new PipelineCompiles().trackNext();
  assert.notEqual(Adapter.prototype.requestDevice, original);
  const made = await new Adapter().requestDevice();
  assert.equal(Adapter.prototype.requestDevice, original);
  made.createShaderModule({ code: '', label: 'startup' });
  assert.equal(compiles.toJSON().count, 1);
  assert.equal(compiles.toJSON().compiles[0].label, 'startup');
  compiles.dispose();
  const unused = new PipelineCompiles().trackNext();
  unused.dispose();
  assert.equal(Adapter.prototype.requestDevice, original);
});

test('trackNext without WebGPU is refused by name', (t) => {
  const saved = globalThis.GPUAdapter;
  t.after(() => (globalThis.GPUAdapter = saved));
  delete globalThis.GPUAdapter;
  assert.throws(() => new PipelineCompiles().trackNext(), { code: 'unsupported' });
});
