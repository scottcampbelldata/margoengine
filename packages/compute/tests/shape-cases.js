// Explicit standard examples plus independent coordinate references, shared by CPU/GPU gates.
import { concatenate, stack, pad, tile, flip, repeat } from '../dist/shape.js';

export async function shapeCases(gpu) {
  let checks = 0;
  const eq = async (array, shape, expected) => {
    try {
      const actual = Array.from(await array.read());
      if (
        JSON.stringify(array.shape) !== JSON.stringify(shape) ||
        actual.length !== expected.length ||
        actual.some((v, k) => v !== expected[k])
      )
        throw new Error(`shape case ${checks}: [${array.shape}] ${actual} != [${shape}] ${expected}`);
      checks++;
    } finally {
      array.dispose();
    }
  };
  const x = gpu.array(new Int32Array([1, 2, 3, 4, 5, 6]), { shape: [2, 3] });
  await eq(concatenate([x, x], 1), [2, 6], [1, 2, 3, 1, 2, 3, 4, 5, 6, 4, 5, 6]);
  await eq(concatenate([x.T, x.T], -1), [3, 4], [1, 4, 1, 4, 2, 5, 2, 5, 3, 6, 3, 6]);
  await eq(concatenate([x, x.add(10)], null), [12], [1, 2, 3, 4, 5, 6, 11, 12, 13, 14, 15, 16]);
  await eq(stack([x, x.add(10)], -1), [2, 3, 2], [1, 11, 2, 12, 3, 13, 4, 14, 5, 15, 6, 16]);
  await eq(stack([gpu.full([], 2), gpu.full([], 4)]), [2], [2, 4]);
  await eq(flip(x), [2, 3], [6, 5, 4, 3, 2, 1]);
  await eq(flip(x.mul(2), [-1]), [2, 3], [6, 4, 2, 12, 10, 8]);
  await eq(tile(x, [2, 1]), [4, 3], [1, 2, 3, 4, 5, 6, 1, 2, 3, 4, 5, 6]);
  await eq(tile(gpu.array([1, 2]), [2, 3]), [2, 6], [1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2]);
  await eq(tile(x.T, 2), [3, 4], [1, 4, 1, 4, 2, 5, 2, 5, 3, 6, 3, 6]);
  await eq(repeat(x, 2, -1), [2, 6], [1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6]);
  await eq(repeat(x, [0, 2, 1], 1), [2, 3], [2, 2, 3, 5, 5, 6]);
  await eq(repeat(x, [1]), [6], [1, 2, 3, 4, 5, 6]);
  await eq(repeat(x.T, [1, 0, 2], 0), [3, 2], [1, 4, 3, 6, 3, 6]);
  await eq(
    pad(
      x,
      [
        [1, 0],
        [0, 1],
      ],
      { constantValues: -2 },
    ),
    [3, 4],
    [-2, -2, -2, -2, 1, 2, 3, -2, 4, 5, 6, -2],
  );
  const v = gpu.array([1, 2, 3]);
  await eq(pad(v, [4, 3], { mode: 'reflect' }), [10], [1, 2, 3, 2, 1, 2, 3, 2, 1, 2]);
  await eq(pad(v, [4, 3], { mode: 'symmetric' }), [10], [3, 3, 2, 1, 1, 2, 3, 3, 2, 1]);
  await eq(pad(v, [4, 3], { mode: 'wrap' }), [10], [3, 1, 2, 3, 1, 2, 3, 1, 2, 3]);
  await eq(pad(v, [2, 1], { mode: 'edge' }), [6], [1, 1, 1, 2, 3, 3]);
  await eq(pad(gpu.ones([1]), 3, { mode: 'reflect' }), [7], [1, 1, 1, 1, 1, 1, 1]);
  await eq(pad(gpu.zeros([0]), [2, 1], { constantValues: 7 }), [3], [7, 7, 7]);
  await eq(flip(gpu.zeros([0, 2])), [0, 2], []);
  await eq(tile(x, [0, 2]), [0, 6], []);
  await eq(repeat(x, 0, 1), [2, 0], []);
  await eq(stack([gpu.zeros([0]), gpu.zeros([0])]), [2, 0], []);
  await eq(concatenate([gpu.zeros([2, 0]), x], 1), [2, 3], [1, 2, 3, 4, 5, 6]);
  // Cross the workgroup boundary; source is a reverse, transposed view.
  const large = gpu.arange(0, 561, 1, 'i32').reshape(17, 33).T.slice([null, null, -1]);
  const ref = Array.from({ length: 561 }, (_, k) => (k % 17) * 33 + 32 - Math.floor(k / 17));
  await eq(concatenate([large, large], 0), [66, 17], [...ref, ...ref]);
  const flipped = Array.from({ length: 561 }, (_, k) => ref[560 - k]);
  await eq(flip(large), [33, 17], flipped);
  // Preserve integers above f32's exact range, and signed/unsigned promotion.
  const exact = gpu.array(new Uint32Array([0xffffffff, 0x80000001]));
  const joined = concatenate([exact, exact]);
  if (joined.dtype !== 'u32') throw new Error('concatenate lost dtype');
  await eq(joined, [4], [0xffffffff, 0x80000001, 0xffffffff, 0x80000001]);
  await eq(pad(exact, 1, { mode: 'wrap' }), [4], [0x80000001, 0xffffffff, 0x80000001, 0xffffffff]);
  return checks;
}
