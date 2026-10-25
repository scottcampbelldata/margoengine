import test from 'node:test';
import assert from 'node:assert/strict';
import { reflectWGSL, createCompute } from '@margoengine/compute';
import { matmul, matmulShader } from '@margoengine/compute/linalg';
import { stockhamShader, fft } from '@margoengine/compute/fft';
import { convolve1dShader, convolve2dShader, convolve } from '@margoengine/compute/signal';
import { Random, randomShader } from '@margoengine/compute/random';
import { chunks, stream } from '@margoengine/compute/stream';
import { ComputeFrame } from '@margoengine/compute/frame';

// The entries' GPU behaviour is checked in tests/compute-browser.mjs; here, what runs without a GPU.

test('each entry exports its kernels with the bindings the code binds by name', () => {
  const names = (code) => reflectWGSL(code).bindings.map((b) => b.name);
  assert.deepEqual(names(matmulShader('f32', 'f32', 'f32')), ['left', 'right', 'product', 'shape']);
  assert.deepEqual(reflectWGSL(matmulShader('i32', 'i32', 'i32')).entryPoints[0].workgroupSize, [16, 16, 1]);
  assert.deepEqual(names(stockhamShader), ['reIn', 'imIn', 'reOut', 'imOut', 'pass_']);
  assert.deepEqual(names(convolve1dShader), ['signal', 'taps', 'out', 'conv']);
  assert.deepEqual(names(convolve2dShader), ['image', 'taps', 'out', 'conv']);
  assert.deepEqual(names(randomShader('f32')), ['out', 'draw']);
  assert.match(randomShader('f16'), /^enable f16;/);
});

test('chunks splits TypedArrays into subarray views and plain arrays into slices', () => {
  const data = Float32Array.from({ length: 10 }, (_, k) => k);
  const parts = [...chunks(data, 4)];
  assert.deepEqual(
    parts.map((p) => p.length),
    [4, 4, 2],
  );
  assert.equal(parts[1].buffer, data.buffer, 'a view, not a copy');
  assert.deepEqual([...chunks([1, 2, 3], 2)], [[1, 2], [3]]);
  assert.throws(() => [...chunks(data, 0)], RangeError);
});

test('entry functions reject bad arguments before touching the GPU', async () => {
  globalThis.GPUBufferUsage ??= {
    STORAGE: 0x80,
    COPY_SRC: 0x4,
    COPY_DST: 0x8,
    MAP_READ: 0x1,
    UNIFORM: 0x40,
    INDIRECT: 0x100,
    VERTEX: 0x20,
  };
  const device = {
    features: new Set(),
    limits: {
      maxStorageBufferBindingSize: 1 << 30,
      maxComputeWorkgroupsPerDimension: 65535,
      maxStorageBuffersPerShaderStage: 8,
    },
    createBuffer: ({ size }) => ({ size, destroy() {} }),
    queue: { writeBuffer() {} },
    lost: new Promise(() => {}),
  };
  const gpu = await createCompute({ device });
  assert.throws(
    () => matmul(gpu.zeros([2, 3]), gpu.zeros([4, 5])),
    (e) => e instanceof RangeError && /inner dimension/.test(e.message),
  );
  assert.throws(() => matmul(gpu.zeros([]), gpu.zeros([3])), RangeError);
  assert.throws(() => fft(gpu.zeros([2]), { axis: 3 }), RangeError);
  assert.throws(
    () => convolve(gpu.zeros([5]), gpu.zeros([2, 2])),
    (e) => e instanceof RangeError && /convolve2d/.test(e.message),
  );
  assert.throws(() => new Random(gpu, { seed: -1 }), RangeError);
  assert.throws(() => new Random(gpu, { seed: 1, stream: 2 ** 32 }), RangeError);
  assert.equal(new Random(gpu, { seed: 2 ** 40 + 5 }).seed, 2 ** 40 + 5);
  assert.throws(() => new Random(gpu).integers(5, 5, 3), RangeError);
  await assert.rejects(async () => {
    for await (const _ of stream(gpu, 42, (c) => c)) void _;
  }, TypeError);
  const frame = new ComputeFrame();
  assert.throws(
    () => frame.gpu,
    (e) => e.code === 'state' && /attach/.test(e.message),
  );
  assert.throws(() => new ComputeFrame({ order: Infinity }), RangeError);
  frame.dispose();
  assert.throws(
    () => frame.gpu,
    (e) => e.code === 'disposed',
  );
});
