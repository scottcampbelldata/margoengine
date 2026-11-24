// Pins restoreMachine's checks one fault at a time (trace.test.js mixes several), and MachineTrace's default capacity,
// clear after the ring wrapped, and a second dispose that must not detach a newer trace.
import test from 'node:test';
import assert from 'node:assert/strict';
import { StateMachine } from '../dist/index.js';
import { ParallelRegions } from '../dist/parallel.js';
import { MachineTrace, restoreMachine, snapshotMachine } from '../dist/trace.js';

const build = () => {
  const regions = new ParallelRegions(
    { legs: { states: { stand: {}, walk: {} }, initial: 'stand', transitions: [{ from: 'stand', to: 'walk', event: 'move' }] } },
    {},
  );
  return new StateMachine(
    {
      alive: { history: 'shallow', initial: 'calm' },
      calm: { parent: 'alive' },
      busy: { ...regions.asState(), parent: 'alive' },
      dead: {},
    },
    'alive',
    {},
    [
      { from: 'calm', to: 'busy', event: 'go' },
      { from: 'alive', to: 'dead', event: 'die' },
      { from: 'dead', to: 'alive', after: 3 },
      { from: 'alive', to: 'calm', after: 5 },
    ],
  );
};
const copy = (value) => JSON.parse(JSON.stringify(value));

test('each kind of bad snapshot field is refused on its own, and the good one is taken', () => {
  const machine = build();
  machine.send('go');
  machine.update(1);
  const good = copy(snapshotMachine(machine));
  assert.deepEqual(good.entered, [['alive', 0], ['busy', 0]]);
  const legs = good.regions[0][1];
  const cases = {
    'entered not a list': [{ ...good, entered: {} }, /are lists/],
    'memory not a list': [{ ...good, memory: {} }, /are lists/],
    'regions not a list': [{ ...good, regions: {} }, /are lists/],
    'an entry off the active path': [{ ...good, entered: [['alive', 0], ['dead', 0]] }, /bad entry for dead/],
    'an entry time that is not a time': [{ ...good, entered: [['alive', 0], ['busy', -1]] }, /bad entry for busy/],
    'an entry after the clock': [{ ...good, entered: [['alive', 0], ['busy', 2]] }, /bad entry for busy/],
    'waits not a list': [{ ...good, waits: {} }, /waits is a list/],
    'a wait for an event transition': [{ ...good, waits: [[0, 0]] }, /bad wait for transition 0/],
    'a wait for no transition': [{ ...good, waits: [[9, 0]] }, /bad wait for transition 9/],
    'a wait time that is not a time': [{ ...good, waits: [[3, -1]] }, /bad wait for transition 3/],
    'a wait after the clock': [{ ...good, waits: [[3, 2]] }, /bad wait for transition 3/],
    'memory of an unknown state': [{ ...good, memory: [['nowhere', 'calm']] }, /nowhere cannot remember calm/],
    'memory of an unknown child': [{ ...good, memory: [['alive', 'nowhere']] }, /alive cannot remember nowhere/],
    'memory of a state that is not below it': [{ ...good, memory: [['alive', 'dead']] }, /alive cannot remember dead/],
    'memory of itself': [{ ...good, memory: [['alive', 'alive']] }, /alive cannot remember alive/],
    'regions of another state': [{ ...good, regions: [['calm', legs]] }, /other regions than state busy/],
    'too few region machines': [{ ...good, regions: [['busy', { ...legs, machines: [] }]] }, /other regions than state busy/],
    'too few region starts': [{ ...good, regions: [['busy', { ...legs, starts: [] }]] }, /other regions than state busy/],
  };
  const before = JSON.stringify(snapshotMachine(machine));
  for (const [what, [snapshot, message]] of Object.entries(cases)) {
    assert.throws(() => restoreMachine(machine, snapshot), (e) => e instanceof TypeError && message.test(e.message), what);
    assert.equal(JSON.stringify(snapshotMachine(machine)), before, what);
  }
  const fresh = build();
  restoreMachine(fresh, { ...good, waits: [[3, 1]], memory: [['alive', 'busy']] });
  assert.deepEqual([fresh.state, [...fresh.waits], [...fresh.memory]], ['busy', [[3, 1]], [['alive', 'busy']]]);
});

test('a trace keeps 256 records by default, and clear after the ring wrapped starts again from the oldest slot', () => {
  const m = new StateMachine({ a: {}, b: {} }, 'a', {}, [
    { from: 'a', to: 'b', event: 'go' },
    { from: 'b', to: 'a', event: 'go' },
  ]);
  using trace = new MachineTrace(m);
  for (let i = 0; i < 300; i++) m.send('go');
  assert.equal(trace.records.length, 256);
  trace.clear();
  assert.deepEqual(trace.records, []);
  for (let i = 0; i < 3; i++) m.send('go');
  assert.deepEqual(trace.records.map((r) => r.from), ['a', 'b', 'a']);
  const small = new StateMachine({ a: {}, b: {} }, 'a', {}, [
    { from: 'a', to: 'b', event: 'go' },
    { from: 'b', to: 'a', event: 'go' },
  ]);
  using ring = new MachineTrace(small, { capacity: 2 });
  for (let i = 0; i < 3; i++) small.send('go'); // wraps: next slot is 1
  ring.clear();
  for (let i = 0; i < 3; i++) small.send('go');
  assert.deepEqual(ring.records.map((r) => r.from), ['a', 'b']);
});

test('disposing a trace again does not detach a newer trace on the same machine', () => {
  const m = new StateMachine({ a: {}, b: {} }, 'a', {}, [{ from: 'a', to: 'b', event: 'go' }]);
  const first = new MachineTrace(m);
  first.dispose();
  using second = new MachineTrace(m);
  first.dispose();
  m.send('go');
  assert.equal(second.records.length, 1);
});
