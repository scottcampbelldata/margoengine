// Pins the StateMachine core, ParallelRegions, FinalMachine and EventMachine at the edges the older tests leave open:
// exact error types, hook order, delay boundaries, history memory, guard evaluation and counters.
import test from 'node:test';
import assert from 'node:assert/strict';
import { StateMachine } from '../dist/index.js';
import { ParallelRegions } from '../dist/parallel.js';
import { FinalMachine } from '../dist/final.js';
import { EventMachine } from '../dist/events.js';

const log = () => {
  const calls = [];
  const hook = (name) => ({ enter: () => calls.push(name + '+'), exit: () => calls.push(name + '-') });
  return { calls, hook };
};

test('constructor refuses each kind of bad definition with a TypeError', () => {
  const ok = { a: {}, b: {} };
  assert.throws(() => new StateMachine({ a: { parent: 'missing' } }, 'a', {}), TypeError);
  assert.throws(() => new StateMachine({ a: { parent: 'b' }, b: { parent: 'a' } }, 'a', {}), TypeError);
  assert.throws(() => new StateMachine({ a: { parent: 'a' } }, 'a', {}), TypeError);
  assert.throws(() => new StateMachine(ok, 'nope', {}), TypeError);
  assert.throws(() => new StateMachine({ a: { initial: 'a' } }, 'a', {}), TypeError, 'initial may not be itself');
  assert.throws(
    () => new StateMachine({ a: { initial: 'b' }, b: {} }, 'a', {}),
    TypeError,
    'initial must be a descendant',
  );
  assert.throws(() => new StateMachine({ a: { history: 'x' } }, 'a', {}), TypeError);
  new StateMachine({ a: { history: 'shallow' } }, 'a', {});
  new StateMachine({ a: { history: 'deep' } }, 'a', {});
  const bad = [
    { from: 'zzz', to: 'b', event: 'e' },
    { from: 'a', to: 'zzz', event: 'e' },
    { from: 'a', to: 'b' },
    { from: 'a', to: 'b', event: '' },
    { from: 'a', to: 'b', event: 'e', after: 1 },
    { from: 'a', to: 'b', after: 0 },
    { from: 'a', to: 'b', after: -1 },
    { from: 'a', to: 'b', after: Infinity },
    { from: 'a', to: 'b', after: NaN },
    { from: 'a', to: 'b', event: 'e', duration: -1 },
    { from: 'a', to: 'b', event: 'e', duration: Infinity },
    { from: 'a', to: 'b', event: 'e', duration: NaN },
  ];
  for (const t of bad) assert.throws(() => new StateMachine(ok, 'a', {}, [t]), TypeError, JSON.stringify(t));
  new StateMachine(ok, 'a', {}, [{ from: 'a', to: 'b', event: 'e', duration: 0 }]);
  new StateMachine(ok, 'a', {}, [{ from: 'a', to: 'b', after: 0.5, duration: 2 }]);
});

test('entry runs outermost first through initial children, exit innermost first, only below the common ancestor', () => {
  const { calls, hook } = log();
  const m = new StateMachine(
    {
      root: { ...hook('root'), initial: 'one' },
      one: { ...hook('one'), parent: 'root' },
      two: { ...hook('two'), parent: 'root', initial: 'deep' },
      deep: { ...hook('deep'), parent: 'two' },
      other: hook('other'),
    },
    'root',
    {},
  );
  assert.deepEqual(calls, ['root+', 'one+']);
  assert.equal(m.state, 'one');
  assert.equal(m.entered.get('root'), 0);
  calls.length = 0;
  m.goto('two');
  assert.deepEqual(calls, ['one-', 'two+', 'deep+']);
  assert.equal(m.state, 'deep');
  assert.equal(m.matches('two'), true);
  assert.equal(m.matches('root'), true);
  assert.equal(m.matches('one'), false);
  calls.length = 0;
  m.goto('other');
  assert.deepEqual(calls, ['deep-', 'two-', 'root-', 'other+']);
  assert.equal(m.entered.has('root'), false);
  assert.equal(m.entered.has('other'), true);
  calls.length = 0;
  m.goto('other');
  assert.deepEqual(calls, []);
});

