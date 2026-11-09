import test from 'node:test';
import assert from 'node:assert/strict';
import { Mixer } from '../dist/index.js';
import { captureSnapshot, recallSnapshot, blendSnapshots } from '@margoengine/mixer/snapshots';
import { FakeContext } from './fakes.js';

test('snapshot saves target states independently, round trips silence through JSON and restores all buses', () => {
  using mixer = new Mixer(new FakeContext(), { buses: { music: { gain: -6 }, voice: { gain: -Infinity, solo: true } } });
  const saved = captureSnapshot(mixer);
  assert.equal(saved.buses[2].gain, null);
  mixer.bus('music').setGain(-30).setMuted(true);
  mixer.bus('voice').setGain(0).setSolo(false);
  assert.equal(saved.buses[1].gain, -6);
  recallSnapshot(mixer, JSON.parse(JSON.stringify(saved)), { at: mixer.now + 1, seconds: 0.8 });
  assert.deepEqual(captureSnapshot(mixer), saved);
  const event = mixer.bus('music').fader.gain.last();
  assert.equal(event.kind, 'target');
  assert.equal(event.time, mixer.now + 1);
  assert.equal(event.constant, 0.2);
});

test('snapshot validates every bus, schema and schedule before mutation', () => {
  using mixer = new Mixer(new FakeContext(), { buses: { a: {} } });
  const good = captureSnapshot(mixer);
  const malformed = [null, {}, { ...good, version: 2 }, { ...good, buses: [good.buses[0], good.buses[0]] },
    { ...good, buses: [{ ...good.buses[0], gain: Infinity }] }, { ...good, buses: [{ ...good.buses[0], gain: 1000 }] },
    { ...good, buses: [{ ...good.buses[0], muted: 1 }] }, { ...good, buses: new Array(1) }];
  for (const bad of malformed) assert.throws(() => recallSnapshot(mixer, bad), TypeError);
  const missing = { version: 1, buses: [{ ...good.buses[0], gain: -10 }, { ...good.buses[1], name: 'missing' }] };
  assert.throws(() => recallSnapshot(mixer, missing), { code: 'state' });
  assert.deepEqual(captureSnapshot(mixer), good);
  for (const options of [{ at: -1 }, { at: NaN }, { seconds: -1 }, { seconds: Infinity }])
    assert.throws(() => recallSnapshot(mixer, good, options), RangeError);
  assert.throws(() => recallSnapshot(mixer, good, { at: 'now' }), TypeError);
});

test('blends match by name, interpolate amplitudes, preserve endpoints and do not mutate inputs', () => {
  using mixer = new Mixer(new FakeContext(), { buses: { a: {} } });
  const a = captureSnapshot(mixer);
  mixer.bus('a').setGain(-Infinity).setMuted(true).setSolo(true);
  const b = captureSnapshot(mixer);
  assert.deepEqual(blendSnapshots(a, b, 0), a);
  assert.deepEqual(blendSnapshots(a, b, 1), b);
  const half = blendSnapshots(a, { ...b, buses: [...b.buses].reverse() }, 0.5);
  assert.ok(Math.abs(half.buses[1].gain - 20 * Math.log10(0.5)) < 1e-12);
  assert.equal(half.buses[1].muted, true);
  assert.equal(a.buses[1].gain, 0);
  assert.equal(b.buses[1].gain, null);
  assert.throws(() => blendSnapshots(a, { version: 1, buses: [] }, 0.5), TypeError);
  assert.throws(() => blendSnapshots(a, b, 2), RangeError);
});

test('snapshots restore underwater filter and wet/dry settings, refusing changed chains and unsafe feedback atomically', () => {
  using mixer = new Mixer(new FakeContext(), { buses: { room: { effects: [
    { type: 'filter', filter: 'lowpass', frequency: 20000 }, { type: 'delay', mix: 0.2, feedback: 0.4 },
  ] } } });
  const clear = captureSnapshot(mixer);
  const bus = mixer.bus('room');
  bus.effects[0].params.frequency.value = 400;
  bus.effects[1].params.wet.value = 0.8;
  const underwater = captureSnapshot(mixer);
  recallSnapshot(mixer, clear, { seconds: 0 });
  assert.equal(bus.effects[0].params.frequency.last().value, 20000);
  assert.equal(bus.effects[1].params.wet.last().value, 0.2);
  const blend = blendSnapshots(clear, underwater, 0.5);
  assert.equal(blend.buses[1].effects[0].params.frequency, 10200);
  const bad = structuredClone(clear);
  bad.buses[0].gain = -10;
  bad.buses[1].effects[1].params.feedback = 1;
  assert.throws(() => recallSnapshot(mixer, bad), RangeError);
  assert.equal(mixer.master.gain, 0);
  bus.setEffects([]);
  assert.throws(() => recallSnapshot(mixer, clear), /chain/);
  assert.throws(() => blendSnapshots(clear, captureSnapshot(mixer), 0.5), /chain/);
});
