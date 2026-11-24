import test from 'node:test';
import assert from 'node:assert/strict';
import { measureLoudness, normalizeLoudness } from '@margoengine/mixer/loudness';

const tone = (rate, seconds, db, frequency = 1000) => Float32Array.from({ length: Math.round(rate * seconds) },
  (_, n) => 10 ** (db / 20) * Math.sin(2 * Math.PI * frequency * n / rate));
const near = (a,b,error) => assert.ok(Math.abs(a-b) <= error, `${a} vs ${b}, bound ${error}`);

test('generated EBU Tech 3341 cases 1 and 2: 20 s stereo tones meet the prescribed 0.1 LU M/S/I bars', () => {
  for (const db of [-23, -33]) {
    const signal = tone(48000, 20, db), result = measureLoudness([signal, signal]);
    for (const field of ['integrated', 'momentary', 'shortTerm']) near(result[field], db, 0.1);
    assert.equal(result.blocks, 197);
    assert.equal(result.momentaryHistory.length, 1961);
    assert.equal(result.shortTermHistory.length, 1701);
  }
});

test('derived rate profiles preserve calibration; six-channel weighting ignores LFE and gives surrounds 1.41 power', () => {
  for (const rate of [32000, 44100, 88200, 96000, 176400, 192000]) {
    const signal = tone(rate, 4, -18), result = measureLoudness([signal, signal], rate);
    near(result.integrated, -18, 0.1);
  }
  const mono = tone(48000, 4, -23), zero = new Float32Array(mono.length);
  const base = measureLoudness([mono]);
  const surround = measureLoudness([zero, zero, zero, zero, mono, zero]);
  near(surround.integrated - base.integrated, 10 * Math.log10(1.41), 1e-10);
  const lfe = measureLoudness([zero, zero, zero, mono, zero, zero]);
  assert.equal(lfe.integrated, -Infinity);
  assert.ok(lfe.truePeak > 0, 'peak cap includes LFE even though programme loudness excludes it');
});

test('generated EBU file-meter offset cases 10 and 13 capture every 3 s and 400 ms tone, including between 100 ms boundaries', () => {
  for (const [duration, offsetStep, history] of [[3, 0.15, 'shortTermHistory'], [0.4, 0.02, 'momentaryHistory']]) {
    const starts = [];
    let length = 0;
    for (let i = 0; i < 20; i++) {
      length += Math.round(i * offsetStep * 48000);
      starts.push(length);
      length += Math.round((duration + 1) * 48000);
    }
    const signal = new Float32Array(length), part = tone(48000, duration, -23);
    for (const start of starts) signal.set(part, start);
    const report = measureLoudness([signal, signal]);
    for (const start of starts) near(report[history][Math.round(start / 480)], -23, 0.1);
  }
});

test('relative/absolute gating excludes quiet blocks and a gain change shifts loudness by its dB value', () => {
  const loud = tone(48000, 4, -23), quiet = tone(48000, 4, -63);
  const signal = new Float32Array(loud.length + quiet.length); signal.set(loud); signal.set(quiet, loud.length);
  const result = measureLoudness([signal, signal]);
  const loudOnly = measureLoudness([loud, loud]);
  assert.ok(result.gatedBlocks < result.blocks);
  assert.ok(result.integrated > loudOnly.integrated - 0.25, 'relative gate removes quiet programme time');
  const doubled = loud.map((value) => value * 2);
  near(measureLoudness([doubled, doubled]).integrated - loudOnly.integrated, 20 * Math.log10(2), 1e-10);
  assert.equal(measureLoudness([tone(48000, 4, -90)]).integrated, -Infinity);
});

test('normalisation copies PCM, reaches the ordinary target and reports peak-limited outcomes without clipping', () => {
  const signal = tone(48000, 4, -10), copy = signal.slice();
  const normalized = normalizeLoudness([signal, signal]);
  assert.deepEqual(signal, copy);
  assert.notEqual(normalized.channels[0], signal);
  near(normalized.after.integrated, -23, 1e-5);
  assert.equal(normalized.peakLimited, false);
  const transient = new Float32Array(48000); transient[12000] = 4;
  const limited = normalizeLoudness([transient], 48000, { target: -10, maxTruePeak: -6 });
  assert.equal(limited.peakLimited, true);
  assert.ok(limited.after.truePeak <= 10 ** (-6 / 20));
  assert.ok(limited.after.integrated < -10);
});

test('short/empty/silent inputs have no gated result; malformed channels/rates/options fail explicitly', () => {
  for (const signal of [new Float32Array(), new Float32Array(100), new Float32Array(48000)]) {
    const report = measureLoudness([signal]);
    assert.equal(report.integrated, -Infinity);
    assert.equal(report.truePeak, 0);
    assert.throws(() => normalizeLoudness([signal]), { code: 'state', message: /https:\/\// });
  }
  for (const bad of [[], [Float32Array.of(NaN)], [new Float32Array(1), new Float32Array(2)], [new Float32Array(2), new Float32Array(2), new Float32Array(2)]])
    assert.throws(() => measureLoudness(bad), TypeError);
  assert.throws(() => measureLoudness([new Float32Array(1)], 12345), RangeError);
  assert.throws(() => measureLoudness([new Float32Array(1)], '48000'), TypeError);
  for (const options of [{ target: -70 }, { target: 1 }, { maxTruePeak: NaN }, { target: 'normal' }])
    assert.throws(() => normalizeLoudness([tone(48000, 1, -23)], 48000, options));
});
