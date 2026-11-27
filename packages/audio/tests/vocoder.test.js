// The phase vocoder (`@margoengine/audio/vocoder`) on signals whose answer is known: tones keep or move to a known
// frequency and level, lengths are exact, clicks stay sharp, a vowel's formant stays put, and long work can be stopped.
import assert from 'node:assert/strict';
import test from 'node:test';
import { pitchShift, timeStretch } from '../dist/vocoder.js';

const rate = 48000;
const sine = (seconds, hz, amplitude = 0.5, phase = 0) =>
  Float32Array.from(
    { length: Math.round(rate * seconds) },
    (_, i) => amplitude * Math.sin((2 * Math.PI * hz * i) / rate + phase),
  );
const mono = (x) => ({ sampleRate: rate, channels: [x] });
/**
 * The sinusoid at `hz` that fits samples [from, to) best (Hann-weighted): its amplitude, its phase, and `snr`, the
 * ratio in dB of its energy to what is left over.
 */
const fit = (x, hz, from, to) => {
  let cc = 0,
    ss = 0,
    cs = 0,
    xc = 0,
    xs = 0;
  const weight = (i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * (i - from)) / (to - from));
  for (let i = from; i < to; i++) {
    const w = weight(i),
      c = Math.cos((2 * Math.PI * hz * i) / rate),
      s = Math.sin((2 * Math.PI * hz * i) / rate);
    cc += w * c * c;
    ss += w * s * s;
    cs += w * c * s;
    xc += w * x[i] * c;
    xs += w * x[i] * s;
  }
  const d = cc * ss - cs * cs,
    a = (xc * ss - xs * cs) / d,
    b = (xs * cc - xc * cs) / d;
  let signal = 0,
    rest = 0;
  for (let i = from; i < to; i++) {
    const y = a * Math.cos((2 * Math.PI * hz * i) / rate) + b * Math.sin((2 * Math.PI * hz * i) / rate);
    signal += weight(i) * y * y;
    rest += weight(i) * (x[i] - y) ** 2;
  }
  return { amplitude: Math.hypot(a, b), phase: Math.atan2(a, b), snr: 10 * Math.log10(signal / rest) };
};
/**
 * The frequency of the partial near `near` (within 10 Hz), from how its fitted phase advances between two overlapping
 * spans of [from, to): first over 50 ms, then over half the length.
 */
const frequency = (x, near, from, to) => {
  const half = Math.floor((to - from) / 2);
  let hz = near;
  for (const apart of [2400, 2400, half, half]) {
    const length = to - from - apart,
      turn = fit(x, hz, from + apart, from + apart + length).phase - fit(x, hz, from, from + length).phase;
    hz += (Math.atan2(Math.sin(turn), Math.cos(turn)) * rate) / (2 * Math.PI * apart);
  }
  return hz;
};

test('a stretched tone keeps its frequency, level and purity, and the length is exact', async () => {
  const input = sine(2, 440.3);
  for (const factor of [0.25, 0.5, 0.8, 1.05, 1.5, 2, 4]) {
    for (const transients of [true, false]) {
      const out = await timeStretch(mono(input), factor, { transients });
      const [y] = out.channels,
        from = 9600,
        to = y.length - 9600,
        label = `factor ${factor}, transients ${transients}`;
      assert.equal(out.sampleRate, rate);
      assert.equal(y.length, Math.round(input.length * factor), label);
      assert.ok(Math.abs(frequency(y, 440.3, from, to) - 440.3) < 0.05, `${label}: ${frequency(y, 440.3, from, to)}`);
      const { amplitude, snr } = fit(y, frequency(y, 440.3, from, to), from, to);
      assert.ok(Math.abs(amplitude / 0.5 - 1) < 0.01, `${label}: amplitude ${amplitude}`);
      assert.ok(snr > 40, `${label}: ${snr} dB`);
    }
  }
});

