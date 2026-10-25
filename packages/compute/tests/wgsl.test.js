import test from 'node:test';
import assert from 'node:assert/strict';
import { reflectWGSL, encode, createCompute, GpuArray } from '@margoengine/compute';

// Layout numbers below are worked by hand from the WGSL specification's alignment and size table (13.4).

test('reflectWGSL reads buffer, texture and sampler bindings by name, in group and binding order', () => {
  const info = reflectWGSL(/* wgsl */ `
    struct Params { count: u32, scale: f32 }
    // @group(9) @binding(9) var<storage> commented: array<f32>;
    /* @group(8) @binding(8) var<storage> blocked: array<f32>; /* nested */ */
    @group(1) @binding(0) var tex: texture_2d<f32>;
    @group(0) @binding(2) var<uniform> params: Params;
    @group(0) @binding(0) var<storage, read> src: array<f32>;
    @binding(1) @group(0) var<storage, read_write> dst: array<vec4f>;
    @group(1) @binding(1) var samp: sampler;
    @group(1) @binding(2) var out: texture_storage_2d<rgba8unorm, write>;
    @group(1) @binding(3) var depth: texture_depth_2d;
    @group(1) @binding(4) var volume: texture_3d<u32>;
    @compute @workgroup_size(64) fn main() {}
  `);
  assert.deepEqual(
    info.bindings.map((b) => [b.name, b.group, b.binding, b.resource]),
    [
      ['src', 0, 0, 'read-only-storage'],
      ['dst', 0, 1, 'storage'],
      ['params', 0, 2, 'uniform'],
      ['tex', 1, 0, 'texture'],
      ['samp', 1, 1, 'sampler'],
      ['out', 1, 2, 'storage-texture'],
      ['depth', 1, 3, 'texture'],
      ['volume', 1, 4, 'texture'],
    ],
  );
  const byName = Object.fromEntries(info.bindings.map((b) => [b.name, b]));
  assert.deepEqual(byName.out.texture, { viewDimension: '2d', format: 'rgba8unorm', access: 'write-only' });
  assert.equal(byName.depth.texture.sampleType, 'depth');
  assert.deepEqual(byName.volume.texture, { viewDimension: '3d', sampleType: 'uint', multisampled: false });
  assert.equal(byName.samp.sampler, 'filtering');
  assert.equal(byName.dst.layout.stride, 16);
  assert.deepEqual(info.entryPoints, [{ name: 'main', workgroupSize: [64, 1, 1] }]);
});

test('reflectWGSL resolves workgroup sizes and array counts through constants and overrides', () => {
  const info = reflectWGSL(`
    const SIZE = 8u;
    override DEPTH: u32 = 2;
    const COUNT = 0x10;
    @group(0) @binding(0) var<uniform> table: array<vec4f, COUNT>;
    @compute @workgroup_size(SIZE, SIZE, DEPTH) fn tile() {}
    @compute
    @workgroup_size(256)
    fn other() {}
    fn helper() {}
  `);
  assert.deepEqual(info.entryPoints, [
    { name: 'tile', workgroupSize: [8, 8, 2] },
    { name: 'other', workgroupSize: [256, 1, 1] },
  ]);
  assert.equal(info.bindings[0].layout.count, 16);
  assert.equal(info.bindings[0].layout.size, 256);
});

test('reflectWGSL rejects a binding index it cannot evaluate, naming the binding', () => {
  assert.throws(
    () =>
      reflectWGSL('@group(0) @binding(foo) var<storage> data: array<f32>; @compute @workgroup_size(1) fn main() {}'),
    (e) => e instanceof TypeError && /data/.test(e.message) && /margoengine\.com\/errors#compute/.test(e.message),
  );
});

test('struct layout follows WGSL alignment: vec3 aligns to 16, a following f32 packs into its tail', () => {
  const [b] = reflectWGSL(`
    struct Light { position: vec3f, intensity: f32, color: vec3<f32>, matrix: mat3x3f, flag: u32, @align(16) last: vec2f }
    @group(0) @binding(0) var<uniform> light: Light;
    @compute @workgroup_size(1) fn main() {}
  `).bindings;
  const offsets = Object.fromEntries(b.layout.members.map((m) => [m.name, m.offset]));
  // position 0..12, intensity 12, color 16..28, matrix aligns 16 -> 32 (3 columns x 16 = 48) -> 80, flag 80,
  // last @align(16) -> 96 (8 bytes) -> 104; struct align 16 rounds the size up to 112.
  assert.deepEqual(offsets, { position: 0, intensity: 12, color: 16, matrix: 32, flag: 80, last: 96 });
  assert.equal(b.layout.align, 16);
  assert.equal(b.layout.size, 112);
});

test('encode writes a uniform struct from a plain object, padding matrix columns', () => {
  const [b] = reflectWGSL(`
    struct P { count: u32, offset: i32, scale: f32, color: vec4f, m: mat2x3f }
    alias Alias = P;
    @group(0) @binding(0) var<uniform> p: Alias;
    @compute @workgroup_size(1) fn main() {}
  `).bindings;
  const bytes = encode(b.layout, { count: 7, offset: -2, scale: 0.5, color: [1, 2, 3, 4], m: [1, 2, 3, 4, 5, 6] });
  const view = new DataView(bytes.buffer);
  assert.equal(bytes.byteLength, 64); // color at 16, m at 32 (2 columns of 16) -> 64
  assert.equal(view.getUint32(0, true), 7);
  assert.equal(view.getInt32(4, true), -2);
  assert.equal(view.getFloat32(8, true), 0.5);
  assert.deepEqual(
    [0, 1, 2, 3].map((k) => view.getFloat32(16 + 4 * k, true)),
    [1, 2, 3, 4],
  );
  assert.deepEqual(
    [0, 1, 2].map((k) => view.getFloat32(32 + 4 * k, true)),
    [1, 2, 3],
  );
  assert.deepEqual(
    [0, 1, 2].map((k) => view.getFloat32(48 + 4 * k, true)),
    [4, 5, 6],
  );
});

