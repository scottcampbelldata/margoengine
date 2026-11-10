import test from 'node:test';
import assert from 'node:assert/strict';
import { StateMachine } from '../dist/index.js';
import { ParallelRegions } from '../dist/parallel.js';

const attack = () =>
  new StateMachine(
    {
      attack: {},
      windup: { parent: 'attack' },
      swing: { parent: 'attack' },
      recover: {},
      ready: {},
    },
    'windup',
    {},
    [
      { from: 'windup', to: 'swing', after: 0.25 },
      { from: 'attack', to: 'recover', after: 0.5 },
      { from: 'recover', to: 'ready', after: 0.25 },
    ],
  );

test('a delay fires by itself, exactly at its time, and not before', () => {
  const machine = attack();
  machine.update(0.124);
  assert.equal(machine.state, 'windup');
  machine.update(0.125);
  assert.equal(machine.state, 'windup');
  machine.update(0.001);
  assert.equal(machine.state, 'swing');
});

test('a parent keeps counting while its children change, and one long update runs the whole chain', () => {
  const machine = attack();
  machine.update(0.3);
  assert.equal(machine.state, 'swing');
  machine.update(0.2);
  assert.equal(machine.state, 'recover');
  const whole = attack();
  whole.update(10);
  assert.equal(whole.state, 'ready');
  assert.equal(whole.clock, 10);
});

test('a state entered inside an update counts from that moment, not the end of the frame', () => {
  const machine = attack();
  machine.update(0.6);
  assert.equal(machine.state, 'recover');
  assert.equal(machine.entered.get('recover'), 0.5);
  assert.equal(machine.elapsed.toFixed(9), '0.100000000');
  machine.update(0.15);
  assert.equal(machine.state, 'ready');
});

test('hooks get the pieces of a split delta, which add up, in the state that lived them', () => {
  const seen = [],
    tick = (name) => ({ update: (_c, delta) => seen.push([name, delta]) }),
    machine = new StateMachine({ a: tick('a'), b: tick('b') }, 'a', {}, [{ from: 'a', to: 'b', after: 0.25 }]);
  machine.update(1);
  assert.deepEqual(seen, [
    ['a', 0.25],
    ['b', 0.75],
  ]);
});

test('leaving cancels, and coming back starts the wait again', () => {
  const machine = new StateMachine({ wait: {}, away: {}, done: {} }, 'wait', {}, [
    { from: 'wait', to: 'done', after: 1 },
    { from: 'wait', to: 'away', event: 'leave' },
    { from: 'away', to: 'wait', event: 'back' },
  ]);
  machine.update(0.75);
  machine.send('leave');
  machine.update(5);
  assert.equal(machine.state, 'away');
  machine.send('back');
  machine.update(0.75);
  assert.equal(machine.state, 'wait');
  machine.update(0.25);
  assert.equal(machine.state, 'done');
});

test('a declined guard is asked again until it passes, and time does not stall for it', () => {
  let open = false;
  const machine = new StateMachine({ a: {}, b: {}, c: {} }, 'a', {}, [
    { from: 'a', to: 'b', after: 1, guard: () => open },
    { from: 'a', to: 'c', after: 3 },
  ]);
  machine.update(2);
  assert.equal(machine.state, 'a');
  assert.equal(machine.clock, 2);
  open = true;
  machine.update(0);
  assert.equal(machine.state, 'b');
  // Held to the end, the later delay wins at its own time.
  open = false;
  const held = new StateMachine({ a: {}, b: {}, c: {} }, 'a', {}, [
    { from: 'a', to: 'b', after: 1, guard: () => open },
    { from: 'a', to: 'c', after: 3 },
  ]);
  held.update(5);
  assert.equal(held.state, 'c');
  assert.equal(held.entered.get('c'), 3);
});

test('inner delays go first when they end together', () => {
  const machine = new StateMachine({ p: {}, a: { parent: 'p' }, b: { parent: 'p' }, out: {} }, 'a', {}, [
    { from: 'p', to: 'out', after: 1, guard: () => machine.state === 'a' },
    { from: 'a', to: 'b', after: 1 },
  ]);
  machine.update(1);
  assert.equal(machine.state, 'b');
});

test('a delay from a parent to its child waits again, and so one to the same state ends', () => {
  let looks = 0;
  const machine = new StateMachine(
    {
      patrol: { initial: 'walk' },
      walk: { parent: 'patrol' },
      look: { parent: 'patrol', enter: () => looks++ },
    },
    'patrol',
    {},
    [
      { from: 'patrol', to: 'look', after: 5 },
      { from: 'look', to: 'walk', after: 1 },
    ],
  );
  machine.update(16);
  assert.equal(looks, 3);
  const self = new StateMachine({ a: {} }, 'a', {}, [{ from: 'a', to: 'a', after: 1 }]);
  self.update(10);
  assert.equal(self.state, 'a');
});

test('a cross-fade on a delayed transition starts at the delay and carries the overshoot', () => {
  const machine = new StateMachine({ a: {}, b: {} }, 'a', {}, [{ from: 'a', to: 'b', after: 1, duration: 1 }]);
  machine.update(1.25);
  assert.equal(machine.previous, 'a');
  assert.equal(machine.blend, 0.25);
});

test('a loop of delays runs its time, and one that cannot end is an error, not a hang', () => {
  const loop = (after) =>
    new StateMachine({ a: {}, b: {} }, 'a', {}, [
      { from: 'a', to: 'b', after },
      { from: 'b', to: 'a', after },
    ]);
  const machine = loop(0.1);
  machine.update(1000.05);
  assert.equal(machine.state, 'a');
  assert.throws(() => loop(1e-9).update(1000), { name: 'MargoError', code: 'state' });
  assert.throws(() => loop(1e-30).update(1), { name: 'MargoError', code: 'state' });
});

