import test from 'node:test';
import assert from 'node:assert/strict';
import { istft, overlapRatio, resynthesize, spectrogram, stft, windows } from '../dist/spectrogram.js';
import { butterflies, fftPlan, fft, realPair, inverseRealPair } from '../src/spectrogram-fft.ts';

const RATE = 48000;

// 3 s of noise plus a chirp, amplitude under 1 (a seeded generator, so the numbers repeat).
function signal(seconds = 3, rate = RATE) {
  const n = Math.round(seconds * rate),
    out = new Float32Array(n);
  let a = 12345;
  const random = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    out[i] = 0.25 * (2 * random() - 1) + 0.5 * Math.sin(2 * Math.PI * (200 * t + (2000 * t * t) / (2 * seconds)));
  }
  return out;
}

const coded = (code, pattern) => (error) => {
  assert.equal(error.name, 'MargoError');
  assert.equal(error.code, code);
  assert.match(error.message, pattern);
  return true;
};

test('windows follow Harris (1978): cosine sums, Kaiser-Bessel, periodic and symmetric forms to 1e-12', () => {
  const N = 64;
  const sums = {
    hann: [0.5, 0.5],
    hamming: [0.54, 0.46],
    blackman: [0.42, 0.5, 0.08],
    blackmanHarris: [0.35875, 0.48829, 0.14128, 0.01168],
  };
  for (const [name, a] of Object.entries(sums)) {
    const periodic = windows[name](N),
      symmetric = windows[name](N, { symmetric: true });
    for (let n = 0; n < N; n++) {
      let p = 0,
        s = 0;
      a.forEach((c, k) => {
        p += (k % 2 ? -1 : 1) * c * Math.cos((2 * Math.PI * k * n) / N);
        s += (k % 2 ? -1 : 1) * c * Math.cos((2 * Math.PI * k * n) / (N - 1));
      });
      assert.ok(Math.abs(periodic[n] - p) < 1e-12, `${name} periodic ${n}`);
      assert.ok(Math.abs(symmetric[n] - s) < 1e-12, `${name} symmetric ${n}`);
    }
    // Peak of 1 at the centre n = N / 2 (the sum of the coefficients), the first sample the sum with alternating signs.
    assert.ok(Math.abs(periodic[N / 2] - a.reduce((x, c) => x + c, 0)) < 1e-12);
  }
  assert.deepEqual(
    [...windows.hann(4)].map((v) => +v.toFixed(12)),
    [0, 0.5, 1, 0.5],
  );
  assert.ok(Math.abs(windows.hamming(8)[0] - 0.08) < 1e-12);
  assert.ok(Math.abs(windows.blackmanHarris(8)[0] - 6e-5) < 1e-12);
  assert.deepEqual([...windows.rectangular(3)], [1, 1, 1]);
  // Kaiser: beta 0 is rectangular, the peak is 1 at the centre and the ends fall to 1 / I0(beta).
  assert.ok(windows.kaiser(16, 0).every((v) => Math.abs(v - 1) < 1e-12));
  const k = windows.kaiser(64, 8.6, { symmetric: true });
  assert.ok(Math.abs(k[31] - 1) < 2e-3 && k[0] < 2e-3 && Math.abs(k[0] - k[63]) < 1e-15);
  // The first sample equals 1 / I0(beta) computed by the defining series.
  let i0 = 1,
    term = 1;
  for (let m = 1; m < 100; m++) {
    term *= (8.6 / (2 * m)) ** 2;
    i0 += term;
  }
  assert.ok(Math.abs(k[0] - 1 / i0) < 1e-12);
  assert.throws(() => windows.hann(0), /at least 1/);
  assert.throws(() => windows.kaiser(8, -1), /beta/);
});

