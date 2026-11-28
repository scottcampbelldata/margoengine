import test from 'node:test';
import assert from 'node:assert/strict';
import { Sky, sunDirection, sunlight } from '../dist/index.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { wgsl } from '../../core/src/shaders.ts';

const luminance = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
/**
 * The engine light is the sun's beam plus the twilight sky (KB-TWILIGHT1), summed as irradiance vectors: with E the
 * luminance-weighted intensity (direction[3] x luminance(radiance)) of each, the light's vector is E1 d1 + E2 d2, so a
 * surface of normal n that both reach gets n . (E1 d1 + E2 d2), their sum as in reality. Checks the engine light is that
 * vector, which lies in the sun's vertical plane on the sun's side, and returns its elevation's sine.
 */
function assertSolar(light, sky) {
  const sun = sky.lights[0],
    dusk = sky.twilightLight,
    e1 = sun.direction[3] * luminance(sun.radiance),
    e2 = dusk.direction[3] * luminance(dusk.radiance),
    sum = [0, 1, 2].map((i) => e1 * sun.direction[i] + e2 * dusk.direction[i]),
    length = Math.hypot(...sum),
    d = light.direction;
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(d[i] - sum[i] / length) < 1e-6, `direction ${i}: ${d[i]}`);
  assert.ok(Math.abs((d[3] * luminance(light.radiance)) / length - 1) < 1e-5, 'the two lights summed');
  // In the sun's vertical plane, on its side: the light never crosses the sky between sun and twilight.
  const across = [sky.sun[2], 0, -sky.sun[0]],
    span = Math.hypot(...across) || 1;
  assert.ok(Math.abs(d[0] * across[0] + d[2] * across[2]) / span < 1e-6, "in the sun's vertical plane");
  assert.ok(d[0] * sky.sun[0] + d[2] * sky.sun[2] >= 0, "on the sun's side");
  return d[1];
}
/**
 * Deep in the night with no moon the sun has no beam and the twilight sky, USNO C171's sky term (Janiczek and
 * DeYoung 1987) times the night blend of 1, is under 1e-20 lux (1e-24 lux with the sun 88.5 degrees down), so the
 * engine light holds `minimum`, from the twilight's side 45 degrees up, in the twilight's colour, which at that level
 * the eye's night shift (Jensen et al. 2000) has made the night's blue (KB-TWILIGHT1). Until twilight it held
 * `minimum` from the sun's direction below the ground, in white.
 */
function assertNightFloor(light, sky, minimum) {
  const dusk = sky.twilightLight;
  assert.ok(sky.lights[0].direction[3] === 0 && dusk.direction[3] > 0 && dusk.direction[3] < 1e-20);
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(light.direction[i] - dusk.direction[i]) < 1e-6, `direction ${i}`);
    assert.ok(Math.abs(light.radiance[i] - dusk.radiance[i]) < 1e-6, `colour ${i}`);
  }
  assert.ok(Math.abs(dusk.direction[1] - Math.SQRT1_2) < 1e-6 && dusk.direction[0] * sky.sun[0] >= 0);
  assert.equal(light.direction[3], Math.fround(minimum));
}
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
  // At 17.9 h the sun is 1.5 degrees up. The sky's night blend starts with the sun 4.6 degrees up, and the twilight
  // glow carries the share of the sky's light the environment hands over (night factor 0.18 here, so 0.18 x USNO C171's
  // 1,480 lux sky = 2.6% of the beam), so the light is the beam plus that glow, from the sun's side; no moon.
  assert.ok(sky.twilightLight.direction[3] > 0 && sky.lights[1].direction[3] === 0);
  assert.ok(assertSolar(h.engine.lighting, sky) > sky.sun[1], 'a little above the sun, toward the glow');
  for (const hours of [12, 17 + 49 / 60, 17.7, 17.9, 18, 18.1, 18.3, 21, 0, 5.9, 6.1]) {
    sky.options.hours = hours;
    h.frame();
    assert.equal(sky.lights, lights);
    assert.deepEqual(lights[0].direction.slice(0, 3), sky.sun);
    assert.deepEqual(lights[1].direction.slice(0, 3), sky.moon);
    // The camera sits 1 m up; the default turbidity is 2.
    assert.equal(lights[0].direction[3], Math.fround(6 * Math.max(...sunlight(sky.sun[1], 0.001, 2))));
    if (sky.sun[1] < -0.02) assert.equal(lights[0].direction[3], 0, 'No sun once its disc has set');
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

// Regression (2026-11-13, Storm Light): a night set without moonDirection drew its moon at its own default but lit
// the clouds and the scene from the sky's fixed default, so a second, unseen moon threw a bright glow elsewhere.
test('the lighting moon is the night moon, placed or at the night default, and keeps its own default without a night', () => {
  const h = optionalGPU();
  h.engine.lighting = { direction: new Float32Array(4), radiance: new Float32Array([1, 1, 1, 0.15]) };
  const sky = new Sky({
    hours: 23,
    timeScale: 0,
    night: { moonDirection: [3, 4, 0] },
    lighting: { intensity: 2, moon: { intensity: 0.4, color: [0.5, 0.6, 1] } },
  });
  h.engine.use(sky);
  const fallback = [-0.3, 0.22, -1].map((v) => Math.fround(v / Math.hypot(0.3, 0.22, 1)));
  const nightDefault = [0.4, 0.7, 0.5].map((v) => Math.fround(v / Math.hypot(0.4, 0.7, 0.5)));
  for (const [placed, expected] of [
    [[3, 4, 0], [0.6, 0.8, 0].map(Math.fround)],
    [[0, 1, -1], [0, Math.SQRT1_2, -Math.SQRT1_2].map(Math.fround)],
    [undefined, nightDefault],
    ['no night', fallback],
  ]) {
    if (placed === 'no night') sky.options.night = undefined;
    else sky.options.night.moonDirection = placed;
    h.frame();
    assert.deepEqual([...sky.moon], expected, 'The moon the sky lights with is the one the night draws');
    assert.deepEqual([...sky.lights[1].direction.slice(0, 3)], expected, 'Water glints use the same moon');
    const values = new Float32Array(h.resources.find((r) => !r.destroyed && r.size === 256).data);
    assert.deepEqual([...values.slice(28, 31)], expected, 'The lighting moon disc sits where the night moon is');
    if (sky.options.night)
      assert.deepEqual([...values.slice(48, 51)], expected, 'The night draws its disc and glow where the light is');
    assert.deepEqual(
      [...h.engine.lighting.direction.slice(0, 3)],
      expected,
      'At night the scene light comes from the moon',
    );
  }
});
test('authored sun direction is normalized and shared by visible sky and scene lighting', () => {
  const h = optionalGPU();
  h.engine.lighting = { direction: new Float32Array(4), radiance: new Float32Array([1, 1, 1, 0.15]) };
  const sky = new Sky({ sunDirection: [3, 4, 12], timeScale: 0, lighting: { intensity: 2 } });
  h.engine.use(sky);
  try {
    h.frame();
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(sky.sun[i] - [3 / 13, 4 / 13, 12 / 13][i]) < 1e-6);
    assert.deepEqual(h.engine.lighting.direction.slice(0, 3), sky.sun);
    sky.options.sunDirection = [-1, 1, -1];
    h.frame();
    assert.ok(sky.sun[0] < 0 && sky.sun[2] < 0);
    sky.options.sunDirection = [0, 0, 0];
    assert.throws(() => h.frame(), /direction/i);
  } finally {
    sky.dispose();
  }
});

