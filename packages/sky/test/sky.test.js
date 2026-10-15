import test from 'node:test';
import assert from 'node:assert/strict';
import { Sky, sunDirection } from '../dist/index.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { wgsl } from '../../core/src/shaders.ts';
test('retained reflection lights track actual sun and moon directions through dusk', () => {
  const h = optionalGPU();
  h.engine.lighting = { direction: new Float32Array(4), radiance: new Float32Array([1, 1, 1, 0.15]) };
  const sky = new Sky({
    hours: 17.9,
    timeScale: 0,
    lighting: { intensity: 6, color: [1, 0.8, 0.54], moon: { intensity: 0.6, color: [0.25, 0.45, 0.75] } },
  });
  h.engine.use(sky);
  const lights = sky.lights;
  h.frame();
  assert.ok(
    Math.hypot(...sky.sun.map((v, i) => v - h.engine.lighting.direction[i])) > 0.1,
    'Dusk exercises the former blended-direction drift',
  );
  for (const hours of [12, 17 + 49 / 60, 17.7, 17.9, 18, 18.1, 18.3, 21, 0, 5.9, 6.1]) {
    sky.options.hours = hours;
    h.frame();
    assert.equal(sky.lights, lights);
    assert.deepEqual(lights[0].direction.slice(0, 3), sky.sun);
    assert.deepEqual(lights[1].direction.slice(0, 3), sky.moon);
    assert.equal(lights[0].direction[3], Math.fround(Math.max(0, sky.sun[1]) * 6));
    const values = new Float32Array(h.resources.find((r) => !r.destroyed && r.size === 256).data);
    assert.equal(lights[1].direction[3], values[31], 'Moon disc, environment and direct glints share one strength');
    if (sky.sun[1] >= 0) assert.equal(lights[1].direction[3], 0, 'No moon reflection before sunset');
    else if (sky.sun[1] <= -0.12) assert.equal(lights[1].direction[3], Math.fround(0.6));
    else assert.ok(lights[1].direction[3] > 0 && lights[1].direction[3] < 0.6);
    const before = lights.map((l) => l.direction.slice());
    for (let i = 0; i < 20; i++) h.frame();
    lights.forEach((l, i) => assert.deepEqual(l.direction, before[i]));
  }
  sky.onDeviceRestored(h.engine);
  h.frame();
  assert.equal(sky.lights, lights);
  assert.deepEqual(lights[0].direction.slice(0, 3), sky.sun);
  sky.dispose();
  assert.ok(h.resources.every((r) => r.destroyed));
  const unlit = new Sky({ hours: 0, timeScale: 0 });
  unlit.onPreUpdate(0);
  assert.ok(unlit.lights.every((l) => l.direction[3] === 0));
});
test('clock and sky models reuse four-order scattering tables until turbidity changes', () => {
  const h = optionalGPU(),
    effect = new Sky({ model: 'bruneton', hours: 12, timeScale: 1 }),
    frame = h.frame;
  h.engine.use(effect);
  frame();
  assert.equal(h.counts.compute, 11);
  const reflection = effect.reflectionTexture;
  assert.ok(reflection);
  assert.ok(Math.abs(effect.options.hours - 12.1) < 1e-8);
  frame();
  assert.equal(h.counts.compute, 12);
  assert.equal(effect.reflectionTexture, reflection);
  effect.options.turbidity = 3;
  frame();
  assert.equal(h.counts.compute, 24);
  effect.options.model = 'preetham';
  frame();
  assert.ok([...sunDirection(12)].every(Number.isFinite));
  assert.ok(Math.abs(sunDirection(6)[1]) < 1e-6);
  assert.ok(sunDirection(0)[1] < -0.99);
  assert.throws(() => new Sky({ turbidity: 0 }), /options/);
  effect.onDeviceRestored(h.engine);
  frame();
  effect.dispose();
  assert.ok(h.resources.every((r) => r.destroyed));
});

