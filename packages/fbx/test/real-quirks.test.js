// What real files do that a tidy writer never would, each seen in the corpus of the package README: the shapes are
// rebuilt here, and the files themselves were compared with the same file in Blender.
import test from 'node:test';
import assert from 'node:assert/strict';
import { convertFBX } from '../dist/index.js';
import { readGLB, rigFixture } from './native-scene-helper.js';

const bytes = (text) => new TextEncoder().encode(text);

test('a cluster with no lists keeps its joint: writers keep it for the skeleton', async () => {
  const full = rigFixture({ morph: false, animation: false }),
    at = full.indexOf('"SubDeformer::Tip"'),
    source = full.slice(0, at) + full.slice(at).replace(/Indexes: \*3 \{\n a: 0,1,2\n\}\s*Weights: \*3 \{\n a: [^\n]*\n\}/, '');
  assert.equal(source.split('Indexes: *3').length, 2, 'the fixture lost its lists');
  const { doc } = readGLB(await convertFBX(bytes(source)));
  assert.equal(doc.skins[0].joints.length, 2);
});

test('a weight for a control point the mesh no longer has is dropped', async () => {
  const source = rigFixture({ morph: false, animation: false }),
    stale = source
      .replace('Indexes: *3 {\n a: 0,1,2\n}', 'Indexes: *4 {\n a: 0,1,2,9\n}')
      .replace('Weights: *3 {\n a: 0.5,0.5,0.5\n}', 'Weights: *4 {\n a: 0.5,0.5,0.5,1\n}');
  assert.notEqual(stale, source);
  const same = (glb) => readGLB(glb).bin.length;
  assert.equal(same(await convertFBX(bytes(stale))), same(await convertFBX(bytes(source))));
});

test('a file of skeleton and curves alone converts: Unity clip files are this', async () => {
  const source = rigFixture({ skin: false, morph: false })
    .replace(/C: "OO",\d+,2\n/, '')
    .replace(/Geometry: 1, [\s\S]*?\n \}\n/, '');
  assert.ok(!source.includes('"Mesh" {\n  Vertices'), 'the fixture lost its mesh');
  const { doc } = readGLB(await convertFBX(bytes(source)));
  assert.equal(doc.meshes, undefined);
  assert.ok(doc.animations.length > 0);
});
