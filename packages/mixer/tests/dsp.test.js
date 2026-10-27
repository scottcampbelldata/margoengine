// The pure maths: biquad coefficients against the filter responses they must have, the compressor curve, the seeded
// impulse response, property tests over random settings and fuzzed input.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  biquadCoefficients,
  biquadMagnitude,
  biquadProcess,
  compressorCurve,
  dbToGain,
  defaultQ,
  gainToDb,
  impulseResponse,
  measure,
} from '../dist/index.js';

const rate = 48000;
const near = (a, b, tolerance, message) => assert.ok(Math.abs(a - b) <= tolerance, `${message ?? ''} ${a} vs ${b}`);
const db = (m) => 20 * Math.log10(m);
// A small seeded generator for the property and fuzz tests.
const random = (seed) => () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};

test('decibel conversions round trip', () => {
  assert.equal(dbToGain(0), 1);
  near(dbToGain(-6.0206), 0.5, 1e-4);
  assert.equal(dbToGain(-Infinity), 0);
  assert.equal(gainToDb(0), -Infinity);
  for (const g of [0.001, 0.25, 1, 3.7]) near(dbToGain(gainToDb(g)), g, 1e-12);
});

test('lowpass and highpass: unity in the pass band, nothing in the stop band, Butterworth -3 dB at the corner', () => {
  const low = biquadCoefficients('lowpass', rate, 1000);
  near(biquadMagnitude(low, 0, rate), 1, 1e-9);
  near(biquadMagnitude(low, 1000, rate), Math.SQRT1_2, 1e-6);
  assert.ok(biquadMagnitude(low, rate / 2, rate) < 1e-3);
  assert.ok(db(biquadMagnitude(low, 8000, rate)) < -30);
  const high = biquadCoefficients('highpass', rate, 1000);
  near(biquadMagnitude(high, rate / 2, rate), 1, 1e-9);
  near(biquadMagnitude(high, 1000, rate), Math.SQRT1_2, 1e-6);
  assert.ok(biquadMagnitude(high, 0, rate) < 1e-9);
  near(defaultQ('lowpass'), -3.0103, 1e-4);
});

test('lowpass resonance q is in decibels: +6 dB q peaks about 6 dB at the corner', () => {
  const c = biquadCoefficients('lowpass', rate, 1000, 6);
  near(db(biquadMagnitude(c, 1000, rate)), 6.02, 0.05);
});

test('peaking: the boost is exact at the centre and fades away from it', () => {
  const c = biquadCoefficients('peaking', rate, 1000, 1, 6);
  near(db(biquadMagnitude(c, 1000, rate)), 6, 1e-9);
  near(db(biquadMagnitude(c, 20, rate)), 0, 0.02);
  near(db(biquadMagnitude(c, 20000, rate)), 0, 0.3);
  const cut = biquadCoefficients('peaking', rate, 1000, 1, -9);
  near(db(biquadMagnitude(cut, 1000, rate)), -9, 1e-9);
});

test('shelves: the shelf gain at one end and unity at the other', () => {
  const lo = biquadCoefficients('lowshelf', rate, 200, 1, 8);
  near(db(biquadMagnitude(lo, 0, rate)), 8, 1e-9);
  near(db(biquadMagnitude(lo, rate / 2, rate)), 0, 1e-9);
  near(db(biquadMagnitude(lo, 200, rate)), 4, 0.01); // half the shelf gain at the corner
  const hi = biquadCoefficients('highshelf', rate, 6000, 1, -5);
  near(db(biquadMagnitude(hi, rate / 2, rate)), -5, 1e-9);
  near(db(biquadMagnitude(hi, 0, rate)), 0, 1e-9);
});

test('notch, bandpass and allpass', () => {
  const notch = biquadCoefficients('notch', rate, 2000, 4);
  assert.ok(biquadMagnitude(notch, 2000, rate) < 1e-9);
  near(biquadMagnitude(notch, 100, rate), 1, 0.01);
  const band = biquadCoefficients('bandpass', rate, 2000, 4);
  near(biquadMagnitude(band, 2000, rate), 1, 1e-9);
  assert.ok(biquadMagnitude(band, 100, rate) < 0.1);
  const all = biquadCoefficients('allpass', rate, 2000, 2);
  for (const f of [50, 500, 2000, 9000, 20000]) near(biquadMagnitude(all, f, rate), 1, 1e-9);
});

