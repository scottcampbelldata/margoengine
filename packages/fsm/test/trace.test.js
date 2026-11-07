import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { StateMachine } from '../dist/index.js';
import { ParallelRegions } from '../dist/parallel.js';
import { loadMachine } from '../dist/document.js';
import { MachineTrace, restoreMachine, snapshotMachine } from '../dist/trace.js';
import { CHART_COUNT, chartDocument, makeChart, traceOf } from './outside/charts.mjs';

const build = (log = []) => {
  const regions = new ParallelRegions(
    {
      legs: {
        states: { stand: {}, walk: {} },
        initial: 'stand',
        transitions: [{ from: 'stand', to: 'walk', event: 'move' }],
      },
      arms: {
        states: { rest: {}, wave: {} },
        initial: 'rest',
        transitions: [{ from: 'rest', to: 'wave', after: 2 }],
      },
    },
    {},
    { history: true },
  );
  return new StateMachine(
    {
      alive: { history: 'deep', initial: 'calm' },
      calm: { parent: 'alive', enter: () => log.push('calm+'), exit: () => log.push('calm-') },
      busy: { ...regions.asState(), parent: 'alive' },
      dead: { enter: () => log.push('dead+') },
    },
    'alive',
    {},
    [
      { from: 'calm', to: 'busy', event: 'go', duration: 1 },
      { from: 'alive', to: 'dead', event: 'die' },
      { from: 'dead', to: 'alive', after: 3 },
    ],
  );
};
const roundTrip = (value) => JSON.parse(JSON.stringify(value));

test('a snapshot through JSON puts a fresh machine where the first one was, and it goes on the same', () => {
  const first = build();
  first.send('go');
  first.send('move');
  first.update(0.5);
  const saved = roundTrip(snapshotMachine(first)),
    log = [],
    second = build(log);
  log.length = 0;
  restoreMachine(second, saved);
  // No hook ran.
  assert.deepEqual(log, []);
  assert.deepEqual(roundTrip(snapshotMachine(second)), saved);
  assert.equal(second.state, 'busy');
  assert.equal(second.previous, 'calm');
  assert.equal(second.blend, 0.5);
  const regions = second.states.busy.regions;
  assert.equal(regions.running, true);
  assert.deepEqual(regions.active, { legs: 'walk', arms: 'rest' });
  // The delay of the arms goes on from 0.5 seconds.
  for (const machine of [first, second]) machine.update(1.5);
  assert.equal(regions.active.arms, 'wave');
  assert.deepEqual(roundTrip(snapshotMachine(second)), roundTrip(snapshotMachine(first)));
});

test('memory and stopped regions come back too', () => {
  const first = build();
  first.send('go');
  first.send('move');
  first.send('die');
  first.update(1);
  const second = build();
  restoreMachine(second, roundTrip(snapshotMachine(first)));
  assert.equal(second.states.busy.regions.running, false);
  second.update(2);
  // Home by deep history, and the regions by their own.
  assert.equal(second.state, 'busy');
  assert.deepEqual(second.states.busy.regions.active, { legs: 'walk', arms: 'rest' });
});

test('restore over a running machine takes it back in time, which is what rollback netcode needs', () => {
  const machine = build(),
    saved = snapshotMachine(machine);
  machine.send('go');
  machine.send('die');
  restoreMachine(machine, saved);
  assert.equal(machine.state, 'calm');
  assert.equal(machine.states.busy.regions.running, false);
  assert.equal(machine.memory.size, 0);
  machine.send('go');
  assert.equal(machine.state, 'busy');
});

test('a snapshot that does not fit is refused and the machine stays as it was', () => {
  const machine = build();
  machine.send('go');
  const good = roundTrip(snapshotMachine(machine)),
    before = JSON.stringify(snapshotMachine(machine));
  const bad = [
    { ...good, version: 2 },
    { ...good, state: 'nowhere' },
    { ...good, state: 'toString' },
    { ...good, previous: 'nowhere' },
    { ...good, elapsed: -1 },
    { ...good, clock: 'soon' },
    { ...good, entered: [] },
    { ...good, entered: good.entered.map(([name]) => [name, 99]) },
    { ...good, memory: [['alive', 'dead']] },
    { ...good, memory: [['alive', 'alive']] },
    { ...good, regions: [] },
    { ...good, regions: [['calm', good.regions[0][1]]] },
    { ...good, regions: [['busy', { ...good.regions[0][1], running: false }]] },
    { ...good, regions: [['busy', { ...good.regions[0][1], starts: ['stand', 'nowhere'] }]] },
    { ...good, regions: [['busy', { ...good.regions[0][1], machines: [] }]] },
  ];
  for (const snapshot of bad) {
    assert.throws(() => restoreMachine(machine, snapshot), TypeError, JSON.stringify(snapshot).slice(0, 80));
    assert.equal(JSON.stringify(snapshotMachine(machine)), before);
  }
  assert.throws(() => restoreMachine(machine, null), TypeError);
  // A bad nested region must not leave the outer machine written.
  const deep = roundTrip(good);
  deep.state = 'calm';
  deep.previous = null;
  assert.throws(() => restoreMachine(machine, deep), TypeError);
  assert.equal(JSON.stringify(snapshotMachine(machine)), before);
});

