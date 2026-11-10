// Clean-room spec fixtures plus DWANGO's real VRM 0.51 model. No rival code.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { glbChunks, GLB_JSON } from '../../shared/glb.js';
import { convertVRM0, convertVRM0Bytes, loadVRM0, readVRM0 } from '../dist/vrm0.js';
import { readVRM, VRMExpressions, checkVRM, vrmSprings } from '../dist/vrm.js';
import { SpringBones } from '../dist/springs.js';

const bytes = new Uint8Array(
  readFileSync(new URL('../../../examples/assets/vrm/AliciaSolid_vrm-0.51.vrm', import.meta.url)),
);
const json = (data) => JSON.parse(new TextDecoder().decode(glbChunks(data)[0].data));
function fixture() {
  const bones = [
    'hips',
    'spine',
    'head',
    'leftUpperLeg',
    'leftLowerLeg',
    'leftFoot',
    'rightUpperLeg',
    'rightLowerLeg',
    'rightFoot',
    'leftUpperArm',
    'leftLowerArm',
    'leftHand',
    'rightUpperArm',
    'rightLowerArm',
    'rightHand',
    'leftThumbProximal',
    'leftThumbIntermediate',
    'leftThumbDistal',
  ];
  const nodes = bones.map((name) => ({ name }));
  for (const [p, children] of [
    [0, [1, 3, 6]],
    [1, [2, 9, 12]],
    [3, [4]],
    [4, [5]],
    [6, [7]],
    [7, [8]],
    [9, [10]],
    [10, [11]],
    [12, [13]],
    [13, [14]],
    [11, [15]],
    [15, [16]],
    [16, [17]],
  ])
    nodes[p].children = children;
  nodes.push({ mesh: 0 }, { mesh: 0 });
  return {
    asset: { version: '2.0' },
    nodes,
    meshes: [{ primitives: [{ targets: [{}, {}] }] }],
    materials: [{ name: 'Face' }],
    scenes: [{ nodes: [0, 18, 19] }, { nodes: [0] }],
    scene: 0,
    extensionsUsed: ['VRM', 'EXAMPLE'],
    extensionsRequired: ['VRM'],
    extensions: {
      EXAMPLE: { retain: true },
      VRM: {
        specVersion: '0.0',
        meta: { title: 'Spec fixture', author: 'Margo', licenseName: 'CC0' },
        humanoid: { humanBones: bones.map((bone, node) => ({ bone, node })) },
        blendShapeMaster: {
          blendShapeGroups: [
            {
              name: 'smile',
              presetName: 'joy',
              binds: [{ mesh: 0, index: 1, weight: 37.5 }],
              materialValues: [
                { materialName: 'Face', propertyName: '_Color', targetValue: [0.2, 0.3, 0.4, 0.5] },
                { materialName: 'Face', propertyName: '_MainTex', targetValue: [2, 3, 0.1, 0.2] },
              ],
            },
            { name: 'Custom', presetName: 'unknown', isBinary: true },
          ],
        },
        firstPerson: {
          firstPersonBone: 2,
          firstPersonBoneOffset: { x: 0.1, y: 0.2, z: 0.3 },
          meshAnnotations: [{ mesh: 0, firstPersonFlag: 'ThirdPersonOnly' }],
          lookAtTypeName: 'BlendShape',
          lookAtVerticalUp: { xRange: 40, yRange: 0.8, curve: [0, 0, 1, 1] },
        },
      },
    },
  };
}

test('real 0.51 avatar converts every mapped bone, expression, annotation, collider and spring', () => {
  const before = json(bytes),
    original = structuredClone(before),
    result = convertVRM0(bytes),
    { avatar, document, legacy } = result;
  assert.equal(avatar.meta.name, 'Alicia Solid');
  assert.equal(avatar.meta.licenseUrl, before.extensions.VRM.meta.otherLicenseUrl);
  assert.deepEqual(legacy, before.extensions.VRM);
  assert.deepEqual(avatar.extras.vrm0, legacy);
  assert.deepEqual(before, original);
  assert.deepEqual(checkVRM(avatar, document), []);
  assert.equal(Object.keys(avatar.humanoid.humanBones).length, legacy.humanoid.humanBones.length);
  assert.equal(
    Object.keys(avatar.expressions.preset).length + Object.keys(avatar.expressions.custom).length,
    legacy.blendShapeMaster.blendShapeGroups.length,
  );
  assert.equal(
    avatar.springBone.colliders.length,
    legacy.secondaryAnimation.colliderGroups.reduce((n, g) => n + g.colliders.length, 0),
  );
  assert.equal(avatar.springBone.springs.length, 48);
  const parents = document.nodes.map(() => -1);
  document.nodes.forEach((n, i) => n.children?.forEach((c) => (parents[c] = i)));
  const springs = new SpringBones(parents, vrmSprings(avatar));
  assert.equal(springs.bones().length, 48);
  for (const [index, node] of before.nodes.entries()) {
    const converted = document.nodes[index];
    for (const [key, value] of Object.entries(node))
      if (key !== 'children') assert.deepEqual(converted[key], value, `node ${index} ${key}`);
  }
  assert.deepEqual(document.accessors, before.accessors);
  assert.deepEqual(document.bufferViews, before.bufferViews);
});