test('the FFT matches a direct DFT, pairs of real frames split and join exactly, and the work count is (N/2) log2 N', () => {
  const N = 64,
    re = Float64Array.from({ length: N }, (_, i) => Math.sin(i * 1.3) + 0.2 * i),
    im = Float64Array.from({ length: N }, (_, i) => Math.cos(i * 0.7));
  const zr = Float64Array.from(re),
    zi = Float64Array.from(im);
  fft(fftPlan(N), zr, zi);
  for (let k = 0; k < N; k++) {
    let sr = 0,
      si = 0;
    for (let n = 0; n < N; n++) {
      const angle = (-2 * Math.PI * k * n) / N;
      sr += re[n] * Math.cos(angle) - im[n] * Math.sin(angle);
      si += re[n] * Math.sin(angle) + im[n] * Math.cos(angle);
    }
    assert.ok(Math.abs(sr - zr[k]) < 1e-9 && Math.abs(si - zi[k]) < 1e-9, `bin ${k}`);
  }
  const a = Float64Array.from(re),
    b = Float64Array.from(im),
    bins = N / 2 + 1,
    parts = Array.from({ length: 6 }, () => new Float64Array(N)),
    spectra = Array.from({ length: 4 }, () => new Float64Array(bins));
  realPair(fftPlan(N), a, b, parts[0], parts[1], ...spectra);
  const ya = new Float64Array(N),
    yb = new Float64Array(N);
  inverseRealPair(fftPlan(N), ...spectra, parts[2], parts[3], ya, yb);
  for (let n = 0; n < N; n++) assert.ok(Math.abs(ya[n] - a[n]) < 1e-12 && Math.abs(yb[n] - b[n]) < 1e-12);
  assert.equal(butterflies(2048), 11264);
  assert.throws(() => fftPlan(1000), /power of two/);
});

test('Parseval: summed squared magnitudes equal frame size times the windowed frame energy', () => {
  const x = signal(0.5),
    spec = stft(x, { sampleRate: RATE, size: 1024, hop: 256, center: false });
  const w = spec.window;
  for (const f of [0, 7, spec.frames - 1]) {
    let energy = 0;
    for (let i = 0; i < 1024; i++) energy += (x[f * 256 + i] * w[i]) ** 2;
    let sum = 0;
    for (let k = 0; k < spec.bins; k++) {
      const p = spec.real[f * spec.bins + k] ** 2 + spec.imag[f * spec.bins + k] ** 2;
      sum += k === 0 || k === spec.bins - 1 ? p : 2 * p;
    }
    assert.ok(Math.abs(sum / 1024 - energy) < 1e-5 * energy, `frame ${f}: ${sum / 1024} vs ${energy}`);
  }
});

test('stft then istft restores 3 s of noise plus chirp within 1e-6 for Hann at hop size/4 and size/2', () => {
  const x = signal();
  for (const hop of [512, 1024]) {
    const spec = stft(x, { sampleRate: RATE, size: 2048, hop });
    assert.equal(spec.frames, 1 + Math.floor(x.length / hop));
    assert.equal(spec.bins, 1025);
    const y = istft(spec);
    assert.equal(y.length, x.length);
    let worst = 0;
    for (let i = 0; i < x.length; i++) worst = Math.max(worst, Math.abs(x[i] - y[i]));
    assert.ok(worst < 1e-6, `hop ${hop}: max error ${worst}`);
  }
  // Without centring the ends where the window is zero cannot be recovered; the rest is exact.
  const spec = stft(x, { size: 1024, hop: 256, center: false });
  const y = istft(spec, { length: spec.frames * 256 + 768 });
  let worst = 0;
  for (let i = 256; i < y.length - 256; i++) worst = Math.max(worst, Math.abs(x[i] - y[i]));
  assert.ok(worst < 1e-6, `uncentred ${worst}`);
});

test('istft refuses a hop the window cannot overlap-add evenly, with a coded error', () => {
  const x = signal(0.2);
  const bad = stft(x, { size: 2048, hop: 1536 });
  assert.throws(() => istft(bad), coded('state', /do not overlap-add evenly[\s\S]*size \/ 4/));
  assert.ok(Math.abs(overlapRatio(windows.hann(2048), 512) - 1) < 1e-9);
  assert.ok(Math.abs(overlapRatio(windows.hann(2048), 1024) - 0.5) < 1e-9);
  assert.ok(overlapRatio(windows.hann(2048), 1536) < 0.1);
  assert.equal(overlapRatio(windows.rectangular(64), 64), 1);
  assert.throws(
    () => resynthesize({ magnitude: new Float32Array(1025 * 4), frames: 4, size: 2048, hop: 1536 }),
    coded('state', /overlap-add/),
  );
});

test('a 1 kHz tone at 48 kHz peaks in bin round(1000 x size / 48000), for several sizes and windows', () => {
  const tone = Float32Array.from({ length: RATE }, (_, i) => Math.sin((2 * Math.PI * 1000 * i) / RATE));
  for (const size of [512, 2048, 8192])
    for (const window of ['hann', 'hamming', 'blackman-harris', 'kaiser']) {
      const spec = stft(tone, { sampleRate: RATE, size, window });
      const f = spec.frames >> 1;
      let best = 0;
      for (let k = 1; k < spec.bins; k++)
        if (
          spec.real[f * spec.bins + k] ** 2 + spec.imag[f * spec.bins + k] ** 2 >
          spec.real[f * spec.bins + best] ** 2 + spec.imag[f * spec.bins + best] ** 2
        )
          best = k;
      assert.equal(best, Math.round((1000 * size) / RATE), `${size} ${window}`);
    }
});

