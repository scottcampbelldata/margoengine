// Pins StateMachine where pins.test.js leaves it open: the starting timers, blend outside a running cross-fade, no
// cross-fade unless one is asked for (send, delays, goto), a re-entered state's delay counting from the new entry,
// the clock as the plain sum of the deltas, and the 100,000 delayed transition limit on its exact boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { StateMachine } from '../dist/index.js';

test('a new machine has no cross-fade and zero timers', () => {
  const m = new StateMachine({ a: {}, b: {} }, 'a', {});
  assert.deepEqual([m.previous, m.elapsed, m.clock, m.duration, m.blend], [null, 0, 0, 0, 1]);
});

test('blend stays in [0, 1] and is 1 with no state to fade from, whatever the public timers hold', () => {
  const m = new StateMachine({ a: {}, b: {} }, 'a', {});
  m.goto('b', 2);
  m.update(0.5);
  assert.equal(m.blend, 0.25);
  m.elapsed = 5; // set by hand past the end; previous is cleared only by update
  assert.equal(m.blend, 1);
  m.elapsed = 0.5;
  m.previous = null;
  assert.equal(m.blend, 1);
});

test('send, a delay and goto change state with no cross-fade unless the transition or call gives one', () => {
  const m = new StateMachine({ a: {}, b: {}, c: {} }, 'a', {}, [
    { from: 'a', to: 'b', event: 'go' },
    { from: 'b', to: 'c', after: 1 },
  ]);
  m.send('go');
  assert.deepEqual([m.state, m.previous, m.duration], ['b', null, 0]);
  m.update(1);
  assert.deepEqual([m.state, m.previous, m.duration], ['c', null, 0]);
  m.goto('a');
  assert.deepEqual([m.state, m.previous, m.duration], ['a', null, 0]);
});

test('a delay re-armed by its own transition counts from a later re-entry of its state, not from the old re-arm', () => {
  const m = new StateMachine({ p: { initial: 'c' }, c: { parent: 'p' }, d: { parent: 'p' }, z: {} }, 'p', {}, [
    { from: 'p', to: 'd', after: 1 },
    { from: 'd', to: 'c', event: 'back' },
    { from: 'p', to: 'z', event: 'out' },
    { from: 'z', to: 'p', event: 'in' },
  ]);
  m.update(1); // p's delay fires at 1 and starts waiting again from 1
  assert.equal(m.state, 'd');
  m.send('back');
  m.send('out');
  m.update(0.5);
  m.send('in'); // p entered again at 1.5: its delay ends at 2.5
  m.update(0.5);
  assert.deepEqual([m.state, m.clock], ['c', 2]);
  m.update(0.5);
  assert.equal(m.state, 'd');
});

test('the clock is the floating-point sum of the deltas, even when a delay ends where rounding lands', () => {
  // 2^53 + 2 - 1 rounds to 2^53, the delta given; 1 + 2^53 rounds back to 2^53, so the delay has not ended.
  const m = new StateMachine({ a: {}, b: {} }, 'a', {}, [{ from: 'a', to: 'b', after: 2 ** 53 + 2 }]);
  m.update(1);
  m.update(2 ** 53);
  assert.deepEqual([m.clock, m.state], [1 + 2 ** 53, 'a']);
});

test('100,000 delayed transitions in one update are allowed and one more throws', () => {
  const pingPong = () => new StateMachine({ a: {}, b: {} }, 'a', {}, [
    { from: 'a', to: 'b', after: 1 },
    { from: 'b', to: 'a', after: 1 },
  ]);
  const m = pingPong();
  m.update(100000);
  assert.deepEqual([m.state, m.clock], ['a', 100000]);
  assert.throws(() => pingPong().update(100001), (e) => e.code === 'state' && /without end/.test(e.message));
});
