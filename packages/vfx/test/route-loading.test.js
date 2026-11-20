// KB-VFX-EMBERCPU1: on the WebGL2 layer a VFX encoded its steps before its compatibility route had loaded, so the
// layer ran the WebGPU kernels of every step (a prewarm is hundreds) on its CPU tier: 95 s over the ember effects of one
// FireFront. The steps of an effect with a prewarm now wait for the route and run, in order, on its draws; an effect
// with no prewarm keeps simulating on its WebGPU kernels until then (the `loadCompatRoute` contract, which the WebGL2
// run of features-check.mjs holds it to: no frame is drawn differently while the route loads).
import test from 'node:test';
import assert from 'node:assert/strict';
import { VFX } from '../dist/index.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

const layerHarness = () => {
  const h = optionalGPU();
  h.engine.stats = { drawCalls: 0 };
  h.engine.gpu.adapterInfo = { vendor: 'margo-webgl2' };
  // A step run from the held list makes its own encoder, as on a real device.
  h.engine.gpu.createCommandEncoder = () => ({
    beginComputePass: () => h.context.encoder.beginComputePass(),
    clearBuffer() {},
    finish: () => ({}),
  });
  const budgets = [],
    queue = h.engine.gpu.queue,
    write = queue.writeBuffer;
  queue.writeBuffer = function (buffer, offset, data, ...rest) {
    if (data?.byteLength === 224) budgets.push(new Int32Array(data.buffer, data.byteOffset, 56)[53]);
    return write.call(this, buffer, offset, data, ...rest);
  };
  return { h, budgets };
};

test('on the WebGL2 layer a prewarm is not simulated before the route loads, and every step it held runs after it', async () => {
  const { h, budgets } = layerHarness();
  // A prewarm of 0.05 s in steps of 1/60 s: three steps before the first live one.
  const effect = new VFX({ capacity: 600, rate: 0, initialCount: 40, schedule: { prewarm: 0.05 } });
  h.engine.use(effect);
  assert.ok(!effect.route, 'the route is still loading');
  h.frame();
  h.frame();
  assert.deepEqual(budgets, [], 'no step is simulated while the route loads');
  for (let i = 0; i < 100 && !effect.route; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(effect.route, 'the route loaded');
  h.frame();
  assert.deepEqual(
    budgets,
    [40, 0, 0, 0, 0, 0],
    'the prewarm with the initial births first, then the live step of each held frame, then this one',
  );
  budgets.length = 0;
  h.frame();
  assert.deepEqual(budgets, [0], 'after that one step a frame');
  effect.dispose();
});

test('on the WebGL2 layer an effect with no prewarm is simulated in every frame while the route loads', () => {
  const { h, budgets } = layerHarness();
  const effect = new VFX({ capacity: 600, rate: 0, initialCount: 40 });
  h.engine.use(effect);
  assert.ok(!effect.route, 'the route is still loading');
  h.frame();
  h.frame();
  assert.deepEqual(budgets, [40, 0], 'one step a frame on the WebGPU kernels, as the frames before the route always were');
  effect.dispose();
});

test('on a native WebGPU device a step is simulated in the first frame', () => {
  const h = optionalGPU();
  h.engine.stats = { drawCalls: 0 };
  let steps = 0;
  const write = h.engine.gpu.queue.writeBuffer;
  h.engine.gpu.queue.writeBuffer = function (buffer, offset, data, ...rest) {
    if (data?.byteLength === 224) steps++;
    return write.call(this, buffer, offset, data, ...rest);
  };
  const effect = new VFX({ capacity: 600, rate: 0, initialCount: 40 });
  h.engine.use(effect);
  h.frame();
  assert.equal(steps, 1);
  effect.dispose();
});

// KB-VFX-EMBERCPU1, the second half: over-life read `particles` and `lifeBirth` back after the kernel had stored to them,
// which the layer puts on its CPU tier (the route's `update` kernel of an effect with over-life ran there, 22 s of the
// 25 s that were left once the steps waited for the route). No route kernel may land on the CPU tier.
import { readdirSync } from 'node:fs';
import { planCompute } from '../../webgl2-compat/dist/compute.js';
import { checkWGSL } from '../../webgl2-compat/dist/wgsl.js';

const compatChunk = readdirSync(new URL('../dist/', import.meta.url)).find((name) => /^compat-.*\.js$/.test(name));
const { routeShaders } = await import(`../dist/${compatChunk}`);

for (const [name, options] of [
  ['a plain effect', {}],
  ['over-life size and speed', { overLife: { size: [1, 2], speed: [1, 0.5] } }],
  ['over-life with local space', { overLife: { size: [1, 2] }, space: { mode: 'local' } }],
  ['death events', { events: { on: 'death', count: 4 } }],
  ['collision events with over-life', { events: { on: 'collision' }, overLife: { size: [1, 2] } }],
  ['over-life, stretch, curves and a schedule', { overLife: { size: [1, 2], spin: [0, 1] }, stretch: { factor: 0.2 }, curves: { size: [1, 0.5] }, schedule: { prewarm: 1 } }],
]) {
  test(`no route kernel runs on the layer's CPU tier: ${name}`, () => {
    const h = optionalGPU();
    h.engine.stats = { drawCalls: 0 };
    const effect = new VFX({ capacity: 8, ...options });
    h.engine.use(effect);
    const simulation = h.pipelines.find((p) => p.compute?.module.code.includes('fn update(')).compute.module.code,
      kernels = routeShaders(simulation);
    for (const kernel of ['flags', 'update', 'marks']) {
      const source = kernels[kernel],
        plan = planCompute({ source, entryPoint: 'main' });
      assert.notEqual(plan.tier, 'cpu', `${kernel}: ${plan.reason}`);
      assert.ok(checkWGSL(source).entryPoints.some((e) => e.name === 'main'));
    }
    effect.dispose();
  });
}

// KB-VFX-EVENTS-CPU: the update kernel of an effect with events stored this frame's event (its half of `eventData`)
// before its births read last frame's half, so the layer could not prove the kernel a point draw and ran it on its CPU
// tier every frame. The event is now kept in the invocation and stored once `update` has returned, after every read.
// The work count: a frame on the route dispatches no kernel the layer plans on its CPU tier.
for (const on of ['death', 'collision']) {
  test(`a frame of an effect with ${on} events dispatches no kernel on the layer's CPU tier`, async () => {
    const { h } = layerHarness();
    const dispatched = [],
      begin = h.context.encoder.beginComputePass;
    h.context.encoder.beginComputePass = () => {
      const pass = begin(),
        state = { pipeline: undefined };
      return {
        ...pass,
        setPipeline(p) {
          state.pipeline = p;
        },
        dispatchWorkgroups() {
          dispatched.push(state.pipeline);
        },
      };
    };
    const effect = new VFX({ capacity: 600, rate: 200, initialCount: 40, events: { on, count: 4 } });
    h.engine.use(effect);
    for (let i = 0; i < 100 && !effect.route; i++) await new Promise((resolve) => setImmediate(resolve));
    assert.ok(effect.route, 'the route loaded');
    h.frame();
    dispatched.length = 0;
    h.frame();
    const tiers = dispatched.map((p) => planCompute({ source: p.compute.module.code, entryPoint: p.compute.entryPoint }));
    assert.ok(tiers.length >= 10, `${tiers.length} dispatches a frame`);
    const cpu = tiers.filter((plan) => plan.tier === 'cpu');
    assert.equal(cpu.length, 0, `CPU-tier dispatches a frame: ${cpu.map((plan) => plan.reason).join('; ')}`);
    effect.dispose();
  });
}
