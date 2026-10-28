// Animation state graph (@margoengine/animator/graph): typed parameters, declarative conditions, triggers that
// transitions consume, exit times, uninterruptible crossfades, events, and a document that round-trips through JSON.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../packages/core/dist/extension.js';
import { GLTFAsset, PBRModel } from '../packages/gltf-pro/dist/index.js';
import { Animation } from '../packages/animation/dist/index.js';
import { AnimatorGraph } from '../packages/animator/dist/graph.js';
import { animatedTriangle } from './support/gltf-pro-fixture.js';

// animatedTriangle's Joint (node 1) has Move (1 s); add Still (1 s, no motion) and Hop (0.5 s, up 0.5).
function fixture() {
  const result = animatedTriangle(),
    { doc, buffers } = result;
  const add = (values, type) => {
    const data = new Float32Array(values);
    buffers.push(data);
    doc.buffers.push({ byteLength: data.byteLength });
    doc.bufferViews.push({ buffer: buffers.length - 1, byteLength: data.byteLength });
    doc.accessors.push({
      bufferView: doc.bufferViews.length - 1,
      componentType: 5126,
      count: data.length / { SCALAR: 1, VEC3: 3 }[type],
      type,
    });
    return doc.accessors.length - 1;
  };
  const clip = (name, times, values) =>
    doc.animations.push({
      name,
      channels: [{ sampler: 0, target: { node: 1, path: 'translation' } }],
      samplers: [{ input: add(times, 'SCALAR'), output: add(values, 'VEC3') }],
    });
  clip('Still', [0, 1], [0, 0, 0, 0, 0, 0]);
  clip('Hop', [0, 0.5], [0, 0, 0, 0, 0.5, 0]);
  return result;
}
async function graphOf(document) {
  const store = await TransformStore.create(16),
    engine = new Engine({ width: 16, height: 16, clientWidth: 16, clientHeight: 16 }, store, {
      backend: 'webgl2',
      add() {},
      remove() {},
      render() {},
      dispose() {},
    }),
    f = fixture(),
    model = new PBRModel(engine, new GLTFAsset(f.doc, f.buffers)),
    animation = new Animation(model);
  engine.use({ name: animation.name, setup() {} });
  const graph = AnimatorGraph.attach(animation, document);
  const states = [];
  graph.on('statechange', (change) => states.push(change.to));
  return {
    graph,
    states,
    step: (seconds = 1 / 60) => graph.animator.onPreUpdate(seconds),
    release() {
      graph.dispose();
      animation.dispose();
      model.dispose();
      engine.dispose();
    },
  };
}

const locomotion = () => ({
  parameters: {
    speed: 'float',
    grounded: { type: 'bool', default: true },
    weapon: { type: 'int', default: 2 },
    jump: 'trigger',
  },
  initial: 'idle',
  states: {
    idle: 'Still',
    move: {
      parameter: 'speed',
      samples: [
        { value: 0, clip: 'Still' },
        { value: 1, clip: 'Move' },
      ],
    },
    jump: 'Hop',
    fall: 'Still',
  },
  transitions: [
    { from: 'idle', to: 'move', conditions: [['speed', '>', 0.1]], duration: 0.2 },
    { from: 'move', to: 'idle', conditions: [['speed', '<=', 0.1]] },
    { from: '*', to: 'jump', conditions: [['jump'], ['grounded']], duration: 0.1 },
    { from: 'jump', to: 'fall', conditions: [['grounded', '==', false]] },
    { from: 'jump', to: 'idle', exitTime: 1, duration: 0.1 },
    { from: 'fall', to: 'idle', conditions: [['grounded'], ['weapon', '!=', 3]] },
  ],
});

test('typed parameters start at their defaults and only take values of their type', async (t) => {
  const f = await graphOf(locomotion());
  t.after(() => f.release());
  const { graph } = f;
  assert.equal(graph.get('speed'), 0);
  assert.equal(graph.get('grounded'), true);
  assert.equal(graph.get('weapon'), 2);
  assert.equal(graph.get('jump'), false);
  graph.set('speed', 0.5).set('grounded', false).set('weapon', 3);
  assert.equal(graph.animator.parameters.speed, 0.5, 'floats and ints are the blend parameters');
  assert.equal(graph.get('grounded'), false);
  assert.throws(() => graph.set('weapon', 1.5), { name: 'RangeError', message: /finite integer/ });
  assert.throws(() => graph.set('speed', Number.NaN), { name: 'RangeError', message: /finite number/ });
  assert.throws(() => graph.set('grounded', 1), { name: 'TypeError', message: /true or false/ });
  assert.throws(() => graph.set('jump', true), { name: 'TypeError', message: /call trigger\("jump"\)/ });
  assert.throws(() => graph.trigger('speed'), { name: 'TypeError', message: /not a trigger/ });
  assert.throws(() => graph.get('missing'), { name: 'TypeError', message: /declare it under parameters/ });
});