test('thumb rename, all mesh instances, fractional morphs, texture V and original inputs', () => {
  const source = fixture(),
    original = structuredClone(source),
    { avatar, document } = convertVRM0(source);
  assert.deepEqual(source, original);
  assert.deepEqual(avatar.humanoid.humanBones.leftThumbMetacarpal, { node: 15 });
  assert.deepEqual(avatar.humanoid.humanBones.leftThumbProximal, { node: 16 });
  assert.equal(avatar.humanoid.humanBones.leftThumbIntermediate, undefined);
  assert.deepEqual(avatar.expressions.preset.happy.morphTargetBinds, [
    { node: 18, index: 1, weight: 0.375 },
    { node: 19, index: 1, weight: 0.375 },
  ]);
  const expressions = new VRMExpressions(avatar);
  expressions.set('happy', 1).set('Custom', 0.51);
  assert.equal(expressions.evaluate().morphs.length, 2);
  assert.deepEqual(avatar.expressions.preset.happy.materialColorBinds[0].targetValue, [0.2, 0.3, 0.4, 0.5]);
  assert.deepEqual(avatar.expressions.preset.happy.textureTransformBinds[0], {
    material: 0,
    scale: [2, 3],
    offset: [0.1, -2.2],
  });
  assert.deepEqual(avatar.firstPerson.meshAnnotations, [
    { node: 18, type: 'thirdPersonOnly' },
    { node: 19, type: 'thirdPersonOnly' },
  ]);
  assert.deepEqual(avatar.lookAt.offsetFromHeadBone, [0.1, 0.2, -0.3]);
  assert.deepEqual(avatar.lookAt.rangeMapVerticalUp, { inputMaxValue: 40, outputScale: 0.8 });
  assert.equal(avatar.lookAt.type, 'expression');
  assert.deepEqual(document.extensions.EXAMPLE, { retain: true });
  assert.deepEqual(document.extensionsRequired, []);
  assert.ok(!document.extensionsUsed.includes('VRM'));
  assert.equal(document.extensions.VRM, undefined);
  const firstRoot = document.scenes[0].nodes[0];
  assert.equal(document.scenes[1].nodes[0], firstRoot);
  assert.deepEqual(document.nodes[firstRoot].rotation, [0, 1, 0, 0]);
  assert.deepEqual(document.nodes[firstRoot].children, [0]);
  avatar.extras.vrm0.meta.title = 'Changed';
  assert.equal(source.extensions.VRM.meta.title, 'Spec fixture');
});

test('every legacy preset is renamed, including blink sides; custom names survive', () => {
  const source = fixture();
  const names = [
    'neutral',
    'a',
    'i',
    'u',
    'e',
    'o',
    'blink',
    'joy',
    'angry',
    'sorrow',
    'fun',
    'lookup',
    'lookdown',
    'lookleft',
    'lookright',
    'blink_l',
    'blink_r',
  ];
  source.extensions.VRM.blendShapeMaster.blendShapeGroups = names.map((presetName) => ({ presetName }));
  assert.deepEqual(Object.keys(readVRM0(source).expressions.preset), [
    'neutral',
    'aa',
    'ih',
    'ou',
    'ee',
    'oh',
    'blink',
    'happy',
    'angry',
    'sad',
    'relaxed',
    'lookUp',
    'lookDown',
    'lookLeft',
    'lookRight',
    'blinkLeft',
    'blinkRight',
  ]);
});

