// KB-RIG-UENAMING1: the human table reads the Unreal mannequin and KayKit bone names, proven on the bundled models.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fitAnatomy } from '../dist/anatomy.js';
import { human } from '../dist/anatomy-human.js';

/** The skin's joints of a bundled GLB as rig joints: names, parents among the joints and rest positions in the world. */
function skinRig(file) {
  const bytes = readFileSync(new URL(`../../../examples/assets/${file}`, import.meta.url));
  assert.equal(bytes.toString('latin1', 0, 4), 'glTF', `${file} is not a GLB (git lfs checkout)`);
  const { nodes, skins } = JSON.parse(bytes.toString('utf8', 20, 20 + bytes.readUInt32LE(12)));
  const parent = new Map(nodes.flatMap((node, i) => (node.children ?? []).map((child) => [child, i])));
  const turn = ([x, y, z, w], [a, b, c]) => {
    const u = 2 * (y * c - z * b),
      v = 2 * (z * a - x * c),
      t = 2 * (x * b - y * a);
    return [a + w * u + y * t - z * v, b + w * v + z * u - x * t, c + w * t + x * v - y * u];
  };
  const place = (i) => {
    let point = [0, 0, 0];
    for (let n = i; n !== undefined; n = parent.get(n)) {
      const { translation = [0, 0, 0], rotation = [0, 0, 0, 1], scale = [1, 1, 1], matrix } = nodes[n];
      assert.equal(matrix, undefined, `${file}: node ${n} holds a matrix`);
      point = turn(
        rotation,
        point.map((value, k) => value * scale[k]),
      ).map((value, k) => value + translation[k]);
    }
    return point;
  };
  const joints = skins[0].joints;
  return joints.map((node) => ({
    name: nodes[node].name,
    parent: joints.indexOf(parent.get(node)),
    position: place(node),
  }));
}

const named = (rig) => {
  const found = human.naming(rig.map((joint) => joint.name));
  return [found.preset, Object.fromEntries([...found.joints].map(([id, bone]) => [id, rig[bone].name]))];
};

test('the bundled Quaternius mannequin is read by its Unreal mannequin names and fits', () => {
  const rig = skinRig('quaternius/UAL1_Standard_RM.glb');
  const [preset, map] = named(rig);
  assert.equal(preset, 'unreal');
  assert.equal(Object.keys(map).length, 52, 'every bone but root and the nine leaf ends');
  const want = {
    humanoid_root: 'pelvis',
    vl5: 'spine_01',
    vt6: 'spine_03',
    vc7: 'neck_01',
    vc1: 'Head',
    l_shoulder: 'upperarm_l',
    r_elbow: 'lowerarm_r',
    l_radiocarpal: 'hand_l',
    r_carpometacarpal_1: 'thumb_01_r',
    l_metacarpophalangeal_5: 'pinky_01_l',
    r_carpal_distal_interphalangeal_2: 'index_03_r',
    l_hip: 'thigh_l',
    r_knee: 'calf_r',
    l_talocrural: 'foot_l',
    r_metatarsophalangeal_1: 'ball_r',
  };
  for (const [id, bone] of Object.entries(want)) assert.equal(map[id], bone, id);
  const body = fitAnatomy(rig, { species: human });
  assert.equal(body.preset, 'unreal');
  assert.ok(body.stature > 1.5 && body.stature < 2.1, `stature ${body.stature}`);
});

// KB-RIG-MAPWINS1: a map that places a bone the naming also read (spine_01 as vl3, where the naming reads vl5) threw
// "mapped to both"; the bone is the map's.
test('an explicit map wins over the naming for the bones it places', () => {
  const rig = skinRig('quaternius/UAL1_Standard_RM.glb');
  const body = fitAnatomy(rig, { species: human, map: { vl3: 'spine_01', vt12: 'spine_02' } }),
    name = (id) => rig[body.joints[body.index.get(id)].bone].name;
  assert.equal(name('vl3'), 'spine_01');
  assert.equal(name('vt12'), 'spine_02');
  assert.equal(body.joints.filter((j) => rig[j.bone].name === 'spine_01').length, 1);
});

test('every bundled KayKit character is read by its bone names and fits', () => {
  for (const who of ['Barbarian', 'Knight', 'Mage', 'Ranger', 'Rogue', 'Rogue_Hooded']) {
    const rig = skinRig(`kaykit/adventurers/characters/${who}.glb`);
    const [preset, map] = named(rig);
    assert.equal(preset, 'kaykit', who);
    assert.equal(Object.keys(map).length, 18, `${who}: every bone but root and the two hand slots and hands`);
    assert.equal(map.humanoid_root, 'hips');
    assert.equal(map.l_radiocarpal, 'wrist.l', 'the wrist is the bone under the forearm');
    assert.equal(map.r_hip, 'upperleg.r');
    assert.equal(map.l_metatarsophalangeal_1, 'toes.l');
    assert.equal(fitAnatomy(rig, { species: human }).preset, 'kaykit', who);
  }
});

test('a five-bone Unreal spine is its own naming', () => {
  const names = ['root', 'pelvis', 'spine_01', 'spine_02', 'spine_03', 'spine_04', 'spine_05', 'neck_01', 'neck_02'];
  names.push('head', 'thigh_l', 'thigh_r', 'index_metacarpal_l', 'index_01_l');
  const found = human.naming(names);
  assert.equal(found.preset, 'unreal5');
  const at = (id) => names[found.joints.get(id)];
  assert.deepEqual(['vl5', 'vl3', 'vt12', 'vt8', 'vt4', 'vc7', 'vc4'].map(at), [
    ...['spine_01', 'spine_02', 'spine_03', 'spine_04', 'spine_05'],
    ...['neck_01', 'neck_02'],
  ]);
  assert.equal(at('l_carpometacarpal_2'), 'index_metacarpal_l');
  assert.equal(at('l_metacarpophalangeal_2'), 'index_01_l');
});
