import test from 'node:test';
import assert from 'node:assert/strict';
import { Clustered, clusteredSampling } from '../dist/index.js';
import { LocalShadows } from '../dist/shadows.js';
import { MAX_STOCHASTIC_SAMPLES, StochasticLights } from '../dist/stochastic.js';
import { CubeProjectorLights } from '../dist/cube-projector.js';
import { estimate, exact, rng } from './stochastic-reference.js';
import { wgsl } from '../../core/src/shaders.ts';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

function harness() {
  const h = optionalGPU(),
    gpu = h.engine.gpu;
  globalThis.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2 };
  globalThis.GPUTextureUsage = {
    ...globalThis.GPUTextureUsage,
    COPY_DST: 2,
    TEXTURE_BINDING: 4,
    RENDER_ATTACHMENT: 16,
  };
  Object.assign(gpu.limits, { maxTextureDimension2D: 8192, maxTextureArrayLayers: 256 });
  gpu.createBindGroupLayout = (d) => ({ ...d });
  gpu.createPipelineLayout = (d) => ({ ...d });
  const begin = h.context.encoder.beginRenderPass;
  h.context.encoder.beginRenderPass = (d) => ({ ...begin(d), setViewport() {}, setScissorRect() {} });
  const frame = () => {
    h.context.shader = wgsl;
    h.context.bindings.length = 0;
    h.engine.frameGraph.execute(h.context);
  };
  return { ...h, frame };
}

test('cube cookies and stochastic shadows compose with distinct shader and resource bindings', () => {
  const h = harness(),
    lights = Clustered.attach(h.engine, { grid: [1, 1, 1], shadows: { resolution: 64 } }),
    cookies = CubeProjectorLights.attach(h.engine, { lights }),
    stochastic = StochasticLights.attach(h.engine, { lights, quad: false });
  lights.setLights([{ position: [0, 2, 0], range: 6, castShadow: true }]);
  cookies.setCubes([{ faces: Array.from({ length: 6 }, () => ({
    width: 1, height: 1, data: new Uint8Array([128, 128, 128, 255]),
  })) }]);
  try {
    h.frame();
    const entries = lights.bindings().map((entry) => entry.binding);
    assert.equal(new Set(entries).size, entries.length, 'each composed resource needs its own binding');
    const declarations = lights.pbr(0).declarations;
    const bindings = [...declarations.matchAll(/@group\(0\)\s*@binding\((\d+)\)/g)].map((match) => Number(match[1]));
    assert.equal(new Set(bindings).size, bindings.length, 'the composed shader must not alias resources');
    assert.match(declarations, /cubeCookie:CubeCookieData/);
    assert.match(declarations, /clusterStochastic:ClusterStochastic/);
    assert.match(declarations, /clusterCubeProjector\(index,light,position\)/);
  } finally {
    stochastic.dispose();
    cookies.dispose();
    lights.dispose();
  }
});
const lights200 = Array.from({ length: 200 }, (_, i) => ({
  radiance: [0.5, 0.4, 0.3].map((c) => c * (1 + (i % 7))),
  visibility: (i * 37) % 11 < 4 ? 0 : (i % 3) / 2,
}));

test('stochastic lights: the ratio estimator converges to the exact sum for lights of one colour', () => {
  const want = exact(lights200),
    random = rng(9),
    mean = [0, 0, 0],
    n = 20000;
  for (let t = 0; t < n; t++) estimate(lights200, 2, random).forEach((v, k) => (mean[k] += v / n));
  for (let k = 0; k < 3; k++) assert.ok(Math.abs(mean[k] - want[k]) < 0.01 * want[k], `${mean[k]} vs ${want[k]}`);
});

test('stochastic lights: four quad pixels sharing the ratio cut the spread at the same lookups', () => {
  const want = exact(lights200)[0],
    random = rng(5),
    spread = (quad) => {
      let s = 0;
      for (let t = 0; t < 4000; t++) s += (estimate(lights200, 2, random, quad)[0] - want) ** 2;
      return Math.sqrt(s / 4000);
    },
    one = spread(1),
    four = spread(4);
  // Four times the picks: the spread falls by about 2 (1.6 or more allows for the sampling noise of the spread itself).
  assert.ok(one / four > 1.6, `${one} vs ${four}`);
});

test('stochastic lights: exact per channel when the lights of each channel share a visibility', () => {
  const lights = [
    { radiance: [1, 0, 0], visibility: 0.25 },
    { radiance: [0, 0, 2], visibility: 0.75 },
    { radiance: [0, 3, 0], visibility: 0.5 },
    { radiance: [2, 0, 0], visibility: 0.25 },
    { radiance: [0, 1, 0], visibility: 0.5 },
  ];
  const random = rng(3),
    want = exact(lights);
  // One sample per pixel, four pixels: a channel none of the picks lights falls back to the picks' mean visibility,
  // so check the channels whose light was picked: every pick of a channel carries that channel's one visibility.
  for (let t = 0; t < 200; t++) {
    const got = estimate(lights, 4, random);
    for (const k of [0, 1, 2]) assert.ok(Math.abs(got[k] - want[k]) < 1e-12 || got.picked[k] === 0, `${got} ${want}`);
  }
  assert.deepEqual([...estimate([], 4, random)], [0, 0, 0]);
});

