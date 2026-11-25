// Skinning modes and in-between shapes against the frames Maya wrote out as OBJ (test/fixtures/real).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { encodeDualQuaternions, skinDualQuaternion } from '@margoengine/animation/dqs';
import { convertFBX } from '../dist/index.js';
import { deformers, inbetweenWeight } from '../dist/deformers.js';
import { animationLayers } from '../dist/layers.js';
import { farthest, objVertices, posed, skinInputs } from './frame-truth.js';
import { readGLB, rigFixture } from './native-scene-helper.js';

const real = (name) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/real', name));
const extensions = [deformers, animationLayers];
const FPS = 24;

test('in-between shapes: all four frames Maya wrote', async () => {
  const glb = await convertFBX(real('maya_blend_inbetween_7500_binary.fbx'), { extensions });
  for (const frame of [1, 30, 65, 120]) {
    const obj = objVertices(real(`maya_blend_inbetween_${frame}.obj`).toString());
    const ours = posed(glb, frame / FPS);
    const off = farthest(ours, obj, 100);
    assert.ok(off < 1e-3, `frame ${frame} is ${off} cm off`);
  }
});

test('the base reader names the entry for a progressive channel', async () => {
  await assert.rejects(
    convertFBX(real('maya_blend_inbetween_7500_binary.fbx'), { extensions: [animationLayers] }),
    /deformers/,
  );
});

test('between stops a channel walks in straight lines, with the base shape a stop at 0', () => {
  const stops = [50, 100];
  assert.equal(inbetweenWeight(stops, 50, 25), 0.5);
  assert.equal(inbetweenWeight(stops, 100, 25), 0);
  assert.equal(inbetweenWeight(stops, 50, 75), 0.5);
  assert.equal(inbetweenWeight(stops, 100, 75), 0.5);
  assert.equal(inbetweenWeight(stops, 100, 150), 2);
  assert.equal(inbetweenWeight(stops, 50, 150), -1);
});

test('Maya blended skin: linear alone misses frames that the dual quaternion share meets', async () => {
  const glb = await convertFBX(real('maya_dq_weights_7500_binary.fbx'), { extensions }),
    { doc } = readGLB(glb),
    node = doc.nodes.find((n) => n.skin !== undefined);
  assert.equal(node.extras.fbxSkinning.type, 'Blend');
  assert.ok(node.extras.fbxSkinning.blendWeights.some((v) => v > 0));
  for (const frame of [10, 18]) {
    const obj = objVertices(real(`maya_dq_weights_${frame}.obj`).toString()),
      time = frame / FPS,
      linear = posed(glb, time),
      { palette, joints, weights, positions } = skinInputs(glb, time),
      slots = encodeDualQuaternions(Float32Array.from(palette), new Float32Array(palette.length)),
      share = node.extras.fbxSkinning.blendWeights,
      blended = linear.map((p, v) => {
        const dq = skinDualQuaternion(
          slots,
          joints.subarray(v * 4, v * 4 + 4),
          weights.subarray(v * 4, v * 4 + 4),
          positions.subarray(v * 3, v * 3 + 3),
        ).position;
        return p.map((c, k) => c * (1 - share[v]) + dq[k] * share[v]);
      }),
      linearOff = farthest(linear, obj, 100),
      blendedOff = farthest(blended, obj, 100);
    assert.ok(blendedOff < linearOff / 2, `frame ${frame}: blended ${blendedOff}, linear ${linearOff}`);
    assert.ok(blendedOff < 0.05, `frame ${frame} is ${blendedOff} cm off`);
  }
});

test('total one clusters read as weights, and an additive vertex keeps its unweighted share at rest (stand-in)', async () => {
  const total = rigFixture({ mode: 'TotalOne', morph: false, animation: false }),
    bytes = (text) => new TextEncoder().encode(text),
    plain = readGLB(await convertFBX(bytes(rigFixture({ morph: false, animation: false })))).doc;
  await assert.rejects(convertFBX(bytes(total)), /cluster mode/);
  assert.equal(
    readGLB(await convertFBX(bytes(total), { extensions })).doc.skins[0].joints.length,
    plain.skins[0].joints.length,
  );
  const additive = rigFixture({ mode: 'Additive', morph: false, animation: false }).replaceAll(
      'a: 0.5,0.5,0.5',
      'a: 0.25,0.25,0.25',
    ),
    glb = await convertFBX(bytes(additive), { extensions }),
    { doc } = readGLB(glb);
  assert.equal(doc.skins[0].joints.length, 3);
  // A quarter on each of two joints, a half on the joint that stays.
  const weights = readGLB(glb).accessor(doc.meshes[0].primitives[0].attributes.WEIGHTS_0);
  assert.deepEqual([...weights.subarray(0, 4)].sort(), [0, 0.25, 0.25, 0.5]);
  // Nothing has moved, so the vertices stay where they were.
  const moved = posed(glb, 0);
  assert.ok(moved.every((p) => p.every(Number.isFinite)));
});

test('two additive skins on one skeleton both keep their joint that stays in the scene (stand-in)', async () => {
  const array = (name, values) => `${name}: *${values.length} {\n a: ${values.join(',')}\n}`,
    move = (x) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1],
    cluster = (n, name, transform, link) =>
      `Deformer: ${n}, "SubDeformer::${name}", "Cluster" {\n  Mode: "Additive"\n  ${array('Indexes', [0, 1, 2])}\n  ${array('Weights', [0.25, 0.25, 0.25])}\n  ${array('Transform', transform)}\n  ${array('TransformLink', link)}\n }`;
  // A second triangle bound to the same Root and Tip joints, with additive clusters of its own.
  const extraModel = `Geometry: 101, "Geometry::Second", "Mesh" {
  ${array('Vertices', [0, 0, 0, 1, 0, 0, 0, 1, 0])}
  ${array('PolygonVertexIndex', [0, 1, -3])}
 }
 Model: 102, "Model::Second", "Mesh" {
  Properties70: {
   P: "Lcl Translation", "Vector3D", "Vector", "A", 2,0,0
  }
 }
 Deformer: 110, "Deformer::SecondSkin", "Skin" {
 }
 ${cluster(111, 'SecondRoot', move(2), move(0))}
 ${cluster(112, 'SecondTip', move(1), move(1))}`;
  const extraConnections =
    'C: "OO",101,102\n C: "OO",102,0\n C: "OO",110,101\n C: "OO",111,110\n C: "OO",112,110\n C: "OO",3,111\n C: "OO",4,112';
  const text = rigFixture({
      mode: 'Additive',
      morph: false,
      animation: false,
      extraModel,
      extraConnections,
    }).replaceAll('a: 0.5,0.5,0.5', 'a: 0.25,0.25,0.25'),
    { doc } = readGLB(await convertFBX(new TextEncoder().encode(text), { extensions }));
  assert.equal(doc.skins.length, 2);
  const reached = new Set(),
    walk = (n) => {
      reached.add(n);
      for (const c of doc.nodes[n].children ?? []) walk(c);
    };
  for (const n of doc.scenes[doc.scene ?? 0].nodes) walk(n);
  for (const skin of doc.skins) {
    assert.equal(skin.joints.length, 3);
    // glTF 2.0 3.7.3: every joint is a node of the scene, so the joint that stays must be reachable from a root.
    for (const joint of skin.joints)
      assert.ok(reached.has(joint), `joint ${doc.nodes[joint].name} is not in the scene`);
  }
  assert.notEqual(doc.skins[0].joints[2], doc.skins[1].joints[2]);
});