test('branching springs include every original joint exactly once and keep vector spaces distinct', () => {
  const source = fixture();
  source.nodes.push(
    { translation: [0, 0.2, 0], children: [21, 22] },
    { translation: [0.1, 0.1, 0] },
    { translation: [-0.1, 0.1, 0] },
  );
  source.nodes[2].children = [20];
  source.extensions.VRM.secondaryAnimation = {
    colliderGroups: [{ node: 2, colliders: [{ offset: { x: 0.1, y: 0.2, z: 0.3 }, radius: 0.04 }] }],
    boneGroups: [
      {
        bones: [20],
        center: 2,
        stiffiness: 2.3,
        gravityPower: 0.4,
        gravityDir: { x: 0.3, y: -1, z: 0.5 },
        colliderGroups: [0],
      },
    ],
  };
  const { document, avatar } = convertVRM0(source),
    data = avatar.springBone;
  assert.deepEqual(data.colliders[0].shape.sphere, { offset: [0.1, 0.2, -0.3], radius: 0.04 });
  assert.deepEqual(
    data.springs.map((s) => s.joints[0].node),
    [20, 21, 22],
  );
  assert.deepEqual(data.springs[0].joints[0].gravityDir, [-0.3, -1, 0.5]);
  assert.equal(data.springs[0].joints[0].stiffness, 2.3);
  const parents = document.nodes.map(() => -1);
  document.nodes.forEach((n, i) => n.children?.forEach((c) => (parents[c] = i)));
  assert.deepEqual(new SpringBones(parents, vrmSprings(avatar)).bones(), [20, 21, 22]);
  const tip = document.nodes[data.springs[1].joints[1].node].translation;
  assert.ok(Math.abs(Math.hypot(...tip) - 0.07) < 1e-15);
});

test('non-head first-person anchors are rebased through the original hierarchy', () => {
  const source = fixture();
  source.nodes[1].translation = [0, 1, 0];
  source.nodes[2].translation = [0, 0.3, 0];
  source.extensions.VRM.firstPerson.firstPersonBone = 1;
  const offset = readVRM0(source).lookAt.offsetFromHeadBone;
  assert.ok(Math.abs(offset[1] + 0.1) < 1e-12);
  assert.equal(offset[0], 0.1);
  assert.equal(offset[2], -0.3);
});

test('binary conversion preserves BIN and unknown chunks byte for byte and reads via the 1.0 entry', () => {
  const result = convertVRM0Bytes(bytes),
    before = glbChunks(bytes),
    after = glbChunks(result);
  assert.equal(after[0].type, GLB_JSON);
  for (let i = 1; i < before.length; i++) assert.deepEqual(after[i], before[i]);
  assert.equal(readVRM(result).meta.name, 'Alicia Solid');
  const padded = new Uint8Array(bytes.length + 9);
  padded.set(bytes, 3);
  assert.deepEqual(convertVRM0Bytes(padded.subarray(3, 3 + bytes.length)), result);
  assert.deepEqual(
    bytes,
    new Uint8Array(readFileSync(new URL('../../../examples/assets/vrm/AliciaSolid_vrm-0.51.vrm', import.meta.url))),
  );
});

test('missing, ambiguous and invalid documents fail with a coded, linked error', () => {
  const reject = (edit) => {
    const doc = fixture();
    edit(doc);
    assert.throws(
      () => convertVRM0(doc),
      (e) => e.code === 'failed' && e.message.includes('https://margoengine.com/errors#failed'),
    );
  };
  reject((d) => delete d.extensions.VRM);
  reject((d) => (d.extensions.VRM.specVersion = '2.0'));
  reject((d) => (d.extensions.VRMC_vrm = {}));
  reject((d) => (d.nodes[2].children = [0]));
  reject((d) => d.nodes[0].children.push(2));
  reject((d) => (d.extensions.VRM.humanoid.humanBones[0].node = 900));
  reject((d) => d.extensions.VRM.humanoid.humanBones.push({ bone: 'hips', node: 0 }));
  reject((d) => (d.extensions.VRM.blendShapeMaster.blendShapeGroups[0].binds[0].mesh = 3));
  reject((d) => (d.extensions.VRM.blendShapeMaster.blendShapeGroups[0].binds[0].weight = 101));
  reject((d) => (d.extensions.VRM.blendShapeMaster.blendShapeGroups[0].materialValues[0].materialName = 'Absent'));
  reject((d) => d.extensions.VRM.blendShapeMaster.blendShapeGroups.push({ presetName: 'joy' }));
  assert.throws(() => convertVRM0Bytes(new Uint8Array(12)));
});

test('load cancellation precedes fetch and bounded fetching refuses oversized data', async () => {
  const controller = new AbortController(),
    reason = new Error('stop');
  controller.abort(reason);
  await assert.rejects(
    loadVRM0({}, 'unused.vrm', { signal: controller.signal, fetch: () => assert.fail('must not fetch') }),
    (e) => e === reason,
  );
  await assert.rejects(loadVRM0({}, bytes, { maxDownloadBytes: 10 }), /maxDownloadBytes/);
  await assert.rejects(
    loadVRM0({}, 'large.vrm', { maxDownloadBytes: 16, fetch: async () => new Response(bytes) }),
    /byte budget|maximum|exceed/i,
  );
});
