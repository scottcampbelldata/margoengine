// A rig and clip authored from raw arrays, written by @margoengine/exporters and read back by gltf-pro + Animation
// (a PBRModel without engine.use, since parseGLTF's setup needs WebGPU):
// the posed vertices of the reimported glTF match this package's CPU skinning at fixed times.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { GLTFAsset, PBRModel } from '../../gltf-pro/dist/index.js';
import { exportGLB } from '../../exporters/dist/index.js';
import { invertMatrix, multiplyMatrices } from '../../math/dist/mat4.js';
import { Animation, Skeleton, Skin, applyKeyframeClip, bakeKeyframeClip, createKeyframeClip } from '../dist/index.js';

const sz = (degrees) => [0, 0, Math.sin((degrees * Math.PI) / 360), Math.cos((degrees * Math.PI) / 360)];

test('a skinned, animated quad strip survives exportGLB, parseGLTF and Animation at fixed times within 1e-4', async () => {
  const bones = [
    { name: 'root', parent: -1, scale: [1, 1, 1] },
    { name: 'mid', parent: 0, translation: [0, 1, 0] },
    { name: 'tip', parent: 1, translation: [0, 1, 0], rotation: sz(10) },
  ];
  const skeleton = new Skeleton(bones);
  // Two columns, four rows (y = 0..3); weights shift from root to tip up the strip and are not pre-normalised.
  const positions = [],
    normals = [],
    uvs = [],
    joints = [],
    weights = [],
    indices = [];
  const rows = [
    [0, 0, 1, 0],
    [0, 1, 2, 2],
    [1, 2, 1, 3],
    [2, 0, 1, 0],
  ];
  for (let y = 0; y < 4; y++)
    for (const x of [-0.5, 0.5]) {
      positions.push(x, y, 0);
      normals.push(0, 0, 1);
      uvs.push(x + 0.5, y / 3);
      const [a, b, wa, wb] = rows[y];
      joints.push(a, b, 0, 0);
      weights.push(wa, wb, 0, 0);
    }
  for (let y = 0; y < 3; y++) indices.push(y * 2, y * 2 + 1, y * 2 + 2, y * 2 + 2, y * 2 + 1, y * 2 + 3);
  const skin = new Skin(skeleton, joints, weights);
  const clip = createKeyframeClip({
    name: 'Bend',
    tracks: [
      {
        target: 'mid',
        path: 'rotation',
        keys: [
          { time: 0, value: sz(0), interpolation: 'easeInOut' },
          { time: 1, value: sz(80), interpolation: 'linear' },
          { time: 2, value: sz(-30) },
        ],
      },
      {
        target: 'tip',
        path: 'translation',
        keys: [
          { time: 0, value: [0, 1, 0], interpolation: 'discrete' },
          { time: 0.5, value: [0.25, 1.5, 0], interpolation: 'easeOut' },
          { time: 2, value: [0, 1, 0] },
        ],
      },
      {
        target: 'root',
        path: 'scale',
        keys: [
          { time: 0, value: [1, 1, 1], interpolation: 'easeIn' },
          { time: 2, value: [1.5, 0.75, 1] },
        ],
      },
    ],
  });

  // Bones become export nodes under the skinned mesh node, which is moved to show skeleton space survives.
  const nodes = bones.map(({ name, translation, rotation, scale }) => ({ name, translation, rotation, scale }));
  bones.forEach(({ parent }, i) => parent >= 0 && (nodes[parent].children ??= []).push(nodes[i]));
  const mesh = {
    name: 'strip',
    translation: [2, -1, 0.5],
    geometry: { positions, normals, uvs, indices, joints, weights },
    skin: { joints: nodes, inverseBindMatrices: Array.from(skeleton.inverseBindMatrices) },
    children: [nodes[skeleton.root]],
  };
  const glb = exportGLB({
    nodes: [mesh],
    animations: [bakeKeyframeClip(clip, 30, (target) => nodes[skeleton.index(target)])],
  });

  const engine = new Engine(
      { width: 1, height: 1, getContext() {} },
      await TransformStore.create(64),
      { backend: 'webgl2', add() {}, remove() {}, dispose() {}, render() {} },
      undefined,
      null,
    ),
    view = new DataView(glb.buffer, glb.byteOffset),
    json = view.getUint32(12, true),
    model = new PBRModel(
      engine,
      new GLTFAsset(
        JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + json))),
        [],
        glb.subarray(28 + json, 28 + json + view.getUint32(20 + json, true)),
      ),
    ),
    animation = new Animation(model, { loop: false }).play('Bend'),
    doc = model.asset.doc,
    primitive = model.primitives[0],
    attributes = doc.meshes[0].primitives[0].attributes,
    jointIds = model.asset.accessor(attributes.JOINTS_0, 'VEC4'),
    jointWeights = model.asset.accessor(attributes.WEIGHTS_0, 'VEC4'),
    inverseBinds = model.asset.accessor(doc.skins[0].inverseBindMatrices, 'MAT4'),
    skinNodes = doc.skins[0].joints.map((id) => model.nodes[id]);
  for (let v = 0; v < 8; v++)
    assert.deepEqual(Array.from(primitive.vertices.subarray(v * 20, v * 20 + 3)), positions.slice(v * 3, v * 3 + 3));
  const toMesh = new Float64Array(16),
    joint = new Float64Array(16),
    matrix = new Float64Array(16);
  // Frame times at 30 fps (incl. inside eased segments) and every key time.
  for (const t of [0, 0.2, 0.5, 2 / 3, 1, 1.4, 1.5, 2]) {
    animation.seek(t);
    engine.store.tick(false);
    invertMatrix(primitive.node.matrix, toMesh);
    applyKeyframeClip(clip, skeleton, t);
    const ours = skin.pose(positions).positions;
    for (let v = 0; v < 8; v++) {
      const blended = [0, 0, 0];
      for (let c = 0; c < 4; c++) {
        const w = jointWeights[v * 4 + c];
        if (!w) continue;
        const k = jointIds[v * 4 + c];
        multiplyMatrices(skinNodes[k].matrix, inverseBinds.subarray(k * 16, k * 16 + 16), joint);
        multiplyMatrices(toMesh, joint, matrix);
        const [x, y, z] = positions.slice(v * 3, v * 3 + 3);
        for (let r = 0; r < 3; r++)
          blended[r] += w * (matrix[r] * x + matrix[4 + r] * y + matrix[8 + r] * z + matrix[12 + r]);
      }
      for (let r = 0; r < 3; r++)
        assert.ok(
          Math.abs(blended[r] - ours[v * 3 + r]) < 1e-4,
          `t=${t} vertex ${v}: glTF ${blended} vs ours ${Array.from(ours.subarray(v * 3, v * 3 + 3))}`,
        );
    }
  }
  // The pose actually moved the tip row.
  assert.ok(Math.abs(skin.pose(positions).positions[18] - positions[18]) > 0.1);
  animation.dispose();
  model.dispose();
  engine.dispose();
});
