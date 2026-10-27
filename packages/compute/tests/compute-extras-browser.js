// Real-GPU checks of the @margoengine/compute entries: linalg, fft, signal, random, stream and frame, each against a
// CPU reference written here.
import { Engine, box, PbrMaterial } from '@margoengine/core';
import { createCompute } from '@margoengine/compute';
import { matmul, dot, outer, norm } from '@margoengine/compute/linalg';
import { fft, ifft, fft2, fftfreq } from '@margoengine/compute/fft';
import { convolve, convolve2d, correlate } from '@margoengine/compute/signal';
import { Random, philox4x32 } from '@margoengine/compute/random';
import { stream, chunks, reduceStream, statsStream, histogramStream } from '@margoengine/compute/stream';
import { ComputeFrame } from '@margoengine/compute/frame';

const checks = [];
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const check = async (name, run) => {
  try {
    await run();
  } catch (error) {
    throw new Error(`${name}: ${error.message}`);
  }
  checks.push(name);
};
const rng = (seed) => {
  let s = seed | 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
};
const floats = (n, seed = 1, scale = 2) => {
  const r = rng(seed),
    a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = (r() - 0.5) * scale;
  return a;
};
const near = (a, b, tolerance, label) => {
  assert(a.length === b.length, `${label}: length ${a.length} != ${b.length}`);
  for (let i = 0; i < a.length; i++)
    if (!(Math.abs(a[i] - b[i]) <= tolerance * Math.max(1, Math.abs(b[i]))))
      throw new Error(`${label}: element ${i} is ${a[i]}, expected ${b[i]} (tolerance ${tolerance})`);
};
const equal = (a, b, label) => {
  assert(a.length === b.length, `${label}: length ${a.length} != ${b.length}`);
  for (let i = 0; i < a.length; i++)
    if (a[i] !== b[i]) throw new Error(`${label}: element ${i} is ${a[i]}, expected ${b[i]}`);
};
// Reference DFT in double precision.
const dft = (re, im, inverse = false) => {
  const n = re.length,
    outRe = new Float64Array(n),
    outIm = new Float64Array(n),
    sign = inverse ? 1 : -1;
  for (let k = 0; k < n; k++)
    for (let t = 0; t < n; t++) {
      const angle = (sign * 2 * Math.PI * ((k * t) % n)) / n;
      outRe[k] += re[t] * Math.cos(angle) - im[t] * Math.sin(angle);
      outIm[k] += re[t] * Math.sin(angle) + im[t] * Math.cos(angle);
    }
  if (inverse) for (let k = 0; k < n; k++) (outRe[k] /= n), (outIm[k] /= n);
  return [outRe, outIm];
};

