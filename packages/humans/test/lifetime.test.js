// @margoengine/humans: a person and an outfit live in the scene of the model they are put on, whatever scene is active
// when the call starts or finishes, and take everything they registered off again. The full owner/lifetime matrix (both
// scene targets, detach, scene and engine disposal, device losses) is test/owner-lifetime.fixture.js under
// `npm run check:owners -- --packages=humans`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseGLTF } from '../../gltf/dist/pbr.js';
import { addPerson } from '../dist/index.js';
import { dressPerson } from '../dist/fit.js';
import { riggedTestGLB } from './rigged-body.js';
import { nodeLifetimeAdapter } from '../../../tests/support/owner-lifetime-node.js';

// An engine on the inert device the owner/lifetime check uses on the CPU.
async function engineWithScenes(t) {
  const adapter = await nodeLifetimeAdapter(),
    { engine } = await adapter.create();
  t.after(() => {
    engine.dispose();
    adapter.close();
  });
  return engine;
}

// The model goes into `scene` the way a loader started in that scene puts it there.
function modelIn(engine, scene) {
  let model;
  scene.use({ name: 'load', setup: () => (model = parseGLTF(engine, riggedTestGLB('T'))) });
  scene.removePlugin('load');
  return model;
}

test('dressPerson puts the outfit in the scene of a model that is not in the active scene, and takes it off again', async (t) => {
  const engine = await engineWithScenes(t),
    side = engine.createScene('side'),
    model = modelIn(engine, side);
  t.after(() => model.dispose());
  assert.equal(engine.sceneOf(model), side);
  assert.notEqual(engine.scene, side, 'the default scene stays active');
  const person = await addPerson(engine, model, { hands: false });
  const before = new Set(side.plugins.values()),
    active = new Set(engine.scene.plugins.values());
  // Old: the outfit was parsed into the active scene and then parented under the model: "Foreign parent".
  const dressed = await dressPerson(engine, person, 'townsman-1910');
  assert.equal(engine.sceneOf(dressed.model), side, 'the outfit model is in the model scene');
  assert.equal(engine.sceneOf(dressed.animation), side, 'its Animation is in the model scene');
  assert.deepEqual(new Set(engine.scene.plugins.values()), active, 'nothing joined the active scene');
  const added = [...side.plugins.values()].filter((p) => !before.has(p));
  assert.ok(added.length >= 2, `the outfit registered its model and Animation (${added.map((p) => p.name)})`);
  dressed.dispose();
  for (const plugin of added) assert.equal(engine.sceneOf(plugin), undefined, `${plugin.name} released`);
  assert.deepEqual(new Set(side.plugins.values()), before, 'the person is left as it was');
  person.dispose();
});
