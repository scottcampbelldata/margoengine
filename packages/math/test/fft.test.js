// The FFT (K17) in TypeScript gives kernel-common's Rust bits for every vector in
// packages/physics/kernel-common/tests/fft-vectors.txt, and is the discrete Fourier transform.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Fft, Fft3, RealFft2 } from '../dist/fft.js';

const fromHex = (hex) => new Float64Array(new BigUint64Array([BigInt(`0x${hex}`)]).buffer)[0];
const toHex = (x) => new BigUint64Array(new Float64Array([x]).buffer)[0].toString(16).padStart(16, '0');
const words = (text) => Float64Array.from(text.trim().split(' ').filter(Boolean), fromHex);

test('every transform gives the Rust bits for every vector', () => {
  const text = readFileSync(new URL('../../physics/kernel-common/tests/fft-vectors.txt', import.meta.url), 'utf8');
  let rows = 0;
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const [head, inText, outText] = line.split('|'),
      [kind, ...sizes] = head.trim().split(' '),
      n = sizes.map(Number),
      input = words(inText),
      want = outText.trim().split(' ');
    let got;
    if (kind === 'fft') {
      got = input.slice();
      new Fft(n[0]).transform(got, n[1] === 1);
    } else if (kind === 'fft3') {
      got = input.slice();
      new Fft3(n[0], n[1], n[2]).transform(got);
    } else if (kind === 'rfft2') got = new RealFft2(n[0], n[1]).forward(input);
    else if (kind === 'irfft2') got = new RealFft2(n[0], n[1]).inverse(input);
    else assert.fail(`unknown kind ${kind}`);
    assert.deepEqual(Array.from(got, toHex), want, head);
    rows++;
  }
  assert.ok(rows >= 37);
});

test('a forward transform then an inverse gives the input back; lengths with other primes are refused', () => {
  const x = Float64Array.from({ length: 120 }, (_, i) => Math.sin(i * 0.37)),
    y = x.slice(),
    plan = new Fft(60);
  plan.transform(y);
  // The DC term is the plain sum.
  let re = 0;
  for (let i = 0; i < 60; i++) re += x[2 * i];
  assert.ok(Math.abs(y[0] - re) < 1e-12);
  plan.transform(y, true);
  for (let i = 0; i < 120; i++) assert.ok(Math.abs(y[i] - x[i]) < 1e-13);
  assert.throws(() => new Fft(7), RangeError);
  assert.throws(() => new RealFft2(5, 4), RangeError);
});

// Regression (2026-11-28, KB-WATER-WAKEREADME1): the water README's WakeSolver example ran 600 steps of five 256 x 128
// real transforms and missed its 20 s page limit (31 ms a step, 18.6 s). forward() transformed all nx columns and kept
// nx / 2 + 1; the radix-2 stage ran the generic p-loop. Both are cheaper now with the same bits.
test('a real forward transform runs the rows and only the columns its half spectrum keeps', () => {
  const plan = new RealFft2(16, 8),
    original = Fft.prototype.transform;
  let calls = 0;
  Fft.prototype.transform = function (...args) {
    calls++;
    return original.apply(this, args);
  };
  try {
    plan.forward(Float64Array.from({ length: 128 }, (_, i) => Math.cos(i)));
    assert.equal(calls, 8 + 9, '8 rows and 9 of the 16 columns');
    calls = 0;
    plan.inverse(new Float64Array(2 * 9 * 8));
    assert.equal(calls, 8 + 16, 'the inverse needs every column');
  } finally {
    Fft.prototype.transform = original;
  }
});

test('the written-out radix-2 stage gives the generic stage bits, -0 inputs included', async () => {
  const { cos, sin } = await import('../dist/pinned.js');
  // The stage loop as it was before the radix-2 case, for lengths of 2s, 3s and 5s.
  const generic = (n, data, inverse) => {
    const factors = [];
    for (const p of [2, 3, 5]) for (let r = n; r % p === 0; r /= p) factors.push(p);
    const w = new Float64Array(2 * n);
    for (let j = 0; j < n; j++) {
      w[2 * j] = cos((6.283185307179586 * j) / n);
      w[2 * j + 1] = -sin((6.283185307179586 * j) / n);
    }
    let x = data.slice(),
      y = new Float64Array(2 * n),
      s = 1,
      length = n;
    const sign = inverse ? -1 : 1;
    for (const p of factors) {
      const m = length / p,
        stepC = n / length,
        stepP = n / p;
      for (let q = 0; q < s; q++)
        for (let j1 = 0; j1 < m; j1++)
          for (let k2 = 0; k2 < p; k2++) {
            let re = 0,
              im = 0;
            for (let j2 = 0; j2 < p; j2++) {
              const at = 2 * (q + s * (j1 + m * j2)),
                t = 2 * (((j2 * k2) % p) * stepP);
              re += x[at] * w[t] - x[at + 1] * (sign * w[t + 1]);
              im += x[at] * (sign * w[t + 1]) + x[at + 1] * w[t];
            }
            const t = 2 * ((j1 * k2 * stepC) % n),
              to = 2 * (q + s * (k2 + p * j1));
            y[to] = re * w[t] - im * (sign * w[t + 1]);
            y[to + 1] = re * (sign * w[t + 1]) + im * w[t];
          }
      [x, y] = [y, x];
      s *= p;
      length = m;
    }
    return x.map((v) => v * (inverse ? 1 / n : 1));
  };
  let seed = 7;
  const next = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5) * 8;
  for (const n of [2, 4, 8, 16, 48, 256, 240, 1024])
    for (const inverse of [false, true])
      for (const fill of ['random', 'signed zeros']) {
        const data = Float64Array.from({ length: 2 * n }, (_, i) => (fill === 'random' ? next() : i % 3 ? -0 : 0)),
          got = data.slice();
        new Fft(n).transform(got, inverse);
        assert.deepEqual(Array.from(got, toHex), Array.from(generic(n, data, inverse), toHex), `${n} ${inverse} ${fill}`);
      }
});
