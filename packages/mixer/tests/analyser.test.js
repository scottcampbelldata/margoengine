import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnalyser, createBusAnalyser } from '@margoengine/mixer/analyser';
import { Mixer } from '@margoengine/mixer';
import { measureLoudness } from '@margoengine/mixer/loudness';
import { processorHarness, processAudio } from './processor-harness.js';

test('live audio-thread RMS/peak and LUFS match independent offline measurements across rates and layouts', async t => {
  for (const rate of [32000, 44100, 48000, 96000]) for (const channels of [1, 2, 6]) {
    const h = processorHarness(t, rate);
    using a = await createAnalyser(h.context, { channels, interval: 0.1 });
    const pcm = Array.from({ length: channels }, (_, c) => Float32Array.from({ length: rate * 4 }, (_, i) =>
      0.1 * Math.sin(2 * Math.PI * (997 + c * 127) * i / rate) * (c % 2 ? -1 : 1)));
    assert.deepEqual(processAudio(h.worklets[0].processor, pcm, 73), pcm);
    const expected = measureLoudness(pcm, rate), live = a.read();
    assert.equal(live.frames, rate * 4);
    for (const field of ['momentary','shortTerm']) assert.ok(Math.abs(live[field] - expected[field]) < 1e-9, `${rate}/${channels}/${field}`);
    for (let c = 0; c < channels; c++) {
      const tail = pcm[c].slice(-rate / 10);
      const rms = Math.sqrt(tail.reduce((a, v) => a + v*v, 0) / tail.length);
      assert.ok(Math.abs(live.rms[c] - rms) < 1e-12);
      assert.equal(live.peak[c], Math.max(...tail.map(Math.abs)));
      assert.ok(Math.abs(live.db[c] - 20*Math.log10(rms)) < 1e-10);
    }
  }
});

test('meter windows are audio-clock continuous across quanta, reset clears history, silence is -Infinity', async t => {
  const h = processorHarness(t);
  using a = await createAnalyser(h.context, { channels: 1 });
  const p = h.worklets[0].processor;
  assert.equal(a.read().momentary, -Infinity);
  processAudio(p, [new Float32Array(48000).fill(0.25)], 17);
  assert.equal(a.read().rms[0], 0.25); assert.equal(a.read().shortTerm, -Infinity);
  a.reset(); assert.equal(a.read().frames, 0);
  processAudio(p, [new Float32Array(144000)], 31);
  assert.equal(a.read().momentary, -Infinity); assert.equal(a.read().shortTerm, -Infinity);
  assert.equal(a.read().db[0], -Infinity);
  const copy = a.read(); copy.rms[0] = 42; assert.equal(a.read().rms[0], 0);
  const before = h.context.nodes.length;
  for (const options of [{ fftSize: 100 }, { smoothing: NaN }, { channels: 3 }, { interval: 0 }])
    await assert.rejects(createAnalyser(h.context, options));
  assert.equal(h.context.nodes.length, before);
  assert.throws(() => a.waveform(2)); assert.throws(() => a.spectrum(0, new Float32Array(2)));
  assert.equal(a.frequency(10), 10 * 48000 / 2048);
  assert.throws(() => a.frequency(0.5));
});

test('bus analyser is owned, preserves serial stages and releases worklet resources', async t => {
  const h = processorHarness(t);
  using m = new Mixer(h.context, { buses: { x: {} } });
  using a = await createBusAnalyser(m.bus('x'));
  m.dispose(); assert.throws(() => a.read(), { code: 'disposed' });
  assert.equal(h.worklets[0].processor.process([[]], [[new Float32Array(1)]]), false);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(createAnalyser(h.context, { signal: controller.signal }), { name: 'AbortError' });
});

test('LUFS windows read -Infinity again once a loud passage has left them, and stay drift free', async t => {
  // M6 Mac mini: a 0.37 stereo chirp for 5 s then 4 s of digital silence read momentary -149 and short-term -143.5
  // LUFS, because the running window sums kept the rounding left by adding and removing loud samples.
  for (const amp of [0.9, 0.37]) {
    const h = processorHarness(t);
    using a = await createAnalyser(h.context, { channels: 2 });
    const p = h.worklets[0].processor;
    const tone = [0, 1].map(c => Float32Array.from({ length: 48000 * 5 }, (_, i) =>
      amp * Math.sin(2 * Math.PI * (440 + c * 77) * i / 48000 + 0.3 * i * i / 48000 / 48000)));
    const pcm = tone.map(c => { const v = new Float32Array(48000 * 9); v.set(c); return v; });
    processAudio(p, pcm, 128);
    // The K-weighting tail is still (far below any meter's range) ringing in the short-term window; the offline
    // measurement of the same samples is the reference.
    const expected = measureLoudness(pcm, 48000), live = a.read();
    assert.equal(live.momentary, -Infinity, `momentary after silence at ${amp}`);
    for (const field of ['momentary', 'shortTerm'])
      assert.ok(live[field] === expected[field] || Math.abs(live[field] - expected[field]) < 1e-6,
        `${field} ${live[field]} vs offline ${expected[field]} at ${amp}`);
  }
});

test('a meter report already in flight when reset() is called does not bring back the old readings', async t => {
  // Port messages are asynchronous: the audio thread can post a report before it receives 'reset', and that report
  // used to land after reset() and restore the pre-reset frame count and levels.
  const h = processorHarness(t);
  using a = await createAnalyser(h.context, { channels: 1 });
  const node = h.worklets[0], p = node.processor;
  processAudio(p, [new Float32Array(4800).fill(0.5)], 128);
  const stale = node.messages.at(-1);
  a.reset();
  node.port.onmessage({ data: stale });
  assert.equal(a.read().frames, 0);
  assert.equal(a.read().rms[0], 0);
  processAudio(p, [new Float32Array(2400).fill(0.25)], 128);
  assert.equal(a.read().frames, 2400);
  assert.equal(a.read().rms[0], 0.25);
});
