// GAP-FILM-TIME: a clock started at film time T reads what a continuous run reads at T. Run A takes n + 1 frame updates;
// run B is fresh, replays n steps with `advanceTime` (what `seek` from @margoengine/cutscene/seek runs), then takes one
// update. The clock moves in the frame update, so a draw no longer moves it out of reach of a seek.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Shadertoy } from '../dist/shadertoy.js';

async function seekMatches(make, label, { scale = 1, after = () => {} } = {}) {
  for (const n of [1, 600, 54000]) {
    const a = await make(),
      b = await make();
    try {
      assert.equal(b.clock.time, 0, `a fresh ${label} starts at 0`);
      for (let step = 0; step <= n; step++) a.clock.onPreUpdate(1 / 60);
      for (let step = 0; step < n; step++) b.clock.advanceTime(1 / 60);
      b.clock.onPreUpdate(1 / 60);
      assert.ok(Object.is(b.clock.time, a.clock.time), `${label} at ${n} steps`);
      if (scale) assert.ok(Math.abs(a.clock.time - ((n + 1) / 60) * scale) <= 1e-6 * (n + 1) * scale, `${label} counts its clock`);
      after(a, b, n);
    } finally {
      a.close?.();
      b.close?.();
    }
  }
}

const plain = 'void mainImage(out vec4 c, in vec2 p) { c = vec4(sin(iTime), 0.0, 0.0, 1.0); }';

// iTime starts on the second frame (the first frame shows time 0), in a seek as in a continuous run.
test('a Shadertoy clock replayed equals a continuous run, iFrame included', async () => {
  await seekMatches(() => ({ clock: new Shadertoy(plain) }), 'Shadertoy', {
    scale: 0,
    after: (a, b, n) => {
      assert.deepEqual([b.clock.frame, b.clock.timeDelta], [a.clock.frame, a.clock.timeDelta]);
      assert.ok(Math.abs(a.clock.time - n / 60) < 1e-6 * n);
    },
  });
});

// The shader frame clock: node `time`, a NodePass or ComputePass `time` and the raw camera block's `time` read it, not
// performance.now(), so the same frame draws the same picture and a seek replays shader time with every other clock.
import { FrameGraph } from '../../core/dist/extension.js';
import { mockGPU } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { RawShaders } from '../dist/raw.js';
import { ComputePass, ShaderClock, storage, time, deltaTime } from '../dist/index.js';

function mockEngine() {
  const graph = new FrameGraph(),
    plugins = new Map(),
    gpu = mockGPU(),
    engine = {
      gpu: gpu.device,
      frameGraph: graph,
      disposed: false,
      plugins,
      sceneOf: (plugin) => (plugins.get(plugin.name) === plugin ? engine : undefined),
      use(plugin) {
        if (plugins.has(plugin.name)) throw new TypeError('Invalid plugin');
        plugins.set(plugin.name, plugin);
        graph.withOwner(plugin.name, () => {
          plugin.setup(engine);
          plugin.registerPasses?.(graph);
        });
        return engine;
      },
      removePlugin(name) {
        const plugin = plugins.get(name);
        plugins.delete(name);
        plugin?.dispose();
      },
      // The engine's frame update: every plugin's onPreUpdate, in attach order.
      update(delta) {
        for (const plugin of plugins.values()) plugin.onPreUpdate?.(delta);
      },
    };
  return engine;
}

const busy = (ms) => {
  for (const end = performance.now() + ms; performance.now() < end; );
};

test('a ShaderClock replayed equals a continuous run', async () => {
  await seekMatches(() => ({ clock: new ShaderClock() }), 'ShaderClock', {
    after: (a, b) => assert.ok(Object.is(b.clock.delta, a.clock.delta)),
  });
});

test('one ShaderClock per engine: RawShaders and ComputePass attach it, ShaderClock.attach finds it', () => {
  const engine = mockEngine();
  engine.use(new RawShaders());
  const clock = engine.plugins.get('shader:clock');
  assert.ok(clock instanceof ShaderClock, 'RawShaders attaches the clock');
  ComputePass.attach(engine, 1, () => storage(1, 'f32').store(0, time));
  assert.equal(ShaderClock.attach(engine), clock, 'a second host shares it');
  assert.equal([...engine.plugins.keys()].filter((name) => name === 'shader:clock').length, 1);
  assert.throws(() => engine.use(new ShaderClock()), TypeError);
});

test('ShaderClock.attach follows the engine-feature conventions: one clock, and Symbol.dispose detaches it', () => {
  const engine = mockEngine(),
    clock = ShaderClock.attach(engine);
  assert.equal(engine.plugins.get('shader:clock'), clock);
  assert.equal(ShaderClock.attach(engine), clock, 'one clock per engine');
  clock[Symbol.dispose]();
  assert.equal(engine.plugins.get('shader:clock'), undefined, 'Symbol.dispose removes the plugin');
  const next = ShaderClock.attach(engine);
  assert.notEqual(next, clock, 'a later attach starts a new clock');
  assert.equal(next.time, 0);
});

test('the raw camera block time is the frame clock, not the wall clock', () => {
  const engine = mockEngine(),
    raw = new RawShaders(),
    camera = { position: [0, 0, 5], target: [0, 0, 0] },
    m = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  engine.use(raw);
  for (let i = 0; i < 90; i++) engine.update(1 / 60);
  const first = raw.cameraBlock(camera, m, 64, 32, 1 / 60, 0)[51];
  busy(20);
  const again = raw.cameraBlock(camera, m, 64, 32, 1 / 60, 0)[51];
  assert.equal(first, Math.fround(ShaderClock.attach(engine).time));
  assert.equal(again, first, 'the same frame drawn twice reads the same time');
  assert.ok(Math.abs(first - 1.5) < 1e-5);
});

test('a node program writes the frame clock time and delta, not the wall clock', () => {
  const engine = mockEngine(),
    out = storage(2, 'f32'),
    pass = ComputePass.attach(engine, 1, () => [out.store(0, time), out.store(1, deltaTime)]),
    device = engine.gpu,
    clock = ShaderClock.attach(engine);
  // The pass's frame step, as the frame graph runs it.
  for (let i = 0; i < 30; i++) engine.update(1 / 60);
  const read = () => {
    const u = pass.program.buffers.get(device);
    return [...new Float32Array(u.bytes.buffer)];
  };
  pass.dispatch({ device, encoder: device.createCommandEncoder(), width: 1, height: 1, delta: clock.delta });
  const first = read();
  busy(20);
  pass.dispatch({ device, encoder: device.createCommandEncoder(), width: 1, height: 1, delta: clock.delta });
  assert.deepEqual(read(), first, 'the same frame uploads the same values');
  assert.ok(first.includes(Math.fround(0.5)), 'time is 30 steps of 1/60 s');
  assert.ok(first.includes(Math.fround(1 / 60)), 'deltaTime is the last step');
});

test('a node material on an engine without a clock attaches one after the frame that draws it', async () => {
  const engine = mockEngine();
  assert.equal(ShaderClock.find(engine), undefined, 'no clock in the frame that first draws');
  assert.equal(ShaderClock.find(engine), undefined);
  assert.equal(engine.plugins.size, 0, 'nothing attaches while the frame draws');
  await Promise.resolve();
  const clock = engine.plugins.get('shader:clock');
  assert.ok(clock instanceof ShaderClock);
  assert.equal(ShaderClock.find(engine), clock);
  const gone = mockEngine();
  ShaderClock.find(gone);
  gone.disposed = true;
  await Promise.resolve();
  assert.equal(gone.plugins.size, 0, 'a disposed engine gets no clock');
});