test('spectrogram images: size, decibel scaling, row order, colour and raw values', () => {
  const tone = Float32Array.from({ length: 24000 }, (_, i) => Math.sin((2 * Math.PI * 3000 * i) / RATE));
  const spec = stft(tone, { sampleRate: RATE, size: 512 });
  const image = spectrogram(spec);
  assert.equal(image.width, spec.frames);
  assert.equal(image.height, 257);
  assert.equal(image.channels, 1);
  assert.equal(image.data.length, image.width * image.height);
  const mid = image.width >> 1,
    column = Array.from({ length: image.height }, (_, y) => image.data[y * image.width + mid]);
  assert.equal(column[32], 255); // 3000 Hz at 48 kHz in 512 points is bin 32
  assert.equal(Math.max(...column), 255);
  const top = spectrogram(spec, { origin: 'high' });
  assert.equal(top.data[(256 - 32) * top.width + mid], 255);
  const raw = spectrogram(spec, { format: 'f32' });
  assert.ok(
    raw.data instanceof Float32Array &&
      Math.abs(raw.data[32 * raw.width + mid]) < 1e-3 &&
      Math.min(...raw.data) >= -100,
  );
  const colour = spectrogram(spec, { colormap: 'heat', range: [-80, 0] });
  assert.equal(colour.channels, 4);
  assert.deepEqual(
    [...colour.data.subarray(4 * (32 * colour.width + mid), 4 * (32 * colour.width + mid) + 4)],
    [255, 250, 200, 255],
  );
  assert.equal(colour.data[3], 255);
  const custom = spectrogram(spec, { colormap: (t) => [t * 255, 0, 0] });
  assert.equal(custom.data[4 * (32 * custom.width + mid)], 255);
  const power = spectrogram(spec, { dB: false, format: 'f32' });
  assert.ok(power.data[32 * power.width + mid] > 1000);
  assert.throws(() => spectrogram(spec, { floor: 5 }), /Floor must be below 0/);
});

test('Griffin-Lim: convergence never worsens without momentum, and momentum 0.99 beats it past 20 dB in 32 iterations', () => {
  // The chirp alone: its magnitude spectrogram is the target. Size 2048 at hop 256 (87.5 percent overlap); at 75 percent
  // overlap 32 iterations reach about 18 dB (docs/limits.md).
  const n = RATE;
  const chirp = Float32Array.from(
    { length: n },
    (_, i) => 0.8 * Math.sin(2 * Math.PI * (300 * (i / RATE) + (3000 * (i / RATE) ** 2) / 2)),
  );
  const spec = stft(chirp, { sampleRate: RATE, size: 2048, hop: 256 });
  const magnitude = Float32Array.from({ length: spec.real.length }, (_, i) => Math.hypot(spec.real[i], spec.imag[i]));
  const target = { magnitude, frames: spec.frames, size: 2048, hop: 256, length: n };
  const plain = resynthesize(target, { iterations: 32, momentum: 0 });
  for (let i = 1; i < 32; i++) assert.ok(plain.convergence[i] <= plain.convergence[i - 1] + 1e-12, `plain step ${i}`);
  const fast = resynthesize(target, { iterations: 32, momentum: 0.99 });
  assert.equal(fast.transforms, 32 * 2 * spec.frames + spec.frames);
  assert.equal(fast.samples.length, n);
  // The magnitude SNR of the returned signal, measured independently.
  const snr = (samples) => {
    const check = stft(samples, { size: 2048, hop: 256 });
    let error = 0,
      energy = 0;
    for (let i = 0; i < magnitude.length; i++) {
      error += (magnitude[i] - Math.hypot(check.real[i], check.imag[i])) ** 2;
      energy += magnitude[i] ** 2;
    }
    return 10 * Math.log10(energy / error);
  };
  const fastSnr = snr(fast.samples),
    plainSnr = snr(plain.samples);
  assert.ok(fastSnr > 20, `momentum SNR ${fastSnr} dB`);
  assert.ok(fastSnr > plainSnr, `momentum ${fastSnr} dB vs plain ${plainSnr} dB`);
  assert.ok(fast.convergence[31] < fast.convergence[0]);
  console.log(`griffin-lim 32 iterations: plain ${plainSnr.toFixed(1)} dB, momentum 0.99 ${fastSnr.toFixed(1)} dB`);
  // A zero start and a given spectrum start are accepted; the seed changes the random start.
  assert.equal(resynthesize(target, { iterations: 2, init: 'zero' }).samples.length, n);
  assert.equal(resynthesize(target, { iterations: 2, init: spec }).samples.length, n);
  const a = resynthesize(target, { iterations: 2, seed: 1 }).samples,
    b = resynthesize(target, { iterations: 2, seed: 2 }).samples;
  assert.notDeepEqual([...a.subarray(1000, 1010)], [...b.subarray(1000, 1010)]);
});