test('goto validates its arguments and refuses a change from inside a hook', () => {
  const m = new StateMachine({ a: {}, b: {} }, 'a', {});
  assert.throws(() => m.goto('zzz'), RangeError);
  assert.throws(() => m.goto('b', -1), RangeError);
  assert.throws(() => m.goto('b', NaN), RangeError);
  assert.throws(() => m.goto('b', Infinity), RangeError);
  assert.equal(m.state, 'a');
  m.goto('b', 0);
  assert.equal(m.previous, null);
  const inner = new StateMachine({ a: { exit: () => inner.goto('b') }, b: {} }, 'a', {});
  assert.throws(
    () => inner.goto('b'),
    (e) => e.code === 'state',
  );
  assert.equal(inner.changing, false);
  assert.equal(inner.state, 'a');
});

test('cross-fade: previous, duration, elapsed and blend', () => {
  const m = new StateMachine({ a: {}, b: {} }, 'a', {});
  assert.equal(m.blend, 1);
  m.goto('b', 2);
  assert.equal(m.previous, 'a');
  assert.equal(m.duration, 2);
  assert.equal(m.elapsed, 0);
  assert.equal(m.blend, 0);
  m.update(0.5);
  assert.equal(m.blend, 0.25);
  assert.equal(m.elapsed, 0.5);
  m.update(1.5);
  assert.equal(m.previous, null);
  assert.equal(m.blend, 1);
  m.goto('a', 4);
  m.update(3.9);
  assert.equal(m.previous, 'b');
  assert.ok(Math.abs(m.blend - 0.975) < 1e-12);
  m.update(0.1);
  assert.equal(m.previous, null);
  assert.equal(m.clock, 1.5 + 0.5 + 3.9 + 0.1 - 0);
});

test('send picks the innermost matching transition, honours guards, and plan does not move', () => {
  const guards = [];
  const m = new StateMachine(
    { root: { initial: 'leaf' }, leaf: { parent: 'root' }, x: {}, y: {} },
    'root',
    { open: true },
    [
      { from: 'root', to: 'x', event: 'go' },
      { from: 'leaf', to: 'y', event: 'go', guard: (c) => (guards.push(1), c.open) },
      { from: 'leaf', to: 'x', event: 'other' },
    ],
  );
  const action = m.plan('go');
  assert.equal(typeof action, 'function');
  assert.equal(m.state, 'leaf');
  assert.deepEqual(guards, [1]);
  action();
  assert.equal(m.state, 'y');
  const n = new StateMachine(
    { root: { initial: 'leaf' }, leaf: { parent: 'root' }, x: {}, y: {} },
    'root',
    { open: false },
    [
      { from: 'root', to: 'x', event: 'go' },
      { from: 'leaf', to: 'y', event: 'go', guard: (c) => c.open },
    ],
  );
  assert.equal(n.send('go'), true);
  assert.equal(n.state, 'x');
  assert.equal(n.send('go'), false);
  assert.equal(n.plan('nothing'), null);
  assert.equal(n.send('nothing'), false);
});