test('conditions compare parameters, triggers wait until a transition takes them, exit times end a state', async (t) => {
  const f = await graphOf(locomotion());
  t.after(() => f.release());
  const { graph, states, step } = f;
  step();
  assert.equal(graph.state, 'idle', 'speed 0 is not > 0.1');
  graph.set('speed', 0.8);
  step();
  assert.equal(graph.state, 'move');
  graph.set('grounded', false).trigger('jump');
  step();
  assert.equal(graph.state, 'move', 'jump needs grounded too');
  assert.equal(graph.get('jump'), true, 'the trigger stays set');
  graph.set('grounded', true);
  step();
  assert.equal(graph.state, 'jump');
  assert.equal(graph.get('jump'), false, 'taking the transition cleared the trigger');
  step();
  assert.equal(graph.state, 'jump', 'a consumed trigger does not fire the any-state jump again');
  for (let i = 0; i < 40 && graph.state === 'jump'; i++) step(1 / 60);
  assert.equal(graph.state, 'idle', 'Hop ends (exit time 1) back in idle');
  assert.deepEqual(states, ['move', 'jump', 'idle']);
  graph.trigger('jump').resetTrigger('jump');
  step();
  assert.equal(graph.state, 'move', 'a reset trigger fires nothing; speed 0.8 moves again');
});

test('bool and int conditions, and != with an int', async (t) => {
  const f = await graphOf(locomotion());
  t.after(() => f.release());
  const { graph, step } = f;
  graph.trigger('jump');
  step();
  assert.equal(graph.state, 'jump');
  graph.set('grounded', false).set('weapon', 3);
  step();
  assert.equal(graph.state, 'fall');
  graph.set('grounded', true);
  step();
  assert.equal(graph.state, 'fall', 'weapon 3 holds the fall');
  graph.set('weapon', 1);
  step();
  assert.equal(graph.state, 'idle');
});

test('an uninterruptible crossfade holds every transition until it ends; an interruptible one does not', async (t) => {
  for (const interruptible of [false, true]) {
    const f = await graphOf({
      parameters: { go: 'trigger', stop: 'bool' },
      initial: 'a',
      states: { a: 'Still', b: 'Move', c: 'Hop' },
      transitions: [
        { from: 'a', to: 'b', conditions: [['go']], duration: 0.5, interruptible },
        { from: 'b', to: 'c', conditions: [['stop']], duration: 0.1 },
      ],
    });
    t.after(() => f.release());
    const { graph, step } = f;
    graph.trigger('go').set('stop', true);
    step(0.1);
    assert.equal(graph.state, 'b');
    step(0.1);
    if (interruptible) {
      assert.equal(graph.state, 'c', 'an interruptible crossfade lets b to c cut in');
      continue;
    }
    for (let i = 0; i < 3; i++) {
      assert.equal(graph.state, 'b', 'held during the 0.5 s crossfade');
      step(0.1);
    }
    step(0.1);
    assert.equal(graph.state, 'c', 'taken once the crossfade is over');
  }
});

test('the document is plain data: it round-trips through JSON and behaves the same', async (t) => {
  const document = locomotion(),
    copy = JSON.parse(JSON.stringify(document));
  assert.deepEqual(copy, document);
  const [a, b] = [await graphOf(document), await graphOf(copy)];
  t.after(() => {
    a.release();
    b.release();
  });
  for (const f of [a, b]) {
    f.graph.set('speed', 1);
    for (let i = 0; i < 5; i++) f.step();
    f.graph.trigger('jump');
    for (let i = 0; i < 50; i++) f.step();
  }
  assert.deepEqual(a.states, b.states);
});

test('timed events reach graph.on', async (t) => {
  const f = await graphOf({
    initial: 'walk',
    states: { walk: 'Move' },
    events: [{ state: 'walk', time: 0.5, name: 'footstep', data: 'left' }],
  });
  t.after(() => f.release());
  const heard = [];
  f.graph.on('event', (event) => heard.push(event.data));
  for (let i = 0; i < 4; i++) f.step(0.3);
  assert.deepEqual(heard, ['left']);
});

test('a bad document throws a TypeError that names the fix; a disposed graph a coded error', async () => {
  const bad = (change, message) => {
    const document = { ...locomotion(), ...change };
    return assert.rejects(graphOf(document), { name: 'TypeError', message });
  };
  await bad({ parameters: { speed: 'number' } }, /'float', 'int', 'bool' or 'trigger'/);
  await bad({ parameters: { grounded: { type: 'bool', default: 1 } } }, /true or false default/);
  await bad({ transitions: [{ from: 'idle', to: 'move', conditions: [['run']] }] }, /declare it under parameters/);
  await bad(
    { transitions: [{ from: 'idle', to: 'move', conditions: [['speed', '~', 1]] }] },
    /use >, >=, <, <=, == or !=/,
  );
  await bad({ transitions: [{ from: 'idle', to: 'move', conditions: [['speed']] }] }, /compare a float with a value/);
  await bad({ transitions: [{ from: 'idle', to: 'move', conditions: [['jump', '==', 1]] }] }, /takes no comparison/);
  await bad({ transitions: [{ from: 'idle', to: 'move', conditions: [['grounded', '>', true]] }] }, /== or !=/);
  await bad({ transitions: [{ from: 'idle', to: 'move' }] }, /needs conditions or an exitTime/);
  await bad(
    { states: { idle: { parameter: 'grounded', samples: [{ value: 0, clip: 'Still' }] } } },
    /declare it as a float or int/,
  );
  const f = await graphOf(locomotion());
  f.release();
  f.graph.dispose();
  assert.throws(() => f.graph.set('speed', 1), { code: 'disposed', message: /create a new AnimatorGraph/ });
});
