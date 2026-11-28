// @margoengine/sky/aerial: options, the atmosphere's parameters and the GPU work on the tracing mock. The air's
// transmittance against Beer-Lambert on the CPU is proved on a real GPU by features-check.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AerialPerspective, EARTH_ATMOSPHERE, atmosphereParameters } from '@margoengine/sky/aerial';
import { Sky } from '@margoengine/sky';
import { HillaireSky } from '@margoengine/sky/hillaire';
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

test('atmosphere parameters default to Earth and name the field they reject', () => {
  const earth = atmosphereParameters();
  assert.deepEqual(earth, { ...EARTH_ATMOSPHERE });
  assert.deepEqual(earth.rayleigh, [0.005802, 0.013558, 0.0331], 'Hillaire 2020 Table 1');
  assert.equal(atmosphereParameters({ mieG: 0.7 }).mieG, 0.7);
  assert.throws(() => atmosphereParameters({ topRadius: 6000 }), /topRadius/);
  assert.throws(() => atmosphereParameters({ mieG: 1 }), /mieG/);
  assert.throws(() => atmosphereParameters({ rayleigh: [1, -1, 0] }), /rayleigh/);
  assert.throws(() => atmosphereParameters({ mieHeight: 0 }), /mieHeight/);
});

test('aerial perspective needs a depth function and checks its options', () => {
  assert.throws(() => new AerialPerspective(), /needs a depth function/);
  const depth = () => undefined;
  assert.doesNotThrow(() => new AerialPerspective({ depth, maxDistance: 100000, metersPerUnit: 50 }));
  for (const bad of [{ maxDistance: 10 }, { metersPerUnit: 0 }, { altitude: -1 }, { sunIlluminance: -1 }])
    assert.throws(
      () => new AerialPerspective({ depth, ...bad }),
      /Invalid AerialPerspective options/,
      JSON.stringify(bad),
    );
  assert.throws(() => new AerialPerspective({ depth, atmosphere: { mieG: 2 } }), /mieG/);
});

