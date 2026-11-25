// Pins FinalMachine where the older tests leave it open: each refused final state, the run-to-completion settle (one
// onStable per public call, re-entrant sends from a hook), goto's default, update's delta check, the delayed
// transition order and guards, and the two runaway limits on their exact boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FinalMachine } from '../dist/final.js';

const refused = (fn, what) => assert.throws(fn, TypeError, what);

test('a final state with initial, regions, a child or an outgoing transition is refused; a plain leaf is not', () => {
  refused(() => new FinalMachine({ s: { final: true, initial: 'c' }, c: { parent: 's' } }, 'c', {}), 'initial');
  refused(() => new FinalMachine({ s: { final: true, regions: {} }, t: {} }, 't', {}), 'regions');
  refused(() => new FinalMachine({ s: { final: true }, c: { parent: 's' } }, 'c', {}), 'a child');
  refused(
    () => new FinalMachine({ s: { final: true }, t: {} }, 't', {}, [{ from: 's', to: 't', event: 'go' }]),
    'a transition',
  );
  refused(() => new FinalMachine({ s: { final: 1 }, t: {} }, 't', {}), 'a final flag that is not boolean');
  const m = new FinalMachine({ s: { final: true }, t: {} }, 't', {}, [{ from: 't', to: 's', event: 'go' }]);
  assert.equal(m.send('go'), true);
  assert.equal(m.done, true);
});

class Counted extends FinalMachine {
  stable = 0;
  onStable() {
    this.stable++;
  }
}

test('every public call reaches one stable point: onStable once per send, none for an event refused when done', () => {
  const m = new Counted({ a: {}, b: {}, end: { final: true } }, 'a', {}, [
    { from: 'a', to: 'b', event: 'go' },
    { from: 'b', to: 'end', event: 'stop' },
  ]);
  assert.equal(m.stable, 0);
  assert.equal(m.send('go'), true);
  assert.equal(m.stable, 1, 'a taken event');
  assert.equal(m.send('nothing'), false);
  assert.equal(m.stable, 2, 'a refused event still settles once');
  m.send('stop');
  assert.equal([m.done, m.stable].join(), 'true,3');
  assert.equal(m.send('go'), false);
  assert.equal(m.stable, 3, 'a done machine takes no event and does not settle again');
});

test('a hook that sends while eventless transitions settle does not settle again inside them', () => {
  // f is entered by an eventless step; its hook sends an event nobody takes. The completion of p must be delivered by
  // the settle already running, after the hook, not by a second settle started inside the hook.
  let m;
  m = new FinalMachine(
    {
      x: {},
      p: { initial: 'a' },
      a: { parent: 'p' },
      f: { parent: 'p', final: true, enter: () => m.send('noop') },
      out: {},
    },
    'x',
    {},
    [
      { from: 'x', to: 'p', event: 'go' },
      { from: 'a', to: 'f', always: true },
      { from: 'p', to: 'out', event: 'done.state.p' },
    ],
  );
  m.send('go');
  assert.equal(m.state, 'out');
});

test('goto has no cross-fade by default; update refuses a negative or non-finite delta', () => {
  const m = new FinalMachine({ a: {}, b: {} }, 'a', {});
  m.goto('b');
  assert.deepEqual([m.state, m.previous, m.duration, m.blend], ['b', null, 0, 1]);
  m.goto('a', 0.5);
  assert.deepEqual([m.previous, m.duration], ['b', 0.5]);
  for (const delta of [-1, -Number.MIN_VALUE, NaN, Infinity, -Infinity])
    assert.throws(() => m.update(delta), RangeError);
  m.update(0);
  assert.equal(m.state, 'a');
  const done = new FinalMachine({ end: { final: true } }, 'end', {});
  assert.equal(done.done, true);
  for (const delta of [-1, NaN])
    assert.throws(() => done.update(delta), RangeError, 'a done machine still checks delta');
});

test('delays: the leaf wins over its parent, a parent delay into its own child re-arms, and a guard runs again', () => {
  const order = new FinalMachine({ p: { initial: 'c' }, c: { parent: 'p' }, x: {}, y: {} }, 'p', {}, [
    { from: 'p', to: 'x', after: 1 },
    { from: 'c', to: 'y', after: 1 },
  ]);
  order.update(1);
  assert.equal(order.state, 'y');
  // The parent's delay moves nowhere (c is already where p's initial goes) but its guard opens the leaf's: the leaf
  // delay, due at the same time, is taken in the same update.
  let open = false;
  const flip = new FinalMachine({ p: { initial: 'c' }, c: { parent: 'p' }, x: {} }, 'p', {}, [
    { from: 'c', to: 'x', after: 1, guard: () => open },
    { from: 'p', to: 'c', after: 1, guard: () => (open = true) },
  ]);
  flip.update(1);
  assert.equal(flip.state, 'x');
});

test('a due delay held by its guard does not stop time for the rest of the update', { timeout: 10000 }, () => {
  let open = false;
  const m = new FinalMachine({ a: {}, b: {}, c: {} }, 'a', {}, [
    { from: 'a', to: 'b', after: 1, guard: () => open },
    { from: 'a', to: 'c', after: 3 },
  ]);
  m.update(2);
  assert.deepEqual([m.state, m.clock], ['a', 2]);
  m.update(2);
  assert.deepEqual([m.state, m.clock], ['c', 4]);
});

test('runaway limits: 100,000 delayed transitions in one update are allowed, one more throws; 9,999 eventless settle', () => {
  const pingPong = () =>
    new FinalMachine({ a: {}, b: {} }, 'a', {}, [
      { from: 'a', to: 'b', after: 1 },
      { from: 'b', to: 'a', after: 1 },
    ]);
  const fine = pingPong();
  fine.update(100000);
  assert.deepEqual([fine.state, fine.clock], ['a', 100000]);
  assert.throws(
    () => pingPong().update(100001),
    (e) => e.code === 'state' && /delayed/.test(e.message),
  );
  const cycle = (n) => {
    let count = 0;
    const guard = () => count++ < n;
    return () =>
      new FinalMachine({ a: {}, b: {} }, 'a', {}, [
        { from: 'a', to: 'b', always: true, guard },
        { from: 'b', to: 'a', always: true, guard },
      ]);
  };
  assert.equal(cycle(9999)().state, 'b');
  assert.throws(cycle(10000), (e) => e.code === 'state' && /settle/.test(e.message));
});