test('encode names the field that is missing, mistyped or out of range', () => {
  const [b] = reflectWGSL(`
    struct P { count: u32, inner: Inner }
    struct Inner { v: vec2f }
    @group(0) @binding(0) var<uniform> p: P;
    @compute @workgroup_size(1) fn main() {}
  `).bindings;
  assert.throws(() => encode(b.layout, { count: 1 }, 'p'), /p\.inner is missing/);
  assert.throws(() => encode(b.layout, { count: 1, inner: { v: [1] } }, 'p'), /p\.inner\.v needs 2 numbers/);
  assert.throws(() => encode(b.layout, { count: -1, inner: { v: [1, 2] } }, 'p'), RangeError);
  assert.throws(() => encode(b.layout, { count: 1.5, inner: { v: [1, 2] } }, 'p'), RangeError);
  assert.throws(() => encode(b.layout, { count: 'x', inner: { v: [1, 2] } }, 'p'), TypeError);
});

test('f16 members encode as IEEE binary16 with round-to-nearest-even', () => {
  const [b] = reflectWGSL(`
    enable f16;
    struct H { a: f16, b: f16, c: f16, d: f16, e: f16, f: f16 }
    @group(0) @binding(0) var<uniform> h: H;
    @compute @workgroup_size(1) fn main() {}
  `).bindings;
  assert.equal(b.layout.size, 12);
  const view = new DataView(encode(b.layout, { a: 1, b: -2, c: 65504, d: 1e6, e: 2 ** -24, f: 1 + 2 ** -11 }).buffer);
  assert.deepEqual(
    [0, 2, 4, 6, 8, 10].map((o) => view.getUint16(o, true)),
    // 1.0, -2.0, max finite, overflow to +inf, smallest subnormal, a tie that rounds to even (1.0)
    [0x3c00, 0xc000, 0x7bff, 0x7c00, 0x0001, 0x3c00],
  );
});

test('createCompute without WebGPU rejects with a coded unsupported error and a help link', async () => {
  await assert.rejects(
    () => createCompute(),
    (e) => e.name === 'MargoError' && e.code === 'unsupported' && /errors#compute/.test(e.message),
  );
  const engine = { gpu: null };
  await assert.rejects(
    () => createCompute({ engine }),
    (e) => e.code === 'unsupported' && /WebGL2/.test(e.message),
  );
  const controller = new AbortController();
  controller.abort(new Error('stop'));
  await assert.rejects(() => createCompute({ signal: controller.signal }), /stop/);
});

test('GpuArray maps TypedArrays to element types and checks lengths against device limits', async () => {
  // A device stand-in with just what array creation and writing use (Node has no WebGPU globals).
  globalThis.GPUBufferUsage ??= { STORAGE: 0x80, COPY_SRC: 0x4, COPY_DST: 0x8, MAP_READ: 0x1, UNIFORM: 0x40 };
  const writes = [];
  const device = {
    features: new Set(),
    limits: { maxStorageBufferBindingSize: 64, maxComputeWorkgroupsPerDimension: 65535 },
    createBuffer: ({ size }) => ({
      size,
      destroyed: false,
      destroy() {
        this.destroyed = true;
      },
    }),
    queue: { writeBuffer: (buffer, offset, data) => writes.push([offset, data]) },
    lost: new Promise(() => {}),
  };
  const gpu = await createCompute({ device });
  assert.equal(gpu.array(new Float64Array([1.5, 2])).dtype, 'f32');
  assert.equal(gpu.array(new Int16Array(2)).dtype, 'i32');
  assert.equal(gpu.array(new Uint8Array(2)).dtype, 'u32');
  assert.equal(gpu.array([1, 2, 3]).dtype, 'f32');
  const a = gpu.zeros(4, 'u32');
  assert.equal(a.size, 4);
  assert.throws(
    () => gpu.zeros(2, 'f16'),
    (e) => e.code === 'unsupported',
    'f16 needs shader-f16',
  );
  assert.throws(() => gpu.array([1, 2, 3], { shape: [2, 2] }), RangeError);
  assert.ok(a instanceof GpuArray);
  assert.ok(writes[0][1] instanceof Float32Array, 'Float64Array data is written as f32');
  assert.throws(() => gpu.zeros(17), RangeError, '17 x 4 bytes is over the 64-byte storage limit');
  assert.throws(() => a.write([1, 2, 3], 2), RangeError);
  assert.throws(() => gpu.array(new BigInt64Array(1)), TypeError);
  gpu.dispose();
  assert.ok(a.disposed && a.buffer.destroyed, 'disposing the context frees its arrays');
  assert.throws(
    () => a.write([1]),
    (e) => e.code === 'disposed',
  );
  assert.throws(
    () => gpu.zeros(1),
    (e) => e.code === 'disposed',
  );
  assert.equal(device.destroyed, undefined, 'a borrowed device is not destroyed');
});
