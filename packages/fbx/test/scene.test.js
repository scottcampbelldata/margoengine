import assert from 'node:assert/strict';
import { test } from 'node:test';
import { headless, headlessModels } from '../../../tests/support/pbr-snapshot.js';
import { parseFBX } from '../dist/index.js';
import { rigFixture } from './native-scene-helper.js';

// KB-OWN-ASYNC1: a parseFBX started in a second scene's setup builds its model after its awaits, when the default scene
// is active again.
const bytes = new TextEncoder().encode(rigFixture({ skin: false, morph: false, animation: false }));
/** Runs `start` inside a second scene's setup, which is where an app starts a load for that scene. */
function inSecondScene(engine, start) {
  const scene = engine.createScene('b');
  let started;
  scene.use({ name: 'loader', setup: () => (started = start()) });
  return { scene, started };
}
const owned = (scene) => [...scene.plugins.keys()].filter((name) => name !== 'loader');
const withEngine = (run) =>
  headlessModels(async () => {
    const engine = await headless();
    try {
      return await run(engine);
    } finally {
      engine.dispose();
    }
  });

test('parseFBX started in a second scene builds the model there', () =>
  withEngine(async (engine) => {
    const { scene, started } = inSecondScene(engine, () => parseFBX(engine, bytes)),
      model = await started;
    assert.ok(model.root.scene === scene, `the root is in scene ${model.root.scene.name}`);
    for (const node of model.nodes) assert.ok(node.scene === scene, 'a node is not in the second scene');
    assert.ok(engine.sceneOf(model) === scene, 'the model plugin is not in the second scene');
    assert.equal(engine.scene.meshes.size, 0, 'meshes landed in the default scene');
    assert.equal(engine.scene.plugins.size, 0, 'a plugin landed in the default scene');
    model.dispose();
    assert.equal(scene.meshes.size, 0);
    assert.deepEqual(owned(scene), []);
  }));

test('a parseFBX started outside any setup stays in the default scene', () =>
  withEngine(async (engine) => {
    const model = await parseFBX(engine, bytes);
    assert.ok(model.root.scene === engine.scene);
    assert.ok(engine.sceneOf(model) === engine.scene);
    model.dispose();
  }));

test('an aborted parseFBX started in a second scene leaves nothing in either scene', () =>
  withEngine(async (engine) => {
    const controller = new AbortController(),
      { scene, started } = inSecondScene(engine, () => parseFBX(engine, bytes, { signal: controller.signal }));
    controller.abort(new Error('stop'));
    await assert.rejects(started, /stop/);
    for (const each of [scene, engine.scene]) {
      assert.equal(each.meshes.size, 0, `scene ${each.name} holds meshes`);
      assert.deepEqual(owned(each), [], `scene ${each.name} holds plugins`);
    }
  }));