test('history: shallow returns to the remembered child, deep to the innermost, first visit uses initial', () => {
  const states = {
    work: { history: 'shallow', initial: 'a' },
    a: { parent: 'work', initial: 'a1' },
    a1: { parent: 'a' },
    a2: { parent: 'a' },
    b: { parent: 'work' },
    away: {},
  };
  const m = new StateMachine(states, 'work', {});
  assert.equal(m.state, 'a1');
  m.goto('a2');
  m.goto('b');
  m.goto('away');
  assert.equal(m.memory.get('work'), 'b');
  m.goto('work');
  assert.equal(m.state, 'b');
  assert.equal(m.memory.get('work'), 'b', 'memory stays until the state is left again');
  const deepStates = { ...states, work: { history: 'deep', initial: 'a' } };
  const d = new StateMachine(deepStates, 'work', {});
  d.goto('a2');
  d.goto('away');
  assert.equal(d.memory.get('work'), 'a2');
  d.goto('work');
  assert.equal(d.state, 'a2');
  // leaving the history state itself while it is the leaf forgets
  const solo = new StateMachine({ h: { history: 'shallow' }, o: {} }, 'h', {});
  solo.goto('o');
  assert.equal(solo.memory.has('h'), false);
  // a state already active goes on to its initial and ignores memory
  const act = new StateMachine(states, 'work', {});
  act.goto('b');
  act.goto('work');
  assert.equal(act.state, 'a1');
});

test('update validates delta, runs hooks outermost first with the delta, and stops after a hook changes state', () => {
  const m = new StateMachine({ a: {}, b: {} }, 'a', {});
  for (const bad of [-1, NaN, Infinity, -Infinity]) assert.throws(() => m.update(bad), RangeError);
  m.update(0);
  const seen = [];
  const n = new StateMachine(
    {
      root: { initial: 'leaf', update: (c, d) => seen.push(['root', d]) },
      leaf: { parent: 'root', update: (c, d) => seen.push(['leaf', d]) },
    },
    'root',
    {},
  );
  n.update(0.25);
  assert.deepEqual(seen, [
    ['root', 0.25],
    ['leaf', 0.25],
  ]);
  const stop = new StateMachine(
    {
      root: { initial: 'leaf', update: () => stop.goto('other') },
      leaf: { parent: 'root', update: () => seen.push('leaf!') },
      other: {},
    },
    'root',
    {},
  );
  seen.length = 0;
  stop.update(1);
  assert.deepEqual(seen, []);
  assert.equal(stop.state, 'other');
});

test('delayed transitions: boundary, splitting, re-arming, guards, innermost first, and the runaway limit', () => {
  const calls = [];
  const m = new StateMachine(
    {
      a: { update: (c, d) => calls.push(['a', +d.toFixed(9)]) },
      b: { update: (c, d) => calls.push(['b', +d.toFixed(9)]) },
    },
    'a',
    {},
    [{ from: 'a', to: 'b', after: 1 }],
  );
  m.update(0.5);
  assert.equal(m.state, 'a');
  m.update(0.5);
  assert.equal(m.state, 'b', 'a delay ending exactly at the end of the step fires');
  const s = new StateMachine(
    {
      a: { update: (c, d) => calls.push(['a2', +d.toFixed(9)]) },
      b: { update: (c, d) => calls.push(['b2', +d.toFixed(9)]) },
    },
    'a',
    {},
    [{ from: 'a', to: 'b', after: 1 }],
  );
  calls.length = 0;
  s.update(1.75);
  assert.deepEqual(calls, [
    ['a2', 1],
    ['b2', 0.75],
  ]);
  assert.equal(s.elapsed, 0.75);
  // guard that declines is asked again on every update
  let ok = false;
  const g = new StateMachine({ a: {}, b: {} }, 'a', {}, [{ from: 'a', to: 'b', after: 1, guard: () => ok }]);
  g.update(2);
  assert.equal(g.state, 'a');
  ok = true;
  g.update(0.001);
  assert.equal(g.state, 'b');
  // a self-loop on a parent re-arms and fires once per wait
  let fired = 0;
  const loop = new StateMachine(
    { p: { initial: 'c' }, c: { parent: 'p' }, q: { enter: () => fired++ }, d: {} },
    'p',
    {},
    [
      { from: 'p', to: 'q', after: 2 },
      { from: 'q', to: 'p', after: 1 },
    ],
  );
  loop.update(2);
  assert.equal(loop.state, 'q');
  loop.update(1);
  assert.equal(loop.state, 'c');
  loop.update(2);
  assert.equal(loop.state, 'q');
  assert.equal(fired, 2);
  // leaf delay beats parent delay when both are due
  const order = new StateMachine({ p: { initial: 'c' }, c: { parent: 'p' }, x: {}, y: {} }, 'p', {}, [
    { from: 'p', to: 'x', after: 1 },
    { from: 'c', to: 'y', after: 1 },
  ]);
  order.update(1);
  assert.equal(order.state, 'y');
  // a zero-gap ping-pong trips the limit with a state error
  const runaway = new StateMachine({ a: {}, b: {} }, 'a', {}, [
    { from: 'a', to: 'b', after: 1e-9 },
    { from: 'b', to: 'a', after: 1e-9 },
  ]);
  assert.throws(
    () => runaway.update(1),
    (e) => e.code === 'state',
  );
});

