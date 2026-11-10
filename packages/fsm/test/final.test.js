import test from 'node:test';
import assert from 'node:assert/strict';
import { FinalMachine } from '../dist/final.js';
import { EventTrace } from '../dist/events.js';

test('initial final child raises done on parent, then top-level final stops processing', () => {
  const m = new FinalMachine({ p: { initial: 'f' }, f: { parent: 'p', final: true }, end: { final: true } }, 'p', {},
    [{ from: 'p', to: 'end', event: 'done.state.p' }]);
  assert.equal(m.state, 'end'); assert.equal(m.done, true);
  assert.equal(m.send('ignored'), false); m.update(12); assert.equal(m.clock, 0);
});

test('eventless transitions run in leaf and definition order, receive payload and precede done events', () => {
  const seen = [];
  const m = new FinalMachine({ p: {}, a: { parent: 'p' }, f: { parent: 'p', final: true }, b: {}, c: {} }, 'a', {}, [
    { from: 'a', to: 'f', event: 'go' },
    { from: 'p', to: 'b', always: true, guard: (_c, d) => { seen.push(d); return d === 4; } },
    { from: 'p', to: 'c', event: 'done.state.p' },
  ]);
  using trace = new EventTrace(m);
  m.send('go', 4); assert.equal(m.state, 'b');
  assert.ok(seen.includes(4)); assert.equal(trace.records[1].event, null);
  assert.equal(trace.records[1].data, 4);
});

test('a delayed transition settles always before advancing remaining time', () => {
  const make = () => new FinalMachine({ a: {}, b: {}, c: {}, d: {} }, 'a', {}, [
    { from: 'a', to: 'b', after: 1 }, { from: 'b', to: 'c', always: true }, { from: 'c', to: 'd', after: 1 },
  ]);
  const m = make(), split = make(); using trace = new EventTrace(m);
  m.update(2.5); for (let i = 0; i < 10; i++) split.update(.25);
  assert.equal(m.state, 'd'); assert.equal(m.state, split.state); assert.equal(m.elapsed, split.elapsed);
  assert.deepEqual(trace.records.map(r => [r.event, r.after]), [[null, 1], [null, null], [null, 1]]);
});

test('completion is once per final entry and may happen again after leaving', () => {
  let count = 0;
  const m = new FinalMachine({ p: {}, f: { parent: 'p', final: true }, idle: {} }, 'f', {}, [
    { from: 'p', to: 'idle', event: 'done.state.p', guard: () => { count++; return false; } },
  ]);
  m.update(0); m.send('ignored'); assert.equal(count, 1);
  m.goto('idle'); m.goto('f'); assert.equal(count, 2);
});

test('eventless cycles fail with a coded error and invalid final definitions reject', () => {
  assert.throws(() => new FinalMachine({ a: {}, b: {} }, 'a', {}, [
    { from: 'a', to: 'b', always: true }, { from: 'b', to: 'a', always: true },
  ]), e => e.code === 'state');
  assert.throws(() => new FinalMachine({ a: { final: true }, b: { parent: 'a' } }, 'a', {}), /leaf/);
  assert.throws(() => new FinalMachine({ a: {} }, 'a', {}, [{ from: 'a', to: 'a', always: true, event: 'x' }]), /trigger/);
});

test('an ignored event reconsiders guarded always transitions', () => {
  const context = { ready: false };
  const m = new FinalMachine({ a: {}, b: {} }, 'a', context,
    [{ from: 'a', to: 'b', always: true, guard: c => c.ready }]);
  context.ready = true;
  assert.equal(m.send('check'), false);
  assert.equal(m.state, 'b');
});
