import test from 'node:test';
import assert from 'node:assert/strict';
import { encodePrefilteredIBL, parsePrefilteredIBL, loadPrefilteredEnvironment } from '../dist/prefiltered.js';
import { Environment } from '../dist/index.js';
import { mockGPU } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';

mockGPU();

const make = () => ({
  size: 4,
  specularSize: 2,
  cube: [4, 2, 1].map((n) => Uint16Array.from({ length: n * n * 24 }, (_, i) => (i * 37) % 0x7c00)),
  specular: [2, 1].map((n) => Uint16Array.from({ length: n * n * 24 }, (_, i) => i + 500)),
  brdf: new Uint32Array([0x30003800, 0x20003a00, 0x28003400, 0x10003c00]),
  radiance: Float32Array.from({ length: 27 }, (_, i) => (i - 12) / 32),
  irradiance: Float32Array.from({ length: 27 }, (_, i) => (13 - i) / 64),
  rotation: 0.5,
  intensity: 2,
});

test('KTX2 metadata overflow is rejected from dimensions before reading or allocating cube mips', () => {
  const mipAccess = new Error('mip data must not be read for an unrepresentable KTX2');
  for (const size of [8192, 16384, 4096]) {
    const data = {
      ...make(),
      size,
      specularSize: 1,
      brdf: new Uint32Array(1),
      get cube() {
        throw mipAccess;
      },
    };
    if (size === 4096) assert.throws(() => encodePrefilteredIBL(data), (error) => error === mipAccess);
    else
      assert.throws(() => encodePrefilteredIBL(data), {
        name: 'RangeError',
        message: /KTX2 metadata exceeds the 32-bit byte length limit/,
      });
  }
});

test('KTX2 baked IBL preserves every source/specular mip, LUT, SH and metadata bit', () => {
  const data = make(),
    encoded = encodePrefilteredIBL(data),
    parsed = parsePrefilteredIBL(encoded);
  assert.deepEqual(parsed, data);
  const d = new DataView(encoded.buffer);
  assert.equal(d.getUint32(12, true), 97);
  assert.equal(d.getUint32(36, true), 6);
  assert.ok(d.getBigUint64(80, true) > d.getBigUint64(104, true), 'smallest mip first on disk');
  // A sliced input is allowed and never aliases the returned data.
  const padded = new Uint8Array(encoded.length + 3);
  padded.set(encoded, 3);
  const copy = parsePrefilteredIBL(padded.subarray(3));
  padded.fill(0);
  assert.deepEqual(copy, data);
});

test('KTX2 baked IBL round-trips every brdfSize Environment accepts, not only powers of two (R5)', () => {
  // Environment takes brdfSize as any integer 1..4096; a 100 x 100 LUT made savePrefilteredEnvironment throw.
  for (const edge of [1, 3, 48, 100]) {
    const data = make();
    data.brdf = Uint32Array.from({ length: edge * edge }, (_, i) => 0x30003800 + i);
    assert.deepEqual(parsePrefilteredIBL(encodePrefilteredIBL(data)), data, `brdfSize ${edge}`);
  }
  const data = make();
  data.brdf = new Uint32Array(4097 * 4097);
  assert.throws(() => encodePrefilteredIBL(data), 'brdfSize above 4096 is refused like Environment');
});

test('baked IBL rejects every truncated prefix, corrupt layout, overlapping levels and invalid values', () => {
  const encoded = encodePrefilteredIBL(make());
  for (let n = 0; n < encoded.length; n++) assert.throws(() => parsePrefilteredIBL(encoded.subarray(0, n)));
  for (const [offset, value] of [
    [12, 37],
    [16, 4],
    [20, 3],
    [36, 1],
    [40, 99],
    [44, 1],
    [48, 80],
    [52, 1],
    [60, 0],
  ]) {
    const copy = encoded.slice();
    new DataView(copy.buffer).setUint32(offset, value, true);
    assert.throws(() => parsePrefilteredIBL(copy), `${offset}`);
  }
  for (const value of [0n, 81n, 0xffffffffffffffffn]) {
    const copy = encoded.slice();
    new DataView(copy.buffer).setBigUint64(80, value, true);
    assert.throws(() => parsePrefilteredIBL(copy));
  }
  const copy = encoded.slice(),
    d = new DataView(copy.buffer);
  d.setBigUint64(80, d.getBigUint64(104, true), true);
  assert.throws(() => parsePrefilteredIBL(copy));
  for (const change of [
    (d) => d.cube.pop(),
    (d) => (d.brdf = new Uint32Array(3)),
    (d) => (d.intensity = -1),
    (d) => (d.irradiance[0] = NaN),
    (d) => (d.specular[0] = new Uint16Array(1)),
  ]) {
    const data = make();
    change(data);
    assert.throws(() => encodePrefilteredIBL(data));
  }
});

test('load cancellation occurs before fetch or any GPU allocation', async () => {
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(loadPrefilteredEnvironment({}, 'https://example.invalid/ibl.ktx2', { signal: abort.signal }), {
    name: 'AbortError',
  });
});

test('load uploads baked bytes without creating any GPU pipeline or command encoder and restores all bindings', async () => {
  let allocations = 0,
    destroyed = 0;
  const device = () => ({
    limits: { maxTextureDimension2D: 4096 },
    queue: { writeBuffer() {}, writeTexture() {} },
    createTexture(d) {
      allocations++;
      return {
        ...d,
        createView() {
          return {};
        },
        destroy() {
          destroyed++;
        },
      };
    },
    createBuffer(d) {
      allocations++;
      return {
        ...d,
        destroy() {
          destroyed++;
        },
      };
    },
    createSampler() {
      return {};
    },
  });
  const first = device(),
    env = await loadPrefilteredEnvironment(first, encodePrefilteredIBL(make()));
  assert.ok(env instanceof Environment);
  assert.equal(allocations, 5);
  assert.equal(env.specularMips, 2);
  assert.equal(env.intensity, 2);
  assert.deepEqual(env.sh.radiance, make().radiance);
  env.rotation = 0.25;
  env.intensity = 3;
  let changes = 0;
  env.onChange(() => changes++);
  const next = device();
  await Promise.all([env.restore(next), env.restore(next)]);
  assert.equal(allocations, 10);
  assert.equal(destroyed, 5);
  assert.equal(changes, 1);
  assert.equal(env.version, 1);
  assert.equal(env.device, next);
  assert.equal(env.rotation, 0.25);
  assert.equal(env.intensity, 3);
  env.dispose();
  env.dispose();
  assert.equal(destroyed, 10);
  await assert.rejects(env.restore(first), { code: 'disposed' });
});
