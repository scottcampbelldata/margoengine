// Animation.attach puts the animation in its model's scene, wherever it is called from (docs/integration-fixtures.md).
import assert from 'node:assert/strict';
import test from 'node:test';
import { GLTFAsset, PBRModel } from '../../gltf-pro/dist/index.js';
import { Animation } from '../dist/index.js';
import { skinnedStrip } from '../test/fixture.js';
import { ownerEngine } from './owner-lifetime.fixture.js';

test('Animation.attach joins the scene of a model loaded into a second scene, so its deform pass draws there', async (t) => {
  const engine = await ownerEngine(t),
    scene = engine.createScene('models');
  let model;
  scene.use({
    name: 'load',
    setup() {
      const data = skinnedStrip();
      model = new PBRModel(engine, new GLTFAsset(data.doc, data.buffers));
    },
  });
  scene.removePlugin('load');
  t.after(() => model.dispose());
  assert.equal(model.root.scene, scene);
  // Called by the app after loading, outside any scene setup: the default scene is the active one.
  const animation = Animation.attach(model);
  assert.equal(engine.sceneOf(animation), scene, "the animation is in its model's scene");
  assert.equal(engine.scene.plugins.has(animation.name), false);
  animation.dispose();
  assert.equal(scene.plugins.has(animation.name), false);
});