test('biquadProcess reaches the gain biquadMagnitude predicts', () => {
  const c = biquadCoefficients('peaking', rate, 1500, 2, 9);
  const length = rate / 2;
  const sine = new Float64Array(length);
  for (let i = 0; i < length; i++) sine[i] = Math.sin((2 * Math.PI * 1500 * i) / rate);
  const out = biquadProcess(c, sine);
  const { rms } = measure(out, length / 2, length);
  near(rms * Math.SQRT2, biquadMagnitude(c, 1500, rate), 1e-3);
});

test('invalid settings are refused with the right error', () => {
  assert.throws(() => biquadCoefficients('lowpass', rate, -1), RangeError);
  assert.throws(() => biquadCoefficients('lowpass', rate, rate), RangeError);
  assert.throws(() => biquadCoefficients('lowpass', rate, NaN), RangeError);
  assert.throws(() => biquadCoefficients('lowpass', 0, 100), RangeError);
  assert.throws(() => biquadCoefficients('wobble', rate, 100), TypeError);
  assert.throws(() => biquadCoefficients('peaking', rate, 100, 1, Infinity), RangeError);
});

test('compressorCurve: identity below the knee, slope 1/ratio above, continuous through the knee', () => {
  const s = { threshold: -20, knee: 10, ratio: 4 };
  assert.equal(compressorCurve(-60, s), -60);
  assert.equal(compressorCurve(-26, s), -26);
  near(compressorCurve(0, s), -20 + 20 / 4, 1e-12);
  near(compressorCurve(-25, s), -25, 1e-12); // lower knee edge
  near(compressorCurve(-15, s), -20 + 5 / 4, 1e-12); // upper knee edge
  assert.equal(compressorCurve(-5, { ...s, ratio: 1 }), -5);
  const hard = { threshold: -10, knee: 0, ratio: 10 };
  near(compressorCurve(-10, hard), -10, 1e-12);
  near(compressorCurve(10, hard), -8, 1e-12);
  assert.throws(() => compressorCurve(0, { threshold: 0, knee: 0, ratio: 0.5 }), RangeError);
  assert.throws(() => compressorCurve(0, { threshold: 0, knee: -1, ratio: 2 }), RangeError);
});

test('compressorCurve with a hard knee is finite exactly at the threshold (regression: 0/0 gave NaN)', () => {
  for (const ratio of [1, 2, 20]) assert.equal(compressorCurve(-12, { threshold: -12, knee: 0, ratio }), -12);
});

test('biquadCoefficients refuses settings whose maths overflows (regression: 1e300 dB gave NaN coefficients)', () => {
  assert.throws(() => biquadCoefficients('peaking', rate, 1000, 1, 1e300), RangeError);
  assert.throws(() => biquadCoefficients('lowshelf', rate, 1000, 1, -1e300), RangeError);
  assert.throws(() => biquadCoefficients('peaking', rate, 1000, 1e-300, 0), RangeError);
  assert.throws(() => biquadCoefficients('lowpass', rate, 1000, 1e300), RangeError);
});

test('compressorCurve is monotone, never boosts and never reduces by more than the ratio allows (random settings)', () => {
  const rnd = random(7);
  for (let n = 0; n < 200; n++) {
    const s = { threshold: -60 + rnd() * 60, knee: rnd() * 20, ratio: 1 + rnd() * 19 };
    let previous = -Infinity;
    for (let level = -90; level <= 12; level += 0.5) {
      const out = compressorCurve(level, s);
      assert.ok(out >= previous - 1e-9, 'monotone');
      assert.ok(out <= level + 1e-9, 'never boosts');
      previous = out;
    }
    const slope = (compressorCurve(20, s) - compressorCurve(19, s)) / 1;
    near(slope, 1 / s.ratio, 1e-9, 'slope far above the knee');
  }
});