test('listener sees every change before the hooks, with the transition or null for goto', () => {
  const seen = [];
  const t = { from: 'a', to: 'b', event: 'go' };
  const m = new StateMachine({ a: { exit: () => seen.push('exit') }, b: {} }, 'a', {}, [t]);
  m.listener = (from, to, tr) => seen.push([from, to, tr]);
  m.send('go');
  assert.deepEqual(seen, [['a', 'b', t], 'exit']);
  m.goto('a');
  assert.deepEqual(seen.at(-1), ['b', 'a', null]);
});

test('ParallelRegions: validation, start, stop, history, send, raise, forward and asState', () => {
  assert.throws(() => new ParallelRegions({}, {}), TypeError);
  assert.throws(() => new ParallelRegions({ r: { states: { a: {} }, initial: 'zzz' } }, {}), TypeError);
  const calls = [];
  const def = {
    move: {
      states: {
        idle: { enter: () => calls.push('idle+'), exit: () => calls.push('idle-') },
        run: { enter: () => calls.push('run+') },
      },
      initial: 'idle',
      transitions: [
        { from: 'idle', to: 'run', event: 'go' },
        { from: 'run', to: 'idle', event: 'stop' },
      ],
    },
    aim: { states: { low: {}, high: {} }, initial: 'low', transitions: [{ from: 'low', to: 'high', event: 'go' }] },
  };
  const p = new ParallelRegions(def, {});
  assert.deepEqual(p.active, { move: null, aim: null });
  assert.throws(
    () => p.send('go'),
    (e) => e.code === 'state',
  );
  assert.throws(
    () => p.update(1),
    (e) => e.code === 'state',
  );
  assert.throws(
    () => p.raise('go'),
    (e) => e.code === 'state',
  );
  assert.throws(
    () => p.stop(),
    (e) => e.code === 'state',
  );
  assert.throws(
    () => p.plan('go'),
    (e) => e.code === 'state',
  );
  p.start();
  assert.equal(p.running, true);
  assert.deepEqual(p.active, { move: 'idle', aim: 'low' });
  assert.throws(
    () => p.start(),
    (e) => e.code === 'state',
  );
  assert.equal(p.send('go'), true);
  assert.deepEqual(p.active, { move: 'run', aim: 'high' });
  assert.equal(p.send('go'), false);
  assert.equal(p.matches('move', 'run'), true);
  assert.equal(p.matches('move', 'idle'), false);
  assert.throws(() => p.matches('nope', 'run'), RangeError);
  p.stop();
  assert.equal(p.running, false);
  assert.deepEqual(p.active, { move: null, aim: null });
  p.start();
  assert.deepEqual(p.active, { move: 'idle', aim: 'low' }, 'without history regions restart at initial');
  const h = new ParallelRegions(def, {}, { history: true });
  h.start();
  h.send('go');
  h.stop();
  h.start();
  assert.deepEqual(h.active, { move: 'run', aim: 'high' });
  // all regions choose before any moves: a guard in one sees the other's old state
  const seen = [];
  const sync = new ParallelRegions(
    {
      x: { states: { a: {}, b: {} }, initial: 'a', transitions: [{ from: 'a', to: 'b', event: 'e' }] },
      y: {
        states: { a: {}, b: {} },
        initial: 'a',
        transitions: [{ from: 'a', to: 'b', event: 'e', guard: () => (seen.push(sync.active.x), true) }],
      },
    },
    {},
  );
  sync.start();
  sync.send('e');
  assert.deepEqual(seen, ['a']);
  // raise: delivered in order; an event nobody takes goes to forward; hooks raising for ever is an error
  const forwarded = [];
  const r = new ParallelRegions(
    { x: { states: { a: {}, b: {} }, initial: 'a', transitions: [{ from: 'a', to: 'b', event: 'e' }] } },
    {},
    { forward: (e) => forwarded.push(e) },
  );
  r.start();
  r.raise('unknown');
  r.raise('e');
  assert.deepEqual(forwarded, ['unknown']);
  assert.equal(r.active.x, 'b');
  const loop = new ParallelRegions(
    {
      x: {
        states: { a: { enter: () => loop.raise('e') }, b: { enter: () => loop.raise('e') } },
        initial: 'a',
        transitions: [
          { from: 'a', to: 'b', event: 'e' },
          { from: 'b', to: 'a', event: 'e' },
        ],
      },
    },
    {},
  );
  assert.throws(
    () => loop.start(),
    (e) => e.code === 'state',
  );
  assert.equal(loop.busy, false);
  // sending from a hook is refused
  const inHook = new ParallelRegions({ x: { states: { a: { enter: () => inHook.send('e') } }, initial: 'a' } }, {});
  assert.throws(
    () => inHook.start(),
    (e) => e.code === 'state',
  );
  // as a state of a machine
  const inner = new ParallelRegions(
    { x: { states: { a: {}, b: {} }, initial: 'a', transitions: [{ from: 'a', to: 'b', event: 'poke' }] } },
    {},
  );
  const outer = new StateMachine({ idle: {}, busy: { ...inner.asState() } }, 'idle', {}, [
    { from: 'busy', to: 'idle', event: 'poke' },
    { from: 'idle', to: 'busy', event: 'start' },
  ]);
  outer.send('start');
  assert.equal(inner.running, true);
  outer.send('poke');
  assert.equal(inner.active.x, 'b');
  assert.equal(outer.state, 'busy', 'the nested region takes the event before the outer transition');
  outer.send('poke');
  assert.equal(outer.state, 'idle');
  assert.equal(inner.running, false);
});

