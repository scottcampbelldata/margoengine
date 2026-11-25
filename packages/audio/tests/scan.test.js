// KB-FILM-AUDIOSCAN1 (2026-11-16): Margo Film Studio's narration gate needs clipped runs and silences of decoded audio;
// the engine measured loudness and true peak only, so the app kept its own loops. @margoengine/audio/scan is the
// Node-safe answer, read through decodeWav as the app does.
import assert from 'node:assert/strict';
import test from 'node:test';
import { findSilences, scanClipping } from '../dist/scan.js';
import { decodeWav, encodeWav } from '../dist/wav.js';

const rate = 48000;
const tone = (seconds, amplitude, hz = 220) =>
  Float32Array.from(
    { length: Math.round(seconds * rate) },
    (_, i) => amplitude * Math.sin((2 * Math.PI * hz * i) / rate),
  );
const join = (...parts) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) out.set(p, (at += p.length) - p.length);
  return out;
};

test('scanClipping reports runs of samples at the rail with their channel and times; a lone full-scale sample is a peak', () => {
  const left = new Float32Array(rate),
    right = new Float32Array(rate);
  left[100] = 1; // one sample at full scale: a peak
  left.fill(1, 4800, 4805); // 5 samples held at the rail at 0.1 s
  right.fill(-0.9995, 9600, 9603); // 3 negative samples just under full scale, as a lossy codec leaves them
  right.fill(0.99, 20000, 20100); // loud but under the level
  const report = scanClipping([left, right], rate);
  assert.deepEqual(report.runs, [
    { channel: 0, startSample: 4800, length: 5, start: 0.1, end: 4805 / rate },
    { channel: 1, startSample: 9600, length: 3, start: 0.2, end: 9603 / rate },
  ]);
  assert.equal(report.clippedSamples, 8);
  assert.equal(report.peak, 1);
  // A run that reaches the end of the channel still counts; a stricter run length drops the short one.
  left.fill(1, rate - 4);
  assert.deepEqual(
    scanClipping(left, rate, { run: 4 }).runs.map((r) => [r.startSample, r.length]),
    [
      [4800, 5],
      [rate - 4, 4],
    ],
  );
  assert.equal(scanClipping([tone(1, 0.5)], rate).runs.length, 0);
});

test('a clipped file read back through decodeWav is caught at 16 bits, where full scale is 32767/32768', () => {
  const hot = tone(0.5, 2).map((v) => Math.max(-1, Math.min(1, v))); // a sine driven 6 dB over full scale
  const audio = decodeWav(encodeWav({ sampleRate: rate, channels: [hot] }));
  const report = scanClipping(audio.channels, audio.sampleRate);
  // 220 Hz for 0.5 s: 110 cycles, each clipped once at the top and once at the bottom.
  assert.equal(report.runs.length, 220);
  assert.ok(report.runs.every((r) => r.length > 3));
});

test('findSilences finds the gap inside speech, with times to the window, its level, and ignores short pauses', () => {
  const quiet = (seconds) => tone(seconds, 10 ** (-70 / 20), 1000); // a -70 dBFS sine, 10 cycles a window: room tone
  const signal = join(tone(1, 0.3), quiet(3.5), tone(1, 0.3), quiet(0.4), tone(1, 0.3));
  const silences = findSilences(signal, rate, { minSeconds: 3 });
  assert.equal(silences.length, 1);
  const [gap] = silences;
  assert.ok(Math.abs(gap.start - 1) <= 0.01 && Math.abs(gap.end - 4.5) <= 0.01, JSON.stringify(gap));
  assert.ok(Math.abs(gap.duration - 3.5) <= 0.02);
  // AES17: a sine reads its peak level, so -70 dBFS here.
  assert.ok(Math.abs(gap.level + 70) < 0.1, String(gap.level));
  // The 0.4 s pause shows with a shorter limit; digital silence reads -Infinity.
  assert.equal(findSilences(signal, rate, { minSeconds: 0.3 }).length, 2);
  assert.equal(findSilences(new Float32Array(rate * 3), rate)[0].level, -Infinity);
});

test('findSilences looks only inside spans and never joins a silence across a span edge', () => {
  const signal = join(tone(1, 0.3), new Float32Array(rate * 4), tone(1, 0.3));
  assert.deepEqual(
    findSilences(signal, rate, {
      spans: [
        [0, 3],
        [3, 6],
      ],
    }).map((s) => [s.start, s.end]),
    [
      [1, 3],
      [3, 5],
    ],
  );
  assert.deepEqual(findSilences(signal, rate, { spans: [[0, 1]] }), []);
  // Stereo: the mean square of both channels decides, so one live channel is not silence.
  assert.equal(findSilences([signal, tone(6, 0.3)], rate).length, 0);
});

test('scan checks its input', () => {
  assert.throws(() => scanClipping([], rate), TypeError);
  assert.throws(() => scanClipping([new Float32Array(2), new Float32Array(3)], rate), RangeError);
  assert.throws(() => scanClipping(new Float32Array(2), 0), RangeError);
  assert.throws(() => scanClipping(new Float32Array(2), rate, { level: 1.5 }), RangeError);
  assert.throws(() => findSilences(new Float32Array(2), rate, { spans: [[2, 1]] }), RangeError);
  assert.throws(() => findSilences(new Float32Array(2), rate, { window: 0 }), RangeError);
});