test('sky lighting registration uses native PBR hooks and restores target on disposal', () => {
  const h = optionalGPU(),
    sky = new Sky({ timeScale: 0, lighting: { ambient: { day: [0.1, 0.1, 0.1], night: [0.01, 0.01, 0.01] } } });
  h.engine.lighting = { direction: new Float32Array(4), radiance: new Float32Array(4) };
  h.engine.use(sky);
  let effect,
    released = 0;
  const target = {
    addLighting(value) {
      effect = value;
      return () => released++;
    },
  };
  h.frame = () => {
    sky.onPreUpdate(h.context.delta);
    h.context.shader = wgsl;
    h.context.bindings = [];
    h.engine.frameGraph.execute(h.context);
  };
  const detach = sky.add(target);
  h.frame();
  assert.ok(effect.pbr(2).declarations.includes('@group(2)'));
  assert.match(effect.pbr(2).ambient, /skyLighting\(s.n,v,s.base.rgb,s.metal,s.roughness,s.f0,s.sw\)/);
  assert.equal(effect.bindings().length, 3);
  detach();
  detach();
  assert.equal(released, 1);
  sky.add(target);
  sky.dispose();
  assert.equal(released, 2);
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

test('sunlight is the transmittance relative to noon: plane-parallel high up, warm low down, zero once set', () => {
  assert.deepEqual([...sunlight(1, 0.001, 2)], [1, 1, 1]);
  // Turbidity 2 gives the Mie coefficient 0.003996 * 0.5; scale heights are 8 and 1.2 km.
  const mie = (0.003996 * 0.5) / 0.9;
  for (const mu of [0.9, 0.6, 0.4]) {
    const s = sunlight(mu, 0.001, 2);
    [0.005802, 0.013558, 0.0331].forEach((beta, i) => {
      const flat = Math.exp(-(beta * 8 + mie * 1.2) * (1 / mu - 1));
      assert.ok(Math.abs(s[i] - flat) < 0.01 * flat, `mu ${mu}, channel ${i}: ${s[i]} against ${flat}`);
    });
  }
  // 17:34 on the island clock: about 6 degrees up, turbidity 3.2.
  const golden = sunlight(sunDirection(17 + 34 / 60)[1], 0.001, 3.2);
  assert.ok(golden[0] > golden[1] && golden[1] > golden[2] && golden[2] < 0.35 && golden[0] > 0.5, `${golden}`);
  assert.ok(sunlight(0, 0.001, 2)[0] > 0, 'The disc still shows on the horizon');
  assert.deepEqual([...sunlight(-0.02, 0.001, 2)], [0, 0, 0]);
  let previous = 0;
  for (let mu = -0.03; mu <= 0.3; mu += 0.001) {
    const red = sunlight(mu, 0.001, 2)[0];
    assert.ok(red >= previous - 1e-6, 'Rises steadily through sunrise');
    previous = red;
  }
  assert.throws(() => sunlight(NaN, 0, 2), /Invalid sunlight/);
  assert.throws(() => sunlight(0, 0, 2, new Float32Array(4)), /Invalid sunlight/);
});

test('the engine sun takes colour and strength from the transmittance; sunset is ignored', () => {
  const h = optionalGPU();
  h.engine.lighting = { direction: new Float32Array(4), radiance: new Float32Array(4) };
  const sky = new Sky({
    hours: 12,
    timeScale: 0,
    lighting: { intensity: 6, color: [1, 0.97, 0.92], sunset: [1, 0.69, 0.36] },
  });
  h.engine.use(sky);
  h.frame();
  assert.deepEqual([...sky.lights[0].radiance], [1, 0.97, 0.92].map(Math.fround), 'Noon keeps the configured colour');
  assert.deepEqual(h.engine.lighting.radiance.slice(0, 3), sky.lights[0].radiance);
  assert.equal(h.engine.lighting.direction[3], 6);
  sky.options.hours = 17 + 34 / 60;
  h.frame();
  const [r, g, b] = sky.lights[0].radiance,
    strength = h.engine.lighting.direction[3];
  assert.ok(r === 1 && g < 0.8 && b < g, `Golden hour is warm: ${[r, g, b]}`);
  assert.ok(strength > 6 * 0.5 && strength < 6, `and dimmed once, by the air (${strength}), not by elevation too`);
  assert.deepEqual(h.engine.lighting.radiance.slice(0, 3), sky.lights[0].radiance);
  delete sky.options.lighting.sunset;
  h.frame();
  assert.deepEqual([...sky.lights[0].radiance], [r, g, b], 'sunset no longer changes the colour');
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
  assert.doesNotThrow(() => new Sky({ fog: {} }));
  for (const fog of [
    null,
    { depth: null },
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

test('fog automatically reads the live samples of a 4x capture before its single-sample depth resolves', () => {
  const h = optionalGPU(),
    depth = Object.assign(
      h.engine.gpu.createTexture({
        size: [128, 96],
        format: 'depth32float',
        usage: GPUTextureUsage.TEXTURE_BINDING,
      }),
      { depthOrArrayLayers: 1 },
    ),
    samples = { label: 'this frame' },
    sky = new Sky({ fog: { density: 0.008, start: 45 } });
  h.engine.use(sky);
  // What a capture (Bloom, a PostStack) leaves on the pass context between its begin() and its resolve.
  h.engine.use({
    name: 'capture',
    setup() {},
    registerPasses(graph) {
      graph.add({
        name: 'capture',
        order: -60,
        execute: (c) => {
          c[Symbol.for('margoengine.optional.msaa')] = {
            samples: 4,
            resolvedDepth: depth,
            depthSource: samples,
            color: c.color,
            depth: c.depth,
          };
        },
      });
    },
  });
  h.frame();
  const fog = h.pipelines.findLast((p) => p.fragment?.entryPoint === 'fogFragment');
  assert.match(fog.fragment.module.code, /texture_depth_multisampled_2d/);
  assert.match(fog.fragment.module.code, /@builtin\(sample_index\)/);
  assert.equal(h.groups.at(-1).entries.find((e) => e.binding === 3).resource, samples);
  sky.dispose();
  depth.destroy();
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
    Array.from(new Float32Array(h.resources.find((r) => !r.destroyed && r.size === 320).data), (v) => +v.toFixed(4));
  assert.deepEqual(values().slice(0, 12), [0.01, 0, 1, 0.065, 0.1, 0.2, 0.3, 1, 0, 0, 0, 0]);
  assert.ok(
    values()
      .slice(12)
      .every((v) => v === 0),
    'no fire: nothing added to the haze',
  );
  color[0] = 0.5;
  sky.options.fog.density = 0.02;
  Object.assign(sky.options.fog, { scaleHeight: 500, base: 80 });
  h.frame();
  assert.deepEqual(values().slice(8, 12), [0.002, 80, 0, 0], 'the height falloff: 1 / scaleHeight and the base');
  assert.deepEqual(values().slice(0, 5), [0.02, 0, 1, 0.065, 0.5]);
  delete sky.options.fog.color;
  delete sky.options.fog.falloff;
  h.frame();
  assert.deepEqual(values().slice(2, 8), [0, 0.065, 0, 0, 0, 0]);
  // KB-SKY-PALLFALLOFF1: the fires' spots on the haze from float 12, two vec4 each, every frame.
  sky.options.fog.fireSpots = [{ color: [0.5, 0.25, 0.125], x: 300, z: -40, reach: 1200 }];
  h.frame();
  assert.deepEqual(values().slice(12, 20), [0.5, 0.25, 0.125, 1440000, 300, 1000, -40, 0]);
  delete sky.options.fog.fireSpots;
  h.frame();
  assert.ok(
    values()
      .slice(12)
      .every((v) => v === 0),
    'cleared with the spots',
  );
  // KB-SKY-HAZEBELOW1: the haze's light decay below the eye in floats 76 to 78, every frame.
  sky.options.fog.lightDecay = [0.3, 0.45, 0.7];
  h.frame();
  assert.deepEqual(values().slice(76, 80), [0.3, 0.45, 0.7, 0]);
  delete sky.options.fog.lightDecay;
  h.frame();
  assert.deepEqual(values().slice(76, 80), [0, 0, 0, 0]);
  for (const bad of [[{ color: [5, 0, 0], x: 0, z: 0 }], [{ color: [0, 0, 0], x: 0, z: 0, reach: 0 }], [null]])
    assert.throws(() => new Sky({ fog: { fireSpots: bad } }), /fog\.fireSpots/);
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
  // Nine SH coefficients (GPU-written), the ambient floor at vec4 9 and the ground row at 10 (CPU-written).
  const ambient = () => h.resources.find((r) => !r.destroyed && r.size === 176),
    values = () => new Float32Array(ambient().data).subarray(36);
  assert.equal(sky.nightFactor, 0);
  assert.equal(h.engine.lighting.direction[3], 6);
  assert.deepEqual(Array.from(values().subarray(0, 3)), options.lighting.ambient.day.map(Math.fround));
  assert.match(
    h.context.shader,
    /let margoAmbient=skyLighting\(n,v,i\.color,i\.material\.y,i\.material\.x,vec3f\(0\.04\),1\.0\);/,
  );
  assert.match(h.context.shader, /\*0\.0\*frame\.ambient\.rgb\+margoAmbient;/, 'The constant ambient gives way');
  assert.ok(h.context.bindings.some((e) => e.binding === 8 && e.resource.buffer === ambient()));
  const map = h.context.bindings.find((e) => e.binding === 10).resource,
    lightPasses = h.pipelines.filter((p) => ['renderLight', 'main'].includes(p.compute?.entryPoint));
  assert.ok(map && h.context.bindings.some((e) => e.binding === 11), 'Sky map and its sampler for reflections');
  assert.ok(
    lightPasses.some((p) => p.compute.module.code.includes('workgroupBarrier()')),
    'SH projection',
  );
  options.hours = 0;
  h.frame();
  assert.deepEqual(h.engine.lighting.direction.slice(0, 3), sky.moon);
  assert.ok(sky.moon[1] > 0.17 && sky.moon[1] < 0.26, 'Moon preset stays 10-15 degrees above the horizon');
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
  // Derivation (KB-TWILIGHT1). Until the moon takes over, the engine light is the sun's beam plus the twilight sky
  // summed as irradiance vectors (assertSolar), both from the sun's vertical plane: as the beam goes out over the two
  // minutes the disc takes to set, that sum turns upward in the plane from the sun toward the glow 45 degrees up, with
  // the light on every surface the exact sum of the two, so no step in it. A step that leaves the plane is a change of
  // body, to the moon: it happens once, while both are nearly off, as the sun-to-moon switch did before twilight.
  let previous,
    previousStrength = 0,
    previousRise = -1,
    wasSolar = false,
    switches = 0,
    turns = 0;
  for (let i = 0; i <= 200; i++) {
    options.hours = 17.5 + i / 200;
    h.frame();
    const direction = h.engine.lighting.direction.slice(0, 3),
      strength = h.engine.lighting.direction[3],
      solar = !(sky.moonUnderClouds.direction[3] > 0 && direction.every((v, j) => v === sky.moon[j]));
    if (solar) {
      const rise = assertSolar(h.engine.lighting, sky);
      // Once the sun is down its beam only weakens, so the light only rises toward the glow.
      if (sky.sun[1] < 0) assert.ok(rise >= previousRise - 1e-7, `the light rises after sunset: ${rise}`);
      previousRise = rise;
    }
    if (previous && direction.reduce((sum, v, j) => sum + v * previous[j], 0) < 0.995) {
      if (solar && wasSolar) turns++;
      else {
        switches++;
        assert.ok(Math.max(strength, previousStrength) < 0.05, `switched at strength ${strength}`);
      }
    }
    previous = direction;
    previousStrength = strength;
    wasSolar = solar;
    assert.ok(direction.every(Number.isFinite));
  }
  assert.ok(turns > 0, 'the beam hands over to the glow inside the sun plane');
  assert.equal(switches, 1, 'One switch from sun to moon');
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

/** The WGSL a stylized night compiles into: the sky pass, its fog and its reflection, plus the night function itself. */
function nightShaders() {
  const h = optionalGPU(),
    depth = Object.assign(
      h.engine.gpu.createTexture({ size: [128, 96], format: 'depth32float', usage: GPUTextureUsage.TEXTURE_BINDING }),
      { depthOrArrayLayers: 1 },
    );
  const sky = new Sky({ hours: 0, timeScale: 0, night: {}, fog: { depth: () => depth, density: 0.01 } });
  h.engine.use(sky);
  sky.reflectionTexture;
  h.frame();
  h.frame();
  const code = (entry) => {
    const pipeline = h.pipelines.findLast((p) => (p.fragment ?? p.compute)?.entryPoint === entry);
    return (pipeline.fragment ?? pipeline.compute).module.code;
  };
  const fog = code('fogFragment'),
    shaders = { sky: code('fragment'), fog, reflection: code('reflectSky') };
  shaders.night = fog.slice(fog.indexOf('fn stylizedNight('));
  sky.dispose();
  depth.destroy();
  assert.ok(h.resources.every((r) => r.destroyed));
  return shaders;
}

test('fog takes the night gradient alone; the sky and its reflection pass their sample footprints', () => {
  const { sky, fog, reflection, night } = nightShaders();
  assert.match(fog, /skyRadiance\(normalize\([^;]*\),0\.0\)/, 'Fog asks for the sky with a zero footprint');
  assert.match(night, /^fn stylizedNight\(r:vec3f,footprint:f32\)/);
  const early = night.indexOf('if(footprint<=0.0){return color;}');
  assert.ok(early > 0 && early < night.indexOf('let cosine='), 'A zero footprint returns before stars and moon');
  assert.match(
    sky,
    /let footprint=max\(length\(dpdx\(w\)\),length\(dpdy\(w\)\)\);let sky=skyRadiance\(w,footprint\);var color=sky;/,
  );
  assert.match(
    reflection,
    /skyEnvironment\(environmentDirection\([^;]*\),0\.1\)/,
    'The 64 x 32 reflection passes its texel size',
  );
  assert.match(reflection, /color=mix\(color,nightSky\(w,footprint\),frame\.sun\.w\);/);
});

test('stars keep a 0.7 px minimum radius and their energy on square stereographic cells', () => {
  const { night } = nightShaders();
  assert.match(night, /let scale=434\.0\/\(1\.0\+r\.y\);let cell=r\.xz\*scale;/);
  assert.doesNotMatch(
    night,
    /\/\(r\.y\+0\.15\)\*250\.0/,
    'The former cells were thinner than a pixel near the horizon',
  );
  assert.match(night, /let radius=max\(0\.0003,footprint\*0\.7\);/, 'At least 0.7 px in radius');
  assert.match(night, /let energy=0\.0003\*0\.0003\/\(radius\*radius\)/, 'Dimmed by the area it covers');
  // A star's disc (support twice its radius) stays inside the four cells searched until it fades out at half a cell.
  assert.match(night, /\(1\.0-smoothstep\(0\.35,0\.5,size\)\)/);
  assert.match(night, /smoothstep\(0\.0,2\.0\*size,length\(cell-id-0\.5\)\)/);
});

// Regression (2026-11-13, Storm Light): with a night set, the sky and the environment also drew the lighting moon's
// celestial disc (0.018 rad) where the night's moon is, so a smaller disc sat inside the night's moon.
test('with a night set the moon disc is drawn once, by the night, in the sky and in what it reflects', () => {
  const { sky, reflection } = nightShaders(),
    gated = 'moonRadiance(w,frame.moon.xyz,footprint)*f32(frame.sunlight.w<0.5)';
  for (const [name, code] of [
    ['sky', sky],
    ['reflection', reflection],
  ]) {
    assert.ok(code.includes('fn stylizedNight('), `the ${name} draws the night`);
    assert.equal(
      code.split('*moonRadiance(').length - 1,
      code.split(gated).length - 1,
      `every ${name} lighting disc yields to the night`,
    );
    assert.ok(code.includes(gated), `the ${name} draws the lighting disc only without a night`);
  }
});

// Regression (2026-11-13, Storm Light): at phase 0.7 the moon showed a bright disc with a grey disc offset beside it.
// The dark part replaced the sky and its glow was thinned to 40% over the disc, so the unlit limb read as a second
// moon inside the halo. Now the air in front shows whole over the disc and the dark part adds only earthshine.
test('the moon disc hides the stars, not the air in front: a gibbous dark limb is the sky plus faint earthshine', () => {
  const { night } = nightShaders(),
    disc = night.indexOf('color=mix(color,gradient,cover)'),
    glow = night.indexOf('pow(max(cosine,0.0),32.0)');
  assert.ok(disc > 0 && glow > disc, 'The disc goes down over the gradient, before the glow');
  assert.match(night, /let earthshine=0\.02\*\(1\.0-params\.x\)/, 'Earthshine falls from 0.04 at new to 0 at full');
  assert.match(night, /\(smoothstep\(0\.0,0\.02,lit\)\+earthshine\)\*cover/, 'The unlit part adds only earthshine');
  assert.match(night, /params\.y\*0\.35;\n/, 'The glow is whole over the disc');
  assert.doesNotMatch(night, /1\.0-0\.6\*cover/, 'The glow is not thinned over the disc');
  assert.match(
    night,
    /let edge=max\(0\.01,0\.5\*footprint\/frame\.nightMoonColor\.w\)/,
    'The rim follows the footprint',
  );
});

// Regression (2026-11-28, KB-GPUMAIN1): the 2026-11-20 default moon radiance [6.4, 7.6, 9.6] (eight times the old
// [0.92, 0.95, 1]) also scaled the glow, which then drew a white halo some 14 degrees round the moon, and the Vite starter's
// moonlit scenery showed no disc against it. The glow takes the moon's tint over its brightest channel above 1.
test('the moon glow keeps its own level when the disc is brighter than 1', () => {
  const { night } = nightShaders();
  assert.match(
    night,
    /let glow=frame\.nightMoonColor\.rgb;return color\+glow\/max\(1\.0,max\(glow\.r,max\(glow\.g,glow\.b\)\)\)\*pow\(max\(cosine,0\.0\),32\.0\)\*params\.y\*0\.35;\n/,
    'The glow is the moon tint at no more than 1, times the glow intensity',
  );
  // The same arithmetic in JavaScript: the default disc's glow peaks at its old level, a colour up to 1 is unchanged.
  const glowTint = (c) => c.map((v) => v / Math.max(1, ...c));
  assert.deepEqual(glowTint([0.92, 0.95, 1]), [0.92, 0.95, 1]);
  assert.ok(Math.max(...glowTint([6.4, 7.6, 9.6])) === 1);
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
  assertNightFloor(h.engine.lighting, sky, 0.15);
  assert.equal(radiance[3], colors[3], 'the ambient level is left alone');
  const hours = sky.options.hours;
  h.engine.frameGraph.execute(h.context);
  assert.equal(sky.options.hours, hours);
  sky.onDeviceRestored(h.engine);
  sky.onPreUpdate(0);
  assertNightFloor(h.engine.lighting, sky, 0.15);
  sky.dispose();
  for (const lighting of [{ intensity: -1 }, { minimum: NaN }, null])
    assert.throws(() => new Sky({ lighting }), /options/);
});

test('sky clock wraps midnight and synchronizes sun and lighting once before rendering', () => {
  const h = optionalGPU(),
    effect = new Sky({ hours: 23.95, timeScale: 1, lighting: { intensity: 2, minimum: 0.25 } });
  h.engine.lighting = { direction: new Float32Array(4), radiance: new Float32Array(4) };
  h.engine.use(effect);
  try {
    h.frame();
    assert.ok(Math.abs(effect.options.hours - 0.05) < 1e-8);
    const uniform = h.resources.find((r) => r.size === 256),
      values = new Float32Array(uniform.data);
    assert.deepEqual([...values.subarray(20, 23)], [...effect.sun]);
    assert.deepEqual([...effect.sun], [...sunDirection(effect.options.hours)]);
    assertNightFloor(h.engine.lighting, effect, 0.25);
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
  assert.deepEqual([...values().subarray(60, 63)], [0, 0, 0], 'Midnight: the sun lights no cloud');
  const code = h.pipelines.find((p) => p.fragment?.entryPoint === 'fragment').fragment.module.code,
    cloud = code.slice(code.indexOf('fn cloudHash('));
  // Integer hash, curved shell, distance fade, three sun samples with phase and powder; no sin hash or angle cutoff.
  assert.match(cloud, /bitcast<vec2u>\(p\)\*1664525u\+1013904223u/);
  assert.doesNotMatch(cloud, /fract\(sin\(/);
  assert.match(cloud, /let t=-r\*mu\+sqrt\(r\*r\*\(mu\*mu-1\.0\)\+shell\*shell\);/);
  assert.match(cloud, /let haze=exp\(-t\/40\.0\);/);
  assert.doesNotMatch(cloud, /ray\.y<=0\.05|smoothstep\(0\.05,0\.18,ray\.y\)/);
  assert.match(cloud, /for\(var k=1;k<=3;k\+\+\)/);
  assert.match(cloud, /frame\.sunlight\.rgb\*1\.6\*\(exp\(-tau\)\*powder\*cloudPhase\(nu\)/);
  assert.match(code, /color=cloudSky\(color,sky,w,footprint\);/, 'The sky without discs lights the clouds');
  sky.options.hours = 17 + 34 / 60;
  sky.onPreUpdate(0);
  h.frame();
  const sunlit = values().subarray(60, 63);
  assert.ok(sunlit[0] > sunlit[1] && sunlit[1] > sunlit[2] && sunlit[2] > 0, 'Golden hour lights clouds amber');
  sky.options.hours = 0;
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

test('a sky with environment lights PBR meshes as a fallback environment, without driving the sun, and yields to EnvironmentLighting', async () => {
  const { Sky: BaseSky } = await import('../dist/base.js'),
    { skyEnvironmentFloor } = await import('../dist/index.js');
  const h = optionalGPU(),
    engineLight = { direction: new Float32Array([0, 1, 0, 3]), radiance: new Float32Array([1, 1, 1, 0.15]) };
  h.engine.lighting = engineLight;
  const sky = new Sky({ hours: 12, timeScale: 0, environment: true });
  h.engine.use(sky);
  const frame = () => {
    sky.onPreUpdate(h.context.delta);
    h.context.shader = wgsl;
    h.context.bindings = [];
    h.engine.frameGraph.execute(h.context);
  };
  frame();
  // Metals get image-based light: the sky's own split-sum term replaces core's constant ambient (zero for metals).
  assert.match(
    h.context.shader,
    /let margoAmbient=skyLighting\(n,v,i\.color,i\.material\.y,i\.material\.x,vec3f\(0\.04\),1\.0\);/,
  );
  assert.ok(h.context.bindings.some((e) => e.binding === 10) && h.context.bindings.some((e) => e.binding === 11));
  const ambient = h.resources.find((r) => !r.destroyed && r.size === 176),
    floor = new Float32Array(ambient.data).subarray(36, 39);
  assert.deepEqual(Array.from(floor), skyEnvironmentFloor.day.map(Math.fround));
  // The environment is a fallback, not a light: the engine's sun is untouched.
  assert.deepEqual(Array.from(engineLight.direction), [0, 1, 0, 3]);
  assert.deepEqual(Array.from(engineLight.radiance), [1, 1, 1, Math.fround(0.15)]);
  // Without the option the shader is left alone.
  sky.options.environment = false;
  frame();
  assert.equal(h.context.shader, wgsl);
  // An explicit environment wins: a scene effect that patched the shader first (EnvironmentLighting runs at order -1
  // and leaves margoAmbient in it) is left alone, and the sky adds no bindings.
  sky.options.environment = true;
  const explicit = 'let margoAmbient=iblLight(n,v);let linear=0.0+margoAmbient;';
  let patched = true;
  h.engine.frameGraph.add({
    name: 'test:explicit-environment',
    order: -1,
    execute: (c) => {
      if (patched) c.shader = explicit;
    },
  });
  frame();
  assert.equal(h.context.shader, explicit);
  assert.equal(h.context.bindings.length, 0);
  patched = false;
  frame();
  assert.notEqual(h.context.shader, wgsl);
  assert.match(h.context.shader, /skyLighting/);
  sky.dispose();
  assert.throws(() => new BaseSky({ environment: true }), /lighting from @margoengine\/sky\/lighting/);
  assert.throws(() => new Sky({ environment: 1 }), RangeError);
});
test("lighting.ambient yields core's ambient to an explicit environment: one margoAmbient per shader (KB-ENV-AMBIENT-DUP1)", () => {
  const h = optionalGPU();
  h.engine.lighting = { direction: new Float32Array(4), radiance: new Float32Array([1, 1, 1, 0.18]) };
  const sky = new Sky({ hours: 12, timeScale: 0, lighting: { ambient: { day: [0.1, 0.1, 0.1], night: [0, 0, 0] } } });
  h.engine.use(sky);
  // EnvironmentLighting's own patch at its own order (-1): the IBL term named margoAmbient on core's `let linear=`.
  let explicit = true;
  h.engine.frameGraph.add({
    name: 'test:environment-lighting',
    order: -1,
    execute: (c) => {
      if (!explicit) return;
      c.shader = c.shader.replace(
        /let linear=([^;]+);/,
        (_, terms) =>
          `let margoAmbient=iblShade(n,v);let linear=${terms.replace('frame.radiance.w', '0.0')}+margoAmbient;`,
      );
      c.bindings.push({ binding: 40, resource: {} });
    },
  });
  const frame = () => {
    sky.onPreUpdate(h.context.delta);
    h.context.shader = wgsl;
    h.context.bindings = [];
    h.engine.frameGraph.execute(h.context);
  };
  for (let i = 0; i < 2; i++) {
    frame();
    // Two declarations of margoAmbient do not compile (WGSL redeclaration) and the GPU was lost.
    assert.equal(h.context.shader.split('let margoAmbient=').length, 2, 'exactly one margoAmbient');
    assert.match(h.context.shader, /let margoAmbient=iblShade\(n,v\);/, 'the explicit environment owns the ambient');
    assert.doesNotMatch(h.context.shader, /skyLighting\(n,v/);
    assert.deepEqual(
      h.context.bindings.map((e) => e.binding),
      [40],
      "no sky ambient bindings beside the environment's (an unused binding fails the auto layout)",
    );
  }
  // The sky still drives the sun under the explicit environment.
  assert.ok(h.engine.lighting.direction[3] > 0);
  explicit = false;
  frame();
  assert.equal(h.context.shader.split('let margoAmbient=').length, 2);
  assert.match(
    h.context.shader,
    /let margoAmbient=skyLighting\(n,v,i\.color,i\.material\.y,i\.material\.x,vec3f\(0\.04\),1\.0\);/,
  );
  assert.deepEqual(
    h.context.bindings.map((e) => e.binding).sort((a, b) => a - b),
    [8, 10, 11],
  );
  // A HemisphereLight (also order -1) puts its sky term where core's constant ambient was: the sky's light joins it,
  // as when the sky patched first.
  h.engine.frameGraph.add({
    name: 'test:hemisphere',
    order: -1,
    execute: (c) => {
      c.shader = c.shader.replace(/\*frame\.radiance\.w\*frame\.ambient\.rgb/, '*margoSkyLight(n)');
    },
  });
  frame();
  assert.match(h.context.shader, /\*margoSkyLight\(n\)[^;]*\+margoAmbient;/);
  assert.match(h.context.shader, /let margoAmbient=skyLighting\(/);
  sky.dispose();
});
test('cloudLayer gives the cloud field, height and clock to what must match the clouds', () => {
  assert.equal(new Sky({ hours: 12 }).cloudLayer, undefined);
  const sky = new Sky({ hours: 12, clouds: { coverage: 0.3, speed: 10, height: 2000 } });
  sky.onPreUpdate(5);
  const layer = sky.cloudLayer;
  assert.match(layer.field, /fn cloudOctaves\(/);
  assert.doesNotMatch(layer.field, /frame\./, 'the field must stand alone, away from the sky frame');
  assert.deepEqual([layer.coverage, layer.drift, layer.height], [0.3, 50, 2000]);
});
test('a second Sky.attach on one scene says it is a second sky, and the first keeps rendering', async () => {
  const { Sky: BaseSky } = await import('../dist/base.js'),
    { preetham } = await import('../dist/preetham.js');
  // The sky README's day/night example once attached a second sky after the fog example's and got core's bare
  // "Invalid plugin". One sky per scene stays the rule; the error now names it and what to do instead.
  for (const [Kind, features] of [[Sky], [BaseSky, { preetham }]]) {
    const h = optionalGPU();
    const first = Kind.attach(h.engine, { hours: 12 }, features);
    assert.ok(first instanceof Kind, 'attach builds the class it is called on, so the root Sky keeps its features');
    assert.equal(h.engine.plugins.get('sky'), first);
    assert.throws(
      () => Kind.attach(h.engine, { hours: 18.5 }, features),
      (error) => error.name === 'MargoError' && error.code === 'attached' && /already has a Sky/.test(error.message),
    );
    assert.equal(h.engine.plugins.get('sky'), first, 'the failed attach leaves the first sky in place');
    h.frame();
    first.dispose();
    h.engine.removePlugin('sky');
    const again = Kind.attach(h.engine, { hours: 6 }, features);
    assert.equal(h.engine.plugins.get('sky'), again, 'after removing the first, a new sky attaches');
    again.dispose();
  }
});

test('KB2224a: the sky compiles only the day model in use; a live switch recompiles sky, fog, reflection and lighting', () => {
  const h = optionalGPU(),
    depth = Object.assign(
      h.engine.gpu.createTexture({ size: [128, 96], format: 'depth32float', usage: GPUTextureUsage.TEXTURE_BINDING }),
      { depthOrArrayLayers: 1 },
    );
  h.engine.lighting = { direction: new Float32Array(4), radiance: new Float32Array(4) };
  const sky = new Sky({
    hours: 12,
    timeScale: 0,
    fog: { depth: () => depth, density: 0.01 },
    lighting: { ambient: { day: [0.1, 0.1, 0.1], night: [0.01, 0.01, 0.01] } },
  });
  h.engine.use(sky);
  h.frame = () => {
    sky.onPreUpdate(h.context.delta);
    h.context.shader = wgsl;
    h.context.bindings = [];
    h.engine.frameGraph.execute(h.context);
  };
  const texture = sky.reflectionTexture;
  const daySky = (entry) => {
    const pipeline = h.pipelines.findLast((p) => (p.fragment ?? p.compute)?.entryPoint === entry),
      code = (pipeline.fragment ?? pipeline.compute).module.code,
      start = code.indexOf('fn daySky(');
    return code.slice(start, code.indexOf('return color;', start));
  };
  const entries = ['fragment', 'fogFragment', 'reflectSky', 'renderLight'];
  const check = (model) => {
    for (const entry of entries) {
      const body = daySky(entry);
      // No branch between the models: WebKit's Apple compile rounds by the branch's shape (one half-float step).
      assert.doesNotMatch(body, /settings\.x|if\(|else/, `${entry}: ${model} without a model branch`);
      if (model === 'bruneton') {
        assert.match(body, /color=brunetonSky\(scattering,/, `${entry} reads the Bruneton tables`);
        assert.doesNotMatch(body, /preetham\(/, `${entry} leaves Preetham out`);
      } else {
        assert.match(body, /color=preetham\(w,s\);/, `${entry} evaluates Preetham`);
        assert.doesNotMatch(body, /lookup\(|brunetonSky\(/, `${entry} leaves the Bruneton lookup out`);
      }
    }
  };
  try {
    h.frame();
    h.frame();
    check('preetham');
    const steady = h.pipelines.length;
    h.frame();
    assert.equal(h.pipelines.length, steady, 'Steady frames compile nothing');
    sky.options.model = 'bruneton';
    h.frame();
    check('bruneton');
    assert.equal(sky.reflectionTexture, texture, 'The borrowed reflection texture survives the switch');
    const switched = h.pipelines.length;
    h.frame();
    assert.equal(h.pipelines.length, switched, 'One recompile per switch');
    sky.options.model = 'preetham';
    h.frame();
    check('preetham');
    assert.equal(sky.reflectionTexture, texture);
  } finally {
    sky.dispose();
    depth.destroy();
  }
  assert.ok(h.resources.every((r) => r.destroyed));
});

test('KB6171a: the stylized night is compiled only while options.night is set; setting or clearing it recompiles', () => {
  const h = optionalGPU(),
    depth = Object.assign(
      h.engine.gpu.createTexture({ size: [128, 96], format: 'depth32float', usage: GPUTextureUsage.TEXTURE_BINDING }),
      { depthOrArrayLayers: 1 },
    );
  h.engine.lighting = { direction: new Float32Array(4), radiance: new Float32Array(4) };
  const sky = new Sky({
    hours: 16,
    timeScale: 0,
    fog: { depth: () => depth, density: 0.01 },
    lighting: { ambient: { day: [0.1, 0.1, 0.1], night: [0.01, 0.01, 0.01] } },
  });
  h.engine.use(sky);
  h.frame = () => {
    sky.onPreUpdate(h.context.delta);
    h.context.shader = wgsl;
    h.context.bindings = [];
    h.engine.frameGraph.execute(h.context);
  };
  const texture = sky.reflectionTexture;
  const code = (entry) => {
    const pipeline = h.pipelines.findLast((p) => (p.fragment ?? p.compute)?.entryPoint === entry);
    return (pipeline.fragment ?? pipeline.compute).module.code;
  };
  const check = (stylized) => {
    for (const entry of ['fragment', 'fogFragment', 'reflectSky', 'renderLight']) {
      const text = code(entry);
      if (stylized) {
        assert.match(text, /fn stylizedNight\(/, `${entry} holds the stylized night`);
        assert.match(text, /if\(frame\.sunlight\.w>0\.5\)\{return stylizedNight\(/, `${entry} calls it`);
      } else {
        // Under ANGLE Metal the dead branch alone moved two cloud pixels of a sky without a night (KB6171a).
        assert.doesNotMatch(text, /stylizedNight|nightPcg|hash21/, `${entry} leaves the unused night out`);
      }
    }
  };
  try {
    h.frame();
    check(false);
    const steady = h.pipelines.length;
    h.frame();
    assert.equal(h.pipelines.length, steady, 'Steady frames compile nothing');
    sky.options.night = {};
    h.frame();
    check(true);
    const set = h.pipelines.length;
    assert.ok(set > steady, 'Setting a night recompiles');
    h.frame();
    assert.equal(h.pipelines.length, set, 'One recompile per change');
    assert.equal(sky.reflectionTexture, texture, 'The borrowed reflection texture survives the change');
    delete sky.options.night;
    h.frame();
    check(false);
  } finally {
    sky.dispose();
    depth.destroy();
  }
  assert.ok(h.resources.every((r) => r.destroyed));
});
test('coverage records the pixels the sky draws only while asked, at the frame size, and frees them (KB-HEARTH-CLIP1)', () => {
  assert.throws(() => new Sky({ coverage: 1 }), RangeError);
  const h = optionalGPU(),
    begin = h.context.encoder.beginRenderPass,
    passes = [];
  h.context.encoder.beginRenderPass = (descriptor) => (passes.push(descriptor), begin(descriptor));
  globalThis.GPUTextureUsage = {
    COPY_SRC: 1,
    COPY_DST: 2,
    TEXTURE_BINDING: 4,
    STORAGE_BINDING: 8,
    RENDER_ATTACHMENT: 16,
  };
  const sky = new Sky({ hours: 12, timeScale: 0 });
  h.engine.use(sky);
  h.frame();
  const plain = passes.splice(0).length;
  assert.equal(sky.coverageTexture, undefined, 'nothing is recorded without the option');
  sky.options.coverage = true;
  h.frame();
  assert.equal(passes.length, plain + 1, 'the record is one render pass more');
  const texture = sky.coverageTexture,
    record = passes.at(-1);
  assert.equal(texture.format, 'r8unorm');
  assert.deepEqual([texture.width, texture.height], [h.context.width, h.context.height]);
  // The frame is multisampled (4): drawn into a 4-sample target resolved into the record, against the frame's depth.
  assert.equal(record.colorAttachments[0].resolveTarget.texture, texture);
  assert.equal(record.colorAttachments[0].view.texture.sampleCount, 4);
  assert.equal(record.colorAttachments[0].loadOp, 'clear');
  assert.equal(record.depthStencilAttachment.view, h.context.depth);
  assert.equal(record.depthStencilAttachment.depthReadOnly, true);
  const many = record.colorAttachments[0].view.texture;
  passes.length = 0;
  h.frame();
  assert.equal(sky.coverageTexture, texture, 'kept while the size holds');
  sky.options.coverage = false;
  passes.length = 0;
  h.frame();
  assert.equal(passes.length, plain);
  assert.equal(sky.coverageTexture, undefined);
  assert.ok(texture.destroyed && many.destroyed, 'clearing the option frees both textures');
  sky.options.coverage = true;
  h.frame();
  const again = sky.coverageTexture;
  sky.dispose();
  assert.ok(again.destroyed, 'dispose frees the record');
  h.cleanup();
});

// KB-SKY-SUNUNITS1: the light map is in the sky's own units and the engine sun is lighting.intensity times its share
// of the zenith sun on the ground, so clear sky lit level ground 1.3 to 1.5 times as much as the sun (real skies give
// 0.1 to 0.2 of the light: Erbs, Klein and Duffie 1982) and a brighter sun only diluted it. One factor a frame,
// Sky.lightScale, takes the map into the sun's units: intensity over Preetham's 4 pi 0.55 or over Bruneton's 20 times
// the zenith transmittance; the shader reads it from skyLight[9].w. The share itself is measured on a real GPU
// (test/sky-light-units-check.mjs).
test('the sky light map is taken into the engine sun units, in proportion to lighting.intensity (KB-SKY-SUNUNITS1)', () => {
  // The zenith transmittance at sea level through Earth's air at turbidity 2: the sky's own 64-step table definition.
  const zenith = (km) => {
    const r = 6360 + km,
      step = (6460 - r) / 64,
      mie = (0.003996 * 0.5) / 0.9;
    let rayleigh = 0,
      aerosol = 0;
    for (let i = 0; i < 64; i++) {
      const h = r + (i + 0.5) * step - 6360;
      rayleigh += Math.exp(-h / 8) * step;
      aerosol += Math.exp(-h / 1.2) * step;
    }
    return [0.005802, 0.013558, 0.0331].reduce(
      (sum, beta, i) => sum + [0.2126, 0.7152, 0.0722][i] * Math.exp(-(beta * rayleigh + mie * aerosol)),
      0,
    );
  };
  for (const [model, unit] of [
    ['preetham', 4 * Math.PI * 0.55],
    ['bruneton', 20 * zenith(0.001)],
  ])
    for (const intensity of [1, 3]) {
      const h = optionalGPU();
      h.engine.lighting = { direction: new Float32Array(4), radiance: new Float32Array([1, 1, 1, 0.18]) };
      const sky = new Sky({
        hours: 12,
        timeScale: 0,
        model,
        // The sky's own units, so the light buffer carries the whole scale (balanced, the picture takes it: below).
        balance: false,
        lighting: { intensity, ambient: { day: [0, 0, 0], night: [0, 0, 0] } },
      });
      h.engine.use(sky);
      sky.onPreUpdate(h.context.delta);
      h.context.shader = wgsl;
      h.context.bindings = [];
      h.engine.frameGraph.execute(h.context);
      assert.ok(
        Math.abs(sky.lightScale - intensity / unit) < 1e-6 * sky.lightScale,
        `${model} ${intensity}: ${sky.lightScale}`,
      );
      // The 160-byte light buffer carries it in its last float, beside the ambient floor.
      const buffer = h.context.bindings.find((e) => e.binding === 8).resource.buffer;
      assert.equal(
        new Float32Array(buffer.data)[39],
        Math.fround(sky.lightScale),
        `${model} ${intensity}: skyLight[9].w`,
      );
      assert.match(
        h.context.shader,
        /n\.x\*n\.x-n\.y\*n\.y\)\)\*skyLight\[9\]\.w,skyLight\[9\]\.rgb\)/,
        'diffuse scaled, floor not',
      );
      assert.match(h.context.shader, /rough\*3\.0\)\.rgb\*skyLight\[9\]\.w\*specular/, 'reflections scaled');
      sky.dispose();
    }
  // The environment fallback drives no sun: its sky is the light of the engine's own sun, here core's default 3.
  const h = optionalGPU();
  h.engine.lighting = { direction: new Float32Array([0, 1, 0, 3]), radiance: new Float32Array([1, 1, 1, 0.18]) };
  const fallback = new Sky({ hours: 12, timeScale: 0, environment: true });
  h.engine.use(fallback);
  fallback.onPreUpdate(h.context.delta);
  assert.ok(Math.abs(fallback.lightScale - 3 / (4 * Math.PI * 0.55)) < 1e-6, String(fallback.lightScale));
  fallback.dispose();
});

// KB-SKY-SANDGREY1: the light map was taken into the engine sun's units (KB-SKY-SUNUNITS1), but the sky drew its picture,
// fog and reflection map in its own: at a sun of 5 the Preetham sky stood 1.4 times too bright against the ground the
// sun lights, Bruneton at 3 about 6 times. A sky that lights the scene now draws all of it at its exposure plus
// log2(Sky.pictureScale), which is lightScale by day, and the light map takes only lightScale / pictureScale, so the map
// is not scaled twice. The night, a backdrop-only sky and balance: false keep the sky's own units.
test('a sky that lights the scene draws in the engine light units, the light map scaled once (KB-SKY-SANDGREY1)', () => {
  const run = (options, hours = 12) => {
    const h = optionalGPU();
    h.engine.lighting = { direction: new Float32Array([0, 1, 0, 3]), radiance: new Float32Array([1, 1, 1, 0.18]) };
    const sky = new Sky({ hours, timeScale: 0, ...options });
    h.engine.use(sky);
    sky.onPreUpdate(h.context.delta);
    h.context.shader = wgsl;
    h.context.bindings = [];
    h.engine.frameGraph.execute(h.context);
    const light = h.context.bindings.find((e) => e.binding === 8)?.resource.buffer,
      result = {
        lightScale: sky.lightScale,
        pictureScale: sky.pictureScale,
        exposure: sky['values'][25],
        map: light ? new Float32Array(light.data)[39] : undefined,
      };
    sky.dispose();
    return result;
  };
  const lit = { lighting: { intensity: 5, ambient: { day: [0, 0, 0], night: [0, 0, 0] } } };
  for (const model of ['preetham', 'bruneton']) {
    const r = run({ ...lit, model, exposure: -0.6 });
    assert.ok(Math.abs(r.pictureScale - r.lightScale) < 1e-9, `${model}: by day the picture takes lightScale`);
    assert.ok(Math.abs(r.exposure - (-0.6 + Math.log2(r.lightScale))) < 1e-5, `${model}: exposure ${r.exposure}`);
    assert.equal(r.map, 1, `${model}: the light map is not scaled twice`);
    const off = run({ ...lit, model, balance: false });
    assert.equal(off.pictureScale, 1, `${model}: balance false keeps the sky units`);
    assert.equal(off.exposure, 0);
    assert.equal(off.map, Math.fround(off.lightScale), `${model}: the map still takes lightScale`);
  }
  // Preetham at a sun of 5: 5 / (4 pi 0.55), the picture 0.72 of what it drew before.
  assert.ok(Math.abs(run(lit).pictureScale - 5 / (4 * Math.PI * 0.55)) < 1e-6);
  // The night keeps its look: the factor fades to 1 with the night blend (sun 15 degrees down at hour 1).
  const night = run(lit, 1);
  assert.equal(night.pictureScale, 1, 'the night is drawn as before');
  assert.equal(night.map, Math.fround(night.lightScale));
  // A sky that only draws a backdrop does not light the scene, so nothing ties its units to the engine's.
  const backdrop = run({});
  assert.equal(backdrop.pictureScale, 1);
  assert.equal(backdrop.exposure, 0);
  assert.throws(() => run({ ...lit, balance: 'yes' }), RangeError);
});
