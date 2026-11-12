// The README runner's test character (scripts/support/readme-humanoid.mjs, KB1867c): a valid glTF 2.0 skin whose bone
// names the rigging presets recognise, with the face shapes, correctives, extra bones and clips the rigging README
// examples look up by name, and a VRM avatar that checks clean.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { splitGLB } from '../packages/exporters/dist/index.js';
import { detectSkeleton, humanoidBones } from '../packages/rigging/dist/retarget.js';
import { checkVRM, readVRM, VRM_REQUIRED_BONES } from '../packages/rigging/dist/vrm.js';
import { faceShapeOf } from '../packages/rigging/dist/face.js';
import { ARKIT_SHAPES, AVATAR_SHAPES, humanoidGLB, writeReadmeRigs } from '../scripts/support/readme-humanoid.mjs';

for (const naming of ['mixamo', 'godot'])
  test(`${naming} naming: every bone the examples ask for is found by name`, () => {
    const { json } = splitGLB(humanoidGLB({ naming })),
      names = json.nodes.map((n) => n.name),
      match = detectSkeleton(names);
    assert.equal(match?.preset, naming);
    const bones = humanoidBones(names, naming);
    for (const bone of [...VRM_REQUIRED_BONES, 'upperChest', 'neck', 'leftShoulder', 'rightShoulder', 'leftToes'])
      assert.ok(bones.has(bone), `${bone} is missing`);
    for (const extra of ['Hair1', 'Hair2', 'Hair3', 'LeftEarring', 'Belly']) assert.ok(names.includes(extra), extra);
    // Each node's parent is the bone it hangs from, so a chain of joints is a chain of children.
    const parent = new Map(json.nodes.flatMap((n, i) => (n.children ?? []).map((c) => [c, i])));
    assert.equal(parent.get(bones.get('leftLowerArm')), bones.get('leftUpperArm'));
    assert.equal(parent.get(bones.get('leftHand')), bones.get('leftLowerArm'));
    assert.equal(parent.get(names.indexOf('Hair2')), names.indexOf('Hair1'));
    assert.equal(parent.get(names.indexOf('Hair1')), bones.get('head'));
    assert.deepEqual(
      json.animations.map((a) => a.name),
      ['Idle', 'Walk'],
    );
    assert.equal(json.skins[0].joints.length, names.length - 2, 'every bone a joint; Body and Face are not');
  });

test('the face carries the 52 ARKit shapes, the body its correctives, under extras.targetNames', () => {
  const { json, bin } = splitGLB(humanoidGLB()),
    mesh = (name) => json.meshes[json.nodes.find((n) => n.name === name).mesh];
  assert.deepEqual(mesh('Face').extras.targetNames, ARKIT_SHAPES);
  assert.deepEqual(new Set(ARKIT_SHAPES.map(faceShapeOf)).size, 52, 'each name reads as its own face shape');
  assert.ok(mesh('Body').extras.targetNames.includes('LeftElbowFix'));
  for (const name of ['Body', 'Face']) {
    const [primitive] = mesh(name).primitives;
    assert.equal(primitive.targets.length, mesh(name).extras.targetNames.length);
    assert.equal(mesh(name).weights.length, primitive.targets.length);
  }
  // Every accessor lies inside its view, and every view inside the BIN chunk.
  for (const accessor of json.accessors) {
    const view = json.bufferViews[accessor.bufferView],
      size = { SCALAR: 1, VEC3: 3, VEC4: 4, MAT4: 16 }[accessor.type] * (accessor.componentType === 5123 ? 2 : 4);
    assert.ok(accessor.count * size <= view.byteLength);
    assert.ok(view.byteOffset + view.byteLength <= bin.byteLength);
  }
});

test('the VRM avatar holds every required bone and its face shapes under other names', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'readme-rigs-'));
  try {
    const rigs = new Map(await writeReadmeRigs(folder)),
      bytes = new Uint8Array(readFileSync(rigs.get('avatar.vrm'))),
      avatar = readVRM(bytes),
      { json } = splitGLB(bytes);
    assert.deepEqual(checkVRM(avatar, json), []);
    for (const bone of VRM_REQUIRED_BONES) assert.ok(avatar.humanoid.humanBones[bone], bone);
    const face = json.nodes.findIndex((n) => n.name === 'Face');
    assert.deepEqual(json.meshes[json.nodes[face].mesh].extras.targetNames, AVATAR_SHAPES);
    assert.equal(avatar.expressions.preset.aa.morphTargetBinds[0].index, AVATAR_SHAPES.indexOf('Mouth_Open'));
    for (const name of ['character.glb', 'rigged.glb', 'mixamo-walk.glb', 'godot-hero.glb'])
      assert.ok(rigs.has(name), name);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
