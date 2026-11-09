import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '@margoengine/core/extension';
import { GLTFAsset, PBRModel } from '@margoengine/gltf-pro';
import { Animation } from '@margoengine/animation';
import { Animator } from '../dist/index.js';
import { AnimatorGraph } from '../dist/graph.js';
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
    },
  );
  const model = new PBRModel(engine, new GLTFAsset(data.doc, data.buffers));
  t.after(() => model.dispose());
  const animation = new Animation(model);
  scene.use(animation);
  return { engine, scene, model, animation };
}

for (const target of ['default', 'secondary']) {
  for (const mode of ['direct', 'owner', 'scene', 'engine', 'model']) {
    if (target === 'default' && mode === 'scene') continue;
    test(`Animator ${target} ${mode} disposal preserves same-name isolation`, async (t) => {
      const { engine, scene, animation, model } = await fixture(t, target);
      const animator = new Animator(animation, options);
      scene.use(animator);
      const sentinel = { name: animator.name, setup() {} };
      if (target === 'secondary') engine.use(sentinel);
      animator.onDeviceRestored();
      if (mode === 'direct') animator.dispose();
      else if (mode === 'owner') scene.removePlugin(animator.name);
      else if (mode === 'scene') scene.dispose();
      else if (mode === 'model') model.dispose();
      else engine.dispose();
      assert.equal(engine.sceneOf(animator)?.name, undefined);
      assert.equal(animation.playing, true);
      if (target === 'secondary' && mode !== 'engine')
        assert.equal(engine.scene.plugins.get(animator.name) === sentinel, true);
      if (mode === 'direct' || mode === 'owner') {
        const replacement = new Animator(animation, options);
        scene.use(replacement);
        animator.dispose();
        assert.equal(scene.plugins.get(animator.name) === replacement, true);
        replacement.dispose();
        const next = engine.createScene('reattach');
        assert.throws(() => next.use(animator), { code: 'state' });
        assert.equal(engine.sceneOf(animator)?.name, undefined);
        assert.equal(next.plugins.has(animator.name), false);
      }
    });
  }
  for (const [name, Factory] of Object.entries({ Animator, AnimatorGraph }))
    test(`${name}.attach follows the registered Animation in ${target}`, async (t) => {
      const { engine, scene, animation } = await fixture(t, target);
      // The model is deliberately default-owned: the dependency's registration owns playback.
      const handle = Factory.attach(animation, options);
      const animator = handle.animator ?? handle;
      assert.equal(engine.sceneOf(animator)?.name, scene.name);
      animator.onPreUpdate(0.25);
      assert.equal(animator.time, 0.25);
      handle.dispose();
      assert.equal(engine.sceneOf(animator)?.name, undefined);
    });
}

test('direct secondary updates query the owning registry, including dependency removal', async (t) => {
  const { engine, scene, animation } = await fixture(t);
  const animator = new Animator(animation, options);
  scene.use(animator);
  animator.onPreUpdate(0.25);
  assert.equal(animator.time, 0.25);
  assert.equal(engine.sceneOf(animator)?.name, scene.name);
  engine.use({ name: animation.name, setup() {} });
  scene.removePlugin(animation.name);
  animator.onPreUpdate(0.25);
  assert.equal(engine.sceneOf(animator)?.name, undefined);
  assert.equal(animation.playing, true);
});
