import test from 'node:test';
import assert from 'node:assert/strict';
import { createStereo, createBusStereo } from '@margoengine/mixer/stereo';
import { Mixer } from '@margoengine/mixer';
import { FakeContext, FakeNode, FakeParam, reaches } from './fakes.js';

function context() {
  const c = new FakeContext();
  c.createChannelSplitter = () => c.track(new FakeNode(c, 'splitter'));
  c.createChannelMerger = () => c.track(new FakeNode(c, 'merger'));
  c.createStereoPanner = () => c.track(Object.assign(new FakeNode(c, 'stereo'), { pan: new FakeParam(0) }));
  c.createConstantSource = () => c.track(Object.assign(new FakeNode(c, 'constant'), {
    offset: new FakeParam(0), started: false, stopped: false,
    start() { this.started = true; }, stop() { this.stopped = true; },
  }));
  return c;
}

test('stereo controls use native audio parameters and reject invalid automation before changes', () => {
  const c = context();
  using s = createStereo(c);
  assert.equal(s.pan.value, 0); assert.equal(s.width.value, 0.5);
  s.setPan(-1, { at: 1, seconds: 0.2 });
  assert.deepEqual(s.pan.last(), { kind: 'target', value: -1, time: 1, constant: 0.05 });
  for (const [v, o] of [[2, {}], [NaN, {}], [0, { at: -1 }], [0, { seconds: Infinity }]]) {
    const count = s.pan.events.length;
    assert.throws(() => s.setPan(v, o)); assert.equal(s.pan.events.length, count);
  }
  s.setWidth(1); assert.equal(s.width.value, 1);
  s.dispose(); s.dispose(); assert.throws(() => s.setWidth(0), { code: 'disposed' });
  assert.ok(c.nodes.find(n => n.kind === 'constant').stopped);
});

test('every bus supports serial optional inserts, effects replacement, removal and owned cleanup', () => {
  const c = context();
  using m = new Mixer(c, { buses: { music: {} } });
  const b = m.bus('music');
  const a = createBusStereo(b), z = createBusStereo(b);
  assert.ok(reaches(b.gate, a.input) && reaches(a.output, z.input) && reaches(z.output, b.output));
  b.setEffects([{ type: 'filter', filter: 'lowpass', frequency: 1000 }]);
  assert.ok(reaches(b.input, a.input));
  a.dispose(); assert.ok(reaches(b.gate, z.input)); assert.ok(!reaches(b.gate, a.input));
  b.dispose(); assert.throws(() => z.setPan(0), { code: 'disposed' });
  assert.ok(c.nodes.filter(n => n.kind === 'constant').every(n => n.stopped));
  assert.throws(() => createBusStereo(b), { code: 'disposed' });
  const other = createStereo(context());
  assert.throws(() => m.master.insert(other), /context/); other.dispose();
});
