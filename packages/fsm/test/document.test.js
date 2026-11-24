import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { StateMachine } from '../dist/index.js';
import { ParallelRegions } from '../dist/parallel.js';
import { loadMachine, saveMachine, validateMachine } from '../dist/document.js';
import { CHART_COUNT, chartDocument, makeChart, traceOf } from './outside/charts.mjs';

const document = () => ({
  version: 1,
  initial: 'play',
  states: {
    play: { history: 'deep', initial: 'idle', enter: 'log' },
    idle: { parent: 'play' },
    run: { parent: 'play', update: 'tick' },
    pause: { exit: 'log' },
    both: {
      regions: {
        legs: { states: { up: {}, down: {} }, initial: 'up', transitions: [{ from: 'up', to: 'down', event: 'duck' }] },
      },
      regionHistory: true,
    },
  },
  transitions: [
    { from: 'idle', to: 'run', event: 'go', guard: 'allowed', duration: 0.25 },
    { from: 'run', to: 'idle', after: 2 },
    { from: 'play', to: 'pause', event: 'pause' },
    { from: 'pause', to: 'play', event: 'resume' },
    { from: 'pause', to: 'both', event: 'split' },
  ],
});
const bindings = (log = []) => ({
  hooks: {
    log: (context) => log.push(`log ${context.name}`),
    tick: (context, delta) => log.push(`tick ${delta}`),
  },
  guards: { allowed: (context) => context.name === 'hero' },
});

test('a document loads into a working machine, hooks, guards, delays, history and regions included', () => {
  const log = [],
    machine = loadMachine(document(), { name: 'hero' }, bindings(log));
  assert.equal(machine.state, 'idle');
  assert.deepEqual(log, ['log hero']);
  machine.send('go');
  assert.equal(machine.state, 'run');
  assert.equal(machine.previous, 'idle');
  machine.update(1);
  assert.equal(log.at(-1), 'tick 1');
  machine.send('pause');
  machine.send('resume');
  assert.equal(machine.state, 'run');
  machine.update(3);
  assert.equal(machine.state, 'idle');
  machine.send('pause');
  machine.send('split');
  machine.send('duck');
  assert.equal(machine.states.both.regions.active.legs, 'down');
  const refused = loadMachine(document(), { name: 'other' }, bindings());
  assert.equal(refused.send('go'), false);
});

test('save gives back the document that loaded, through JSON', () => {
  const binds = bindings(),
    machine = loadMachine(document(), { name: 'hero' }, binds);
  assert.deepEqual(JSON.parse(JSON.stringify(saveMachine(machine, binds))), document());
});

test('saving a hand-built machine with regions gives a document that loads', () => {
  const enter = () => {},
    guard = () => true,
    regions = new ParallelRegions(
      {
        one: { states: { a: { enter }, b: {} }, initial: 'a', transitions: [{ from: 'a', to: 'b', after: 1, guard }] },
      },
      {},
      { history: true },
    ),
    machine = new StateMachine({ p: { initial: 'held' }, held: { ...regions.asState(), parent: 'p' } }, 'p', {});
  const binds = { hooks: { enter }, guards: { guard } },
    saved = saveMachine(machine, binds);
  assert.deepEqual(validateMachine(JSON.parse(JSON.stringify(saved)), binds), []);
  assert.equal(saved.states.held.regionHistory, true);
  assert.equal(saved.states.held.regions.one.transitions[0].guard, 'guard');
  assert.equal(saved.states.held.parent, 'p');
  assert.equal(loadMachine(saved, {}, binds).state, 'held');
});

test('saving a function with no name in bindings is refused, naming it', () => {
  const machine = new StateMachine({ a: { enter: () => {} }, b: {} }, 'a', {}, [
    { from: 'a', to: 'b', event: 'e', guard: () => true },
  ]);
  assert.throws(() => saveMachine(machine), /enter of a/);
  const guarded = new StateMachine({ a: {}, b: {} }, 'a', {}, [{ from: 'a', to: 'b', event: 'e', guard: () => true }]);
  assert.throws(() => saveMachine(guarded), /guard of transition 0/);
  assert.throws(() => saveMachine(new StateMachine({ a: { plan: () => null } }, 'a', {})), /plan hook/);
});