test('a chord keeps every partial, and a longer window separates closer ones', async () => {
  // Partials 62 Hz or more apart at the default window; a C major seventh with two 15 Hz apart at 170 ms.
  const cases = [
    [[130.81, 196, 261.63, 329.63, 392, 493.88], {}],
    [[130.81, 164.81, 196, 246.94, 261.63, 329.63, 392, 493.88], { frameMs: 170, transients: false }],
  ];
  for (const [notes, options] of cases) {
    const input = new Float32Array(3 * rate);
    notes.forEach((hz, n) => sine(3, hz, 0.1, n).forEach((v, i) => (input[i] += v)));
    for (const factor of [0.75, 1.6]) {
      const [y] = (await timeStretch(mono(input), factor, options)).channels,
        from = 9600,
        to = y.length - 9600;
      for (const hz of notes) {
        const got = frequency(y, hz, from, to);
        assert.ok(Math.abs(got - hz) < 0.1, `factor ${factor}: ${hz} Hz came out at ${got}`);
        const { amplitude } = fit(y, got, from, to);
        assert.ok(Math.abs(amplitude / 0.1 - 1) < 0.05, `factor ${factor}: ${hz} Hz at amplitude ${amplitude}`);
      }
    }
  }
});

test('stereo channels keep their level and phase difference, even in opposite phase', async () => {
  const left = sine(1.5, 523.25, 0.4),
    right = sine(1.5, 523.25, 0.2, 2.1),
    out = await timeStretch({ sampleRate: rate, channels: [left, right] }, 1.3),
    [l, r] = out.channels,
    hz = frequency(l, 523.25, 9600, l.length - 9600),
    a = fit(l, hz, 9600, l.length - 9600),
    b = fit(r, hz, 9600, r.length - 9600),
    difference = Math.atan2(Math.sin(b.phase - a.phase), Math.cos(b.phase - a.phase));
  assert.ok(Math.abs(difference - 2.1) < 0.01, `phase difference ${difference}`);
  assert.ok(Math.abs(b.amplitude / a.amplitude - 0.5) < 0.005, `level ratio ${b.amplitude / a.amplitude}`);
  // Three channels, the last the exact negative of the first: it stays so, sample for sample.
  const three = await timeStretch({ sampleRate: rate, channels: [left, right, left.map((v) => -v)] }, 0.9);
  for (let i = 0; i < three.channels[0].length; i += 31)
    assert.ok(Math.abs(three.channels[2][i] + three.channels[0][i]) < 1e-6, `sample ${i}`);
  // A tone on one side only leaves the other silent.
  const panned = await timeStretch({ sampleRate: rate, channels: [new Float32Array(left.length), left] }, 1.2);
  assert.ok(panned.channels[0].every((v) => Math.abs(v) < 1e-6));
  assert.ok(Math.abs(fit(panned.channels[1], 523.25, 9600, 60000).amplitude - 0.4) < 0.004);
});

test('pitch shift moves a tone by the interval asked and keeps the length', async () => {
  const input = sine(1.5, 440);
  for (const semitones of [-24, -12, -5, 0.5, 7, 12, 24]) {
    const [y] = (await pitchShift(mono(input), semitones)).channels,
      want = 440 * 2 ** (semitones / 12),
      from = 9600,
      to = y.length - 9600;
    assert.equal(y.length, input.length, `${semitones}: length`);
    const got = frequency(y, want, from, to);
    assert.ok(Math.abs(got / want - 1) < 2e-4, `${semitones} semitones: ${got} Hz, want ${want}`);
    const { amplitude, snr } = fit(y, got, from, to);
    assert.ok(Math.abs(amplitude / 0.5 - 1) < 0.02, `${semitones}: amplitude ${amplitude}`);
    assert.ok(snr > 40, `${semitones}: ${snr} dB`);
  }
  // Both at once: length and pitch.
  const [both] = (await timeStretch(mono(input), 1.5, { semitones: -3 })).channels;
  assert.equal(both.length, Math.round(input.length * 1.5));
  const want = 440 * 2 ** (-3 / 12);
  assert.ok(Math.abs(frequency(both, want, 9600, both.length - 9600) / want - 1) < 2e-4);
});