test('one update ends where any split of it does, over seeded machines', () => {
  let seed = 2024;
  const next = (limit) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % limit;
  for (let round = 0; round < 200; round++) {
    const names = ['p', 'a', 'b', 'c', 'q', 'd', 'e'],
      states = { p: {}, a: { parent: 'p' }, b: { parent: 'p' }, c: { parent: 'p' }, q: {}, d: { parent: 'q' }, e: {} },
      transitions = names.map((from) => ({
        from,
        to: names[next(names.length)],
        // Sixteenths add up with no rounding, so the only difference left would be a real one.
        after: (1 + next(40)) / 16,
      }));
    const whole = new StateMachine(states, 'a', {}, transitions),
      pieces = new StateMachine(states, 'a', {}, transitions);
    whole.update(30);
    for (let left = 30 * 16; left > 0; ) {
      const step = Math.min(left, 1 + next(50));
      pieces.update(step / 16);
      left -= step;
    }
    assert.equal(pieces.state, whole.state);
    assert.equal(pieces.clock, whole.clock);
    assert.deepEqual([...pieces.entered], [...whole.entered]);
    // Thirds do not add up exactly: a delay on the very edge may land a frame apart, so the clock is the check here.
    const thirds = new StateMachine(states, 'a', {}, transitions);
    for (let i = 0; i < 90; i++) thirds.update(1 / 3);
    assert.ok(Math.abs(thirds.clock - 30) < 1e-9);
  }
});

test('a bad after or a transition with both triggers is refused', () => {
  const states = { a: {}, b: {} };
  for (const bad of [
    { from: 'a', to: 'b', after: 0 },
    { from: 'a', to: 'b', after: -1 },
    { from: 'a', to: 'b', after: Infinity },
    { from: 'a', to: 'b', after: Number.NaN },
    { from: 'a', to: 'b', after: 1, event: 'e' },
    { from: 'a', to: 'b' },
  ])
    assert.throws(() => new StateMachine(states, 'a', {}, [bad]), /Invalid transition/);
});

test('regions run their own delays, and a hook of one raising during an update waits for the update', () => {
  const log = [];
  const regions = new ParallelRegions(
    {
      fuse: {
        states: { lit: {}, gone: { enter: () => regions.raise('boom') } },
        initial: 'lit',
        transitions: [{ from: 'lit', to: 'gone', after: 2 }],
      },
      crowd: {
        states: { calm: { update: () => log.push(regions.active.fuse) }, panic: {} },
        initial: 'calm',
        transitions: [{ from: 'calm', to: 'panic', event: 'boom' }],
      },
    },
    {},
  );
  regions.start();
  regions.update(1);
  assert.deepEqual(regions.active, { fuse: 'lit', crowd: 'calm' });
  regions.update(1);
  // The crowd ran its update with the fuse gone, and only then heard the raise.
  assert.deepEqual(regions.active, { fuse: 'gone', crowd: 'panic' });
  assert.deepEqual(log, ['lit', 'gone']);
  regions.stop();
  regions.start();
  assert.equal(regions.active.fuse, 'lit');
  regions.update(1.5);
  assert.equal(regions.active.fuse, 'lit');
});

// Batch 132 audit: re-arming one delay used to restart every delay of the same state, so the 2.5 s one never came.
const rearmStates = { S: { initial: 'a' }, a: { parent: 'S' }, T: {} };
const rearmTransitions = () => [
  { from: 'S', to: 'a', after: 1 },
  { from: 'S', to: 'T', after: 2.5 },
];
test('a delay that re-arms leaves the other delays of its state counting from entry', () => {
  const machine = new StateMachine(rearmStates, 'S', {}, rearmTransitions());
  for (let i = 0; i < 24; i++) machine.update(0.1);
  assert.equal(machine.state, 'a');
  machine.update(0.1);
  assert.equal(machine.state, 'T');
  const once = new StateMachine(rearmStates, 'S', {}, rearmTransitions());
  once.update(4);
  assert.equal(once.state, 'T');
  assert.ok(Math.abs(once.elapsed - 1.5) < 1e-9);
});
test('a final machine re-arms one delay without restarting the others', async () => {
  const { FinalMachine } = await import('../dist/final.js');
  const machine = new FinalMachine(rearmStates, 'S', {}, rearmTransitions());
  machine.update(2.4);
  assert.equal(machine.state, 'a');
  machine.update(0.2);
  assert.equal(machine.state, 'T');
});
test('a snapshot keeps a re-armed wait, so a restored machine fires when the original does', async () => {
  const { snapshotMachine, restoreMachine } = await import('../dist/trace.js');
  const machine = new StateMachine(rearmStates, 'S', {}, rearmTransitions());
  machine.update(1.5);
  const saved = JSON.parse(JSON.stringify(snapshotMachine(machine)));
  assert.deepEqual(saved.waits, [[0, 1]]);
  const copy = new StateMachine(rearmStates, 'S', {}, rearmTransitions());
  restoreMachine(copy, saved);
  copy.update(0.4);
  machine.update(0.4);
  assert.equal(copy.clock, machine.clock);
  const before = copy.waits.get(0);
  copy.update(0.2);
  assert.equal(copy.waits.get(0), 2);
  assert.equal(before, 1);
  copy.update(0.5);
  assert.equal(copy.state, 'T');
  assert.throws(() => restoreMachine(copy, { ...saved, waits: [[1, 9]] }), /bad wait for transition 1/);
});
