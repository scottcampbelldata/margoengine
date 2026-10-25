import test from 'node:test';
import assert from 'node:assert/strict';
import { broadcastShapes, createCompute } from '@margoengine/compute';
import { philox4x32, PHILOX } from '@margoengine/compute/random';

// A device stand-in with what array creation, views and fusion use (no GPU work is submitted by these tests).
globalThis.GPUBufferUsage ??= {
  STORAGE: 0x80,
  COPY_SRC: 0x4,
  COPY_DST: 0x8,
  MAP_READ: 0x1,
  UNIFORM: 0x40,
  INDIRECT: 0x100,
  VERTEX: 0x20,
  QUERY_RESOLVE: 0x200,
};
const device = () => ({
  features: new Set(),
  limits: {
    maxStorageBufferBindingSize: 1 << 30,
    maxComputeWorkgroupsPerDimension: 65535,
    maxStorageBuffersPerShaderStage: 8,
  },
  createBuffer: ({ size }) => ({ size, destroy() {} }),
  queue: { writeBuffer() {} },
  lost: new Promise(() => {}),
});

test('broadcastShapes follows NumPy: right-aligned, equal or 1', () => {
  assert.deepEqual(broadcastShapes([3, 1], [4]), [3, 4]);
  assert.deepEqual(broadcastShapes([2, 1, 5], [3, 1]), [2, 3, 5]);
  assert.deepEqual(broadcastShapes([], [7]), [7]);
  assert.deepEqual(broadcastShapes([0], [1]), [0]);
  assert.throws(
    () => broadcastShapes([3], [4]),
    (e) => e instanceof RangeError && /\[3\] and \[4\]/.test(e.message),
  );
});

test('views: reshape, transpose, slices (negative steps, clamping) and broadcastTo compute shapes, strides and offsets', async () => {
  const gpu = await createCompute({ device: device() });
  const m = gpu.zeros([3, 4]);
  assert.deepEqual([...m.strides], [4, 1]);
  const t = m.T;
  assert.deepEqual(
    [t.shape, t.strides],
    [
      [4, 3],
      [1, 4],
    ],
  );
  assert.equal(t.contiguous, false);
  const row = m.slice(1);
  assert.deepEqual([row.shape, row.strides, row.offset, row.contiguous], [[4], [1], 4, true]);
  const cols = m.slice(null, [1, 3]);
  assert.deepEqual([cols.shape, cols.strides, cols.offset], [[3, 2], [4, 1], 1]);
  const back = m.slice([null, null, -1], [null, null, -2]);
  // Rows 2, 1, 0 and columns 3, 1: first element m[2][3] = 11.
  assert.deepEqual([back.shape, back.strides, back.offset], [[3, 2], [-4, -2], 11]);
  const clamped = m.slice([-100, 100]);
  assert.deepEqual(clamped.shape, [3, 4]);
  assert.deepEqual(m.slice([2, 1]).shape, [0, 4], 'an empty slice');
  assert.deepEqual(m.reshape(2, -1).shape, [2, 6]);
  assert.deepEqual(m.reshape([12]).shape, [12]);
  assert.throws(() => m.reshape(5, -1), RangeError);
  assert.throws(() => m.reshape(-1, -1), RangeError);
  const b = gpu.zeros([3, 1]).broadcastTo([2, 3, 4]);
  assert.deepEqual(
    [b.shape, b.strides],
    [
      [2, 3, 4],
      [0, 1, 0],
    ],
  );
  assert.throws(() => gpu.zeros([3]).broadcastTo([4]), RangeError);
  assert.deepEqual(gpu.zeros([1, 3, 1]).squeeze().shape, [3]);
  assert.deepEqual(gpu.zeros([3]).expandDims(-1).shape, [3, 1]);
  assert.throws(() => m.slice(3), RangeError, 'index out of range');
  assert.throws(() => m.transpose(0, 0), RangeError);
  const view = m.T;
  m.dispose();
  assert.equal(view.disposed, true, 'a view dies with its buffer');
});

test('expressions: result types follow NumPy 2 promotion; scalars adopt the array type when they fit', async () => {
  const gpu = await createCompute({ device: device() });
  const f = gpu.zeros(3),
    i = gpu.zeros(3, 'i32'),
    u = gpu.zeros(3, 'u32');
  assert.equal(i.add(1).dtype, 'i32');
  assert.equal(i.add(1.5).dtype, 'f32');
  assert.equal(u.add(-1).dtype, 'i32');
  assert.equal(u.add(i).dtype, 'i32');
  assert.equal(i.add(f).dtype, 'f32');
  assert.equal(i.div(2).dtype, 'f32', 'true division is float');
  assert.equal(i.sqrt().dtype, 'f32');
  assert.equal(f.gt(0).dtype, 'u32', 'comparisons are 0/1 u32');
  assert.equal(f.astype('i32').dtype, 'i32');
  assert.deepEqual(f.reshape(3, 1).add(f).shape, [3, 3]);
  assert.equal(i.add(NaN).dtype, 'f32', 'NaN or Infinity next to integers promotes to float, as in NumPy');
  assert.throws(() => f.bitAnd(1), TypeError, 'bit operations need integers, checked when the expression is built');
  const other = await createCompute({ device: device() });
  assert.throws(
    () => f.add(other.zeros(3)),
    (e) => e instanceof TypeError && /another compute context/.test(e.message),
  );
});

test('Philox4x32-10 matches the known-answer vectors of Salmon et al. (Random123 kat_vectors)', () => {
  const hex = (words) => [...words].map((w) => w.toString(16).padStart(8, '0')).join(' ');
  assert.equal(hex(philox4x32([0, 0, 0, 0], [0, 0])), '6627e8d5 e169c58d bc57ac4c 9b00dbd8');
  assert.equal(
    hex(philox4x32([0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff], [0xffffffff, 0xffffffff])),
    '408f276d 41c83b0e a20bc7c6 6d5451fd',
  );
  assert.equal(
    hex(philox4x32([0x243f6a88, 0x85a308d3, 0x13198a2e, 0x03707344], [0xa4093822, 0x299f31d0])),
    'd16cfe09 94fdcceb 5001e420 24126ea1',
  );
  assert.equal(PHILOX.M0, 0xd2511f53);
});