/** The largest sample within 4 ms of `at`. */
const peak = (y, at) => y.subarray(at - 192, at + 193).reduce((m, v) => Math.max(m, Math.abs(v)), 0);
const clicks = [12000, 36000, 60000, 84000];

test('clicks land at their stretched times, with almost all their energy within 4 ms', async () => {
  const input = new Float32Array(2 * rate);
  for (const at of clicks) input[at] = 0.8;
  for (const factor of [0.5, 0.8, 1.5, 2, 3]) {
    const [y] = (await timeStretch(mono(input), factor)).channels;
    for (const click of clicks) {
      const at = Math.round(click * factor);
      let near = 0,
        all = 0;
      for (let i = at - 2400; i < at + 2400; i++) {
        all += y[i] ** 2;
        if (Math.abs(i - at) <= 192) near += y[i] ** 2;
      }
      assert.ok(all > 0.1 && near / all > 0.95, `factor ${factor}, click ${click}: ${near / all} of ${all}`);
    }
  }
});

test('the transient path keeps attacks over a sustained tone, and noise bursts free of pre-echo', async () => {
  const bed = sine(2, 440.3, 0.2),
    input = bed.slice();
  for (const at of clicks) input[at] += 0.8;
  for (const factor of [1.5, 2]) {
    /** The weakest click's peak, with the stretched tone taken away. */
    const weakest = async (transients) => {
      const [y] = (await timeStretch(mono(input), factor, { transients })).channels,
        [under] = (await timeStretch(mono(bed), factor, { transients })).channels,
        added = y.map((v, i) => v - under[i]);
      return Math.min(...clicks.map((at) => peak(added, Math.round(at * factor))));
    };
    const on = await weakest(true),
      off = await weakest(false);
    assert.ok(on > 0.6 && on > 1.3 * off, `factor ${factor}: peak ${on} with the transient path, ${off} without`);
  }
  // 20 ms bursts of noise: the level of what comes out more than 4 ms before each one's new start.
  let seed = 1;
  const noise = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2147483648 - 1,
    bursts = new Float32Array(2 * rate);
  for (const at of clicks) for (let i = 0; i < 960; i++) bursts[at + i] = 0.7 * noise() * Math.exp(-i / 144);
  const early = async (transients) => {
    const [y] = (await timeStretch(mono(bursts), 2, { transients })).channels;
    let before = 0,
      all = 0;
    for (const at of clicks)
      for (let i = 2 * at - 4000; i < 2 * at + 4000; i++) {
        all += y[i] ** 2;
        if (i < 2 * at - 192) before += y[i] ** 2;
      }
    return 10 * Math.log10(before / all + 1e-12);
  };
  const on = await early(true),
    off = await early(false);
  assert.ok(on < -60 && off > -35, `pre-echo ${on} dB with the transient path, ${off} dB without`);
});

test('preserveFormants keeps a vowel-like resonance where it is while the pitch moves', async () => {
  // Harmonics of 150 Hz under one resonance at 900 Hz.
  const envelope = (hz) => 0.2 / (1 + ((hz - 900) / 150) ** 2) + 0.002,
    input = new Float32Array(2 * rate);
  for (let n = 1; n * 150 < 6000; n++) sine(2, n * 150, envelope(n * 150), n * n).forEach((v, i) => (input[i] += v));
  for (const semitones of [5, -5]) {
    const f0 = 150 * 2 ** (semitones / 12);
    /** The amplitude-weighted mean frequency of the harmonics from 300 to 1800 Hz: where the resonance sits. */
    const centre = (y) => {
      let sum = 0,
        total = 0,
        error = 0;
      for (let n = 1; n * f0 < 1800; n++) {
        if (n * f0 < 300) continue;
        const power = fit(y, n * f0, 9600, y.length - 9600).amplitude ** 2;
        sum += power * n * f0;
        total += power;
        error = Math.max(error, Math.abs(20 * Math.log10(Math.sqrt(power) / envelope(n * f0))));
      }
      return { hz: sum / total, error };
    };
    const kept = centre((await pitchShift(mono(input), semitones, { preserveFormants: true })).channels[0]),
      moved = centre((await pitchShift(mono(input), semitones)).channels[0]),
      ratio = 2 ** (semitones / 12);
    assert.ok(Math.abs(kept.hz / 900 - 1) < 0.08, `${semitones}: kept resonance at ${kept.hz} Hz`);
    assert.ok(Math.abs(moved.hz / 900 - 1) > 0.15, `${semitones}: ratio ${ratio}, moved resonance at ${moved.hz} Hz`);
    assert.ok(kept.error < 4, `${semitones}: ${kept.error} dB from the envelope`);
  }
});

