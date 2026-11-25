// GAP-FILM-STRETCH: an offline time-stretch that keeps pitch (WSOLA), on plain Float32Array channels in Node, so a
// narration section or a take is made a few percent longer or shorter to fit its slot without changing its pitch.
import assert from 'node:assert/strict';
import test from 'node:test';
import { timeStretch } from '../dist/stretch.js';

const rate = 48000;
const tone = (seconds, hz, amplitude = 0.5) =>
  Float32Array.from(
    { length: Math.round(rate * seconds) },
    (_, i) => amplitude * Math.sin((2 * Math.PI * hz * i) / rate),
  );
/** Frequency from upward zero crossings between two samples, interpolated, over [from, to). */
const pitch = (x, from, to) => {
  const crossings = [];
  for (let i = from + 1; i < to; i++)
    if (x[i - 1] < 0 && x[i] >= 0) crossings.push(i - 1 + -x[i - 1] / (x[i] - x[i - 1]));
  return ((crossings.length - 1) * rate) / (crossings.at(-1) - crossings[0]);
};
const rms = (x, from, to) => {
  let sum = 0;
  for (let i = from; i < to; i++) sum += x[i] * x[i];
  return Math.sqrt(sum / (to - from));
};

test('5 % longer and 5 % shorter keep the pitch and the level, and the length is exact', () => {
  const input = tone(2, 220);
  for (const factor of [1.05, 0.95, 1.25, 0.8]) {
    const [out] = timeStretch({ sampleRate: rate, channels: [input] }, factor).channels;
    assert.equal(out.length, Math.round(input.length * factor), `${factor}: length`);
    const from = 4800,
      to = out.length - 4800;
    assert.ok(Math.abs(pitch(out, from, to) / 220 - 1) < 0.002, `${factor}: ${pitch(out, from, to)} Hz`);
    assert.ok(Math.abs(rms(out, from, to) / rms(input, from, input.length - 4800) - 1) < 0.02, `${factor}: level`);
  }
});

test('speech-like audio: two voices of a chord keep their pitches, and stereo channels keep their alignment', () => {
  const a = tone(1.5, 180, 0.3),
    b = tone(1.5, 270, 0.3),
    left = a.map((v, i) => v + b[i]),
    right = left.map((v) => -0.5 * v);
  const out = timeStretch({ sampleRate: rate, channels: [left, right] }, 1.04);
  assert.equal(out.channels.length, 2);
  assert.equal(out.sampleRate, rate);
  // The right channel is the left one scaled by -0.5, sample for sample: the same frames were taken for both.
  for (let i = 0; i < out.channels[0].length; i += 97)
    assert.ok(Math.abs(out.channels[1][i] + 0.5 * out.channels[0][i]) < 1e-6, `sample ${i}`);
  // The sum of 180 and 270 Hz repeats at 90 Hz; its autocorrelation peaks at that period after the stretch too.
  const x = out.channels[0],
    lag = (period) => {
      let s = 0;
      for (let i = 4800; i < x.length - 4800 - period; i++) s += x[i] * x[i + period];
      return s;
    };
  let best = 0,
    peak = -Infinity;
  for (let p = 400; p < 700; p++) if (lag(p) > peak) [peak, best] = [lag(p), p];
  assert.ok(Math.abs(best - rate / 90) <= 1, `period ${best} samples, want ${rate / 90}`);
});

test('a factor of 1 copies, and bad input is refused with a help link', () => {
  const x = tone(0.1, 440);
  const [same] = timeStretch({ sampleRate: rate, channels: [x] }, 1).channels;
  assert.deepEqual([...same], [...x]);
  assert.notEqual(same, x);
  for (const factor of [0, 0.2, 5, Number.NaN])
    assert.throws(() => timeStretch({ sampleRate: rate, channels: [x] }, factor), /errors#audio-stretch/);
  assert.throws(() => timeStretch({ sampleRate: rate, channels: [x] }, 1.1, { frameMs: 5 }), RangeError);
  assert.throws(() => timeStretch({ sampleRate: rate, channels: [x, new Float32Array(3)] }, 1.1), RangeError);
  assert.throws(() => timeStretch({ sampleRate: rate, channels: [] }, 1.1), TypeError);
  assert.equal(timeStretch({ sampleRate: rate, channels: [new Float32Array(0)] }, 1.1).channels[0].length, 0);
});
