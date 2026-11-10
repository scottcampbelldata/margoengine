import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Shadows } from '../dist/index.js';
import { loadGLTF } from '@margoengine/gltf-pro';
import { loadedPBREngine } from '../../../tests/support/loaded-pbr-fixtures.js';

test('static PBR casters tighten cascade distance; transforms update it and deformation keeps the safe range', async () => {
  const engine = await loadedPBREngine(),
    before = globalThis.fetch,
    bytes = await readFile(new URL('../../exporters/tests/fixtures/Box.glb', import.meta.url));
  globalThis.fetch = async () => new Response(bytes);
  const shadow = new Shadows();
  try {
    const model = await loadGLTF(engine, 'https://test.invalid/box.glb');
    // The range query has no GPU work; the owning engine supplies live world transforms.
    shadow.engine = engine;
    for (const node of model.nodes) shadow.add(node);
    engine.store.tick(false);
    engine.camera.far = 1000;
    const distance = () => shadow.range(engine.camera).far;
    assert.ok(distance() < 10, 'a small PBR model retains fine shadow texels');
    model.root.position.z = -40;
    engine.store.tick(false);
    assert.ok(distance() >= 44 && distance() < 64, 'the live PBR world transform is included');
    const primitive = model.primitives[0];
    primitive.deformed = {};
    assert.equal(distance(), 500, 'a GPU deformation has no conservative CPU bound');
    primitive.deformed = undefined;
    shadow.options.distance = 250;
    assert.equal(distance(), 250, 'explicit distance remains authoritative');
    model.dispose();
  } finally {
    globalThis.fetch = before;
    shadow.dispose();
    engine.dispose();
  }
});
