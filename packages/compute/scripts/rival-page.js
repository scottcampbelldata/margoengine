// One headless page: Margo and TensorFlow.js WebGPU take turns. Node 26.12 has no WebGPU global and
// no WebGPU flag, so this page is the runtime that can run both. TensorFlow.js is loaded from the
// install outside the repository (script URLs in the query). Public API: setBackend('webgpu'),
// matMul, spectral.fft, sum (js.tensorflow.org API, tfjs-backend-webgpu README).
import { createCompute } from '@margoengine/compute';
import { matmul } from '@margoengine/compute/linalg';
import { fft } from '@margoengine/compute/fft';
import {
  FFT_N,
  MATMUL_N,
  REDUCE_N,
  ROUNDS,
  checkFft,
  checkMatmul,
  checkReduce,
  checkTfFft,
  fillFft,
  fillMatmul,
  fillReduce,
  matmulStats,
} from './rival-data.js';

const loadScript = (url) =>
  new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = url;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`failed to load ${url}`));
    document.head.appendChild(script);
  });

const waitStart = () =>
  new Promise((resolve) => {
    if (window.__startRival) resolve();
    else {
      const timer = setInterval(() => {
        if (window.__startRival) {
          clearInterval(timer);
          resolve();
        }
      }, 20);
    }
  });

async function paired(runA, runB) {
  const roundsA = [];
  const roundsB = [];
  let outA;
  let outB;
  for (let i = 0; i < ROUNDS; i++) {
    if (i % 2 === 0) {
      const a0 = performance.now();
      outA = await runA();
      roundsA.push(performance.now() - a0);
      const b0 = performance.now();
      outB = await runB();
      roundsB.push(performance.now() - b0);
    } else {
      const b0 = performance.now();
      outB = await runB();
      roundsB.push(performance.now() - b0);
      const a0 = performance.now();
      outA = await runA();
      roundsA.push(performance.now() - a0);
    }
  }
  return { minA: Math.min(...roundsA), minB: Math.min(...roundsB), roundsA, roundsB, outA, outB };
}

try {
  const params = new URLSearchParams(location.search);
  await loadScript(params.get('tf'));
  await loadScript(params.get('webgpu'));
  const tf = globalThis.tf;
  if (!tf) throw new Error('TensorFlow.js did not load');
  const switched = await tf.setBackend('webgpu');
  await tf.ready();
  if (!switched || tf.getBackend() !== 'webgpu') throw new Error(`TensorFlow.js backend is ${tf.getBackend()}`);
  await waitStart();
  console.log('rival backends ready');

  const gpu = await createCompute({ backend: 'webgpu' });
  if (gpu.backend !== 'webgpu') throw new Error(`Margo backend is ${gpu.backend}`);

  const left = gpu.array(fillMatmul(1), { shape: [MATMUL_N, MATMUL_N] });
  const right = gpu.array(fillMatmul(2), { shape: [MATMUL_N, MATMUL_N] });
  const tfA = tf.tensor2d(fillMatmul(1), [MATMUL_N, MATMUL_N]);
  const tfB = tf.tensor2d(fillMatmul(2), [MATMUL_N, MATMUL_N]);
  const margoMatmul = async () => {
    const product = matmul(left, right);
    const data = await product.read();
    product.dispose();
    return data;
  };
  const tfMatmul = async () => {
    const product = tf.matMul(tfA, tfB);
    const data = await product.data();
    product.dispose();
    return data;
  };
  for (let i = 0; i < 2; i++) {
    checkMatmul(matmulStats(await margoMatmul()), 'margo warmup');
    checkMatmul(matmulStats(await tfMatmul()), 'tfjs warmup');
  }
  const matmulRun = await paired(margoMatmul, tfMatmul);
  checkMatmul(matmulStats(matmulRun.outA), 'margo');
  checkMatmul(matmulStats(matmulRun.outB), 'tfjs');
  console.log('rival matmul done');

  const signal = gpu.array(fillFft());
  const fftData = fillFft();
  const tfReal = tf.tensor1d(fftData);
  const tfImag = tf.zeros([FFT_N]);
  const tfInput = tf.complex(tfReal, tfImag);
  const margoFft = async () => {
    const spectrum = fft(signal);
    const re = await spectrum.re.read();
    const im = await spectrum.im.read();
    spectrum.re.dispose();
    spectrum.im.dispose();
    return { re, im };
  };
  const tfFft = async () => {
    const spectrum = tf.spectral.fft(tfInput);
    const reTensor = tf.real(spectrum);
    const imTensor = tf.imag(spectrum);
    const re = await reTensor.data();
    const im = await imTensor.data();
    spectrum.dispose();
    reTensor.dispose();
    imTensor.dispose();
    return { re, im };
  };
  for (let i = 0; i < 2; i++) {
    const mine = await margoFft();
    checkFft(mine.re, mine.im, 'margo warmup');
    const other = await tfFft();
    checkTfFft(other.re, other.im, 'tfjs warmup');
  }
  const fftRun = await paired(margoFft, tfFft);
  const margoFftCheck = checkFft(fftRun.outA.re, fftRun.outA.im, 'margo');
  const tfFftCheck = checkTfFft(fftRun.outB.re, fftRun.outB.im, 'tfjs');
  console.log('rival fft done');

  const values = gpu.array(fillReduce());
  const tfValues = tf.tensor1d(fillReduce());
  const margoReduce = async () => {
    const sum = gpu.reduce(values, 'sum');
    const value = await sum.item();
    sum.dispose();
    return value;
  };
  const tfReduce = async () => {
    const sum = tf.sum(tfValues);
    const data = await sum.data();
    sum.dispose();
    return data[0];
  };
  for (let i = 0; i < 2; i++) {
    checkReduce(await margoReduce(), 'margo warmup');
    checkReduce(await tfReduce(), 'tfjs warmup');
  }
  const reduceRun = await paired(margoReduce, tfReduce);
  checkReduce(reduceRun.outA, 'margo');
  checkReduce(reduceRun.outB, 'tfjs');
  console.log('rival reduce done');

  const pack = ({ minA, minB, roundsA, roundsB }) => ({ minA, minB, roundsA, roundsB });
  window.__rival = {
    backend: tf.getBackend(),
    tfVersion: tf.version?.tfjs ?? null,
    matmul: pack(matmulRun),
    fft: { ...pack(fftRun), margo: margoFftCheck, tfjs: tfFftCheck },
    reduce: { ...pack(reduceRun), margo: reduceRun.outA, tfjs: reduceRun.outB },
    counts: { matmul: MATMUL_N, fft: FFT_N, reduce: REDUCE_N },
  };
  gpu.dispose();
} catch (error) {
  window.__rival = { error: String(error), stack: error?.stack ?? '' };
  console.error(`rival failed ${error}`);
}
