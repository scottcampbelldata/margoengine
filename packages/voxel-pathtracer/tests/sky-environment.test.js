import test from 'node:test';
import assert from 'node:assert/strict';
import { traceSkyEnvironment } from '@margoengine/voxel-pathtracer/sky';
import { fakeDevice } from './support.js';

test('multiple-scattering sky rejects invalid options before touching a GPU', async () => {
  await assert.rejects(traceSkyEnvironment(null, { atmosphere: { topRadius: 6360.00000001 } }), /Float32 rounding/);
  await assert.rejects(
    traceSkyEnvironment(null, {
      atmosphere: {
        rayleigh: [1, 1, 1],
        mie: 1,
        mieAbsorption: 0,
        rayleighHeight: 100000,
        mieHeight: 100000,
        groundAlbedo: [1, 1, 1],
      },
    }),
    /vertical scattering depth/,
  );
  await assert.rejects(traceSkyEnvironment(null, { night: { moonSize: 1e-45 } }), /moonSize/);
  for (const options of [
    { width: 0 },
    { width: 2049 },
    { width: NaN },
    { width: 1.5 },
    { height: Infinity },
    { height: 0 },
    { altitude: -1 },
    { altitude: 1e99 },
    { sunDirection: [0, 0, 0] },
    { sunIlluminance: NaN },
    { hours: NaN },
    { atmosphere: { rayleigh: [1e30, 0, 0] } },
    { atmosphere: { groundAlbedo: [2, 0, 0] } },
    { night: { starIntensity: Infinity } },
    { night: { moonDirection: [0, 0, 0] } },
    { night: { moonColor: [1e20, 0, 0] } },
  ])
    await assert.rejects(traceSkyEnvironment(null, options), RangeError, JSON.stringify(options));
  for (const options of [null, { night: true }, { multipleScattering: 1 }])
    await assert.rejects(traceSkyEnvironment(null, options), TypeError);
  await assert.rejects(
    traceSkyEnvironment(null),
    (error) => error.code === 'unsupported' && /https:\/\/margoengine.com\/errors#sky/.test(error.message),
  );
  const reason = new Error('cancelled before allocation');
  await assert.rejects(traceSkyEnvironment(null, { signal: AbortSignal.abort(reason) }), (error) => error === reason);
});

const bakeDevice = () => {
  const d = fakeDevice();
  d.createSampler = () => ({});
  d.createComputePipeline = () => ({ getBindGroupLayout: () => ({}) });
  d.createComputePipelineAsync = async () => d.createComputePipeline();
  return d;
};
const released = (d) => {
  assert.ok(d.buffers.every((b) => b.destroyed));
  assert.ok(d.textures.every((t) => t.destroyed));
};

test('sky bake owns its result and frees all resources on success and pipeline/readback failures', async () => {
  const d = bakeDevice();
  d.onMap = (b) => new Float32Array(b.data).set([0.1, 0.2, 0.3, 1]);
  const environment = await traceSkyEnvironment(d, { width: 1, height: 1 });
  assert.deepEqual(Array.from(environment.map.data), Array.from(new Float32Array([0.1, 0.2, 0.3, 1])));
  assert.equal(environment.map.width, 1);
  assert.equal(environment.map.height, 1);
  assert.equal(environment.sunIntensity, 20);
  assert.ok(Math.abs(environment.sunDirection[1] - 1) < 1e-6);
  released(d);
  for (const stage of ['pipeline', 'readback']) {
    const failing = bakeDevice(),
      reason = new Error(stage);
    if (stage === 'pipeline')
      failing.createComputePipelineAsync = async () => {
        throw reason;
      };
    else
      failing.onMap = () => {
        throw reason;
      };
    await assert.rejects(traceSkyEnvironment(failing, { width: 1, height: 1 }), (error) => error === reason);
    released(failing);
  }
});

test('sky abort releases resources while compilation or mapping waits', async () => {
  for (const stage of ['pipeline', 'readback']) {
    const d = bakeDevice(),
      controller = new AbortController(),
      reason = new Error(stage);
    let started;
    const waiting = new Promise((resolve) => {
      started = resolve;
    });
    if (stage === 'pipeline')
      d.createComputePipelineAsync = () => {
        started();
        return new Promise(() => {});
      };
    else {
      const create = d.createBuffer.bind(d);
      d.createBuffer = (desc) => {
        const b = create(desc);
        if (desc.usage & GPUBufferUsage.MAP_READ)
          b.mapAsync = () => {
            started();
            return new Promise(() => {});
          };
        return b;
      };
    }
    const pending = traceSkyEnvironment(d, { width: 1, height: 1, signal: controller.signal });
    await waiting;
    controller.abort(reason);
    await assert.rejects(pending, (error) => error === reason);
    released(d);
  }
});
