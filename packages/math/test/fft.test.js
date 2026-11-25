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