test('neither works from a hook in the middle of a change', () => {
  let checked = 0;
  const hook = () => {
    for (const run of [() => snapshotMachine(machine), () => restoreMachine(machine, saved)])
      assert.throws(run, { name: 'MargoError', code: 'state' });
    checked++;
  };
  const machine = new StateMachine({ a: {}, b: { enter: hook } }, 'a', {}),
    saved = snapshotMachine(machine);
  machine.goto('b');
  assert.equal(checked, 1);
});

test('the trace records changes in order, with what caused each, regions included', () => {
  const machine = build(),
    trace = new MachineTrace(machine);
  machine.send('go');
  machine.send('move');
  machine.update(2);
  machine.goto('dead');
  assert.deepEqual(trace.records, [
    { machine: '', clock: 0, from: 'calm', to: 'busy', event: 'go', after: null },
    { machine: 'busy/legs', clock: 0, from: null, to: 'stand', event: null, after: null },
    { machine: 'busy/arms', clock: 0, from: null, to: 'rest', event: null, after: null },
    { machine: 'busy/legs', clock: 0, from: 'stand', to: 'walk', event: 'move', after: null },
    { machine: 'busy/arms', clock: 2, from: 'rest', to: 'wave', event: null, after: 2 },
    { machine: '', clock: 2, from: 'busy', to: 'dead', event: null, after: null },
    { machine: 'busy/arms', clock: 2, from: 'wave', to: null, event: null, after: null },
    { machine: 'busy/legs', clock: 2, from: 'walk', to: null, event: null, after: null },
  ]);
  assert.equal(JSON.stringify(roundTrip(trace.records)), JSON.stringify(trace.records));
});

test('the trace keeps the newest records, oldest first, and stops on dispose', () => {
  const machine = new StateMachine({ a: {}, b: {} }, 'a', {});
  {
    using trace = new MachineTrace(machine, { capacity: 3 });
    for (let i = 0; i < 7; i++) machine.goto(i % 2 ? 'a' : 'b');
    // Seven changes end b, a, b, a, b, a, b: the last three stay.
    assert.deepEqual(
      trace.records.map(({ to }) => to),
      ['b', 'a', 'b'],
    );
    trace.clear();
    assert.deepEqual(trace.records, []);
  }
  assert.equal(machine.listener, null);
  const again = new MachineTrace(machine);
  assert.throws(() => new MachineTrace(machine), { name: 'MargoError', code: 'attached' });
  again.dispose();
  again.dispose();
  assert.throws(() => new MachineTrace(machine, { capacity: 0 }), RangeError);
  assert.throws(() => new MachineTrace(machine, { capacity: 1.5 }), RangeError);
});

test('a trace refused half way leaves no machine attached', () => {
  const machine = build(),
    legs = machine.states.busy.regions.machines.legs,
    taken = () => {};
  legs.listener = taken;
  assert.throws(() => new MachineTrace(machine), { name: 'MargoError', code: 'attached' });
  assert.equal(machine.listener, null);
  assert.equal(legs.listener, taken);
});

test('a no-op goto records nothing, and an untraced machine has no listener', () => {
  const machine = new StateMachine({ a: {} }, 'a', {}),
    trace = new MachineTrace(machine);
  machine.goto('a');
  assert.deepEqual(trace.records, []);
  trace.dispose();
  assert.equal(machine.listener, null);
});

test('every seeded chart, saved and restored into a new machine on every step, walks the states Sismic walked', () => {
  const traces = JSON.parse(readFileSync(new URL('outside/traces.json', import.meta.url), 'utf8'));
  assert.equal(traces.length, CHART_COUNT);
  traces.forEach((outside, index) => {
    const chart = makeChart(index + 1),
      { document, guards: names } = chartDocument(chart);
    const fresh = () => {
      const guards = {};
      let machine;
      for (const name of names) guards[`active ${name}`] = () => traceOf.active(machine, name);
      machine = loadMachine(document, {}, { guards });
      return machine;
    };
    let current = fresh();
    const walked = traceOf(current, chart, (machine) => {
      const next = fresh();
      restoreMachine(next, roundTrip(snapshotMachine(machine)));
      current = next;
      return next;
    });
    assert.deepEqual(walked, outside, `seed ${index + 1}`);
  });
});