test('FinalMachine: validation, always transitions, completion events, done and delays', () => {
  assert.throws(() => new FinalMachine({ a: { final: 'yes' } }, 'a', {}), TypeError);
  assert.throws(() => new FinalMachine({ a: { final: true, initial: 'b' }, b: { parent: 'a' } }, 'a', {}), TypeError);
  assert.throws(
    () => new FinalMachine({ a: { final: true }, b: {} }, 'a', {}, [{ from: 'a', to: 'b', event: 'x' }]),
    TypeError,
  );
  assert.throws(() => new FinalMachine({ a: {}, b: {} }, 'a', {}, [{ from: 'a', to: 'b' }]), TypeError);
  assert.throws(
    () => new FinalMachine({ a: {}, b: {} }, 'a', {}, [{ from: 'a', to: 'b', event: 'x', always: true }]),
    TypeError,
  );
  assert.throws(() => new FinalMachine({ a: {}, b: {} }, 'a', {}, [{ from: 'a', to: 'b', always: false }]), TypeError);
  assert.throws(() => new FinalMachine({ a: {}, b: {} }, 'a', {}, [{ from: 'a', to: 'b', after: 0 }]), TypeError);
  assert.throws(
    () => new FinalMachine({ a: {}, b: {} }, 'a', {}, [{ from: 'a', to: 'b', event: '\0fsm.x' }]),
    TypeError,
  );
  const m = new FinalMachine({ a: {}, b: {} }, 'a', {}, []);
  assert.throws(() => m.send('\0fsm.always'), TypeError);
  assert.throws(() => m.update(-1), RangeError);
  assert.throws(() => m.update(NaN), RangeError);
  // eventless chain settles at construction and after goto; a guard holds it back
  let open = false;
  const chain = new FinalMachine({ a: {}, b: {}, c: {} }, 'a', {}, [
    { from: 'a', to: 'b', always: true },
    { from: 'b', to: 'c', always: true, guard: () => open },
  ]);
  assert.equal(chain.state, 'b');
  open = true;
  chain.send('nothing');
  assert.equal(chain.state, 'c', 'a rejected event still reconsiders eventless guards');
  // a cycle without a guard is an error
  assert.throws(
    () =>
      new FinalMachine({ a: {}, b: {} }, 'a', {}, [
        { from: 'a', to: 'b', always: true },
        { from: 'b', to: 'a', always: true },
      ]),
    (e) => e.code === 'state',
  );
  // completion: entering a final child raises done.state.<parent>
  const done = new FinalMachine(
    { work: { initial: 'step' }, step: { parent: 'work' }, fin: { parent: 'work', final: true }, after: {} },
    'work',
    {},
    [
      { from: 'step', to: 'fin', event: 'finish' },
      { from: 'work', to: 'after', event: 'done.state.work' },
    ],
  );
  assert.equal(done.state, 'step');
  done.send('finish');
  assert.equal(done.state, 'after');
  // a top-level final stops the machine
  const top = new FinalMachine({ a: {}, z: { final: true } }, 'a', {}, [{ from: 'a', to: 'z', event: 'end' }]);
  assert.equal(top.done, false);
  top.send('end');
  assert.equal(top.done, true);
  assert.equal(top.send('end'), false);
  assert.equal(top.plan('end'), null);
  top.update(5);
  assert.equal(top.clock, 0);
  top.goto('a');
  assert.equal(top.done, false);
  // delays run through the final machine and settle each step
  const timed = new FinalMachine({ a: {}, b: {}, c: {} }, 'a', {}, [
    { from: 'a', to: 'b', after: 1 },
    { from: 'b', to: 'c', always: true },
  ]);
  timed.update(0.5);
  assert.equal(timed.state, 'a');
  timed.update(0.5);
  assert.equal(timed.state, 'c');
  assert.deepEqual(
    timed.transitionDefinitions.map((t) => [t.from, t.to, t.after, t.always]),
    [
      ['a', 'b', 1, undefined],
      ['b', 'c', undefined, true],
    ],
  );
});

test('EventMachine delivers the payload to guards and hooks and restores it after', () => {
  const seen = [];
  const m = new EventMachine(
    { a: { exit: (c, d) => seen.push(['exit', d]) }, b: { enter: (c, d) => seen.push(['enter', d]) } },
    'a',
    {},
    [{ from: 'a', to: 'b', event: 'go', guard: (c, d) => (seen.push(['guard', d]), d?.ok === true) }],
  );
  assert.equal(m.data, undefined);
  assert.equal(m.send('go', { ok: false }), false);
  assert.equal(m.send('go', { ok: true }), true);
  assert.deepEqual(seen, [
    ['guard', { ok: false }],
    ['guard', { ok: true }],
    ['exit', { ok: true }],
    ['enter', { ok: true }],
  ]);
  assert.equal(m.data, undefined);
  const n = new EventMachine({ a: {}, b: {} }, 'a', {}, [
    { from: 'a', to: 'b', event: 'go', guard: (c, d) => d === 7 },
  ]);
  const action = n.plan('go', 7);
  n.send('other', 1);
  action();
  assert.equal(n.state, 'b');
  assert.equal(n.plan('go', 8), null);
});