test('aerial perspective builds its tables once, its volume every frame, and draws only over scene depth', () => {
  const h = tracedGPU();
  h.engine.lighting = { direction: new Float32Array(4), radiance: new Float32Array([1, 1, 1, 0.15]) };
  let depth;
  const sky = new Sky({ hours: 10, timeScale: 0, turbidity: 3 }),
    aerial = new AerialPerspective({ sky, depth: () => depth }),
    writes = [],
    queue = h.engine.gpu.queue,
    write = queue.writeBuffer.bind(queue);
  queue.writeBuffer = (buffer, offset, data) => {
    if (data.length === 56) writes.push(Float32Array.from(data));
    return write(buffer, offset, data);
  };
  h.engine.use(sky);
  h.engine.use(aerial);
  const frame = () => {
    sky.onPreUpdate(h.context.delta);
    aerial.onPreUpdate(h.context.delta);
    h.context.bindings = [];
    h.engine.frameGraph.execute(h.context);
  };
  frame();
  assert.equal(writes.length, 0, 'no scene depth, no air');
  depth = depthOf(h);
  frame();
  frame();
  const code = [...h.shaders.values()].join('\n');
  assert.match(code, /fn integrateScattering\(/);
  assert.match(code, /@fragment fn transmit\(/);
  assert.match(code, /texture_depth_multisampled_2d/);
  assert.ok(
    h.created.some((r) => r.startsWith('texture(256,64,rgba16float')),
    'transmittance table',
  );
  assert.ok(
    h.created.some((r) => r.startsWith('texture(32,32,rgba16float')),
    'multiple scattering table',
  );
  assert.equal(
    h.created.filter((r) => r.startsWith('texture(32,32,32,rgba16float')).length,
    2,
    'scatter and transmittance volumes',
  );
  const v = writes.at(-1);
  // The sky's turbidity 3 scales Mie scattering by (3 - 1) / 2 = 1; the Preetham sky lends illuminance 10.
  assert.equal(v[20], Math.fround(0.003996));
  // The medium reads Mie scattering and absorption per channel (48-50, 52-54); grey haze gives three equal values.
  assert.deepEqual([...v.subarray(48, 51)], [0.003996, 0.003996, 0.003996].map(Math.fround));
  assert.deepEqual([...v.subarray(52, 55)], [0.000444, 0.000444, 0.000444].map(Math.fround));
  assert.equal(v[34], 10);
  sky.options.turbidity = 5;
  sky.options.model = 'bruneton';
  frame();
  assert.equal(writes.at(-1)[20], Math.fround(0.003996 * 2));
  assert.equal(writes.at(-1)[34], 20, 'the Bruneton model is built at 20');
  aerial.dispose();
  sky.dispose();
});

test('a pipeline that is not ready yet stops the tables once, and the next frame still bakes them', () => {
  // warmUp of @margoengine/quality stops a frame at the first pipeline still compiling; the retried frame must bake
  // the transmittance (32 x 8 groups) and multiple scattering (32 x 32) tables, or the air draws from empty tables.
  const h = tracedGPU();
  h.engine.lighting = { direction: new Float32Array(4), radiance: new Float32Array([1, 1, 1, 0.15]) };
  const depth = depthOf(h),
    sky = new Sky({ hours: 10, timeScale: 0, turbidity: 3 }),
    aerial = new AerialPerspective({ sky, depth: () => depth }),
    gpu = h.engine.gpu,
    create = gpu.createComputePipeline;
  let refused = 0;
  gpu.createComputePipeline = function (descriptor) {
    if (refused === 0 && descriptor.compute.module.code.includes('vec2u(256,64)')) {
      refused++;
      throw Object.assign(new Error('still compiling'), { code: 'Compiling' });
    }
    return create.call(this, descriptor);
  };
  h.engine.use(sky);
  h.engine.use(aerial);
  const frame = () => {
    sky.onPreUpdate(h.context.delta);
    aerial.onPreUpdate(h.context.delta);
    h.context.bindings = [];
    h.engine.frameGraph.execute(h.context);
  };
  const bakes = () => {
    const list = h.commands('short');
    return [list.filter((c) => c === 'dispatch 32 8').length, list.filter((c) => c === 'dispatch 32 32').length];
  };
  assert.throws(frame, /still compiling/);
  assert.equal(refused, 1, 'the frame stopped at the tables');
  frame();
  assert.deepEqual(bakes(), [1, 1], 'the retried frame bakes both tables');
  frame();
  assert.deepEqual(bakes(), [1, 1], 'and only once');
  aerial.dispose();
  sky.dispose();
});

test('a wide planet keeps the eye above its ground in Float32, for the sky and the air', () => {
  // At 60,000 km a Float32 step is about 4 m: a metre of clearance rounded away, the eye sat on the ground sphere,
  // sphereHit took the far root from it and every upward ray met the ground at 0, so the sky and the air were black.
  for (const bottomRadius of [6360, 60000, 99999]) {
    const h = tracedGPU();
    const atmosphere = { bottomRadius, topRadius: bottomRadius + 100 },
      sky = new HillaireSky({ hours: 12, timeScale: 0, atmosphere }),
      aerial = new AerialPerspective({ sky, depth: () => depthOf(h) }),
      writes = [],
      queue = h.engine.gpu.queue,
      write = queue.writeBuffer.bind(queue);
    queue.writeBuffer = (buffer, offset, data) => {
      if (data.length === 56) writes.push(Float32Array.from(data));
      return write(buffer, offset, data);
    };
    h.engine.camera.position[1] = 0;
    h.engine.use(sky);
    h.engine.use(aerial);
    h.context.bindings = [];
    h.engine.frameGraph.execute(h.context);
    assert.equal(writes.length, 2, 'the sky and the air each upload their uniform');
    for (const v of writes) {
      assert.equal(v[32], Math.fround(bottomRadius));
      assert.ok(v[45] > v[32], `eye ${v[45]} above the ground ${v[32]} at ${bottomRadius} km`);
    }
    sky.dispose();
    aerial.dispose();
  }
});
