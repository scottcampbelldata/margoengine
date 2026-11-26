import test from 'node:test';
import assert from 'node:assert/strict';
import { Shadows } from '../dist/index.js';
import { Material, createInstancedMesh, createMesh } from '@margoengine/materials';
import { boxGeometry } from '@margoengine/geometry';
import { loadedPBREngine } from '../../../tests/support/loaded-pbr-fixtures.js';

const at = (x, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, z, 1];

// KB-SHADOW-INSTFIT1: an instanced caster left the cascades at the default 500, so the same boxes drawn as one
// instanced mesh got coarser shadow texels than as separate meshes.
test('an instanced caster fits the cascades to its instances, read again only when its rows change', async () => {
  const engine = await loadedPBREngine(),
    shadow = new Shadows(),
    box = boxGeometry(1, 1, 1);
  try {
    shadow.engine = engine;
    engine.camera.far = 1000;
    const mesh = createInstancedMesh(engine, box, new Material(), 3),
      rows = mesh.instances;
    rows.setMatrixAt(0, at(0, 0)).setMatrixAt(1, at(0, -20)).setMatrixAt(2, at(0, -40));
    let remove = shadow.add(mesh);
    engine.store.tick(false);
    const range = () => shadow.range(engine.camera).far;
    // The farthest instance is 44 units from the camera at z 4; separate meshes at the same places fit the same.
    const fitted = range();
    assert.ok(fitted >= 44.5 && fitted < 64, `fitted to the instances, got ${fitted}`);
    const separate = [0, -20, -40].map((z) => {
      const m = createMesh(engine, box, new Material());
      m.root.setPosition([0, 0, z]);
      return m;
    });
    remove();
    const removers = separate.map((m) => shadow.add(m));
    engine.store.tick(false);
    assert.equal(range(), fitted, 'separate meshes at the instances fit the same cascades');
    removers.forEach((r) => r());
    separate.forEach((m) => m.destroy());
    remove = shadow.add(mesh);
    engine.store.tick(false);
    assert.equal(range(), fitted);
    // Rows written without needsUpdate are not drawn either: the fit keeps the drawn rows' box.
    rows.data[2 * 24 + 14] = -400;
    assert.equal(range(), fitted, 'still rows are not read again');
    rows.needsUpdate = true;
    assert.ok(range() > 404, 'rows marked for upload are read again');
    rows.setMatrixAt(2, at(0, -10));
    assert.ok(range() < 32, 'setMatrixAt moves the fit');
    rows.count = 1;
    assert.ok(range() < 8, 'only drawn instances count');
    rows.count = 0;
    assert.equal(range(), 500, 'an instanced node that draws nothing adds nothing: no caster box, the default');
    remove();
    mesh.destroy();
  } finally {
    shadow.dispose();
    engine.dispose();
  }
});
