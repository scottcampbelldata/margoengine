// GAP-FILM-MIX: an offline mix in plain code (levels, ducking, limiter) that runs in Node without Web Audio. Every
// expected number is worked out from the test's own signals.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mixPCM, duckGain, limitPCM } from '@margoengine/mixer/pcm';
import { measureTruePeak } from '@margoengine/mixer/worklet';

const rate = 48000;
const flat = (value, seconds) => new Float32Array(Math.round(seconds * rate)).fill(value);
const near = (actual, expected, tolerance, label) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} is not ${expected} +- ${tolerance}`);
const db = (value) => 10 ** (value / 20);
const sine = (frequency, amplitude, seconds, phase = 0) =>
  Float32Array.from(flat(0, seconds), (_, n) => amplitude * Math.sin((2 * Math.PI * frequency * n) / rate + phase));

test('it runs without Web Audio: clips land at their time with their level, bus level and master level', () => {
  assert.equal(typeof OfflineAudioContext, 'undefined');
  const mix = mixPCM({
    channels: 1,
    gain: -6,
    limiter: false,
    buses: { music: { gain: -6 } },
    clips: [
      { channels: [flat(0.5, 1)], bus: 'music', gain: -6 },
      { channels: [flat(0.25, 1)], at: 0.5, offset: 0.25, duration: 0.5 },
    ],
  });
  assert.equal(mix.channels.length, 1);
  assert.equal(mix.channels[0].length, rate);
  near(mix.channels[0][100], 0.5 * db(-18), 1e-7, 'the bus clip alone');
  near(mix.channels[0][rate / 2], 0.5 * db(-18) + 0.25 * db(-6), 1e-7, 'both');
});

test('seconds sets the length; fades are linear; a mono source keeps its level at the centre and pans at constant power', () => {
  const clip = { channels: [flat(0.5, 1)], fadeIn: 0.25, fadeOut: 0.25 };
  const centre = mixPCM({ clips: [clip], seconds: 2, limiter: false });
  assert.equal(centre.channels[0].length, 2 * rate);
  assert.equal(centre.channels[0][0], 0);
  near(centre.channels[0][rate / 8], 0.25, 1e-4, 'half way up');
  near(centre.channels[1][rate / 2], 0.5, 1e-7, 'centre');
  assert.equal(centre.channels[0][rate - 1], 0);
  assert.equal(centre.channels[0][rate + 10], 0);
  const left = mixPCM({ clips: [{ channels: [flat(0.5, 1)], pan: -1 }], limiter: false });
  near(left.channels[0][10], 0.5 * Math.SQRT2, 1e-6, 'hard left');
  near(left.channels[1][10], 0, 1e-7, 'right is silent');
  const balance = mixPCM({ clips: [{ channels: [flat(0.5, 1), flat(0.25, 1)], pan: 0.5 }], limiter: false });
  near(balance.channels[0][10], 0.25, 1e-7, 'stereo balance lowers the far side');
  near(balance.channels[1][10], 0.25, 1e-7, 'and keeps the near one');
});

test('ducking lowers the music while the voice speaks, starts ahead of it, holds through gaps and comes back', () => {
  const voice = flat(0, 4);
  // Two words with a 0.1 s gap, shorter than the hold.
  voice.fill(0.5, rate, 1.5 * rate);
  voice.fill(0.5, 1.6 * rate, 2 * rate);
  const mix = mixPCM({
    channels: 1,
    limiter: false,
    buses: { music: { duck: { key: 'voice', amount: 12, attack: 0.02, release: 0.1 } }, voice: { gain: -120 } },
    clips: [
      { channels: [flat(0.5, 4)], bus: 'music' },
      { channels: [voice], bus: 'voice' },
    ],
  });
  const level = (seconds) => mix.channels[0][Math.round(seconds * rate)];
  near(level(0.5), 0.5, 1e-4, 'before');
  // The key is read after its bus gain: at -120 dB it is under the threshold, so nothing ducks.
  near(level(1.55), 0.5, 1e-4, 'a silenced key does not duck');
  const heard = mixPCM({
    channels: 1,
    limiter: false,
    buses: { music: { duck: { key: 'voice', amount: 12, attack: 0.02, release: 0.1 } }, voice: {} },
    clips: [
      { channels: [flat(0.5, 4)], bus: 'music' },
      { channels: [voice], bus: 'voice' },
    ],
  });
  const music = (seconds) => heard.channels[0][Math.round(seconds * rate)] - voice[Math.round(seconds * rate)];
  near(music(0.5), 0.5, 1e-4, 'before');
  // Three attack time constants ahead: -12 dB * (1 - e^-3) at the first voiced sample.
  near(20 * Math.log10(music(1) / 0.5), -12 * (1 - Math.exp(-3)), 0.02, 'at the first word');
  near(music(1.55), 0.5 * db(-12), 1e-4, 'held through the gap');
  near(music(2.2), 0.5 * db(-12), 1e-4, 'held after the last word');
  // The hold ends 0.25 s after the voice; one release time constant later 1/e of the dip is left.
  near(20 * Math.log10(music(2.35) / 0.5), -12 * Math.exp(-1), 0.05, 'coming back');
  near(music(3.9), 0.5, 1e-3, 'back');
});

test('duckGain is 1 on a silent key and the deepest of two rules wins', () => {
  assert.ok(duckGain([flat(0, 0.1)], rate).every((g) => g === 1));
  const loud = flat(0.5, 1);
  const mix = mixPCM({
    channels: 1,
    limiter: false,
    buses: {
      music: {
        duck: [
          { key: 'a', amount: 6, attack: 0 },
          { key: 'b', amount: 12, attack: 0 },
        ],
      },
      a: {},
      b: {},
    },
    clips: [
      { channels: [flat(0.25, 1)], bus: 'music' },
      { channels: [loud], bus: 'a' },
      { channels: [loud], bus: 'b' },
    ],
  });
  near(mix.channels[0][rate / 2], 1 + 0.25 * db(-12), 1e-5, 'two keys');
});

test('the limiter holds the true peak at the ceiling, moves before the peak and leaves quiet audio untouched', () => {
  // A quarter-rate sine at 45 degrees: samples at 0.707 of the amplitude, the true peak between them.
  const signal = sine(rate / 4, 0.2, 1, Math.PI / 4);
  const burst = sine(rate / 4, 1.5, 0.1, Math.PI / 4);
  signal.set(burst, rate / 2);
  const original = signal.slice();
  assert.ok(measureTruePeak([signal]) > 1.4);
  const result = limitPCM([signal], rate, { ceiling: -1, lookahead: 0.005, release: 0.01 });
  assert.ok(result.truePeak <= db(-1), `${result.truePeak} is over ${db(-1)}`);
  assert.equal(result.truePeak, measureTruePeak([signal]));
  near(result.truePeak, db(-1), 0.02, 'and it is not turned down further than needed');
  near(result.reduction, 20 * Math.log10(measureTruePeak([burst]) / db(-1)), 0.5, 'reduction');
  for (let n = 0; n < rate / 2 - 300; n++) assert.equal(signal[n], original[n], `sample ${n} untouched`);
  // The gain is already moving 2.5 ms ahead of the burst.
  const n = rate / 2 - 120;
  assert.ok(Math.abs(signal[n]) < Math.abs(original[n]) * 0.8);
  near(signal[rate - 10], original[rate - 10], 1e-3, 'released');
});

test('the limiter is on by default, keeps one gain for all channels, and noise stays under the ceiling', () => {
  let seed = 1;
  const noise = (amplitude) =>
    Float32Array.from({ length: rate }, () => {
      seed = (Math.imul(seed, 48271) >>> 0) % 2147483647;
      return amplitude * (seed / 1073741823.5 - 1);
    });
  const mix = mixPCM({ clips: [{ channels: [noise(2), noise(0.1)] }] });
  assert.ok(mix.truePeak <= db(-1), `${mix.truePeak}`);
  assert.ok(mix.reduction > 6);
  const quiet = flat(0.1, 0.1);
  const both = [flat(2, 0.1), quiet.slice()];
  limitPCM(both, rate);
  near(both[1][2400] / quiet[2400], both[0][2400] / 2, 1e-6, 'linked');
});

test('the same input gives the same samples, and the sources are not changed', () => {
  const source = sine(440, 1.2, 0.5);
  const before = source.slice();
  const options = { clips: [{ channels: [source] }] };
  assert.deepEqual(mixPCM(options).channels, mixPCM(options).channels);
  assert.deepEqual(source, before);
  assert.deepEqual(mixPCM({ clips: [] }).channels, [new Float32Array(0), new Float32Array(0)]);
});

test('bad input is refused with what to change, and an abort is observed', () => {
  const clips = [{ channels: [flat(0, 0.01)] }];
  assert.throws(() => mixPCM({ clips: [{ channels: [flat(0, 0.01)], bus: 'x' }] }), /bus "x"/);
  assert.throws(() => mixPCM({ clips, buses: { a: { duck: { key: 'b' } } } }), /ducks under "b"/);
  assert.throws(() => mixPCM({ clips: [{ channels: [new Float32Array([Number.NaN])] }] }), TypeError);
  assert.throws(() => mixPCM({ clips, channels: 1.5 }), RangeError);
  assert.throws(() => mixPCM({ clips, channels: 1, buses: {}, limiter: { ceiling: 3 } }), /ceiling/);
  assert.throws(() => mixPCM({ clips: [{ channels: [flat(0, 0.01)], pan: 1 }], channels: 1 }), /pan/);
  assert.throws(() => mixPCM({ clips, signal: AbortSignal.abort() }), { name: 'AbortError' });
});
