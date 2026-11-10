import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '@margoengine/core/extension';
import { GLTFAsset, PBRModel } from '@margoengine/gltf-pro';
import { Animation } from '@margoengine/animation';
import { addSyncGroup } from '../dist/sync.js';
import { Animator } from '../dist/index.js';
import { animatorDocument } from '../../../tests/support/animator-rig.js';

const options = { initial: 'move', states: { move: 'Move' } };
async function fixture(t, target = 'secondary') {
  // No skin or morph data: the real Animation installs with no GPU allocations.
  const device = { limits: { maxStorageBufferBindingSize: 1 << 28, maxBufferSize: 1 << 28 } };
  const engine = new Engine({ width: 8, height: 8, clientWidth: 8, clientHeight: 8 }, await TransformStore.create(32), {
    backend: 'webgl2',
    gpu: device,
    add() {},
    remove() {},
    render() {},
    dispose() {},
  });
  t.after(() => engine.dispose());
  const scene = target === 'default' ? engine.scene : engine.createScene('animator-owner');
  const data = animatorDocument(
    { Root: [null, 0, 0, 0] },
    {
      Move: { duration: 1, fps: 1, tracks: { 'Root.translation': (s) => [s, 0, 0] } },
      Back: { duration: 1, fps: 1, tracks: { 'Root.translation': (s) => [-s, 0, 0] } },
    },
  );
  const model = new PBRModel(engine, new GLTFAsset(data.doc, data.buffers));
  t.after(() => model.dispose());
  const animation = new Animation(model);
  scene.use(animation);
  return { engine, scene, model, animation };
}

test('fade and independent layers survive JSON and continue with the same pose', async (t) => {
  const { animation, model } = await fixture(t);
  const animator = new Animator(animation, { initial: 'a', states: { a: 'Move', b: 'Back' } });
  animator.onPreUpdate(0.2);
  animator.transition('b', 1);
  animator.addLayer({ clip: 'Move', weight: 0.4, mask: [0], time: 0.7, referenceTime: 0.1 });
  animator.setTrigger('pending');
  animator.parameters.speed = 0.6;
  animator.onPreUpdate(0.3);
  const saved = JSON.parse(JSON.stringify(animator.captureState()));
  const position = model.nodes[0].position.x;
  animator.onPreUpdate(0.15);
  const expected = animator.captureState(),
    next = model.nodes[0].position.x;
  let events = 0;
  animator.on('statechange', () => events++);
  animator.restoreState(saved);
  assert.equal(model.nodes[0].position.x, position);
  assert.equal(events, 0);
  assert.deepEqual(animator.captureState(), saved);
  animator.onPreUpdate(0.15);
  assert.equal(model.nodes[0].position.x, next);
  assert.deepEqual(animator.captureState(), expected);
  saved.layers[0].mask.push(100);
  assert.throws(() => animator.restoreState(saved));
  assert.deepEqual(animator.captureState(), expected);
});
test('restoreState keeps the caller layer object live, so later weight writes and its remover still work', async (t) => {
  const { animation, model } = await fixture(t);
  const animator = new Animator(animation, { initial: 'a', states: { a: 'Back' } });
  const layer = { clip: 'Move', weight: 0, mask: [0], blend: 'override' };
  const off = animator.addLayer(layer);
  animator.onPreUpdate(0.5);
  const saved = JSON.parse(JSON.stringify(animator.captureState()));
  layer.weight = 0.25;
  animator.restoreState(saved);
  assert.equal(layer.weight, 0);
  layer.weight = 1;
  animator.onPreUpdate(0);
  assert.equal(animator.captureState().layers[0].weight, 1);
  assert.ok(model.nodes[0].position.x > 0, 'the override layer drives the pose');
  off();
  assert.deepEqual(animator.captureState().layers, []);
  animator.onPreUpdate(0);
  assert.ok(model.nodes[0].position.x < 0, 'the base state drives the pose again');
});
test('animation preserves duplicate clip indices, pause, loop and speed', async (t) => {
  const { animation } = await fixture(t);
  animation.seek(0.4);
  animation.playing = false;
  animation.options.loop = false;
  animation.options.speed = 0.25;
  const saved = JSON.parse(JSON.stringify(animation.captureState()));
  animation.seek(0.8);
  animation.options.speed = 2;
  animation.restoreState(saved);
  assert.deepEqual(animation.captureState(), saved);
  assert.throws(() => animation.restoreState({ ...saved, time: Infinity }), { code: 'state' });
  assert.deepEqual(animation.captureState(), saved);
});

test('sync clock phase is restored before the next transition', async (t) => {
  const { animation } = await fixture(t);
  const animator = new Animator(animation, { initial: 'a', states: { a: 'Move', b: 'Move' } });
  const sync = addSyncGroup(animator, { states: ['a', 'b'] });
  animator.onPreUpdate(0.3);
  const state = JSON.parse(JSON.stringify(animator.captureState()));
  animator.onPreUpdate(0.5);
  animator.restoreState(state);
  assert.equal(sync.phase, 0.3);
  animator.transition('b');
  assert.equal(animator.time, 0.3);
  sync.dispose();
});