test('Preetham retains sun transmission and lazily builds scattering when switching to Bruneton', () => {
  const h = optionalGPU(),
    sky = new Sky({ hours: 12, timeScale: 0 });
  h.engine.use(sky);
  const computeFrame = () => {
    const before = h.counts.compute;
    h.frame();
    return h.counts.compute - before;
  };
  try {
    assert.equal(computeFrame(), 1, 'Default sky computes the sun transmission table without unused scattering');
    assert.equal(computeFrame(), 0, 'Unchanged transmission is retained');
    const reflected = sky.reflectionTexture;
    assert.ok(reflected);
    assert.equal(computeFrame(), 1, 'Requested Preetham reflection still updates');
    sky.options.turbidity = 3;
    assert.equal(computeFrame(), 2, 'Turbidity refreshes transmission and the requested reflection');
    assert.equal(sky.reflectionTexture, reflected);
    sky.options.model = 'bruneton';
    assert.equal(
      computeFrame(),
      11,
      'Switching at unchanged turbidity builds all four scattering orders before reflection',
    );
    assert.equal(computeFrame(), 1, 'Bruneton tables are retained');
    sky.options.model = 'preetham';
    assert.equal(computeFrame(), 1);
    sky.options.turbidity = 4;
    assert.equal(computeFrame(), 2);
    sky.options.model = 'bruneton';
    assert.equal(computeFrame(), 11, 'A model switch cannot reuse scattering computed for an older turbidity');
    sky.options.model = 'preetham';
    sky.onDeviceRestored(h.engine);
    assert.notEqual(sky.reflectionTexture, reflected, 'Restoration replaces the borrowed reflection texture');
    assert.equal(computeFrame(), 2, 'Restored default sky rebuilds transmission and reflection');
    sky.options.model = 'bruneton';
    assert.equal(computeFrame(), 11, 'Restoration also invalidates deferred scattering');
    sky.options.turbidity = 5;
    assert.equal(
      computeFrame(),
      12,
      'Active Bruneton turbidity changes rebuild transmission and all scattering orders',
    );
  } finally {
    sky.dispose();
  }
  assert.ok(h.resources.every((resource) => resource.destroyed));
});

test('interrupted Bruneton precomputation retains the original error and retries changed tables', () => {
  const h = optionalGPU(),
    sky = new Sky({ timeScale: 0 });
  h.engine.use(sky);
  h.frame();
  sky.options.model = 'bruneton';
  sky.options.turbidity = 3;
  const failure = new Error('Compute encoding failed'),
    begin = h.context.encoder.beginComputePass;
  let attempts = 0;
  h.context.encoder.beginComputePass = function (...args) {
    if (++attempts === 2) throw failure;
    return begin.apply(this, args);
  };
  try {
    assert.throws(h.frame, (error) => error === failure);
    h.context.encoder.beginComputePass = begin;
    const before = h.counts.compute;
    h.frame();
    assert.equal(h.counts.compute - before, 11, 'Retry recomputes transmission and all four scattering orders');
    const cached = h.counts.compute;
    h.frame();
    assert.equal(h.counts.compute, cached);
  } finally {
    h.context.encoder.beginComputePass = begin;
    sky.dispose();
  }
  assert.ok(h.resources.every((resource) => resource.destroyed));
});

test('optional sunset tint follows elevation in both scene lighting and water light records', () => {
  const h = optionalGPU();
  h.engine.lighting = { direction: new Float32Array(4), radiance: new Float32Array(4) };
  const sky = new Sky({
    hours: 12,
    timeScale: 0,
    lighting: { intensity: 6, color: [1, 0.97, 0.92], sunset: [1, 0.69, 0.36] },
  });
  h.engine.use(sky);
  h.frame();
  assert.deepEqual([...sky.lights[0].radiance], [1, 0.97, 0.92].map(Math.fround));
  assert.deepEqual(h.engine.lighting.radiance.slice(0, 3), sky.lights[0].radiance);
  sky.options.hours = 17.9;
  h.frame();
  assert.deepEqual([...sky.lights[0].radiance], [1, 0.69, 0.36].map(Math.fround));
  assert.deepEqual(h.engine.lighting.radiance.slice(0, 3), sky.lights[0].radiance);
  sky.options.hours = 6.1;
  h.frame();
  assert.deepEqual([...sky.lights[0].radiance], [1, 0.69, 0.36].map(Math.fround));
  sky.dispose();
  for (const sunset of [
    [-1, 0, 0],
    [1, NaN, 1],
    [1, 1],
  ])
    assert.throws(() => new Sky({ lighting: { sunset } }), /Sky|sky/);
});

