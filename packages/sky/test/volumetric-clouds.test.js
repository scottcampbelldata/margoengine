// @margoengine/sky/volumetric-clouds: options, GPU work on the tracing mock, and the wind drift. The pictures are
// proved on a real GPU by features-check.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { VolumetricClouds, PLANET_RADIUS, cloudField } from '@margoengine/sky/volumetric-clouds';
import { Sky } from '@margoengine/sky';
import { tracedGPU } from '../../../tests/support/gpu-trace.js';

const code = (h) => [...h.shaders.values()].join('\n');
function frame(h, ...plugins) {
  for (const p of plugins) p.onPreUpdate(h.context.delta);
  h.context.bindings = [];
  h.engine.frameGraph.execute(h.context);
}

test('volumetric clouds validate their options and name the fix', () => {
  assert.doesNotThrow(() => new VolumetricClouds());
  assert.doesNotThrow(() => new VolumetricClouds({ coverage: 0, bottom: 800, top: 9000, steps: 128, lightSteps: 1 }));
  for (const bad of [
    { coverage: 1.5 },
    { coverage: -0.1 },
    { bottom: 50 },
    { bottom: 3000, top: 2000 },
    { top: 25000 },
    { density: 0 },
    { scale: 10 },
    { steps: 4 },
    { steps: 64.5 },
    { lightSteps: 0 },
    { maxDistance: 10 },
    { evolution: -1 },
  ])
    assert.throws(() => new VolumetricClouds(bad), /Invalid VolumetricClouds options/, JSON.stringify(bad));
  assert.throws(() => new VolumetricClouds({ sunDirection: [0, 0, 0] }), /nonzero length/);
  assert.throws(() => new VolumetricClouds({ sky: {} }), /must be a Sky/);
  assert.throws(() => new VolumetricClouds({ depth: 3 }), /depth must be a function/);
  // Options are read every frame: a bad value set later throws on the next update.
  const clouds = new VolumetricClouds();
  clouds.options.coverage = 2;
  assert.throws(() => clouds.onPreUpdate(0), /Invalid VolumetricClouds options/);
});

test('volumetric clouds make their noise volumes once and ray march one pass per frame', () => {
  const h = tracedGPU(),
    clouds = new VolumetricClouds({ sunDirection: [0.2, 0.8, 0.1] });
  h.engine.use(clouds);
  frame(h, clouds);
  frame(h, clouds);
  assert.ok(h.created.some((r) => r.startsWith('texture(64,64,64,rgba8unorm')), 'shape volume 64^3');
  assert.ok(h.created.some((r) => r.startsWith('texture(32,32,32,rgba8unorm')), 'erosion volume 32^3');
  const wgsl = code(h);
  assert.match(wgsl, /fn shape\(/);
  assert.match(wgsl, /fn erosion\(/);
  assert.match(wgsl, /fn cloudDensityAt\(/);
  assert.match(wgsl, /fn cloudShell\(/);
  assert.equal(h.created.filter((r) => r.startsWith('texture(64,64,64')).length, 1, 'Made once, not per frame');
  assert.ok(cloudField.includes('struct Clouds'));
  clouds.dispose();
});

test('volumetric clouds take their light from a Sky and draw nothing at coverage 0', () => {
  const h = tracedGPU();
  h.engine.lighting = { direction: new Float32Array(4), radiance: new Float32Array([1, 1, 1, 0.15]) };
  const sky = new Sky({ hours: 10, timeScale: 0 }),
    clouds = new VolumetricClouds({ sky, coverage: 0 });
  h.engine.use(sky);
  h.engine.use(clouds);
  frame(h, sky, clouds);
  assert.doesNotMatch(code(h), /fn cloudDensityAt\(/, 'Coverage 0 compiles and draws nothing');
  clouds.options.coverage = 0.4;
  frame(h, sky, clouds);
  // The sky's reflection map lights the clouds, reduced on the GPU to light from above and from the horizon.
  assert.match(code(h), /var<workgroup> sums/);
  assert.ok(h.created.some((r) => r.startsWith('texture(64,32')), 'The sky reflection map was asked for');
  clouds.dispose();
  sky.dispose();
});

test('the wind drift wraps at the noise repeat so f32 keeps it exact', () => {
  const clouds = new VolumetricClouds({ wind: [20, -5], evolution: 2, scale: 10000 });
  clouds.onPreUpdate(1000);
  assert.deepEqual([...clouds.drift], [0, -5000, 2000]);
  clouds.onPreUpdate(10);
  assert.deepEqual([...clouds.drift], [200, -5050, 2020]);
  assert.equal(PLANET_RADIUS, 6_360_000);
});
