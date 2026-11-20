// GAP-FILM-DRACO-NODE: a Draco glTF could not load in Node, which has no Web Worker, because the Draco decoder
// refused to run without one. The decoders now decode in the calling thread there, so the glTF loader reads the
// Khronos Draco Box in Node through the same decoder module `loadGLTF` from gltf/pbr gives it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GLTFAsset } from '../dist/pbr.js';

const fixture = (name) => readFileSync(new URL(`../../decoders/tests/fixtures/${name}`, import.meta.url));

test('a Draco glTF decodes in Node with the default decoders (GAP-FILM-DRACO-NODE)', async () => {
  assert.equal(typeof Worker, 'undefined');
  const doc = JSON.parse(fixture('Box.gltf').toString('utf8')),
    primitive = doc.meshes[0].primitives[0],
    asset = new GLTFAsset(doc, [new Uint8Array(fixture('Box.bin'))], undefined, {
      decoderModule: () => import('@margoengine/decoders'),
    });
  await asset.decode();
  const position = doc.accessors[primitive.attributes.POSITION],
    positions = asset.accessor(primitive.attributes.POSITION, 'VEC3'),
    indices = asset.accessor(primitive.indices, 'SCALAR');
  assert.equal(positions.length, position.count * 3);
  assert.equal(indices.length, doc.accessors[primitive.indices].count);
  for (let i = 0; i < positions.length; i++)
    assert.ok(Math.abs(positions[i]) <= 0.5 + 1e-4, 'positions inside the Box accessor bounds');
  assert.ok(indices.every((index) => index < position.count));
});
