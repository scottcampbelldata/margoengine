// What real files do that a tidy writer never would, each seen in the corpus of the package README: the shapes are
// rebuilt here, and the files themselves were compared with the same file in Blender.
import test from 'node:test';
import assert from 'node:assert/strict';
import { convertFBX } from '../dist/index.js';
import { readGLB, rigFixture } from './native-scene-helper.js';
import { animationLayers } from '../dist/layers.js';

const bytes = (text) => new TextEncoder().encode(text);

test('a cluster with no lists keeps its joint: writers keep it for the skeleton', async () => {
  const full = rigFixture({ morph: false, animation: false }),
    at = full.indexOf('"SubDeformer::Tip"'),
    source =
      full.slice(0, at) +
      full.slice(at).replace(/Indexes: \*3 \{\n a: 0,1,2\n\}\s*Weights: \*3 \{\n a: [^\n]*\n\}/, '');
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

test('a shape whose normal deltas are garbage takes them from its positions: Character Creator writes these', async () => {
  // Character Creator 4 wrote 12 of the 201 shapes of a real character with normal deltas such as NaN and -6.4e149.
  const source = rigFixture({ skin: false, animation: false }).replace(
      'Vertices: *3 {\n a: 0,0.5,0\n}',
      'Vertices: *3 {\n a: 0,0,1\n}\n  Normals: *3 {\n a: 1.785877537949343e-191,-6.381165258675337e+149,0\n}',
    ),
    // The ASCII reader takes no NaN, so the other file is one just past what a unit-vector difference can reach.
    past = source.replace('-6.381165258675337e+149', '2.0001');
  assert.notEqual(source, rigFixture({ skin: false, animation: false }), 'the fixture lost its shape');
  for (const text of [source, past]) {
    const { doc, accessor } = readGLB(await convertFBX(bytes(text))),
      target = doc.meshes[0].primitives[0].targets[0],
      normals = accessor(target.NORMAL),
      positions = accessor(target.POSITION);
    // Vertex 1 rises out of the plane: the triangle's normal turns from +Z to (-1, 0, 1) / sqrt 2 at every corner.
    assert.equal(normals.length, 9);
    for (let v = 0; v < 3; v++) {
      assert.ok(Math.abs(normals[v * 3] + Math.SQRT1_2) < 1e-6, `x of vertex ${v}: ${normals[v * 3]}`);
      assert.ok(Math.abs(normals[v * 3 + 1]) < 1e-6);
      assert.ok(Math.abs(normals[v * 3 + 2] - (Math.SQRT1_2 - 1)) < 1e-6, `z of vertex ${v}: ${normals[v * 3 + 2]}`);
    }
    assert.deepEqual(Array.from(positions), [0, 0, 0, 0, 0, 1, 0, 0, 0]);
  }
});

test('a curve on the scene root that holds it at rest is left out; one that moves it is refused', async () => {
  // Character Creator 4 keys object 0, the root, which has no node of its own, once at zero translation.
  const root = (value) =>
    rigFixture({
      morph: false,
      extraModel: `AnimationCurveNode: 40, "AnimCurveNode::T", "" {\n }\n AnimationCurve: 41, "AnimCurve::X", "" {\n  KeyTime: *1 {\n a: 0\n}\n  KeyValueFloat: *1 {\n a: ${value}\n}\n  KeyAttrFlags: *1 {\n a: 4\n}\n }`,
      extraConnections: 'C: "OO",40,31\n C: "OP",40,0,"Lcl Translation"\n C: "OP",41,40,"d|X"',
    });
  const plain = readGLB(await convertFBX(bytes(rigFixture({ morph: false })))).doc,
    { doc } = readGLB(await convertFBX(bytes(root(0))));
  assert.deepEqual(doc.animations, plain.animations);
  await assert.rejects(convertFBX(bytes(root(5))), /not a model/);
  // With the layers entry every curve can say its value between keys, and one key still holds the root at rest.
  const layered = { extensions: [animationLayers] };
  assert.deepEqual(
    readGLB(await convertFBX(bytes(root(0)), layered)).doc.animations,
    readGLB(await convertFBX(bytes(rigFixture({ morph: false })), layered)).doc.animations,
  );
  await assert.rejects(convertFBX(bytes(root(5)), layered), /not a model/);
});
