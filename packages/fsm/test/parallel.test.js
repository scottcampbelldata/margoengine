import test from 'node:test';
import assert from 'node:assert/strict';
import { StateMachine } from '../dist/index.js';
import { ParallelRegions } from '../dist/parallel.js';

const hooks = (log, name) => ({ enter: () => log.push(`${name}+`), exit: () => log.push(`${name}-`) });

function player(log = [], options) {
  return new ParallelRegions(
    {
      movement: {
        states: { idle: hooks(log, 'idle'), run: hooks(log, 'run') },
        initial: 'idle',
        transitions: [
          { from: 'idle', to: 'run', event: 'move' },
          { from: 'run', to: 'idle', event: 'halt' },
        ],
      },
      weapon: {
        states: { ready: hooks(log, 'ready'), firing: hooks(log, 'firing') },
        initial: 'ready',
        transitions: [
          { from: 'ready', to: 'firing', event: 'fire' },
          { from: 'firing', to: 'ready', event: 'halt' },
        ],
      },
    },
    {},
    options,
  );
}

test('regions run at once and each takes only its own events', () => {
  const regions = player();
  assert.deepEqual(regions.active, { movement: null, weapon: null });
  regions.start();
  assert.deepEqual(regions.active, { movement: 'idle', weapon: 'ready' });
  assert.equal(regions.send('fire'), true);
  assert.deepEqual(regions.active, { movement: 'idle', weapon: 'firing' });
  assert.equal(regions.send('move'), true);
  assert.deepEqual(regions.active, { movement: 'run', weapon: 'firing' });
  assert.equal(regions.send('nothing'), false);
  // One event moves both.
  assert.equal(regions.send('halt'), true);
  assert.deepEqual(regions.active, { movement: 'idle', weapon: 'ready' });
});

test('regions enter in order and leave in reverse, each innermost first', () => {
  const log = [],
    regions = player(log);
  regions.start();
  assert.deepEqual(log, ['idle+', 'ready+']);
  log.length = 0;
  regions.stop();
  assert.deepEqual(log, ['ready-', 'idle-']);
  assert.equal(regions.running, false);
});

test('all regions choose before any moves, so region order cannot change the result', () => {
  const build = (order) => {
    const defs = {
      a: {
        states: { off: {}, on: {} },
        initial: 'off',
        transitions: [{ from: 'off', to: 'on', event: 'go', guard: () => !regions.matches('b', 'on') }],
      },
      b: {
        states: { off: {}, on: {} },
        initial: 'off',
        transitions: [{ from: 'off', to: 'on', event: 'go', guard: () => !regions.matches('a', 'on') }],
      },
    };
    const regions = new ParallelRegions(Object.fromEntries(order.map((name) => [name, defs[name]])), {});
    regions.start();
    regions.send('go');
    return { a: regions.active.a, b: regions.active.b };
  };
  // Both guards see both regions off, so both move; delivered one at a time, the second would stay.
  assert.deepEqual(build(['a', 'b']), { a: 'on', b: 'on' });
  assert.deepEqual(build(['b', 'a']), { a: 'on', b: 'on' });
});

test('inside a machine: entering starts the regions, leaving stops them, and regions take an event first', () => {
  const log = [],
    regions = player(log),
    machine = new StateMachine(
      { game: {}, alive: { ...regions.asState(), parent: 'game' }, dead: { parent: 'game', ...hooks(log, 'dead') } },
      'alive',
      {},
      [
        { from: 'alive', to: 'dead', event: 'die' },
        { from: 'alive', to: 'dead', event: 'fire' },
        { from: 'dead', to: 'alive', event: 'respawn' },
      ],
    );
  assert.equal(regions.running, true);
  // The weapon region takes fire, so the outer transition on the same event does not run.
  machine.send('fire');
  assert.equal(machine.state, 'alive');
  assert.equal(regions.active.weapon, 'firing');
  // Now no region takes fire: the outer transition is the default.
  machine.send('fire');
  assert.equal(machine.state, 'dead');
  assert.equal(regions.running, false);
  assert.deepEqual(log.slice(-3), ['firing-', 'idle-', 'dead+']);
  machine.send('respawn');
  assert.deepEqual(regions.active, { movement: 'idle', weapon: 'ready' });
});

