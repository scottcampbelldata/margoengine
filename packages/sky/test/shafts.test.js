// @margoengine/sky/shafts: options, the sun's place on screen and the GPU work on the tracing mock. That the shafts
// come only through gaps in geometry and clouds is proved on a real GPU by features-check.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LightShafts } from '@margoengine/sky/shafts';
import { VolumetricClouds } from '@margoengine/sky/volumetric-clouds';
import { Sky } from '@margoengine/sky';
import { tracedGPU } from '../../../tests/support/gpu-trace.js';

const depthOf = (h, samples = 4) =>
  Object.assign(
    h.engine.gpu.createTexture({
      size: [128, 96],
      format: 'depth32float',
      sampleCount: samples,
      usage: globalThis.GPUTextureUsage.TEXTURE_BINDING,
    }),
    { depthOrArrayLayers: 1 },
  );
// A camera at the origin looking down -Z (reversed-Z perspective, 90 degrees), as the engine writes it.
const lookDownZ = (h) => {
  const m = h.context.camera.matrix;
  m.fill(0);
  m[0] = 0.75;
  m[5] = 1;
  m[11] = -1;
  m[14] = 0.1;
  h.context.camera.position.fill?.(0);
};

test('light shafts need a depth function and check their options', () => {
  assert.throws(() => new LightShafts(), /needs a depth function/);
  const depth = () => undefined;
  assert.doesNotThrow(() => new LightShafts({ depth, intensity: 2, samples: 128, cloudSamples: 2 }));
  for (const bad of [
    { intensity: -1 },
    { anisotropy: 0.99 },
    { decay: 0.2 },
    { length: 0 },
    { samples: 4 },
    { samples: 40.5 },
    { cloudSamples: 100 },
    { sunIlluminance: -1 },
  ])
    assert.throws(() => new LightShafts({ depth, ...bad }), /Invalid LightShafts options/, JSON.stringify(bad));
  assert.throws(() => new LightShafts({ depth, sky: {} }), /sky must be a Sky/);
  assert.throws(() => new LightShafts({ depth, clouds: { options: {} } }), /clouds must be VolumetricClouds/);
  assert.throws(() => new LightShafts({ depth, sunDirection: [0, 0, 0] }), /nonzero length/);
});

test('light shafts draw a half-size mask and a blend over the scene, only with depth and the sun ahead', () => {
  const h = tracedGPU();
  let depth;
  const shafts = new LightShafts({ depth: () => depth, sunDirection: [0, 0.25, -1] }),
    writes = [],
    queue = h.engine.gpu.queue,
    write = queue.writeBuffer.bind(queue);
  queue.writeBuffer = (buffer, offset, data) => {
    if (data.length === 48) writes.push(Float32Array.from(data));
    return write(buffer, offset, data);
  };
  h.engine.use(shafts);
  lookDownZ(h);
  const frame = () => {
    shafts.onPreUpdate(h.context.delta);
    h.context.bindings = [];
    h.engine.frameGraph.execute(h.context);
  };
  frame();
  assert.equal(writes.length, 0, 'no scene depth, no shafts');
  depth = depthOf(h);
  frame();
  const v = writes.at(-1);
  // The sun [0, 0.25, -1] / 1.0308 projects to x 0, y 0.25 in NDC: uv (0.5, 0.375); w is its cosine to the view
  // axis, 0.970, past the 0.25 fade, so the shafts are at full strength.
  assert.ok(Math.abs(v[28] - 0.5) < 1e-6 && Math.abs(v[29] - 0.375) < 1e-6, `sun at ${v[28]}, ${v[29]}`);
  assert.equal(v[23], 1);
  assert.deepEqual([v[30], v[31], v[32], v[33]], [Math.fround(0.9), 48, Math.fround(0.97), Math.fround(0.6)]);
  assert.deepEqual([...v.subarray(36, 40)], [0, 0, 1, 1], 'the whole target');
  assert.ok(
    h.created.some((r) => r.startsWith('texture(64,48,r16float')),
    'a half-size mask',
  );
  const code = [...h.shaders.values()].join('\n');
  assert.match(code, /@fragment fn mask\(/);
  assert.match(code, /@fragment fn composite\(/);
  assert.match(code, /texture_depth_multisampled_2d/);
  assert.doesNotMatch(code, /cloudDensityAt/, 'no clouds, no cloud field');
  // The sun behind the camera: nothing is written or drawn.
  shafts.options.sunDirection = [0, 0.25, 1];
  const count = writes.length,
    draws = h.commands().filter((c) => c.startsWith('draw')).length;
  assert.equal(draws, 2, 'the mask and the composite');
  frame();
  assert.equal(writes.length, count);
  assert.equal(h.commands().filter((c) => c.startsWith('draw')).length, draws);
  shafts.dispose();
});

test('light shafts march the clouds they are given, from their options and drift each frame', () => {
  const h = tracedGPU(),
    depth = depthOf(h, 1),
    clouds = new VolumetricClouds({ coverage: 0.7, bottom: 1200, top: 3000, wind: [4, 0] }),
    sky = new Sky({ hours: 10, timeScale: 0 }),
    shafts = new LightShafts({ sky, clouds, depth: () => depth, cloudSamples: 20 }),
    writes = [],
    queue = h.engine.gpu.queue,
    write = queue.writeBuffer.bind(queue);
  queue.writeBuffer = (buffer, offset, data) => {
    if (data.length === 64) writes.push(Float32Array.from(data));
    return write(buffer, offset, data);
  };
  h.engine.use(sky);
  h.engine.use(shafts);
  // Face the sky's sun, so the shafts draw.
  sky.onPreUpdate(0);
  const m = h.context.camera.matrix,
    [x, y, z] = sky.sun;
  m.fill(0);
  // Rows of the view: right = normalize(cross(sun, up)), up' = cross(right, sun), back = -sun; then a 90 degree projection.
  const r = Math.hypot(z, x),
    right = [-z / r, 0, x / r],
    up = [right[1] * z - right[2] * y, right[2] * x - right[0] * z, right[0] * y - right[1] * x];
  for (let c = 0; c < 3; c++) {
    m[c * 4] = 0.75 * right[c];
    m[c * 4 + 1] = up[c];
    m[c * 4 + 3] = sky.sun[c];
  }
  m[14] = 0.1;
  clouds.onPreUpdate(10);
  shafts.onPreUpdate(0);
  h.context.bindings = [];
  h.engine.frameGraph.execute(h.context);
  const v = writes.at(-1);
  assert.ok(v, 'the cloud uniform is written');
  assert.deepEqual([v[28], v[29], Math.fround(v[30]), v[35]], [1200, 3000, Math.fround(0.7), 20]);
  assert.equal(v[36], 40, 'the drift the clouds have now');
  assert.equal(v[34], 80000, "the clouds' farthest reach");
  const code = [...h.shaders.values()].join('\n');
  assert.match(code, /fn shaftCloudsOpen\(/);
  assert.match(code, /texture_depth_2d/);
  assert.ok(
    h.created.some((r) => r.startsWith('texture(64,64,64,rgba8unorm')),
    'its own copy of the noise volumes',
  );
  shafts.dispose();
  sky.dispose();
});
