import assert from 'node:assert/strict';
import test from 'node:test';
import { Lighting2D } from '../dist/index.js';
import { sceneOwnerEngine } from '../../../tests/support/scene-owner-engine.js';

test('dispose() detaches Lighting2D from its own scene, leaving the same name in the default scene', async () => {
  const { engine, scene, decoy } = await sceneOwnerEngine('lighting');
  try {
    const lighting = new Lighting2D({ target: () => null, name: 'lighting' });
    scene.use(lighting);
    lighting.dispose();
    assert.equal(scene.plugins.has('lighting'), false, 'a disposed Lighting2D must leave its scene');
    assert.equal(engine.scene.plugins.get('lighting'), decoy);
    assert.equal(decoy.disposed, 0);
  } finally {
    engine.dispose();
  }
});