test('inputs are validated and AbortSignal stops the work between frames and iterations', () => {
  const x = signal(0.1);
  assert.throws(() => stft(x, { size: 1000 }), /power of two from 32 to 65536/);
  assert.throws(() => stft(x, { size: 16 }), /from 32 to 65536/);
  assert.throws(() => stft(x, { size: 131072 }), /from 32 to 65536/);
  assert.throws(() => stft(x, { hop: 0 }), /hop must be/);
  assert.throws(() => stft(x, { hop: 4096 }), /hop must be/);
  assert.throws(() => stft(x, { sampleRate: 0 }), /Sample rate/);
  assert.throws(() => stft(x, { window: [1, 2, 3] }), /2048 numbers/);
  assert.throws(() => stft(x, { window: 'sine' }), /Unknown window/);
  assert.throws(() => stft(x, { pad: 'wrap' }), /Unknown pad/);
  assert.throws(() => stft(new Float32Array(0)), /at least one sample/);
  assert.throws(() => stft(Float32Array.of(1, NaN, 2)), /Sample 1 is NaN/);
  assert.throws(() => stft(new Float32Array(100), { center: false }), /at least size/);
  assert.throws(() => stft(null), /Float32Array/);
  assert.throws(() => istft(stft(x), { length: 10 ** 7 }), /Length must be/);
  assert.throws(() => stft(x, { signal: AbortSignal.abort(new Error('stop')) }), /stop/);
  const spec = stft(signal(1), { size: 256, hop: 64 });
  const controller = new AbortController();
  const aborting = {
    get aborted() {
      return controller.signal.aborted;
    },
    throwIfAborted: () => controller.signal.throwIfAborted(),
  };
  let calls = 0;
  const signalAfter = {
    ...aborting,
    throwIfAborted() {
      if (++calls === 3) controller.abort(new Error('halfway'));
      controller.signal.throwIfAborted();
    },
  };
  assert.throws(() => istft(spec, { signal: signalAfter }), /halfway/);
  assert.equal(calls, 3);
  const magnitude = new Float32Array(spec.real.length).fill(1);
  assert.throws(
    () => resynthesize({ magnitude, frames: spec.frames, size: 256, hop: 64 }, { iterations: 0 }),
    /Iterations/,
  );
  assert.throws(
    () => resynthesize({ magnitude, frames: spec.frames, size: 256, hop: 64 }, { momentum: 1 }),
    /Momentum/,
  );
  assert.throws(
    () => resynthesize({ magnitude: magnitude.subarray(1), frames: spec.frames, size: 256, hop: 64 }),
    /values/,
  );
  assert.throws(
    () => resynthesize({ magnitude: magnitude.map(() => -1), frames: spec.frames, size: 256, hop: 64 }),
    /at least 0/,
  );
  assert.throws(
    () =>
      resynthesize(
        { magnitude, frames: spec.frames, size: 256, hop: 64 },
        { signal: AbortSignal.abort(new Error('halt')) },
      ),
    /halt/,
  );
});

test('short and odd signals: one sample, a signal shorter than the window, even and odd frame counts', () => {
  const one = stft(Float32Array.of(0.5), { size: 32 });
  assert.equal(one.frames, 1);
  assert.ok(Math.abs(istft(one, { length: 1 })[0] - 0.5) < 1e-6);
  for (const length of [31, 33, 100, 257]) {
    const x = Float32Array.from({ length }, (_, i) => Math.sin(i));
    const y = istft(stft(x, { size: 64, hop: 16 }));
    assert.equal(y.length, length);
    for (let i = 0; i < length; i++) assert.ok(Math.abs(x[i] - y[i]) < 1e-6, `length ${length} sample ${i}`);
  }
  for (const pad of ['zero', 'edge']) {
    const x = Float32Array.from({ length: 200 }, (_, i) => Math.cos(i / 5));
    const y = istft(stft(x, { size: 64, hop: 16, pad }));
    for (let i = 0; i < 200; i++) assert.ok(Math.abs(x[i] - y[i]) < 1e-6, `${pad} ${i}`);
  }
});
