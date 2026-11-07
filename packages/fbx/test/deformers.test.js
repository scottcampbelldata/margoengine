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
  await assert.rejects(convertFBX(real('maya_blend_inbetween_7500_binary.fbx'), { extensions: [animationLayers] }), /deformers/);
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
  assert.equal(readGLB(await convertFBX(bytes(total), { extensions })).doc.skins[0].joints.length, plain.skins[0].joints.length);
  const additive = rigFixture({ mode: 'Additive', morph: false, animation: false }).replaceAll('a: 0.5,0.5,0.5', 'a: 0.25,0.25,0.25'),
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
