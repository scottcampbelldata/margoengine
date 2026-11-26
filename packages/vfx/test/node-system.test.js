import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compileNodeSystem,
  createNodeSystem,
  parseNodeSystem,
  serializeNodeSystem,
  VFXNodeSystemError,
} from '../dist/node-system.js';

const graph = () => ({
  format: 'margo-vfx-node-system',
  version: 1,
  blocks: [
    { id: 'ring', type: 'shape', shape: 'torus', radius: 1.2, tube: 'tube', shell: true, speed: 0.6 },
    { id: 'tube', type: 'number', value: 0.1 },
    { id: 'life', type: 'random', min: 0.5, max: 1 },
    { id: 'jitter', type: 'random', min: 0, max: 1, seed: 3 },
    { id: 'half', type: 'math', op: 'mul', a: 'jitter', b: 0 },
    {
      id: 'fire',
      type: 'gradient',
      stops: [
        { at: 0, color: [1, 1, 0.5] },
        { at: 1, color: [0.5, 0, 0] },
      ],
    },
    { id: 'fade', type: 'curve', samples: [0, 1, 0] },
    { id: 'blue', type: 'color', value: [0.4, 0.7, 1, 1] },
    { id: 'up', type: 'vector', value: [0, 'half', 0] },
    {
      id: 'sparks',
      type: 'system',
      duration: 2,
      shape: 'ring',
      create: ['c-life', 'c-rate', 'c-color', 'c-vel', 'c-burst'],
      update: ['u-size', 'u-color', 'u-gravity'],
    },
    { id: 'c-life', type: 'create-lifetime', value: 'life' },
    { id: 'c-rate', type: 'create-rate', value: 100 },
    { id: 'c-color', type: 'create-color', value: 'blue' },
    { id: 'c-vel', type: 'create-velocity', value: 'up', spread: 0.5 },
    { id: 'c-burst', type: 'create-burst', time: 0.5, count: 10, cycles: 2, interval: 0.25 },
    { id: 'u-size', type: 'update-size', curve: 'fade' },
    { id: 'u-color', type: 'update-color', gradient: 'fire' },
    { id: 'u-gravity', type: 'update-gravity', value: [0, -2, 0] },
    { id: 'embers', type: 'system', create: ['e-rate'] },
    { id: 'e-rate', type: 'create-rate', value: 10 },
    { id: 'chain', type: 'trigger', on: 'end', source: 'sparks', target: 'embers', delay: 0.5 },
  ],
});
const block = (g, id) => g.blocks.find((b) => b.id === id);

test('evaluates blocks into validated options', () => {
  const plan = compileNodeSystem(graph());
  const sparks = plan.systems.get('sparks');
  assert.deepEqual(plan.roots, ['sparks']);
  assert.equal(sparks.duration, 2);
  assert.deepEqual(sparks.options.emitter, { shape: 'torus', radius: 1.2, tube: 0.1, shell: true, speed: 0.6 });
  assert.deepEqual(sparks.options.lifetime, [0.5, 1]);
  assert.deepEqual(sparks.options.velocity, [0, 0, 0]);
  assert.equal(sparks.options.spread, 0.5);
  assert.deepEqual(sparks.options.curves.size, [0, 1, 0]);
  assert.equal(sparks.options.curves.color.length, 2);
  assert.deepEqual(sparks.options.gravity, [0, -2, 0]);
  assert.equal(sparks.options.schedule.bursts[0].cycles, 2);
});

test('random blocks are deterministic per seed and stay in range', () => {
  const g = graph();
  g.blocks.push({ id: 'cs', type: 'create-size', value: 'r' }, { id: 'r', type: 'random', min: 1, max: 2 });
  block(g, 'sparks').create.push('cs');
  const size = (seed) => compileNodeSystem(g, { seed }).systems.get('sparks').options.size;
  assert.equal(size(5), size(5));
  assert.notEqual(size(5), size(6));
  for (const s of [0, 1, 2, 3]) assert.ok(size(s) >= 1 && size(s) <= 2);
});

test('JSON round trips and compiles to the same plan', () => {
  const text = serializeNodeSystem(graph());
  assert.deepEqual(parseNodeSystem(text), graph());
  assert.equal(serializeNodeSystem(parseNodeSystem(text)), text);
  assert.deepEqual(
    compileNodeSystem(parseNodeSystem(text)).systems.get('sparks').options,
    compileNodeSystem(graph()).systems.get('sparks').options,
  );
});

const code = (fn, expected) =>
  assert.throws(
    fn,
    (e) =>
      e instanceof VFXNodeSystemError &&
      e.code === expected &&
      e.message.includes('https://margoengine.com/errors#vfx-node-system'),
    expected,
  );

