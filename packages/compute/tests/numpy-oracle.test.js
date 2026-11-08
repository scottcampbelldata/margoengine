import test from 'node:test';
import { createCompute } from '@margoengine/compute';
import { matmul } from '@margoengine/compute/linalg';
import { fft } from '@margoengine/compute/fft';
import {
  MATMUL_N,
  checkFft,
  checkMatmul,
  checkReduce,
  fillFft,
  fillMatmul,
  fillReduce,
  matmulStats,
} from '../scripts/rival-data.js';

// Frozen NumPy 2.5.4 values for the batch 167 sizes (float32 matmul, float64 fft, exact sum).
// The CPU backend is the stand-in here; the GPU page checks the same numbers.

test('matmul-256, fft-65536 and a sum of 1,048,576 match the NumPy oracle', async () => {
  using gpu = await createCompute({ backend: 'cpu' });
  const product = await matmul(
    gpu.array(fillMatmul(1), { shape: [MATMUL_N, MATMUL_N] }),
    gpu.array(fillMatmul(2), { shape: [MATMUL_N, MATMUL_N] }),
  ).read();
  checkMatmul(matmulStats(product), 'cpu');
  const spectrum = fft(gpu.array(fillFft()));
  checkFft(await spectrum.re.read(), await spectrum.im.read(), 'cpu');
  checkReduce(await gpu.reduce(gpu.array(fillReduce()), 'sum').item(), 'cpu');
});
