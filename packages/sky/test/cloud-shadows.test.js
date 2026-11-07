// @margoengine/sky/cloud-shadows: the shadow effect's WGSL, resources and per-frame values on the tracing mock. That the
// shadows match the clouds seen from the ground is proved on a real GPU by features-check.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { volumetricCloudShadows } from '@margoengine/sky/cloud-shadows';
import { VolumetricClouds } from '@margoengine/sky/volumetric-clouds';
import { tracedGPU } from '../../../tests/support/gpu-trace.js';

test('cloud shadows need volumetric clouds', () => {
  assert.throws(() => volumetricCloudShadows(), /needs VolumetricClouds/);
  assert.throws(() => volumetricCloudShadows({ options: {} }), /needs VolumetricClouds/);
});

test('cloud shadows carry the clouds field under their own names at their binding', () => {
  const shade = volumetricCloudShadows(new VolumetricClouds());
  const wgsl = shade.wgsl(2, 5);
  assert.match(wgsl, /@group\(2\) @binding\(5\) var<uniform> shadowFxCloudFrame5:ShadowFxClouds5;/);
  assert.match(wgsl, /@group\(2\) @binding\(8\) var shadowFxCloudSampler5:sampler;/);
  assert.match(wgsl, /fn shadowFxCloudDensityAt5\(/);
  assert.doesNotMatch(
    wgsl,
    /\bcloudDensityAt\(|\bstruct Clouds\b/,
    'every name is prefixed, so two effects cannot clash',
  );
  assert.equal(shade.call, 'vec3f(shadowFxVolume5(position))');
});

test('cloud shadows read the clouds options and drift every frame and keep their GPU objects per device', () => {
  const h = tracedGPU(),
    clouds = new VolumetricClouds({ coverage: 0.3, bottom: 1200, top: 3000, wind: [5, 0] }),
    shade = volumetricCloudShadows(clouds, { samples: 16 }),
    device = h.engine.gpu,
    writes = [];
  const write = device.queue.writeBuffer.bind(device.queue);
  device.queue.writeBuffer = (buffer, offset, data) => {
    writes.push(Float32Array.from(data));
    return write(buffer, offset, data);
  };
  shade.setup(device);
  const made = h.created.length;
  shade.setup(device);
  assert.equal(h.created.length, made, 'a new map size on the same device makes nothing');
  assert.equal(shade.resources().length, 4);
  clouds.onPreUpdate(10);
  shade.update({ context: { device, encoder: h.context.encoder }, light: [0, 1, 0] });
  const v = writes.at(-1);
  assert.deepEqual([v[28], v[29], Math.fround(v[30]), v[35]], [1200, 3000, Math.fround(0.3), 16]);
  assert.equal(v[36], 50, 'the drift the clouds have now');
  assert.deepEqual([...v.subarray(20, 23)], [0, 1, 0], "the shadows' own light");
  assert.equal(v[41], 1, 'strength');
  assert.ok(
    h.created.some((r) => r.startsWith('texture(64,64,64,rgba8unorm')),
    'its own copy of the noise volumes',
  );
  shade.options.samples = 1;
  assert.throws(() => shade.update({ context: { device, encoder: h.context.encoder }, light: [0, 1, 0] }), /samples/);
  shade.dispose();
});