test('invalid graphs throw coded errors with a help link', () => {
  const edit = (fn) => {
    const g = graph();
    fn(g);
    return g;
  };
  code(() => compileNodeSystem({ ...graph(), format: 'x' }), 'format');
  code(() => compileNodeSystem({ ...graph(), version: 2 }), 'version');
  code(() => parseNodeSystem('{'), 'format');
  code(() => compileNodeSystem(edit((g) => g.blocks.push({ id: 'ring', type: 'number', value: 1 }))), 'duplicate-id');
  code(() => compileNodeSystem(edit((g) => g.blocks.push({ id: 'z', type: 'bogus' }))), 'unknown-block');
  code(() => compileNodeSystem(edit((g) => (block(g, 'c-life').value = 'nope'))), 'unknown-ref');
  code(() => compileNodeSystem(edit((g) => (block(g, 'c-life').value = 'blue'))), 'wrong-type');
  code(() => compileNodeSystem(edit((g) => (block(g, 'c-rate').value = Infinity))), 'bad-param');
  code(() => compileNodeSystem(edit((g) => (block(g, 'tube').value = 'tube'))), 'cycle');
  code(() => compileNodeSystem(edit((g) => (block(g, 'life').min = 2))), 'bad-param');
  code(() => compileNodeSystem({ ...graph(), blocks: [] }), 'no-system');
  code(() => compileNodeSystem(edit((g) => (block(g, 'c-rate').value = -5))), 'invalid-options');
  code(
    () =>
      compileNodeSystem(
        edit((g) => g.blocks.push({ id: 'loop', type: 'trigger', on: 'end', source: 'embers', target: 'sparks' })),
      ),
    'cycle',
  );
  code(
    () =>
      compileNodeSystem(
        edit((g) => g.blocks.push({ id: 't2', type: 'trigger', on: 'start', source: 'sparks', target: 'ring' })),
      ),
    'trigger',
  );
});

// Regression (2026-11-26): create-prewarm's seed went into the schedule unchecked, a string or NaN included.
test('a prewarm seed is a checked number, wired or literal', () => {
  const prewarm = (seed) => {
    const g = graph();
    g.blocks.push({ id: 'pw', type: 'create-prewarm', seconds: 1, seed });
    block(g, 'sparks').create.push('pw');
    return g;
  };
  assert.equal(compileNodeSystem(prewarm(7)).systems.get('sparks').options.schedule.seed, 7);
  code(() => compileNodeSystem(prewarm('loud')), 'unknown-ref');
  code(() => compileNodeSystem(prewarm(Number.NaN)), 'bad-param');
});

test('a death trigger turns its target into the parent sub-emitter', () => {
  const g = {
    format: 'margo-vfx-node-system',
    version: 1,
    blocks: [
      { id: 'shell', type: 'system', create: ['s-rate'] },
      { id: 's-rate', type: 'create-rate', value: 5 },
      { id: 'burst', type: 'system', create: ['b-life', 'b-size'] },
      { id: 'b-life', type: 'create-lifetime', value: [0.2, 0.4] },
      { id: 'b-size', type: 'create-size', value: 0.02 },
      { id: 'pop', type: 'trigger', on: 'death', source: 'shell', target: 'burst', count: 12, inherit: 0.5 },
    ],
  };
  const plan = compileNodeSystem(g);
  assert.deepEqual([...plan.systems.keys()], ['shell']);
  assert.deepEqual(plan.systems.get('shell').options.events, {
    on: 'death',
    count: 12,
    inherit: 0.5,
    lifetime: [0.2, 0.4],
    size: 0.02,
  });
  g.blocks.push({ id: 'again', type: 'trigger', on: 'collision', source: 'shell', target: 'burst' });
  code(() => compileNodeSystem(g), 'trigger');
});

test('a trigger chains a second system on the clock', () => {
  const log = [];
  const disposed = [];
  const set = createNodeSystem(graph(), {
    create: (options, id) => {
      log.push(id);
      return { dispose: () => disposed.push(id) };
    },
  });
  set.start();
  assert.deepEqual(set.running, ['sparks']);
  set.update(2.4);
  assert.deepEqual(set.running, []);
  assert.deepEqual(disposed, ['sparks']);
  set.update(0.2);
  assert.deepEqual(set.running, ['embers']);
  assert.deepEqual(set.started, ['sparks', 'embers']);
  assert.deepEqual(log, ['sparks', 'embers']);
  set.update(100);
  assert.deepEqual(set.running, ['embers']);
  set.dispose();
  assert.deepEqual(disposed, ['sparks', 'embers']);
  assert.throws(() => set.update(1), TypeError);
  set[Symbol.dispose]();
});

test('start triggers delay their target and start() restarts the run', () => {
  const g = graph();
  block(g, 'chain').on = 'start';
  block(g, 'chain').delay = 1;
  const started = [];
  using set = createNodeSystem(g, { create: (o, id) => void started.push(id) });
  set.start().update(0.9);
  assert.deepEqual(started, ['sparks']);
  set.update(0.2);
  assert.deepEqual(started, ['sparks', 'embers']);
  set.start();
  assert.deepEqual(started, ['sparks', 'embers', 'sparks']);
  assert.throws(() => set.update(-1), RangeError);
});