test('validate lists every problem with its place', () => {
  const issues = validateMachine({
    version: 1,
    initial: 'nowhere',
    extra: true,
    states: {
      a: { parent: 'lost', color: 'red', history: 'all', initial: 'b', enter: 3 },
      b: { parent: 'c' },
      c: { parent: 'b' },
      d: 'wrong',
      e: { regions: {} },
      f: { regions: { r: { states: {}, initial: 'x' } }, enter: 'hook' },
      g: { regionHistory: true },
    },
    transitions: [
      { from: 'a', to: 'gone', event: 'x' },
      { from: 'a', to: 'b' },
      { from: 'a', to: 'b', event: 'x', after: 1 },
      { from: 'a', to: 'b', after: 0, duration: -1, guard: 7 },
      { from: 'a', to: 'b', event: '', speed: 2 },
      'wrong',
    ],
  }).map(({ path }) => path);
  for (const path of [
    'initial',
    'extra',
    'states.a.parent',
    'states.a.color',
    'states.a.history',
    'states.a.initial',
    'states.a.enter',
    'states.b.parent',
    'states.c.parent',
    'states.d',
    'states.e.regions',
    'states.f.regions.r.states',
    'states.f.enter',
    'states.g.regionHistory',
    'transitions[0].to',
    'transitions[1]',
    'transitions[2]',
    'transitions[3].after',
    'transitions[3].duration',
    'transitions[3].guard',
    'transitions[4].event',
    'transitions[4].speed',
    'transitions[5]',
  ])
    assert.ok(issues.includes(path), `${path} in ${issues.join(', ')}`);
});

test('a good document has no issues, with bindings names are checked, and anything else is an issue not a crash', () => {
  assert.deepEqual(validateMachine(document()), []);
  assert.deepEqual(validateMachine(document(), bindings()), []);
  const paths = validateMachine(document(), {}).map(({ path }) => path);
  assert.deepEqual(paths.sort(), ['states.pause.exit', 'states.play.enter', 'states.run.update', 'transitions[0].guard']);
  for (const value of [null, 1, 'text', [], {}, { version: 2, states: {}, initial: 'a' }])
    assert.ok(validateMachine(value).length > 0);
  assert.equal(validateMachine({ version: 1, states: {}, initial: 'a' })[0].path, 'states');
  assert.throws(() => loadMachine({ version: 1, states: { a: {} }, initial: 'b' }, {}), /initial: Unknown state/);
});

test('names from Object.prototype and __proto__ are plain names, never inherited functions', () => {
  const text =
    '{"version":1,"initial":"__proto__","states":{"__proto__":{},"constructor":{"enter":"toString"}},' +
    '"transitions":[{"from":"__proto__","to":"constructor","event":"go","guard":"valueOf"}]}';
  const value = JSON.parse(text);
  assert.deepEqual(validateMachine(value, {}).map(({ path }) => path).sort(), [
    'states.constructor.enter',
    'transitions[0].guard',
  ]);
  const plain = JSON.parse(text.replace(',"guard":"valueOf"', '').replace('{"enter":"toString"}', '{}'));
  const machine = loadMachine(plain, {});
  assert.equal(machine.state, '__proto__');
  machine.send('go');
  assert.equal(machine.state, 'constructor');
  assert.deepEqual(JSON.parse(JSON.stringify(saveMachine(machine))), plain);
  const regions = JSON.parse(
    '{"version":1,"initial":"p","states":{"p":{"regions":{"__proto__":{"states":{"a":{}},"initial":"a"}}}}}',
  );
  const held = loadMachine(regions, {});
  assert.equal(held.states.p.regions.matches('__proto__', 'a'), true);
  assert.equal(held.states.p.regions.active.__proto__, 'a');
});

test('a raised event in loaded regions reaches the machine holding them', () => {
  const machine = loadMachine(
    {
      version: 1,
      initial: 'alive',
      states: {
        alive: {
          regions: {
            health: {
              states: { fine: {}, zero: { enter: 'die' } },
              initial: 'fine',
              transitions: [{ from: 'fine', to: 'zero', event: 'hit' }],
            },
          },
        },
        dead: {},
      },
      transitions: [{ from: 'alive', to: 'dead', event: 'died' }],
    },
    {},
    { hooks: { die: () => machine.states.alive.regions.raise('died') } },
  );
  machine.send('hit');
  assert.equal(machine.state, 'dead');
});

test('every seeded chart, as a document through JSON, walks the states Sismic walked, and saves back the same', () => {
  const traces = JSON.parse(readFileSync(new URL('outside/traces.json', import.meta.url), 'utf8'));
  assert.equal(traces.length, CHART_COUNT);
  traces.forEach((outside, index) => {
    const chart = makeChart(index + 1),
      saved = chartDocument(chart),
      guards = {},
      text = JSON.stringify(saved.document);
    let machine;
    for (const name of saved.guards) guards[`active ${name}`] = () => traceOf.active(machine, name);
    machine = loadMachine(JSON.parse(text), {}, { guards });
    assert.equal(JSON.stringify(saveMachine(machine, { guards })), text);
    assert.deepEqual(traceOf(machine, chart), outside, `seed ${index + 1}`);
  });
});
