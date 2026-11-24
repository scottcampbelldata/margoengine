import test from 'node:test';
import assert from 'node:assert/strict';
import { Schedule } from '../dist/schedule.js';
import { Schedule as RootSchedule } from '../dist/index.js';

const recorder = () => {
  const log = [];
  return { log, system: (name) => () => log.push(name) };
};

test('the root entry exports the same Schedule', () => {
  assert.equal(RootSchedule, Schedule);
});

test('before and after order systems, ties keep the order of add, and forward names resolve', () => {
  const { log, system } = recorder();
  const schedule = new Schedule()
    .add('render', system('render'), { after: ['move'] })
    .add('input', system('input'), { before: ['move'] })
    .add('move', system('move'))
    .add('audio', system('audio'));
  assert.deepEqual(schedule.order(), ['input', 'move', 'render', 'audio']);
  schedule.update(0);
  assert.deepEqual(log, ['input', 'move', 'render', 'audio']);
});

test('a cycle, a missing name and a frame system before a fixed one are refused by name', () => {
  const noop = () => {};
  const state = (pattern) => (error) => error.code === 'state' && pattern.test(error.message);
  const cycle = new Schedule().add('a', noop, { after: ['b'] }).add('b', noop, { after: ['a'] }).add('c', noop);
  assert.throws(() => cycle.update(0), state(/cycle among a, b/));
  const missing = new Schedule().add('a', noop, { after: ['ghost'] });
  assert.throws(() => missing.order(), state(/ghost/));
  const late = new Schedule().add('draw', noop, { before: ['physics'] }).add('physics', noop, { fixed: true });
  assert.throws(() => late.order(), state(/fixed phase runs first/));
  const fine = new Schedule().add('draw', noop, { after: ['physics'] }).add('physics', noop, { fixed: true });
  assert.deepEqual(fine.order(), ['physics', 'draw']);
});

test('fixed systems run once per step the time pays for, with the remainder carried over', () => {
  const seen = [];
  const schedule = new Schedule({ step: 0.25 })
    .add('physics', (time) => seen.push(['physics', time.delta, time.elapsed, time.tick, time.fixed, time.alpha]), {
      fixed: true,
    })
    .add('draw', (time) => seen.push(['draw', time.delta, time.elapsed, time.tick, time.fixed, time.alpha]));
  assert.equal(schedule.update(0.125), 0);
  assert.equal(schedule.update(0.625), 3);
  assert.deepEqual(seen, [
    ['draw', 0.125, 0.125, 1, false, 0.5],
    ['physics', 0.25, 0.25, 1, true, 0],
    ['physics', 0.25, 0.5, 2, true, 0],
    ['physics', 0.25, 0.75, 3, true, 0],
    ['draw', 0.625, 0.75, 2, false, 0],
  ]);
});

test('a stall runs at most maxSteps and drops the rest instead of snowballing', () => {
  let steps = 0;
  const schedule = new Schedule({ step: 0.25, maxSteps: 2 }).add('physics', () => steps++, { fixed: true });
  assert.equal(schedule.update(1.375), 2);
  assert.equal(steps, 2);
  assert.equal(schedule.dropped, 0.75);
  assert.equal(schedule.update(0.125), 1);
  assert.equal(schedule.dropped, 0);
});

test('run conditions are asked on every run and pass a system over without stopping the others', () => {
  const { log, system } = recorder();
  let paused = false;
  const asked = [];
  const schedule = new Schedule({ step: 1 })
    .add('tick', system('tick'), {
      fixed: true,
      when: (time) => {
        asked.push(time.tick);
        return time.tick !== 2;
      },
    })
    .add('move', system('move'), { when: () => !paused })
    .add('draw', system('draw'));
  schedule.update(3);
  assert.deepEqual(asked, [1, 2, 3]);
  assert.deepEqual(log, ['tick', 'tick', 'move', 'draw']);
  log.length = 0;
  paused = true;
  schedule.update(0);
  assert.deepEqual(log, ['draw']);
});

test('a removal during an update applies at once, an add from the next update', () => {
  const { log, system } = recorder();
  const schedule = new Schedule();
  schedule.add('first', () => {
    log.push('first');
    if (!schedule.has('late')) schedule.add('late', system('late'));
    schedule.remove('second');
  });
  schedule.add('second', system('second'));
  schedule.update(0);
  assert.deepEqual(log, ['first']);
  schedule.update(0);
  assert.deepEqual(log, ['first', 'first', 'late']);
  assert.equal(schedule.remove('second'), false);
});

test('an error from a system reaches the caller, the step is not repeated and the schedule stays usable', () => {
  const ticks = [];
  let fail = true;
  const schedule = new Schedule({ step: 1 }).add(
    'physics',
    (time) => {
      ticks.push(time.tick);
      if (fail) throw new Error('boom');
    },
    { fixed: true },
  );
  assert.throws(() => schedule.update(2), /boom/);
  fail = false;
  assert.equal(schedule.update(0), 1);
  assert.deepEqual(ticks, [1, 2]);
});

test('update from inside a system is refused', () => {
  const schedule = new Schedule();
  schedule.add('again', () => schedule.update(0));
  assert.throws(
    () => schedule.update(0),
    (error) => error.code === 'state' && /already updating/.test(error.message),
  );
});

test('bad settings and arguments say what to pass', () => {
  const fixes = (Class) => (error) => error instanceof Class && /;/.test(error.message);
  for (const step of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
    assert.throws(() => new Schedule({ step }), fixes(RangeError));
  for (const maxSteps of [0, 1.5]) assert.throws(() => new Schedule({ maxSteps }), fixes(RangeError));
  const noop = () => {};
  const schedule = new Schedule().add('a', noop);
  assert.throws(() => schedule.add('', noop), fixes(TypeError));
  assert.throws(() => schedule.add('a', noop), fixes(TypeError));
  assert.throws(() => schedule.add('b', 1), fixes(TypeError));
  assert.throws(() => schedule.add('b', noop, { when: true }), fixes(TypeError));
  assert.throws(() => schedule.add('b', noop, { after: 'a' }), fixes(TypeError));
  for (const delta of [-1, Number.NaN, Number.POSITIVE_INFINITY])
    assert.throws(() => schedule.update(delta), fixes(RangeError));
});