window.runExtrasTests = async () => {
  const gpu = await createCompute();
  const timings = {};

  await check(
    'matmul: tile edges, batches that broadcast, transposed views without copies, 1-D operands, integers',
    async () => {
      const ref = (a, b, m, k, n) => {
        const c = new Float64Array(m * n);
        for (let i = 0; i < m; i++)
          for (let p = 0; p < k; p++) for (let j = 0; j < n; j++) c[i * n + j] += a[i * k + p] * b[p * n + j];
        return c;
      };
      for (const [m, k, n] of [
        [1, 1, 1],
        [3, 5, 7],
        [64, 64, 64],
        [65, 17, 130],
        [200, 300, 100],
      ]) {
        const a = floats(m * k, m + k),
          b = floats(k * n, k + n);
        near(
          await matmul(gpu.array(a, { shape: [m, k] }), gpu.array(b, { shape: [k, n] })).read(),
          ref(a, b, m, k, n),
          1e-4 * Math.sqrt(k),
          `${m}x${k} @ ${k}x${n}`,
        );
      }
      const a = floats(4 * 6, 3),
        b = floats(6 * 5, 4);
      // Transposed view: (bT)T is b; matmul reads the strides directly.
      const bT = gpu.array(b, { shape: [6, 5] }).T;
      near(
        await matmul(gpu.array(a, { shape: [4, 6] }), bT.T).read(),
        ref(a, b, 4, 6, 5),
        1e-5,
        'transposed view operand',
      );
      const batch = floats(3 * 4 * 6, 9);
      const batched = await matmul(gpu.array(batch, { shape: [3, 4, 6] }), gpu.array(b, { shape: [6, 5] })).read();
      for (let s = 0; s < 3; s++)
        near(
          batched.subarray(s * 20, s * 20 + 20),
          ref(batch.subarray(s * 24, s * 24 + 24), b, 4, 6, 5),
          1e-5,
          `batch ${s}`,
        );
      const v = floats(6, 11);
      const mv = await matmul(gpu.array(a, { shape: [4, 6] }), gpu.array(v)).read();
      near(mv, ref(a, v, 4, 6, 1), 1e-5, 'matrix @ vector drops the column');
      assert(
        matmul(gpu.array(v), gpu.array(b, { shape: [6, 5] })).shape.join() === '5',
        'vector @ matrix drops the row',
      );
      const ia = Int32Array.from({ length: 6 }, (_, i) => i - 2),
        ib = Int32Array.from({ length: 6 }, (_, i) => 3 - i);
      equal(
        await matmul(gpu.array(ia, { shape: [2, 3] }), gpu.array(ib, { shape: [3, 2] })).read(),
        Int32Array.from(ref(ia, ib, 2, 3, 2)),
        'exact integer product',
      );
      near([await dot(gpu.array([1, 2, 3]), gpu.array([4, 5, 6])).item()], [32], 0, 'dot');
      near(await outer(gpu.array([1, 2]), gpu.array([3, 4, 5])).read(), [3, 4, 5, 6, 8, 10], 0, 'outer');
      near([await norm(gpu.array([3, 4])).item()], [5], 1e-7, 'norm');
      let error;
      try {
        matmul(gpu.zeros([2, 3]), gpu.zeros([4, 2]));
      } catch (e) {
        error = e;
      }
      assert(error instanceof RangeError && /inner dimension/.test(error.message), 'inner dimension mismatch');
    },
  );

  await check(
    'fft: power-of-two (Stockham) and other lengths (Bluestein) against a double-precision DFT; inverse round trip',
    async () => {
      for (const n of [1, 2, 8, 64, 1024, 3, 5, 12, 100, 509]) {
        const re = floats(n, n),
          im = floats(n, n + 1);
        const [wantRe, wantIm] = dft(re, im);
        const got = fft({ re: gpu.array(re), im: gpu.array(im) });
        // Error of an f32 FFT grows like log2(n) roundings; scale by the signal's magnitude (about sqrt(n)).
        const tolerance = 2e-6 * Math.sqrt(n) * Math.log2(n + 2);
        near(await got.re.read(), wantRe, tolerance, `re of n=${n}`);
        near(await got.im.read(), wantIm, tolerance, `im of n=${n}`);
        const back = ifft(got);
        near(await back.re.read(), re, 1e-5, `ifft re n=${n}`);
        near(await back.im.read(), im, 1e-5, `ifft im n=${n}`);
      }
      // Batched along an axis: each column of a 8 x 6 array.
      const m = floats(48, 7);
      const cols = fft(gpu.array(m, { shape: [8, 6] }), { axis: 0 });
      const colRe = await cols.re.read();
      for (let c = 0; c < 6; c++) {
        const column = Float32Array.from({ length: 8 }, (_, r) => m[r * 6 + c]);
        const [wr] = dft(column, new Float32Array(8));
        near(
          Float32Array.from({ length: 8 }, (_, r) => colRe[r * 6 + c]),
          wr,
          1e-5,
          `column ${c}`,
        );
      }
      // fft2 of a 2-D delta is all ones.
      const delta = new Float32Array(16 * 12);
      delta[0] = 1;
      const spectrum = fft2(gpu.array(delta, { shape: [16, 12] }));
      near(await spectrum.re.read(), new Float32Array(16 * 12).fill(1), 1e-6, 'fft2 of a delta');
      near(await fftfreq(gpu, 5, 0.5).read(), [0, 0.4, 0.8, -0.8, -0.4], 1e-7, 'fftfreq odd n');
    },
  );

  // The Stockham passes against the same radix-2 Stockham done here in f32 with twiddles rounded once from double
  // precision. WGSL lets GPU sin and cos be off by up to 2^-11; twiddles computed on the GPU put the n = 1024 round trip
  // 1.4e-5 off on an Intel Arc 140V, and this check 5.0 u (u = 2^-24) off on an NVIDIA RTX A6000 (host twiddles: 0 u,
  // bit for bit). The GPU may still fuse a multiply and an add in each complex product: 1.8 u at n = 1024 and 2.7 u at
  // 65536 in a simulation with every product fused, so the bound is 1.5 sqrt(log2 n) u (4.7 u at 1024, 6 u at 65536).
  await check('fft: Stockham passes use correctly rounded twiddles (norm-wise within 1.5 sqrt(log2 n) u)', async () => {
    const f = Math.fround,
      u = 2 ** -24;
    const stockham = (re, im) => {
      const n = re.length,
        half = n / 2;
      let aRe = Float32Array.from(re),
        aIm = Float32Array.from(im);
      for (let l = 1; l < n; l *= 2) {
        const oRe = new Float32Array(n),
          oIm = new Float32Array(n);
        for (let j = 0; j < half; j++) {
          const k = j % l,
            angle = (2 * Math.PI * k * (half / l)) / n,
            quarter = 2 * k === l,
            wr = f(quarter ? 0 : Math.cos(angle)),
            wi = f(quarter ? -1 : -Math.sin(angle)),
            br = f(f(wr * aRe[j + half]) - f(wi * aIm[j + half])),
            bi = f(f(wr * aIm[j + half]) + f(wi * aRe[j + half])),
            d = 2 * j - k;
          oRe[d] = f(aRe[j] + br);
          oIm[d] = f(aIm[j] + bi);
          oRe[d + l] = f(aRe[j] - br);
          oIm[d + l] = f(aIm[j] - bi);
        }
        aRe = oRe;
        aIm = oIm;
      }
      return [aRe, aIm];
    };
    const measured = [];
    for (const n of [1024, 65536]) {
      const re = floats(n, 3 * n),
        im = floats(n, 3 * n + 1),
        [wantRe, wantIm] = stockham(re, im),
        got = fft({ re: gpu.array(re), im: gpu.array(im) }),
        gotRe = await got.re.read(),
        gotIm = await got.im.read();
      let error = 0,
        norm = 0;
      for (let i = 0; i < n; i++) {
        error += (gotRe[i] - wantRe[i]) ** 2 + (gotIm[i] - wantIm[i]) ** 2;
        norm += wantRe[i] ** 2 + wantIm[i] ** 2;
      }
      const ulps = Math.sqrt(error / norm) / u,
        bound = 1.5 * Math.sqrt(Math.log2(n));
      measured.push(`n=${n} ${ulps.toFixed(2)} u`);
      assert(ulps <= bound, `n=${n}: ${ulps.toFixed(2)} u from the host-twiddle reference, over ${bound.toFixed(2)} u`);
      got.re.dispose();
      got.im.dispose();
    }
    checks.push(`fft Stockham against the host-twiddle f32 reference: ${measured.join(', ')}`);
  });

  await check(
    'convolve (full, same, valid; direct and FFT) and correlate against NumPy-style references; convolve2d',
    async () => {
      const ref = (a, v) => {
        const out = new Float64Array(a.length + v.length - 1);
        for (let i = 0; i < a.length; i++) for (let j = 0; j < v.length; j++) out[i + j] += a[i] * v[j];
        return out;
      };
      for (const [n, m] of [
        [10, 3],
        [3, 10],
        [1000, 7],
        [5000, 300],
        [17, 17],
      ]) {
        const a = floats(n, n),
          v = floats(m, m + 3);
        const full = ref(a, v);
        const same = full.slice(Math.floor((full.length - Math.max(n, m)) / 2)).slice(0, Math.max(n, m));
        const valid = full.slice(Math.min(n, m) - 1, Math.max(n, m));
        const tol = 1e-5 * Math.sqrt(Math.min(n, m)) * 4;
        for (const method of ['direct', 'fft']) {
          near(await convolve(gpu.array(a), gpu.array(v), { method }).read(), full, tol, `full ${n},${m} ${method}`);
          near(
            await convolve(gpu.array(a), gpu.array(v), { mode: 'same', method }).read(),
            same,
            tol,
            `same ${n},${m} ${method}`,
          );
          near(
            await convolve(gpu.array(a), gpu.array(v), { mode: 'valid', method }).read(),
            valid,
            tol,
            `valid ${n},${m} ${method}`,
          );
        }
      }
      const a = floats(50, 1),
        v = floats(5, 2);
      const reversed = Float32Array.from(v).reverse();
      near(
        await correlate(gpu.array(a), gpu.array(v)).read(),
        ref(a, reversed).slice(4, 50),
        1e-5,
        'correlate (valid)',
      );
      // 2-D: a 3x3 box filter on a ramp, both methods, plus a batch of two images.
      const h = 20,
        w = 30,
        img = Float32Array.from({ length: h * w }, (_, k) => (k % w) + Math.floor(k / w) * 0.5);
      const box3 = new Float32Array(9).fill(1 / 9);
      const ref2 = (mode) => {
        const fullH = h + 2,
          fullW = w + 2,
          full = new Float64Array(fullH * fullW);
        for (let y = 0; y < h; y++)
          for (let x = 0; x < w; x++)
            for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) full[(y + i) * fullW + x + j] += img[y * w + x] / 9;
        if (mode === 'full') return full;
        const [y0, x0, oh, ow] = mode === 'same' ? [1, 1, h, w] : [2, 2, h - 2, w - 2];
        return Float64Array.from(
          { length: oh * ow },
          (_, k) => full[(Math.floor(k / ow) + y0) * fullW + (k % ow) + x0],
        );
      };
      for (const mode of ['full', 'same', 'valid'])
        for (const method of ['direct', 'fft'])
          near(
            await convolve2d(gpu.array(img, { shape: [h, w] }), gpu.array(box3, { shape: [3, 3] }), {
              mode,
              method,
            }).read(),
            ref2(mode),
            1e-4,
            `2-D ${mode} ${method}`,
          );
      const two = new Float32Array(2 * h * w);
      two.set(img);
      two.set(img, h * w);
      const batched = await convolve2d(gpu.array(two, { shape: [2, h, w] }), gpu.array(box3, { shape: [3, 3] }), {
        mode: 'same',
      }).read();
      near(batched.subarray(h * w), ref2('same'), 1e-4, 'second image of a batch');
    },
  );

  await check(
    'random: GPU Philox matches the CPU reference bit for bit; uniform, normal and integer moments; reproducible seeds',
    async () => {
      const rngA = new Random(gpu, { seed: 1234, stream: 7 });
      const bits = await rngA.bits(4096).read();
      for (let block = 0; block < 1024; block += 97) {
        const want = philox4x32([block, 0, 7, 0], [1234, 0]);
        equal(bits.subarray(block * 4, block * 4 + 4), want, `block ${block}`);
      }
      assert(rngA.counter === 1024n, 'the counter advances by the blocks used');
      const again = await new Random(gpu, { seed: 1234, stream: 7 }).bits(4096).read();
      equal(again, bits, 'same seed, same numbers');
      const n = 1 << 20;
      const u = await new Random(gpu, { seed: 1 }).uniform(n, { low: -1, high: 3 }).read();
      let mean = 0,
        min = Infinity,
        max = -Infinity;
      for (const x of u) {
        mean += x;
        min = Math.min(min, x);
        max = Math.max(max, x);
      }
      mean /= n;
      // The mean of n uniforms on [-1, 3) has standard deviation 4 / sqrt(12 n); 6 of them is a one-in-a-billion miss.
      assert(
        Math.abs(mean - 1) < (6 * 4) / Math.sqrt(12 * n) && min >= -1 && max < 3,
        `uniform mean ${mean}, range ${min}..${max}`,
      );
      const z = await new Random(gpu, { seed: 2 }).normal(n, { mean: 5, std: 2 }).read();
      let zm = 0,
        zv = 0;
      for (const x of z) zm += x;
      zm /= n;
      for (const x of z) zv += (x - zm) ** 2;
      zv /= n;
      assert(
        Math.abs(zm - 5) < (6 * 2) / Math.sqrt(n) && Math.abs(zv - 4) < 6 * 4 * Math.sqrt(2 / n),
        `normal mean ${zm}, variance ${zv}`,
      );
      const ints = await new Random(gpu, { seed: 3 }).integers(-3, 4, 70000).read();
      const counts = new Map();
      for (const x of ints) counts.set(x, (counts.get(x) ?? 0) + 1);
      assert([...counts.keys()].sort((a, b) => a - b).join() === '-3,-2,-1,0,1,2,3', 'every integer in [-3, 4)');
      for (const c of counts.values()) assert(Math.abs(c - 10000) < 600, `integer count ${c} near 10000`);
      const perm = await new Random(gpu, { seed: 4 }).permutation(1000).read();
      equal(
        Uint32Array.from(perm).sort(),
        Uint32Array.from({ length: 1000 }, (_, k) => k),
        'a permutation',
      );
    },
  );

  await check(
    'stream: chunks run in order with the next chunk read meanwhile; reduce, statistics and histogram over chunks',
    async () => {
      const data = floats(1_000_003, 5, 10);
      const sums = [];
      for await (const s of stream(gpu, chunks(data, 100_000), (c) => c.sum().item())) sums.push(s);
      assert(sums.length === 11, `11 chunks, got ${sums.length}`);
      let total = 0,
        mean = 0;
      for (const v of data) total += v;
      near([await reduceStream(gpu, chunks(data, 65536))], [total], 1e-4, 'reduceStream sum');
      mean = total / data.length;
      let m2 = 0;
      for (const v of data) m2 += (v - mean) ** 2;
      const stats = await statsStream(
        gpu,
        (async function* () {
          yield* chunks(data, 250_000);
        })(),
      );
      near([stats.count, stats.mean, stats.variance], [data.length, mean, m2 / data.length], 1e-5, 'statsStream');
      const h = await histogramStream(gpu, chunks(data, 300_000), { bins: 10, range: [-5, 5] });
      const want = new Uint32Array(10);
      for (const v of data) if (v >= -5 && v <= 5) want[Math.min(9, Math.floor(v + 5))]++;
      const got = await h.counts.read();
      // Bin edges computed in f32 and f64 can disagree for values within an ulp of an edge; none of these data are.
      equal(got, want, 'histogramStream');
      const controller = new AbortController();
      controller.abort(new Error('stop'));
      let error;
      try {
        for await (const _ of stream(gpu, chunks(data, 10), (c) => c.size, { signal: controller.signal })) void _;
      } catch (e) {
        error = e;
      }
      assert(error?.message === 'stop', 'stream honours AbortSignal');
    },
  );

  await check(
    'ComputeFrame: a per-frame job inside the engine frame moves particles the scene then draws from',
    async () => {
      const canvas = document.querySelector('canvas');
      const engine = await Engine.create(canvas, { backend: 'webgpu' });
      engine.createMesh().setGeometry(box()).setMaterial(new PbrMaterial());
      const frame = ComputeFrame.attach(engine);
      const positions = frame.gpu.zeros(1024);
      const step = frame.gpu
        .kernel(/* wgsl */ `
        struct P { dt: f32 }
        @group(0) @binding(0) var<storage, read_write> positions: array<f32>;
        @group(0) @binding(1) var<uniform> p: P;
        @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
          if (id.x < arrayLength(&positions)) { positions[id.x] += p.dt; }
        }`)
        .bind({ positions, p: { dt: 0 } });
      let frames = 0;
      frame.add(step, (dt) => {
        frames++;
        step.set('p', { dt: 0.25 });
        return { count: 1024 };
      });
      for (let k = 0; k < 4; k++) engine.render({ delta: 1 / 60 });
      const after = await positions.read();
      assert(frames === 4, `job ran ${frames} times for 4 frames`);
      near(after, new Float32Array(1024).fill(1), 1e-6, 'four steps of 0.25');
      frame.dispose();
      assert(!engine.plugins?.has?.(frame.name), 'dispose removes the plugin');
      engine.dispose();
    },
  );

  // Throughput: a 1024 x 1024 matmul, a 2^20-point FFT and 2^24 normals.
  const time = async (label, run) => {
    await run();
    await gpu.done();
    const t0 = performance.now();
    for (let k = 0; k < 5; k++) {
      await run();
      await gpu.done();
    }
    timings[label] = +((performance.now() - t0) / 5).toFixed(2);
  };
  const A = gpu.array(floats(1024 * 1024, 1), { shape: [1024, 1024] }),
    B = gpu.array(floats(1024 * 1024, 2), { shape: [1024, 1024] });
  await time('matmul 1024^3 f32, ms', () => matmul(A, B).dispose());
  timings['matmul 1024^3 f32, GFLOP/s'] = +((2 * 1024 ** 3) / (timings['matmul 1024^3 f32, ms'] * 1e6)).toFixed(1);
  const signal = gpu.array(floats(1 << 20, 3));
  await time('fft 2^20 points, ms', () => {
    const s = fft(signal);
    s.re.dispose();
    s.im.dispose();
  });
  const random = new Random(gpu, { seed: 9 });
  await time('normal 2^24 samples, ms', () => random.normal(1 << 24).dispose());
  gpu.dispose();
  return { checks, timings };
};