test('update reaches every region with the same delta, and through an outer machine', () => {
  const seen = [],
    tick = (name) => ({ update: (_c, delta) => seen.push([name, delta]) }),
    regions = new ParallelRegions(
      { a: { states: { x: tick('a') }, initial: 'x' }, b: { states: { y: tick('b') }, initial: 'y' } },
      {},
    ),
    machine = new StateMachine({ both: regions.asState() }, 'both', {});
  machine.update(0.5);
  assert.deepEqual(seen, [
    ['a', 0.5],
    ['b', 0.5],
  ]);
});

test('regions nest: a region holds a state that has regions of its own', () => {
  const inner = new ParallelRegions(
      {
        left: { states: { l0: {}, l1: {} }, initial: 'l0', transitions: [{ from: 'l0', to: 'l1', event: 'go' }] },
        right: { states: { r0: {}, r1: {} }, initial: 'r0', transitions: [{ from: 'r0', to: 'r1', event: 'go' }] },
      },
      {},
    ),
    outer = new ParallelRegions(
      {
        one: {
          states: { deep: inner.asState(), flat: {} },
          initial: 'deep',
          transitions: [{ from: 'deep', to: 'flat', event: 'leave' }],
        },
        two: { states: { z0: {}, z1: {} }, initial: 'z0', transitions: [{ from: 'z0', to: 'z1', event: 'go' }] },
      },
      {},
    );
  outer.start();
  assert.equal(outer.send('go'), true);
  assert.deepEqual(inner.active, { left: 'l1', right: 'r1' });
  assert.equal(outer.active.two, 'z1');
  outer.send('leave');
  assert.equal(inner.running, false);
  assert.equal(outer.active.one, 'flat');
});

test('raise waits for the running delivery, keeps order, and send from a hook is refused', () => {
  const log = [];
  const regions = new ParallelRegions(
    {
      a: {
        states: {
          a0: {},
          a1: {
            enter: () => {
              regions.raise('first');
              regions.raise('second');
              log.push('a1 entered');
            },
          },
        },
        initial: 'a0',
        transitions: [{ from: 'a0', to: 'a1', event: 'go' }],
      },
      b: {
        states: {
          b0: { exit: () => log.push(`b0 left, a is ${regions.active.a}`) },
          b1: { enter: () => log.push('b1'), exit: () => log.push('b1 left') },
          b2: { enter: () => log.push('b2') },
        },
        initial: 'b0',
        transitions: [
          { from: 'b0', to: 'b1', event: 'go' },
          { from: 'b1', to: 'b2', event: 'second' },
          { from: 'b0', to: 'b2', event: 'first' },
        ],
      },
    },
    {},
  );
  regions.start();
  regions.send('go');
  // b finishes go before first is delivered; first finds b in b1, where it means nothing, then second moves it.
  assert.deepEqual(log, ['a1 entered', 'b0 left, a is a1', 'b1', 'b1 left', 'b2']);
  const refusing = new ParallelRegions(
    {
      a: {
        states: { a0: {}, a1: { enter: () => refusing.send('other') } },
        initial: 'a0',
        transitions: [{ from: 'a0', to: 'a1', event: 'go' }],
      },
    },
    {},
  );
  refusing.start();
  assert.throws(() => refusing.send('go'), { name: 'MargoError', code: 'state' });
});

test('a raised event no region takes goes to forward, which can leave the regions', () => {
  const regions = new ParallelRegions(
      {
        health: {
          states: { fine: {}, zero: { enter: () => regions.raise('died') } },
          initial: 'fine',
          transitions: [{ from: 'fine', to: 'zero', event: 'hit' }],
        },
      },
      {},
      { forward: (event) => machine.send(event) },
    ),
    machine = new StateMachine({ alive: regions.asState(), dead: {} }, 'alive', {}, [
      { from: 'alive', to: 'dead', event: 'died' },
    ]);
  machine.send('hit');
  assert.equal(machine.state, 'dead');
  assert.equal(regions.running, false);
});

