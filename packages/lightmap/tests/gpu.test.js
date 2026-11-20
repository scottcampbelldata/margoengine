// ./gpu without a GPU: argument checks run before any device work. The bake itself runs in tests/gpu.browser.mjs.
import assert from 'node:assert/strict';
import test from 'node:test';
import { bakeMeshLightmapGPU, GPULightmapBaker } from '../dist/gpu.js';
import { inlinedCopies } from '../../../scripts/support/wgsl-inline.mjs';

const floor = {
  positions: new Float32Array([0, 0, 0, 4, 0, 0, 4, 0, -4, 0, 0, -4]),
  uv1: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
};
const device = { createComputePipeline() {} };

test('the GPU baker names what it needs before touching the device', async () => {
  await assert.rejects(GPULightmapBaker.create(null, floor), /needs a GPUDevice/);
  await assert.rejects(GPULightmapBaker.create({ gpu: null }, floor), TypeError);
  await assert.rejects(GPULightmapBaker.create(device, floor, { bounces: 1 }), /radiometry 'physical'/);
  await assert.rejects(GPULightmapBaker.create(device, floor, { bounces: 9, radiometry: 'physical' }), RangeError);
  await assert.rejects(GPULightmapBaker.create(device, floor, { albedo: [2, 0, 0] }), /0 to 1/);
  await assert.rejects(GPULightmapBaker.create(device, { ...floor, uv1: new Float32Array(8).fill(2) }), /0 to 1/);
  await assert.rejects(
    GPULightmapBaker.create(device, floor, { lights: [{ type: 'spot', position: [0, 1, 0], direction: [0, -1, 0] }] }),
    /spot light needs an angle/,
  );
  await assert.rejects(bakeMeshLightmapGPU(device, floor, { passes: 0 }), RangeError);
});

// KB-COMPAT-FXCTIME1: Direct3D's HLSL compiler, under ANGLE's WebGL2 on Windows, inlines every call. The bake called
// bvhAny twice in directLight, and directLight and bvhClosest twice each, so the program held six copies of the BVH
// walk and took 48 to 51 s to link cold. One directLight, one bvhAny and one bvhClosest call now serve every path
// vertex: two copies of the walk, one per kind of ray.
test('the bake kernel holds one walk per kind of ray (KB-COMPAT-FXCTIME1)', async () => {
  const codes = [],
    limits = { maxStorageBufferBindingSize: 1 << 27, maxBufferSize: 1 << 27, maxComputeWorkgroupsPerDimension: 65535 },
    // Every other call and property answers with another stub, so the baker can build against it.
    stub = () =>
      new Proxy(function () {}, {
        get: (_, key) =>
          key === 'then'
            ? undefined
            : key === 'limits'
              ? limits
              : key === 'createShaderModule'
                ? (d) => (codes.push(d.code), stub())
                : key === 'popErrorScope'
                  ? async () => null
                  : key === Symbol.toPrimitive
                    ? () => 0
                    : stub(),
        apply: () => stub(),
      });
  globalThis.GPUBufferUsage ??= { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 };
  globalThis.GPUTextureUsage ??= { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8 };
  globalThis.GPUShaderStage ??= { COMPUTE: 4 };
  globalThis.GPUMapMode ??= { READ: 1 };
  using baker = await GPULightmapBaker.create(stub(), floor, { radiometry: 'physical', bounces: 2 });
  assert.ok(baker);
  const code = codes.find((c) => c.includes('fn bake(')),
    { copies, size } = inlinedCopies(code, 'bake');
  assert.equal(copies.get('bvhWalk'), 2);
  for (const name of ['directLight', 'bvhAny', 'bvhClosest', 'hemisphere']) assert.equal(copies.get(name), 1, name);
  assert.ok(size < 20000, `${size} characters inlined`);
});
