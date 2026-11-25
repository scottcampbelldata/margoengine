import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadGLTF } from '../dist/pbr.js';
import { loadGLTF as loadLight } from '../../gltf/dist/index.js';
import { loadedPBREngine } from '../../../tests/support/loaded-pbr-fixtures.js';

// KB-SHADOW-GROUP1: the two loaders named loadGLTF returned different shapes. @margoengine/gltf gives `meshes`, the
// meshes that draw; @margoengine/gltf/pbr gave `nodes` and `primitives` only, so code written for one read undefined
// from the other (`for (const mesh of model.meshes ?? [])` ran zero times and cast no shadow).
test('PBRModel.meshes lists the nodes that draw its primitives, once each, as the light loader lists its meshes', async () => {
  const engine = await loadedPBREngine(),
    before = globalThis.fetch,
    bytes = await readFile(new URL('../../exporters/tests/fixtures/Box.glb', import.meta.url));
  globalThis.fetch = async () => new Response(bytes);
  try {
    const model = await loadGLTF(engine, 'https://test.invalid/box.glb'),
      meshes = model.meshes;
    assert.ok(Array.isArray(meshes) && meshes.length > 0, 'a model with primitives has meshes');
    assert.equal(meshes.length, new Set(meshes).size, 'each node once');
    assert.deepEqual(
      meshes,
      [...new Set(model.primitives.map((primitive) => primitive.node))],
      'the primitives nodes, in primitive order',
    );
    for (const mesh of meshes) assert.ok(model.nodes.includes(mesh), 'every mesh is one of the nodes');
    assert.notEqual(model.meshes, meshes, 'a new array on each read');
    // The light loader's shape: an array of mesh handles that draw, one per primitive for this file.
    const light = await loadLight(engine, 'https://test.invalid/box.glb');
    assert.ok(Array.isArray(light.meshes) && light.meshes.length > 0);
    assert.equal(
      meshes.length,
      light.meshes.length,
      'the same file gives the same number of meshes from either loader',
    );
    light.dispose();
    model.dispose();
  } finally {
    globalThis.fetch = before;
    engine.dispose();
  }
});
