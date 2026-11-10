import assert from 'node:assert/strict';
import test from 'node:test';
import { Selection } from '../dist/index.js';
import { XRaySelection } from '../dist/xray.js';
import { Highlight } from '../dist/highlight.js';
import { sceneOwnerEngine } from '../../../tests/support/scene-owner-engine.js';

test('dispose() detaches a Selection from its own scene, leaving the same name in the default scene', async () => {
  const { engine, scene, decoy } = await sceneOwnerEngine('selection');
  try {
    const selection = new Selection();
    scene.use(selection);
    selection.dispose();
    assert.equal(scene.plugins.has('selection'), false, 'a disposed Selection must leave its scene');
    assert.equal(engine.scene.plugins.get('selection'), decoy);
    assert.equal(decoy.disposed, 0);
  } finally {
    engine.dispose();
  }
});

for (const [Effect, label, name] of [
  [XRaySelection, 'XRaySelection', 'selection-xray'],
  [Highlight, 'Highlight', 'selection-highlight'],
]) {
  test(`dispose() detaches a ${label}, which wraps a Selection, from its own scene`, async () => {
    const { engine, scene, decoy } = await sceneOwnerEngine(name);
    try {
      const effect = new Effect();
      scene.use(effect);
      assert.equal(effect.name, name);
      effect.dispose();
      assert.equal(scene.plugins.has(name), false, `a disposed ${label} must leave its scene`);
      assert.equal(engine.scene.plugins.get(name), decoy);
      assert.equal(decoy.disposed, 0);
    } finally {
      engine.dispose();
    }
  });
}