test('impulseResponse: deterministic, unit energy, decays 60 dB over `decay`', () => {
  const a = impulseResponse(rate, { seconds: 1.5, decay: 0.6, seed: 9 });
  const b = impulseResponse(rate, { seconds: 1.5, decay: 0.6, seed: 9 });
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, impulseResponse(rate, { seconds: 1.5, decay: 0.6, seed: 10 }));
  assert.notDeepEqual(a[0], a[1]);
  assert.equal(a.length, 2);
  assert.equal(a[0].length, 72000);
  for (const channel of a) near(measure(channel).rms ** 2 * channel.length, 1, 1e-4);
  // Power 30 dB lower 0.3 s later (decay 0.6 s is 60 dB, so 0.3 s is 30 dB), averaged over 50 ms windows.
  const power = (from) => measure(a[0], from, from + 2400).rms ** 2;
  const drop = 10 * Math.log10(power(4800) / power(4800 + 14400));
  near(drop, 30, 3);
  const mono = impulseResponse(rate, { seconds: 0.5, channels: 1 });
  assert.equal(mono.length, 1);
  const delayed = impulseResponse(rate, { seconds: 0.5, preDelay: 0.1, channels: 1 })[0];
  assert.ok(delayed.slice(0, 4800).every((v) => v === 0));
  assert.ok(delayed[4801] !== 0);
});

test('impulseResponse refuses bad options', () => {
  assert.throws(() => impulseResponse(0), RangeError);
  assert.throws(() => impulseResponse(rate, { seconds: 0 }), RangeError);
  assert.throws(() => impulseResponse(rate, { seconds: 21 }), RangeError);
  assert.throws(() => impulseResponse(rate, { decay: -1 }), RangeError);
  assert.throws(() => impulseResponse(rate, { seconds: 1, preDelay: 1 }), RangeError);
  assert.throws(() => impulseResponse(rate, { channels: 3 }), RangeError);
});

test('measure', () => {
  assert.deepEqual(measure([]), { peak: 0, rms: 0 });
  assert.deepEqual(measure([1, -1, 1, -1]), { peak: 1, rms: 1 });
  assert.deepEqual(measure([0, 0, 3, 4], 2), { peak: 4, rms: Math.sqrt(12.5) });
});

test('property: every valid biquad is stable and its response is finite, and matches a processed sine', () => {
  const rnd = random(2024);
  const kinds = ['lowpass', 'highpass', 'bandpass', 'notch', 'allpass', 'peaking', 'lowshelf', 'highshelf'];
  for (let n = 0; n < 160; n++) {
    const kind = kinds[n % kinds.length];
    const frequency = 20 + rnd() * 18000,
      q = kind === 'lowpass' || kind === 'highpass' ? -6 + rnd() * 18 : 0.3 + rnd() * 6,
      gain = -18 + rnd() * 36;
    const c = biquadCoefficients(kind, rate, frequency, q, gain);
    // Stability triangle: |a2| < 1 and |a1| < 1 + a2.
    assert.ok(Math.abs(c.a2) < 1 && Math.abs(c.a1) < 1 + c.a2, `${kind} ${frequency} stable`);
    const probe = 100 + rnd() * 12000;
    const expected = biquadMagnitude(c, probe, rate);
    assert.ok(Number.isFinite(expected) && expected >= 0);
    const length = 24000;
    const sine = new Float64Array(length);
    for (let i = 0; i < length; i++) sine[i] = Math.sin((2 * Math.PI * probe * i) / rate);
    const { rms } = measure(biquadProcess(c, sine), 12000, length);
    near(rms * Math.SQRT2, expected, 0.02 * Math.max(1, expected), `${kind} ${frequency} at ${probe}`);
  }
});

test('fuzz: biquadCoefficients returns finite numbers or throws RangeError, TypeError or MargoError, nothing else', () => {
  const rnd = random(99);
  const wild = [NaN, Infinity, -Infinity, -1, 0, 1, 1e-300, 1e300, 24000, 24001, '10', null, undefined, {}, [], 0.5];
  const pick = (low, high) => (rnd() < 0.12 ? wild[Math.floor(rnd() * wild.length)] : low + rnd() * (high - low));
  const kinds = [
    'lowpass',
    'highpass',
    'bandpass',
    'notch',
    'allpass',
    'peaking',
    'lowshelf',
    'highshelf',
    'peaking',
    'lowpass',
    'x',
    3,
  ];
  let accepted = 0;
  for (let n = 0; n < 3000; n++) {
    try {
      const c = biquadCoefficients(
        kinds[Math.floor(rnd() * kinds.length)],
        pick(8000, 96000),
        pick(-100, 30000),
        pick(-10, 30),
        pick(-60, 60),
      );
      for (const v of Object.values(c)) assert.ok(Number.isFinite(v));
      accepted++;
    } catch (error) {
      assert.ok(
        error instanceof RangeError || error instanceof TypeError || error.name === 'MargoError',
        String(error),
      );
    }
  }
  assert.ok(accepted > 800, 'the fuzzer reaches valid settings too');
});