test('distance fog borrows scene depth, caches resources and rebinds after resize/restoration', () => {
  const h = optionalGPU();
  let depth;
  const create = (samples = 1) =>
    Object.assign(
      h.engine.gpu.createTexture({
        size: [128, 96],
        format: 'depth32float',
        sampleCount: samples,
        usage: GPUTextureUsage.TEXTURE_BINDING,
      }),
      { depthOrArrayLayers: 1 },
    );
  const sky = new Sky({ fog: { depth: () => depth, density: 0.008, start: 45 } });
  h.engine.use(sky);
  h.frame();
  const before = { ...h.counts };
  depth = create();
  h.frame();
  assert.equal(h.counts.render, before.render + 2);
  const fog = () => h.pipelines.findLast((p) => p.fragment?.entryPoint === 'fogFragment');
  assert.match(fog().fragment.module.code, /if\(d<=0.0\)\{discard;/);
  assert.equal(fog().fragment.targets[0].blend.color.dstFactor, 'one-minus-src-alpha');
  const cached = { ...h.counts };
  for (let i = 0; i < 20; i++) h.frame();
  assert.equal(h.counts.groups, cached.groups);
  assert.equal(h.counts.textures, cached.textures);
  assert.equal(h.counts.buffers, cached.buffers);
  const old = depth;
  depth = create(4);
  h.frame();
  assert.match(fog().fragment.module.code, /texture_depth_multisampled_2d/);
  assert.match(fog().fragment.module.code, /@builtin\(sample_index\)/);
  assert.equal(old.destroyed, false);
  sky.onDeviceRestored(h.engine);
  h.frame();
  assert.ok(h.groups.at(-1).entries.some((e) => e.binding === 3 && e.resource.texture === depth));
  depth.width = 64;
  assert.throws(h.frame, /matching sampleable scene depth/);
  depth.width = 128;
  sky.options.fog.density = 0;
  const rendered = h.counts.render;
  h.frame();
  assert.equal(h.counts.render, rendered + 1);
  sky.dispose();
  assert.equal(depth.destroyed, false);
  old.destroy();
  depth.destroy();
  assert.ok(h.resources.every((r) => r.destroyed));
  for (const fog of [
    null,
    {},
    { depth: 0 },
    { depth: () => undefined, density: -1 },
    { depth: () => undefined, density: NaN },
    { depth: () => undefined, start: Infinity },
    { depth: () => undefined, start: -1 },
    { depth: () => undefined, falloff: 'linear' },
    { depth: () => undefined, height: -1 },
  ])
    assert.throws(() => new Sky({ fog }), /fog/);
  assert.throws(() => new Sky({ fog: { depth: () => undefined, color: [1, NaN, 0] } }), /Fog color/);
});

test('exponential height fog with a fixed colour packs its uniform every frame', () => {
  const h = optionalGPU(),
    depth = Object.assign(
      h.engine.gpu.createTexture({ size: [128, 96], format: 'depth32float', usage: GPUTextureUsage.TEXTURE_BINDING }),
      { depthOrArrayLayers: 1 },
    ),
    color = [0.1, 0.2, 0.3];
  const sky = new Sky({ fog: { depth: () => depth, density: 0.01, start: 0, falloff: 'exp', height: 0.065, color } });
  h.engine.use(sky);
  h.frame();
  const values = () =>
    Array.from(new Float32Array(h.resources.find((r) => !r.destroyed && r.size === 32).data), (v) => +v.toFixed(4));
  assert.deepEqual(values(), [0.01, 0, 1, 0.065, 0.1, 0.2, 0.3, 1]);
  color[0] = 0.5;
  sky.options.fog.density = 0.02;
  h.frame();
  assert.deepEqual(values().slice(0, 5), [0.02, 0, 1, 0.065, 0.5]);
  delete sky.options.fog.color;
  delete sky.options.fog.falloff;
  h.frame();
  assert.deepEqual(values().slice(2, 8), [0, 0.065, 0, 0, 0, 0]);
  sky.dispose();
  depth.destroy();
  assert.ok(h.resources.every((r) => r.destroyed));
});

test('moonlight, ambient color and the reflected night sky share a continuous clock and restore', () => {
  const h = optionalGPU();
  h.engine.lighting = { direction: new Float32Array(4), radiance: new Float32Array([1, 1, 1, 0.18]) };
  const options = {
    hours: 12,
    timeScale: 0,
    lighting: {
      intensity: 6,
      color: [1, 0.8, 0.54],
      moon: { intensity: 0.6, color: [0.25, 0.45, 0.75] },
      ambient: { day: [0.18, 0.18, 0.18], night: [0.02, 0.04, 0.09] },
    },
  };
  const sky = new Sky(options);
  h.engine.use(sky);
  sky.reflectionTexture;
  h.frame = () => {
    sky.onPreUpdate(h.context.delta);
    h.context.shader = wgsl;
    h.context.bindings = [];
    h.engine.frameGraph.execute(h.context);
  };
  h.frame();
  const ambient = () => h.resources.find((r) => !r.destroyed && r.size === 16),
    values = () => new Float32Array(ambient().data);
  assert.equal(sky.nightFactor, 0);
  assert.equal(h.engine.lighting.direction[3], 6);
  assert.deepEqual(Array.from(values().subarray(0, 3)), options.lighting.ambient.day.map(Math.fround));
  assert.match(h.context.shader, /skyAmbient.rgb/);
  assert.ok(h.context.bindings.some((e) => e.binding === 8 && e.resource.buffer === ambient()));
  options.hours = 0;
  h.frame();
  assert.deepEqual(h.engine.lighting.direction.slice(0, 3), sky.moon);
  assert.ok(sky.moon[1] > 0.17 && sky.moon[1] < 0.26, 'Moon preset stays 10–15 degrees above the horizon');
  assert.ok(Math.abs(h.engine.lighting.direction[3] - 0.6) < 1e-6);
  assert.deepEqual(Array.from(h.engine.lighting.radiance.subarray(0, 3)), options.lighting.moon.color.map(Math.fround));
  assert.deepEqual(Array.from(values().subarray(0, 3)), options.lighting.ambient.night.map(Math.fround));
  const skyValues = new Float32Array(h.resources.find((r) => r.size === 256).data);
  assert.equal(sky.nightFactor, 1);
  assert.equal(skyValues[23], 1);
  assert.deepEqual(Array.from(skyValues.subarray(28, 31)), Array.from(sky.moon));
  options.hours = 18;
  h.frame();
  assert.ok(sky.nightFactor > 0 && sky.nightFactor < 1);
  const created = { ...h.counts };
  let previous;
  for (let i = 0; i <= 200; i++) {
    options.hours = 17.5 + i / 200;
    h.frame();
    const direction = h.engine.lighting.direction.slice(0, 3);
    if (previous) assert.ok(direction.reduce((sum, v, j) => sum + v * previous[j], 0) > 0.995);
    previous = direction;
    assert.ok(direction.every(Number.isFinite));
  }
  assert.equal(h.counts.groups, created.groups);
  assert.equal(h.counts.buffers, created.buffers);
  options.hours = 0;
  sky.onDeviceRestored(h.engine);
  h.frame();
  assert.equal(sky.nightFactor, 1);
  assert.deepEqual(Array.from(values().subarray(0, 3)), options.lighting.ambient.night.map(Math.fround));
  sky.dispose();
  assert.ok(h.resources.every((r) => r.destroyed));
  for (const lighting of [
    { moon: null },
    { moon: { intensity: -1 } },
    { moon: { color: [1, , 1] } },
    { ambient: { day: [1, 1, 1] } },
    { ambient: { day: [1, 1, 1], night: [-1, 0, 0] } },
  ])
    assert.throws(() => new Sky({ lighting }), /Sky|sky/);
});

test('opt-in sunlight synchronizes before rendering and reverse clocks wrap at midnight', () => {
  const h = optionalGPU(),
    direction = new Float32Array([3, 5, 4, 3]),
    radiance = new Float32Array([1, 0.8, 0.54, 0.18]);
  h.engine.lighting = { direction, radiance };
  const before = direction.slice(),
    sky = new Sky({ hours: 12, timeScale: 0 });
  h.engine.use(sky);
  sky.onPreUpdate(0);
  assert.deepEqual(direction, before);
  sky.options.lighting = { intensity: 6, minimum: 0.15 };
  sky.onPreUpdate(0);
  assert.deepEqual(direction.slice(0, 3), sky.sun);
  assert.equal(direction[3], 6);
  const colors = radiance.slice();
  sky.options.hours = 0;
  sky.options.timeScale = -1;
  sky.onPreUpdate(0.1);
  assert.ok(Math.abs(sky.options.hours - 23.9) < 1e-8);
  assert.ok(Math.abs(direction[3] - 0.15) < 1e-6);
  assert.deepEqual(radiance, colors);
  const hours = sky.options.hours;
  h.engine.frameGraph.execute(h.context);
  assert.equal(sky.options.hours, hours);
  sky.onDeviceRestored(h.engine);
  sky.onPreUpdate(0);
  assert.deepEqual(direction.slice(0, 3), sky.sun);
  sky.dispose();
  for (const lighting of [{ intensity: -1 }, { minimum: NaN }, null])
    assert.throws(() => new Sky({ lighting }), /options/);
});

test('sky clock wraps midnight and synchronizes sun and lighting once before rendering', () => {
  const h = optionalGPU(),
    effect = new Sky({ hours: 23.95, timeScale: 1, lighting: { intensity: 2, minimum: 0.25 } });
  h.engine.lighting = { direction: new Float32Array(4) };
  h.engine.use(effect);
  try {
    h.frame();
    assert.ok(Math.abs(effect.options.hours - 0.05) < 1e-8);
    const uniform = h.resources.find((r) => r.size === 256),
      values = new Float32Array(uniform.data);
    assert.deepEqual([...values.subarray(20, 23)], [...effect.sun]);
    assert.deepEqual([...h.engine.lighting.direction.subarray(0, 3)], [...sunDirection(effect.options.hours)]);
    assert.equal(h.engine.lighting.direction[3], 0.25);
    const hours = effect.options.hours;
    h.engine.frameGraph.execute(h.context);
    assert.equal(effect.options.hours, hours);
    effect.options.timeScale = -1;
    h.frame();
    assert.ok(Math.abs(effect.options.hours - 23.95) < 1e-8);
    effect.options.hours = 12;
    h.context.delta = 0;
    h.frame();
    assert.equal(effect.options.hours, 12);
    assert.equal(h.engine.lighting.direction[3], 2);
    for (const delta of [-0.1, NaN, Infinity]) {
      h.context.delta = delta;
      assert.throws(h.frame, /Invalid sky delta/);
      assert.equal(effect.options.hours, 12);
    }
  } finally {
    effect.dispose();
  }
});

test('optional procedural clouds share retained frame data and night sky works without moon lighting', () => {
  const h = optionalGPU(),
    sky = new Sky({ hours: 0, timeScale: 0, clouds: { coverage: 0.45, speed: 8, height: 1500 } });
  h.engine.use(sky);
  sky.reflectionTexture;
  h.frame();
  const values = () => new Float32Array(h.resources.find((r) => !r.destroyed && r.size === 256).data),
    first = values()[37];
  assert.equal(values()[23], 1);
  assert.equal(values()[36], Math.fround(0.45));
  assert.equal(values()[38], 1500);
  const created = { ...h.counts };
  for (let i = 0; i < 60; i++) h.frame();
  assert.ok(values()[37] > first);
  assert.equal(h.counts.buffers, created.buffers);
  assert.equal(h.counts.groups, created.groups);
  sky.onDeviceRestored(h.engine);
  h.frame();
  assert.ok(values()[37] > first);
  sky.dispose();
  assert.ok(h.resources.every((r) => r.destroyed));
  for (const clouds of [null, { coverage: -0.1 }, { coverage: 1.1 }, { speed: NaN }, { height: 0 }])
    assert.throws(() => new Sky({ clouds }), /clouds/);
});