test('the output is the same every time, the input is not changed, and factor 1 copies', async () => {
  const input = Float32Array.from({ length: rate }, (_, i) => 0.3 * Math.sin(i * i * 1e-5) + ((i % 977) - 488) * 1e-4),
    keep = input.slice(),
    one = await timeStretch(mono(input), 1.3, { semitones: 2, preserveFormants: true }),
    two = await timeStretch(mono(input), 1.3, { semitones: 2, preserveFormants: true });
  assert.deepEqual(one.channels[0], two.channels[0]);
  assert.deepEqual(input, keep);
  assert.ok(one.channels[0].every(Number.isFinite));
  const [same] = (await timeStretch(mono(input), 1)).channels;
  assert.deepEqual(same, input);
  assert.notEqual(same, input);
});

test('short, empty and silent audio and odd sample rates work', async () => {
  for (const sampleRate of [1, 8000, 22050, 96000, 768000])
    for (const length of [0, 1, 7, 300]) {
      const x = new Float32Array(length).fill(0.1),
        out = await timeStretch({ sampleRate, channels: [x] }, 1.7, { semitones: 3 });
      assert.equal(out.channels[0].length, Math.round(length * 1.7), `${sampleRate} Hz, ${length} samples`);
      assert.ok(out.channels[0].every(Number.isFinite), `${sampleRate} Hz, ${length} samples`);
    }
  const silent = await timeStretch(mono(new Float32Array(rate)), 2);
  assert.ok(silent.channels[0].every((v) => v === 0));
});

test('an AbortSignal stops the work with its reason, before it starts or part way', async () => {
  const audio = mono(sine(20, 300));
  await assert.rejects(timeStretch(audio, 1.5, { signal: AbortSignal.abort(new Error('early')) }), /early/);
  const controller = new AbortController(),
    job = timeStretch(audio, 1.5, { signal: controller.signal });
  let finished = false;
  setTimeout(() => {
    assert.equal(finished, false, 'the work yielded to a timer before it finished');
    controller.abort(new Error('part way'));
  }, 20);
  await assert.rejects(
    job.finally(() => (finished = true)),
    /part way/,
  );
  await assert.rejects(pitchShift(audio, 2, { signal: AbortSignal.timeout(20) }), { name: 'TimeoutError' });
});

test('bad input is refused with a help link', async () => {
  const x = sine(0.1, 440);
  for (const factor of [0, 0.2, 5, Number.NaN])
    await assert.rejects(timeStretch(mono(x), factor), /errors#audio-vocoder/);
  for (const options of [{ semitones: 25 }, { frameMs: 10 }, { envelopeMs: 0 }])
    await assert.rejects(timeStretch(mono(x), 1.1, options), RangeError);
  await assert.rejects(pitchShift(mono(x), Number.NaN), RangeError);
  await assert.rejects(timeStretch({ sampleRate: rate, channels: [] }, 1.1), TypeError);
  await assert.rejects(timeStretch({ sampleRate: rate, channels: [x, new Float32Array(3)] }, 1.1), RangeError);
  await assert.rejects(timeStretch({ sampleRate: 44100.5, channels: [x] }, 1.1), RangeError);
  await assert.rejects(timeStretch(mono(new Float32Array([0, Number.NaN])), 1.1), RangeError);
});
