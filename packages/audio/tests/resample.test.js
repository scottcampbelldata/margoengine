// GAP-FILM-RESAMPLE: an offline sample-rate converter and channel mixer on plain Float32Array channels, so a take
// recorded at 44.1 kHz joins a 48 kHz voice in Node without Web Audio or ffmpeg.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mixChannels, resample } from '../dist/resample.js';

const tone = (rate, seconds, hz, amplitude = 0.5) =>
  Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) => amplitude * Math.sin((2 * Math.PI * hz * i) / rate));
const rms = (x, from = 0, to = x.length) => {
  let sum = 0;
  for (let i = from; i < to; i++) sum += x[i] * x[i];
  return Math.sqrt(sum / (to - from));
};
const db = (x) => 20 * Math.log10(x);

test('44.1 kHz to 48 kHz keeps a tone: the error against the exact sine is below -80 dB away from the ends', () => {
  const input = { sampleRate: 44100, channels: [tone(44100, 1, 1000)] };
  const out = resample(input, 48000);
  assert.equal(out.sampleRate, 48000);
  assert.equal(out.channels[0].length, 48000, 'one second stays one second');
  const exact = tone(48000, 1, 1000),
    error = out.channels[0].map((v, i) => v - exact[i]);
  // The filter reaches 32 / 0.92 input samples, so the first and last 1.5 ms see the silence past the ends.
  const edge = 100;
  assert.ok(db(rms(error, edge, 48000 - edge) / rms(exact)) < -80, `error ${db(rms(error, edge, 48000 - edge) / rms(exact))} dB`);
});

test('a rate drop removes what the new rate cannot hold instead of folding it back', () => {
  // 30 kHz at 96 kHz would alias to 18 kHz at 48 kHz without the filter; 5 kHz must pass.
  const high = resample({ sampleRate: 96000, channels: [tone(96000, 0.5, 30000)] }, 48000).channels[0];
  const low = resample({ sampleRate: 96000, channels: [tone(96000, 0.5, 5000)] }, 48000).channels[0];
  assert.equal(high.length, 24000);
  assert.ok(db(rms(high, 200, 23800) / rms(tone(48000, 0.5, 5000))) < -70, `alias ${db(rms(high, 200, 23800))} dB`);
  assert.ok(Math.abs(db(rms(low, 200, 23800) / rms(tone(48000, 0.5, 5000), 200, 23800))) < 0.01, 'the passband keeps its level');
});

test('lengths round up, the same rate copies, and odd rates and options are refused with a help link', () => {
  assert.equal(resample({ sampleRate: 48000, channels: [new Float32Array(3)] }, 44100).channels[0].length, 3);
  assert.equal(resample({ sampleRate: 22050, channels: [new Float32Array(10)] }, 48000).channels[0].length, 22);
  const same = new Float32Array([0.1, 0.2]);
  const copy = resample({ sampleRate: 48000, channels: [same] }, 48000).channels[0];
  assert.deepEqual([...copy], [...same]);
  assert.notEqual(copy, same, 'a new array');
  for (const bad of [0, 44100.5, -1, 800000])
    assert.throws(() => resample({ sampleRate: 48000, channels: [same] }, bad), /errors#audio-resample/);
  assert.throws(() => resample({ sampleRate: 48000, channels: [same] }, 44100, { zeroCrossings: 2 }), RangeError);
  assert.throws(() => resample({ sampleRate: 48000, channels: [same] }, 44100, { rolloff: 1.5 }), RangeError);
  assert.throws(() => resample({ sampleRate: 48000, channels: [same, new Float32Array(3)] }, 44100), RangeError);
});

test('mixChannels follows the Web Audio speaker rules up and down, discrete otherwise', () => {
  const ch = (...v) => new Float32Array(v);
  const values = (list) => list.map((c) => [...c]);
  assert.deepEqual(values(mixChannels([ch(0.5)], 2)), [[0.5], [0.5]]);
  assert.deepEqual(values(mixChannels([ch(0.5)], 6)), [[0], [0], [0.5], [0], [0], [0]]);
  assert.deepEqual(values(mixChannels([ch(1), ch(0.5)], 1)), [[0.75]]);
  assert.deepEqual(values(mixChannels([ch(1), ch(0.5), ch(0.25), ch(0.25)], 2)), [[0.625], [0.375]]);
  const [l, r] = mixChannels([ch(0), ch(0), ch(1), ch(1), ch(0.5), ch(0)], 2);
  assert.ok(Math.abs(l[0] - Math.SQRT1_2 * 1.5) < 1e-6 && Math.abs(r[0] - Math.SQRT1_2) < 1e-6, '5.1 to stereo: C and the surrounds at -3 dB, LFE dropped');
  assert.deepEqual(values(mixChannels([ch(1), ch(2), ch(3)], 2)), [[1], [2]], 'three to two is discrete');
  const stereo = resample({ sampleRate: 44100, channels: [tone(44100, 0.1, 440)] }, 48000, { channels: 2 });
  assert.deepEqual([...stereo.channels[0]], [...stereo.channels[1]], 'mono to stereo while resampling');
});

test('the documented response: flat within 0.1 dB to 0.86 of the lower Nyquist frequency, 90 dB down at it and above', () => {
  for (const [from, to] of [[44100, 48000], [48000, 44100], [96000, 48000]]) {
    const nyquist = Math.min(from, to) / 2,
      gain = (share) => {
        const input = tone(from, 0.25, share * nyquist, 1),
          out = resample({ sampleRate: from, channels: [input] }, to).channels[0];
        return db(rms(out, 400, out.length - 400) / Math.SQRT1_2);
      };
    for (const share of [0.5, 0.75, 0.86]) assert.ok(Math.abs(gain(share)) < 0.1, `${from} to ${to} at ${share}: ${gain(share)} dB`);
    for (const share of [1, 1.05]) if (share * nyquist < from / 2) assert.ok(gain(share) < -90, `${from} to ${to} at ${share}: ${gain(share)} dB`);
  }
});
