import assert from 'node:assert/strict';
import test from 'node:test';
import { box } from '../../core/dist/index.js';
import { OIT } from '../dist/index.js';
import { addMesh } from '../dist/meshes.js';
import { sceneOwnerEngine } from '../../../tests/support/scene-owner-engine.js';

test('addMesh makes its see-through copy in the scene of the mesh it follows, not the active scene', async () => {
  const { engine, scene } = await sceneOwnerEngine('decoy');
  try {
    const oit = new OIT();
    scene.use(oit);
    const mesh = engine.createMesh(null, scene).setGeometry(box(1, 1, 1));
    const before = [...engine.scene.plugins.keys()];
    // Before the fix: the copy was made in the active (default) scene and parenting it threw "Foreign parent".
    const remove = addMesh(oit, engine, mesh, { opacity: 0.5 });
    assert.equal(mesh.geometry, null, 'the core mesh gives up its geometry');
    assert.deepEqual([...engine.scene.plugins.keys()], before, 'nothing joins the default scene');
    assert.ok([...scene.plugins.keys()].some((name) => name.startsWith('materials:')), 'the draw queue joins the mesh scene');
    remove();
    assert.ok(mesh.geometry, 'the returned function restores the geometry');
    assert.deepEqual([...scene.plugins.keys()], [oit.name], 'the copy and its queue leave the mesh scene');
  } finally {
    engine.dispose();
  }
});