test('stochastic lights: as many shadowed lights as samples or fewer are shaded exactly, with that many lookups', () => {
  const lights = [
      { radiance: [1, 0.5, 0], visibility: 0.1 },
      { radiance: [0, 0, 2], visibility: 0.9 },
      { radiance: [0, 3, 0], visibility: 0 },
    ],
    random = rng(1),
    lookups = { count: 0 };
  assert.deepEqual([...estimate(lights, 3, random, 1, lookups)], exact(lights));
  assert.equal(lookups.count, 3);
  lookups.count = 0;
  estimate(lights200, 2, random, 1, lookups);
  assert.equal(lookups.count, 2, 'two lookups for 200 shadowed lights');
});

test('stochastic lights: the light loop samples shadows only beside shadows; text without it is unchanged', () => {
  const h = harness(),
    lights = Clustered.attach(h.engine, { grid: [2, 2, 2] });
  lights.setLights([{ position: [0, 2, 0], range: 6, castShadow: true }]);
  h.frame();
  const plain = h.context.shader;
  // Without shadows the stochastic hook changes nothing: nothing is shadowed to sample.
  const stochastic = StochasticLights.attach(h.engine, { lights, samples: 3 });
  h.frame();
  assert.equal(h.context.shader, plain);
  assert.deepEqual(
    lights.bindings().map((e) => e.binding),
    [4, 5, 6, 7],
  );
  assert.equal(clusteredSampling(0), clusteredSampling(0, undefined, undefined, false, false, false, { stochastic }));
  const local = LocalShadows.attach(h.engine, { lights, resolution: 64 });
  h.frame();
  const unsampled = clusteredSampling(0, local);
  const shaded = h.context.shader;
  assert.match(shaded, /@binding\(151\) var<uniform> clusterStochastic:ClusterStochastic;/);
  assert.match(shaded, /stochasticPick\[r\]=index;/);
  assert.match(shaded, /stochasticN\+=c\*clusterShadow\(light,position,n\);/);
  assert.match(shaded, /@diagnostic\(off,derivative_uniformity\) fn clusterStochasticQuad/);
  assert.match(shaded, /let shadowedLight=\(light\.params\.z>=1\.0\|\|false\);/);
  assert.ok(!/falloff\*cone\*clusterShadow/.test(shaded), 'no per-light shadow lookup in the loop');
  // The early return of an out-of-range pixel waits until after the quad sum.
  const body = shaded.slice(shaded.indexOf('fn clusterLighting('));
  assert.ok(body.indexOf('{clusterOutside=true;}') > 0);
  assert.ok(!body.slice(0, body.indexOf('clusterStochasticQuad(vec4f')).includes('return'));
  assert.ok(body.indexOf('clusterStochasticQuad(vec4f') < body.indexOf('if(clusterOutside){return vec3f(0);}'));
  assert.deepEqual(
    lights.bindings().map((e) => e.binding),
    [4, 5, 6, 7, 14, 15, 16, 151],
  );
  assert.deepEqual(
    lights['unshadowed'].bindings().map((e) => e.binding),
    [4, 5, 6, 7],
    'receivers without shadows skip the stochastic uniform',
  );
  assert.doesNotMatch(lights['unshadowed'].pbr(1).declarations, /clusterStochastic/);
  const uniform = stochastic.bindings()[0].resource.buffer,
    words = () => [...new Uint32Array(uniform.data)];
  assert.equal(words()[1], 3);
  const seed = words()[0];
  h.frame();
  assert.notEqual(words()[0], seed, 'a new pattern every frame');
  stochastic.dispose();
  assert.equal(lights.stochastic, undefined);
  h.frame();
  assert.equal(clusteredSampling(0, local), unsampled);
  assert.match(h.context.shader, /falloff\*cone\*clusterShadow\(light,position,n\);/);
  assert.deepEqual(
    lights.bindings().map((e) => e.binding),
    [4, 5, 6, 7, 14, 15, 16],
  );
  local.dispose();
  lights.dispose();
});

test('stochastic lights: integrated shadows are sampled too; quad false leaves out the derivatives', () => {
  const h = harness(),
    lights = Clustered.attach(h.engine, { grid: [2, 2, 2], shadows: { resolution: 64 } });
  lights.setLights([{ position: [0, 2, 0], range: 6, castShadow: true }]);
  StochasticLights.attach(h.engine, { lights, quad: false });
  h.frame();
  const shaded = lights.pbr(1).declarations;
  assert.match(shaded, /let shadowedLight=\(false\|\|light\.params\.w>=1\.0\);/);
  assert.match(shaded, /stochasticN\+=c\*clusterShadowVisibility\(light,position,n\);/);
  assert.doesNotMatch(shaded, /dpdx/);
  lights.dispose();
});

test('stochastic lights: a fixed pattern when temporal is false; invalid options throw', () => {
  const h = harness(),
    lights = Clustered.attach(h.engine, { grid: [2, 2, 2] }),
    still = StochasticLights.attach(h.engine, { lights, temporal: false });
  h.frame();
  const words = () => [...new Uint32Array(still.bindings()[0].resource.buffer.data)],
    first = words();
  h.frame();
  assert.deepEqual(words(), first);
  assert.equal(first[1], 2, 'two samples by default');
  for (const samples of [0, 1.5, MAX_STOCHASTIC_SAMPLES + 1])
    assert.throws(() => new StochasticLights({ lights, samples }), RangeError);
  assert.throws(() => new StochasticLights({ lights, temporal: 1 }), TypeError);
  assert.throws(() => new StochasticLights({ lights, quad: 'yes' }), TypeError);
  assert.throws(() => new StochasticLights({}), TypeError);
  still.dispose();
  assert.throws(() => still.bindings(), /not attached/);
  lights.dispose();
});