test('hooks that raise each other for ever end in an error, and the regions can go on', () => {
  const regions = new ParallelRegions(
    {
      a: {
        states: { a0: { enter: () => regions.raise('flip') }, a1: { enter: () => regions.raise('flip') }, rest: {} },
        initial: 'rest',
        transitions: [
          { from: 'rest', to: 'a0', event: 'go' },
          { from: 'a0', to: 'a1', event: 'flip' },
          { from: 'a1', to: 'a0', event: 'flip' },
          { from: 'a0', to: 'rest', event: 'stop' },
          { from: 'a1', to: 'rest', event: 'stop' },
        ],
      },
    },
    {},
  );
  regions.start();
  assert.throws(() => regions.send('go'), { name: 'MargoError', code: 'state', message: /for ever/ });
  regions.send('stop');
  assert.equal(regions.active.a, 'rest');
});

test('a hook that throws leaves no raised event behind', () => {
  const regions = new ParallelRegions(
    {
      a: {
        states: {
          a0: {},
          a1: {
            enter: () => {
              regions.raise('next');
              throw new Error('boom');
            },
          },
          a2: {},
        },
        initial: 'a0',
        transitions: [
          { from: 'a0', to: 'a1', event: 'go' },
          { from: 'a1', to: 'a2', event: 'next' },
        ],
      },
    },
    {},
  );
  regions.start();
  assert.throws(() => regions.send('go'), /boom/);
  regions.raise('other');
  assert.equal(regions.active.a, 'a1');
});

test('with history, regions resume where they stopped; without it, at initial', () => {
  for (const [history, expected] of [
    [true, { movement: 'run', weapon: 'firing' }],
    [false, { movement: 'idle', weapon: 'ready' }],
  ]) {
    const regions = player([], { history });
    regions.start();
    regions.send('move');
    regions.send('fire');
    regions.stop();
    regions.start();
    assert.deepEqual(regions.active, expected);
  }
});

test('misuse is refused with a clear error', () => {
  assert.throws(() => new ParallelRegions({}, {}), TypeError);
  assert.throws(() => new ParallelRegions({ a: { states: { x: {} }, initial: 'y' } }, {}), /Unknown initial/);
  assert.throws(
    () =>
      new ParallelRegions(
        { a: { states: { x: {} }, initial: 'x', transitions: [{ from: 'x', to: 'y', event: 'e' }] } },
        {},
      ),
    TypeError,
  );
  const regions = player();
  for (const call of [
    () => regions.send('move'),
    () => regions.update(0),
    () => regions.raise('move'),
    () => regions.stop(),
  ])
    assert.throws(call, { name: 'MargoError', code: 'state' });
  regions.start();
  assert.throws(() => regions.start(), { name: 'MargoError', code: 'state' });
  assert.throws(() => regions.matches('nowhere', 'idle'), RangeError);
  assert.throws(() => regions.update(-1), RangeError);
});

test('a seeded run of regions equals each region run alone, when no guard links them', () => {
  let seed = 12345;
  const next = (limit) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % limit;
  const events = ['a', 'b', 'c', 'd'];
  for (let round = 0; round < 50; round++) {
    const defs = {};
    for (const region of ['r0', 'r1', 'r2']) {
      const names = ['p', 'q', 'r', 's'],
        transitions = [];
      for (const from of names)
        for (const event of events)
          if (next(2)) transitions.push({ from, to: names[next(4)], event, duration: next(2) * 0.1 });
      defs[region] = { states: Object.fromEntries(names.map((n) => [n, {}])), initial: 'p', transitions };
    }
    const regions = new ParallelRegions(defs, {}),
      alone = Object.fromEntries(
        Object.entries(defs).map(([k, d]) => [k, new StateMachine(d.states, d.initial, {}, d.transitions)]),
      );
    regions.start();
    for (let step = 0; step < 100; step++) {
      const event = events[next(4)],
        took = regions.send(event);
      let any = false;
      for (const machine of Object.values(alone)) any = machine.send(event) || any;
      assert.equal(took, any);
      assert.deepEqual(
        regions.active,
        Object.fromEntries(Object.entries(alone).map(([name, machine]) => [name, machine.state])),
      );
    }
  }
});
