// The human table against its sources. Every number in it names where it was read; this file holds a second copy of
// each of those numbers, typed from the same sources, and the anatomical meaning of every motion of every joint, so a
// changed number, a flipped axis or a renamed joint fails here.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fitAnatomy } from '../dist/anatomy.js';
import {
  ANSUR2,
  ANSUR2_FEMALES,
  ANSUR2_MALES,
  CDC_AGES,
  CDC_MOTIONS,
  CDC_RANGE_OF_MOTION,
  DE_LEVA_1996,
  HUMAN_NAMINGS,
  HUMAN_SPINE_LEVELS,
  fitHuman,
  human,
  humanTable,
} from '../dist/anatomy-human.js';
import { bodyRig, cross, dot, unit } from './anatomy-fixtures.js';

const byId = new Map(human.joints.map((joint) => [joint.id, joint]));
const close = (a, b, tolerance, what) =>
  assert.ok(Math.abs(a - b) <= tolerance, `${what}: ${a} is not within ${tolerance} of ${b}`);
const both = (ids) => ids.flatMap((id) => [`l_${id}`, `r_${id}`]);

// ISO/IEC 19774-1:2019 figures 4.10 to 4.12, body joints only (the face joints of levels 3 and 4 are left to the face rig).
const LIMB2 = [
  ...['hip', 'knee', 'talocrural', 'tarsometatarsal_2', 'metatarsophalangeal_2', 'tarsal_distal_interphalangeal_2'],
  ...['sternoclavicular', 'acromioclavicular', 'shoulder', 'elbow', 'radiocarpal'],
  ...['carpometacarpal_1', 'metacarpophalangeal_1', 'carpal_interphalangeal_1'],
  ...[2, 3, 4, 5].flatMap((n) => [
    `carpometacarpal_${n}`,
    `metacarpophalangeal_${n}`,
    `carpal_proximal_interphalangeal_${n}`,
    `carpal_distal_interphalangeal_${n}`,
  ]),
];
const SPINE3 = [
  ...[5, 4, 3, 2, 1].map((n) => `vl${n}`),
  ...[12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map((n) => `vt${n}`),
  ...[7, 6, 5, 4, 3, 2, 1].map((n) => `vc${n}`),
];
const LOA = {
  1: [
    'humanoid_root',
    'sacroiliac',
    'vl5',
    'skullbase',
    ...both(['hip', 'knee', 'talocrural', 'metatarsophalangeal_2', 'shoulder', 'elbow', 'radiocarpal']),
  ],
  2: [
    'humanoid_root',
    'sacroiliac',
    'vl5',
    'vl3',
    'vl1',
    'vt10',
    'vt6',
    'vt1',
    'vc4',
    'vc2',
    'skullbase',
    ...both(LIMB2),
  ],
  3: ['humanoid_root', 'sacroiliac', ...SPINE3, 'skullbase', ...both(LIMB2)],
};
// Level 2 parents as the standard nests them.
const PARENT2 = {
  sacroiliac: 'humanoid_root',
  vl5: 'humanoid_root',
  vl3: 'vl5',
  vl1: 'vl3',
  vt10: 'vl1',
  vt6: 'vt10',
  vt1: 'vt6',
  vc4: 'vt1',
  vc2: 'vc4',
  skullbase: 'vc2',
  l_hip: 'sacroiliac',
  l_knee: 'l_hip',
  l_talocrural: 'l_knee',
  l_tarsometatarsal_2: 'l_talocrural',
  l_metatarsophalangeal_2: 'l_tarsometatarsal_2',
  l_tarsal_distal_interphalangeal_2: 'l_metatarsophalangeal_2',
  l_sternoclavicular: 'vt1',
  l_acromioclavicular: 'l_sternoclavicular',
  l_shoulder: 'l_acromioclavicular',
  l_elbow: 'l_shoulder',
  l_radiocarpal: 'l_elbow',
  l_carpometacarpal_1: 'l_radiocarpal',
  l_metacarpophalangeal_1: 'l_carpometacarpal_1',
  l_carpal_interphalangeal_1: 'l_metacarpophalangeal_1',
  l_carpometacarpal_4: 'l_radiocarpal',
  l_metacarpophalangeal_4: 'l_carpometacarpal_4',
  l_carpal_proximal_interphalangeal_4: 'l_metacarpophalangeal_4',
  l_carpal_distal_interphalangeal_4: 'l_carpal_proximal_interphalangeal_4',
};

test('the table is the body of ISO/IEC 19774 level 4, rooted at humanoid_root', () => {
  assert.equal(human.id, 'human');
  assert.equal(human.joints[0].id, 'humanoid_root');
  assert.equal(human.joints.length, 139);
  assert.equal(new Set(human.joints.map((joint) => joint.id)).size, 139);
  assert.equal(LOA[1].length, 18);
  assert.equal(LOA[2].length, 71);
  assert.equal(LOA[3].length, 94 - 7);
  for (const level of [1, 2, 3])
    for (const id of LOA[level]) assert.ok(byId.has(id), `level ${level} joint ${id} is in the table`);
  const two = new Set(LOA[2]);
  for (const [id, parent] of Object.entries(PARENT2))
    for (const [at, want] of [
      [id, parent],
      [id.replace(/^l_/, 'r_'), parent.replace(/^l_/, 'r_')],
    ]) {
      let above = byId.get(at).parent;
      while (!two.has(above)) above = byId.get(above).parent;
      assert.equal(above, want, `${at} hangs from ${want} at level 2`);
    }
  for (const [id, segment] of Object.entries({
    l_hip: 'l_thigh',
    r_knee: 'r_calf',
    l_talocrural: 'l_talus',
    vl5: 'l5',
    vt12: 't12',
    vc1: 'c1',
    skullbase: 'skull',
    r_radiocarpal: 'r_carpal',
    l_midcarpal_4_5: 'l_hamate',
    l_sternoclavicular: 'l_clavicle',
  }))
    assert.equal(byId.get(id).segment, segment);
  assert.equal(byId.get('r_carpometacarpal_5').parent, 'r_midcarpal_4_5');
  assert.equal(byId.get('l_tarsometatarsal_5').parent, 'l_transversetarsal');
  for (const joint of human.joints) {
    assert.equal(joint.side, joint.id.startsWith('l_') ? 'left' : joint.id.startsWith('r_') ? 'right' : 'centre');
    if (joint.side !== 'centre') assert.equal(joint.mirror, (joint.side === 'left' ? 'r_' : 'l_') + joint.id.slice(2));
    assert.equal(joint.kind === 'free', ['humanoid_root', 'sacroiliac'].includes(joint.id));
  }
});

// What each named motion does to the body, standing in the neutral pose: x is the body's left, y up, z forward.
const UP = [0, 1, 0],
  DOWN = [0, -1, 0],
  FRONT = [0, 0, 1],
  BACK = [0, 0, -1];
function meaning(joint) {
  const out = joint.side === 'left' ? [1, 0, 0] : [-1, 0, 0],
    inward = [-out[0], 0, 0],
    name = joint.id.replace(/^[lr]_/, '');
  if (joint.side === 'centre')
    return { long: UP, tip: { flexion: FRONT, 'right bend': [-1, 0, 0] }, turn: ['left rotation', FRONT, [1, 0, 0]] };
  if (/^(sternoclavicular|acromioclavicular)$/.test(name))
    return {
      long: out,
      tip: { elevation: UP, 'upward rotation': UP, protraction: FRONT, 'internal rotation': FRONT },
      turn: [name[0] === 's' ? 'posterior rotation' : 'posterior tilt', UP, BACK],
    };
  if (/^(talocrural|talocalcaneonavicular|cuneonavicular|tarsometatarsal|calcaneocuboid|transversetarsal)/.test(name))
    return { long: FRONT, tip: { dorsiflexion: UP, abduction: out }, turn: ['inversion', inward, UP] };
  if (/^(metatarsophalangeal|tarsal_)/.test(name))
    return { long: FRONT, tip: { flexion: DOWN, abduction: out }, turn: ['inversion', inward, UP] };
  if (name === 'knee')
    return { long: DOWN, tip: { flexion: BACK, valgus: out }, turn: ['internal rotation', FRONT, inward] };
  if (name === 'hip' || name === 'shoulder')
    return { long: DOWN, tip: { flexion: FRONT, abduction: out }, turn: ['internal rotation', FRONT, inward] };
  if (name === 'elbow') return { long: DOWN, tip: { flexion: FRONT, valgus: out }, turn: ['pronation', FRONT, inward] };
  if (name === 'carpometacarpal_1')
    return {
      long: DOWN,
      tip: { 'palmar abduction': inward, 'radial abduction': FRONT },
      turn: ['pronation', FRONT, inward],
    };
  // The thumb's own joints flex across the palm: toward the palm and toward the little finger.
  if (name === 'metacarpophalangeal_1' || name === 'carpal_interphalangeal_1')
    return { long: DOWN, tip: { flexion: unit([inward[0], 0, -1]) }, turn: ['pronation', FRONT, inward] };
  // The wrist and fingers flex toward the palm, which faces the thigh; the thumb side of the hand is forward.
  return { long: DOWN, tip: { flexion: inward, 'radial deviation': FRONT }, turn: ['pronation', FRONT, inward] };
}

test('every motion of every joint turns the anatomical way', () => {
  let checked = 0;
  for (const joint of human.joints) {
    if (!joint.dofs) continue;
    const { long, tip, turn } = meaning(joint);
    assert.deepEqual(
      joint.long.map((v) => v + 0),
      long,
      `${joint.id} lies along its segment`,
    );
    // A right-hand turn about the axis moves the far end of the segment along axis x long.
    for (const dof of joint.dofs.slice(0, 2)) {
      const want = tip[dof.positive];
      if (!want) {
        assert.ok(
          ['abduction', 'radial deviation'].includes(dof.positive) && /_1$|phalange/.test(joint.id),
          `${joint.id} ${dof.positive} has no stated meaning`,
        );
        continue;
      }
      close(dot(cross(dof.axis, joint.long), want), 1, 1e-9, `${joint.id} ${dof.positive}`);
      checked++;
    }
    // A twist turns a mark on the segment: the front of a limb, the inner edge of a foot, the top of a collarbone.
    const [name, mark, want] = turn;
    assert.equal(joint.dofs[2].positive, name, `${joint.id} twist is named ${name}`);
    close(dot(cross(joint.dofs[2].axis, mark), want), 1, 1e-9, `${joint.id} ${name}`);
    checked++;
    for (const dof of joint.dofs) assert.notEqual(dof.positive, dof.negative);
  }
  assert.equal(
    checked,
    137 * 3 - 4,
    'every swing and twist but the side play of the four thumb hinges has a stated meaning',
  );
  // The two hinges Scott saw fold the wrong way, in plain words.
  assert.deepEqual(cross(byId.get('l_elbow').dofs[0].axis, DOWN), FRONT, 'an elbow flexes the forearm forward');
  assert.deepEqual(cross(byId.get('r_knee').dofs[0].axis, DOWN), BACK, 'a knee flexes the shank backward');
  assert.equal(byId.get('l_elbow').dofs[0].negative, 'hyperextension');
});

// The second copy of every number that is not read from a dataset file: source, what, value, how it was checked.
const o = 'online',
  r = 'recalled';
const CITED = {
  aaos1965: [
    ['thoracolumbar spine flexion', 80, o],
    ['thoracolumbar spine extension', 25, o],
    ['thoracolumbar spine lateral flexion, each side', 35, o],
    ['thoracolumbar spine rotation, each side', 45, o],
    ['cervical spine flexion', 45, o],
    ['cervical spine extension', 45, o],
    ['cervical spine lateral flexion, each side', 45, o],
    ['cervical spine rotation, each side', 60, o],
    ['hip flexion', 120, o],
    ['hip extension', 20, o],
    ['hip abduction', 40, o],
    ['hip adduction', 20, o],
    ['hip internal rotation', 45, o],
    ['hip external rotation', 45, o],
    ['knee flexion', 135, o],
    ['ankle dorsiflexion', 20, o],
    ['ankle plantar flexion', 50, o],
    ['foot inversion', 35, o],
    ['foot eversion', 15, o],
    ['forefoot abduction', 10, r],
    ['forefoot adduction', 20, r],
    ['great toe MTP flexion', 45, o],
    ['great toe MTP extension', 70, o],
    ['lesser toe MTP flexion', 40, r],
    ['lesser toe MTP extension', 40, r],
    ['great toe IP flexion', 90, r],
    ['lesser toe PIP flexion', 35, r],
    ['lesser toe DIP flexion', 60, r],
    ['lesser toe DIP extension', 30, r],
    ['shoulder flexion', 180, o],
    ['shoulder extension', 60, o],
    ['shoulder abduction', 180, o],
    ['shoulder internal rotation', 70, o],
    ['shoulder external rotation', 90, o],
    ['elbow flexion', 150, o],
    ['forearm pronation', 80, o],
    ['forearm supination', 80, o],
    ['wrist flexion', 80, o],
    ['wrist extension', 70, o],
    ['wrist radial deviation', 20, o],
    ['wrist ulnar deviation', 30, o],
    ['thumb CMC palmar abduction', 60, o],
    ['thumb MCP flexion', 50, o],
    ['thumb MCP extension', 0, o],
    ['thumb IP flexion', 80, o],
    ['thumb IP extension', 0, o],
    ['finger MCP flexion', 90, o],
    ['finger PIP flexion', 100, o],
    ['finger DIP flexion', 90, o],
    ['finger MCP hyperextension', 45, r],
    ['finger DIP hyperextension', 10, r],
  ],
  ama2000: [
    ['lumbar spine extension', 25, o],
    ['lumbar spine lateral flexion, each side', 25, o],
    ['thoracic spine rotation, each side', 30, o],
    ['cervical spine flexion', 50, o],
    ['cervical spine extension', 60, o],
    ['cervical spine lateral flexion, each side', 45, o],
    ['cervical spine rotation, each side', 80, o],
    ['hip flexion', 100, o],
    ['hip extension', 30, o],
    ['hip abduction', 40, o],
    ['hip adduction', 20, o],
    ['hip internal rotation', 40, o],
    ['hip external rotation', 50, o],
    ['knee flexion', 150, o],
    ['foot inversion', 30, o],
    ['foot eversion', 20, o],
    ['shoulder flexion', 180, o],
    ['shoulder extension', 50, o],
    ['shoulder abduction', 180, o],
    ['shoulder adduction', 50, o],
    ['shoulder internal rotation', 90, o],
    ['shoulder external rotation', 90, o],
    ['elbow flexion', 140, o],
    ['forearm pronation', 80, o],
    ['forearm supination', 80, o],
    ['wrist flexion', 60, o],
    ['wrist extension', 60, o],
    ['wrist radial deviation', 20, o],
    ['wrist ulnar deviation', 30, o],
    ['thumb CMC radial abduction', 50, o],
    ['thumb MP flexion', 60, o],
    ['thumb MP extension', 40, o],
    ['thumb IP flexion', 80, o],
    ['thumb IP extension', 30, o],
    ['finger MCP flexion', 90, o],
    ['finger PIP flexion', 100, o],
    ['finger DIP flexion', 70, o],
    ['finger MP extension', 20, o],
    ['finger PIP extension', 30, o],
    ['finger DIP extension', 30, o],
  ],
  dshs: [
    ['back flexion', 90, o],
    ['ankle dorsal flexion', 20, o],
    ['ankle plantar flexion', 40, o],
  ],
  hendriks2020: [
    ['shoulder adduction, added by the authors', 40, o],
    ['thumb CMC palmar abduction, added by the authors', 60, o],
    ['thumb CMC radial abduction, added by the authors', 60, o],
    ['finger MCP flexion, from Richard and Parry', 80, o],
    ['finger PIP flexion, from Richard and Parry', 90, o],
    ['finger DIP flexion, from Richard and Parry', 65, o],
    ['finger PIP extension, from Richard and Parry', 0, o],
    ['finger DIP extension, from Richard and Parry', 0, o],
  ],
  paraskevas2004: [
    ['carrying angle, women, mean 15.07 plus one standard deviation 4.95', 15.07 + 4.95, o],
    ['carrying angle, men, mean 10.97 plus one standard deviation 4.27', 10.97 + 4.27, o],
    ['carrying angle, all, mean', 12.88, o],
    ['carrying angle, all, standard deviation', 5.92, o],
    ['carrying angle, men, mean', 10.97, o],
    ['carrying angle, men, standard deviation', 4.27, o],
    ['carrying angle, women, mean', 15.07, o],
    ['carrying angle, women, standard deviation', 4.95, o],
  ],
  inman1944: [
    ['clavicular elevation during arm raising, about', 30, o],
    ['posterior rotation of the clavicle, about', 40, o],
    ['glenohumeral elevation for each degree of scapular upward rotation', 2, o],
    ['setting phase of abduction, degrees', 30, o],
    ['setting phase of flexion, degrees', 60, o],
    ['humeral elevation past which the clavicle mostly rotates', 90, o],
  ],
  ludewig2009: [
    ['sternoclavicular posterior rotation, average', 31, o],
    ['acromioclavicular posterior tilt, average', 19, o],
    ['scapular upward rotation on the clavicle, average', 11, r],
    ['scapular internal rotation on the clavicle, average', 8, r],
  ],
  kapandji: [
    ['tibial internal rotation, knee flexed 90 degrees', 30, r],
    ['tibial external rotation, knee flexed 90 degrees', 40, r],
    ['knee flexion at which tibial rotation is widest', 90, r],
    ['clavicular depression', 10, r],
    ['clavicular protraction', 15, r],
    ['clavicular retraction', 20, r],
    ['passive rotation at the wrist, each way', 10, r],
    ['thumb retroposition', 15, r],
    ['thumb adduction across the palm', 10, r],
    ['thumb rotation in opposition', 30, r],
    ['second carpometacarpal flexion', 2, r],
    ['third carpometacarpal flexion', 2, r],
    ['fourth carpometacarpal flexion', 15, r],
    ['fifth carpometacarpal flexion', 25, r],
    ['finger MCP abduction, each way', 20, r],
  ],
  bennell1998: [['ankle dorsiflexion bearing weight in a lunge, about', 45, r]],
  rijpkema1991: [['distal interphalangeal flexion as a fraction of proximal interphalangeal flexion', 2 / 3, r]],
  winter2009: [
    ['shoulder height, share of stature', 0.818, o],
    ['elbow height, arm hanging, share of stature', 0.63, o],
    ['wrist height, arm hanging, share of stature', 0.485, o],
    ['fingertip height, arm hanging, share of stature', 0.377, o],
    ['hip height, share of stature', 0.53, o],
    ['knee height, share of stature', 0.285, o],
    ['ankle height, share of stature', 0.039, o],
    ['upper arm length, share of stature', 0.186, o],
    ['forearm length, share of stature', 0.146, o],
    ['hand length, share of stature', 0.108, o],
    ['foot length, share of stature', 0.152, o],
  ],
  white1990: [
    ['thoracic spine flexion plus extension, total', 62, o],
    ['thoracic spine side bend to one side, total', 36, o],
    ['thoracic spine rotation to one side, total', 32.5, o],
  ],
  pearcy1984: [],
};
// The spine's levels: [joint, level, flexion plus extension, side bend to one side, rotation to one side].
const SPINE = {
  lumbar: [
    ['vl5', 'L5-S1', 17, 3, 2],
    ['vl4', 'L4-L5', 17, 6, 2],
    ['vl3', 'L3-L4', 15, 10, 2],
    ['vl2', 'L2-L3', 14, 10, 2],
    ['vl1', 'L1-L2', 12, 10, 2],
  ],
  thoracic: [
    ['vt12', 'T12-L1', 12, 8, 2],
    ['vt11', 'T11-T12', 12, 9, 2],
    ['vt10', 'T10-T11', 9, 7, 2],
    ['vt9', 'T9-T10', 6, 6, 4],
    ['vt8', 'T8-T9', 6, 6, 6],
    ['vt7', 'T7-T8', 6, 6, 7],
    ['vt6', 'T6-T7', 5, 6, 7],
    ['vt5', 'T5-T6', 4, 6, 8],
    ['vt4', 'T4-T5', 4, 6, 8],
    ['vt3', 'T3-T4', 4, 5, 8],
    ['vt2', 'T2-T3', 4, 6, 8],
    ['vt1', 'T1-T2', 4, 5, 9],
  ],
  cervical: [
    ['vc7', 'C7-T1', 9, 4, 2],
    ['vc6', 'C6-C7', 17, 7, 6],
    ['vc5', 'C5-C6', 20, 8, 7],
    ['vc4', 'C4-C5', 20, 11, 7],
    ['vc3', 'C3-C4', 15, 11, 7],
    ['vc2', 'C2-C3', 10, 10, 3],
    ['vc1', 'C1-C2', 20, 5, 40],
    ['skullbase', 'C0-C1', 25, 5, 5],
  ],
};
const MOTIONS = ['flexion plus extension', 'side bend to one side', 'rotation to one side'];
for (const [part, levels] of Object.entries(SPINE))
  for (const level of levels)
    MOTIONS.forEach((motion, m) => {
      const lumbar = part === 'lumbar' && !(m === 0 && level[0] === 'vl5');
      if (lumbar && m > 0) CITED.pearcy1984.push([`${level[1]} ${motion}, about`, level[2 + m], o]);
      else CITED.white1990.push([`${level[1]} ${motion}, representative`, level[2 + m], lumbar ? o : r]);
    });
const cited = new Map(
  Object.entries(CITED).flatMap(([source, rows]) =>
    rows.map(([what, value, provenance]) => [`${source}|${what}`, { value, provenance }]),
  ),
);

/** Every source row of the table, with where it sits. */
function* everyRow(table) {
  for (const joint of table.joints)
    for (const dof of joint.dofs ?? [])
      for (const [end, name] of [
        [dof.max, dof.positive],
        [dof.min, dof.negative],
      ])
        for (const row of end.rows) yield [row, `${joint.id} ${name}`, end];
  for (const norm of [...table.proportions, ...table.segments, ...table.couplings])
    for (const row of norm.rows) yield [row, norm.id, null];
}

test('every number is the one its source gives', () => {
  const used = new Set(),
    counts = { dataset: 0, print: 0, online: 0, recalled: 0 },
    seen = new Set();
  for (const [row, where] of everyRow(human)) {
    assert.ok(human.sources[row.source]?.cite, `${where}: source ${row.source} is cited in full`);
    const key = `${row.source}|${row.what}`;
    if (!seen.has(key)) counts[row.provenance]++;
    seen.add(key);
    if (row.provenance === 'dataset') {
      const sex = / women/.test(row.what) ? 'female' : 'male';
      if (row.source === 'cdc2011') {
        const [, motion, age] = /^(.+), (?:women|men) (\S+) years, mean$/.exec(row.what);
        assert.equal(row.file, 'packages/rigging/src/anatomy-data-cdc.ts');
        assert.equal(row.value, CDC_RANGE_OF_MOTION[sex][age][CDC_MOTIONS.indexOf(motion)][0], `${where}: ${row.what}`);
      } else if (row.source === 'ansur2') {
        const [, dimension] = /^(.+), (?:women|men), mean, cm$/.exec(row.what);
        assert.equal(row.file, 'packages/rigging/src/anatomy-data-ansur2.ts');
        assert.equal(row.value, ANSUR2[dimension][sex === 'female' ? 0 : 2], `${where}: ${row.what}`);
      } else {
        const [, segment, measure] = /^(\w+) (mass|centre)/.exec(row.what);
        assert.equal(row.source, 'deleva1996');
        assert.equal(row.file, 'packages/rigging/src/anatomy-data-deleva.ts');
        assert.equal(row.value, DE_LEVA_1996[segment][measure][sex === 'female' ? 0 : 1], `${where}: ${row.what}`);
      }
      continue;
    }
    const want = cited.get(key);
    assert.ok(want, `${where}: "${key}" has a second copy in this test`);
    close(row.value, want.value, 1e-12, `${where}: ${key}`);
    assert.equal(row.provenance, want.provenance, `${where}: ${key} provenance`);
    if (row.provenance === 'online')
      assert.match(
        row.via ?? human.sources[row.source].url ?? '',
        /^https:\/\//,
        `${where}: ${key} names the page it was read on`,
      );
    used.add(key);
  }
  for (const key of cited.keys()) assert.ok(used.has(key), `the test's copy "${key}" is still used by the table`);
  assert.equal(counts.print, 0, 'nothing has been checked in print yet');
  assert.deepEqual(counts, PROVENANCE, 'distinct source numbers by how they were checked');
});
/** Distinct source numbers of the table by how they were checked. */
const PROVENANCE = { dataset: 98, print: 0, online: 136, recalled: 90 };

test('ranges follow from their rows by the stated rule', () => {
  for (const [row, where, end] of everyRow(human)) {
    if (!end || end.rule || end.rows[0] !== row) continue;
    const widest = Math.max(0, ...end.rows.map((each) => each.value));
    close(end.normal, Math.min(180, Math.max(0, row.value)), 1e-12, `${where} clinical range is its first row`);
    close(
      end.structural,
      Math.min(180, Math.ceil(widest / 5 - 1e-9) * 5 + end.allowance),
      1e-12,
      `${where} stop is its widest row, rounded up to 5, plus its allowance`,
    );
  }
  // The limb motions the CDC study measured: adults of 20 to 44 years, the larger mean of the two sexes.
  const range = (id, s) => [byId.get(id).dofs[s].min, byId.get(id).dofs[s].max];
  for (const [id, s, low, high] of [
    ['l_hip', 0, [18.1, 45], [133.8, 150]],
    ['r_knee', 0, [1.6, 5], [141.9, 160]],
    ['l_talocrural', 0, [62.1, 75], [13.8, 45]],
    ['r_shoulder', 0, [60, 75], [172.0, 180]],
    ['l_elbow', 0, [4.7, 5], [150.0, 160]],
    ['r_elbow', 2, [90.6, 110], [82.0, 100]],
    ['l_elbow', 1, [0, 5], [20.02, 30]],
    ['r_radiocarpal', 0, [70, 85], [80, 95]],
    ['l_metacarpophalangeal_3', 0, [20, 45], [90, 100]],
    ['r_carpal_proximal_interphalangeal_2', 0, [0, 30], [100, 110]],
    ['l_hip', 1, [20, 35], [40, 55]],
    ['r_shoulder', 2, [90, 105], [70, 105]],
  ]) {
    const [min, max] = range(id, s);
    close(min.normal, low[0], 1e-9, `${id} ${byId.get(id).dofs[s].negative}`);
    close(min.structural, low[1], 1e-9, `${id} ${byId.get(id).dofs[s].negative} stop`);
    close(max.normal, high[0], 1e-9, `${id} ${byId.get(id).dofs[s].positive}`);
    close(max.structural, high[1], 1e-9, `${id} ${byId.get(id).dofs[s].positive} stop`);
  }
  // The elbow and the knee, the two hinges the demos showed folding back: 5 degrees past straight and no further.
  assert.equal(byId.get('l_elbow').dofs[0].min.allowance, 0);
  assert.equal(byId.get('l_knee').dofs[0].min.allowance, 0);
  assert.deepEqual(byId.get('l_knee').dofs[2].gate, { by: 0, from: 0, to: 90, floor: 5 });
  assert.equal(byId.get('r_radiocarpal').dofs[2].spill, true);
  // Each spine region's levels share its clinical range by their weights and add up to it.
  assert.deepEqual(HUMAN_SPINE_LEVELS, SPINE);
  const totals = {
      trunk: [
        [80, 25],
        [35, 35],
        [45, 45],
      ],
      neck: [
        [45, 45],
        [45, 45],
        [60, 60],
      ],
    },
    stops = {
      trunk: [
        [105, 40],
        [50, 50],
        [60, 60],
      ],
      neck: [
        [65, 75],
        [60, 60],
        [95, 95],
      ],
    },
    weight = (part, level, m) =>
      part === 'thoracic'
        ? ([62, 36, 32.5][m] * level[2 + m]) / SPINE.thoracic.reduce((sum, each) => sum + each[2 + m], 0)
        : level[2 + m];
  for (const [region, parts] of [
    ['trunk', ['lumbar', 'thoracic']],
    ['neck', ['cervical']],
  ]) {
    const levels = parts.flatMap((part) => SPINE[part].map((level) => [part, level]));
    assert.deepEqual(
      human.regions.find((each) => each.id === region),
      { id: region, joints: levels.map(([, level]) => level[0]), shared: true },
    );
    for (let m = 0; m < 3; m++) {
      const sum = levels.reduce((total, [part, level]) => total + weight(part, level, m), 0);
      let normal = [0, 0],
        stop = [0, 0];
      for (const [part, level] of levels) {
        const dof = byId.get(level[0]).dofs[m],
          share = weight(part, level, m) / sum;
        close(dof.max.normal, totals[region][m][0] * share, 1e-9, `${level[0]} ${dof.positive}`);
        close(dof.min.normal, totals[region][m][1] * share, 1e-9, `${level[0]} ${dof.negative}`);
        normal = [normal[0] + dof.max.normal, normal[1] + dof.min.normal];
        stop = [stop[0] + dof.max.structural, stop[1] + dof.min.structural];
      }
      for (let k = 0; k < 2; k++) {
        close(normal[k], totals[region][m][k], 1e-9, `${region} clinical range, motion ${m}`);
        close(stop[k], stops[region][m][k], 1e-9, `${region} stop, motion ${m}`);
      }
    }
  }
  // About half of the turn of the head is between the first two neck vertebrae.
  close(byId.get('vc1').dofs[2].max.normal / 60, 40 / 77, 1e-9, 'share of neck rotation at C1-C2');
});

test('the datasets are the published tables', () => {
  // CDC Normal Joint Range of Motion Study, 20 to 44 years: women, then men, in the page's order of motions.
  assert.deepEqual(CDC_MOTIONS, [
    'hip extension',
    'hip flexion',
    'knee flexion',
    'knee extension',
    'ankle dorsiflexion',
    'ankle plantar flexion',
    'shoulder flexion',
    'elbow flexion',
    'elbow extension',
    'elbow pronation',
    'elbow supination',
  ]);
  assert.deepEqual(CDC_AGES, ['2-8', '9-19', '20-44', '45-69']);
  assert.deepEqual(
    CDC_RANGE_OF_MOTION.female['20-44'].map((cell) => cell[0]),
    [18.1, 133.8, 141.9, 1.6, 13.8, 62.1, 172.0, 150.0, 4.7, 82.0, 90.6],
  );
  assert.deepEqual(
    CDC_RANGE_OF_MOTION.male['20-44'].map((cell) => cell[0]),
    [17.4, 130.4, 137.7, 1.0, 12.7, 54.6, 168.8, 144.6, 0.8, 76.9, 85.0],
  );
  assert.deepEqual(
    CDC_RANGE_OF_MOTION.female['2-8'].map((cell) => cell[0]),
    [26.2, 140.8, 152.6, 5.4, 24.8, 67.1, 178.6, 152.9, 6.8, 84.6, 93.7],
  );
  assert.deepEqual(
    CDC_RANGE_OF_MOTION.male['45-69'].map((cell) => cell[0]),
    [13.5, 127.2, 132.9, 0.5, 11.9, 49.4, 164.0, 143.5, -0.7, 77.7, 82.4],
  );
  for (const sex of ['female', 'male'])
    for (const age of CDC_AGES) {
      assert.equal(CDC_RANGE_OF_MOTION[sex][age].length, 11);
      for (const [mean, low, high] of CDC_RANGE_OF_MOTION[sex][age])
        assert.ok(
          low < mean && mean < high && high - low < 6,
          `${sex} ${age}: the mean lies inside a narrow confidence interval`,
        );
    }
  // ANSUR II: 1,986 women and 4,082 men; centimetres.
  assert.deepEqual([ANSUR2_FEMALES, ANSUR2_MALES], [1986, 4082]);
  assert.equal(Object.keys(ANSUR2).length, 48);
  // The girths the pose checker's body volumes read (second read, 2026-11-28).
  assert.deepEqual(ANSUR2['biceps circumference, flexed'], [30.56, 3.08, 35.81, 3.46]);
  assert.deepEqual(ANSUR2['wrist circumference'], [15.48, 0.78, 17.59, 0.9]);
  assert.deepEqual(ANSUR2['chest depth'], [24.74, 2.73, 25.38, 2.62]);
  assert.deepEqual(ANSUR2['calf circumference'], [37.33, 2.85, 39.23, 2.97]);
  assert.deepEqual(ANSUR2.stature, [162.85, 6.42, 175.62, 6.86]);
  assert.deepEqual(ANSUR2['acromial height'], [133.51, 5.81, 144.07, 6.33]);
  assert.deepEqual(ANSUR2['trochanterion height'], [84.54, 4.47, 90.09, 4.92]);
  assert.deepEqual(ANSUR2['lateral femoral epicondyle height'], [46.59, 2.71, 49.17, 2.66]);
  assert.deepEqual(ANSUR2['lateral malleolus height'], [6.27, 0.51, 7.29, 0.57]);
  assert.deepEqual(ANSUR2['acromion-radiale length'], [31.12, 1.72, 33.52, 1.75]);
  assert.deepEqual(ANSUR2['radiale-stylion length'], [24.13, 1.52, 26.79, 1.54]);
  assert.deepEqual(ANSUR2['hand length'], [18.11, 1.01, 19.33, 0.99]);
  assert.deepEqual(ANSUR2['wrist height'], [79.42, 3.82, 84.75, 4.17]);
  assert.deepEqual(ANSUR2['foot length'], [24.63, 1.24, 27.12, 1.31]);
  assert.deepEqual(ANSUR2.span, [166.03, 8.3, 181.42, 8.46]);
  for (const [dimension, [fm, fs, mm, ms]] of Object.entries(ANSUR2))
    assert.ok(fm > 0 && mm > 0 && fs > 0 && ms > 0 && fs < fm / 5 && ms < mm / 5, dimension);
  // de Leva 1996, table 4: [women, men], percent. A body's segments add up to the body.
  assert.deepEqual(DE_LEVA_1996.thigh.mass, [14.78, 14.16]);
  assert.deepEqual(DE_LEVA_1996.thigh.centre, [36.12, 40.95]);
  assert.deepEqual(DE_LEVA_1996.head.mass, [6.68, 6.94]);
  assert.deepEqual(DE_LEVA_1996.trunk.centre, [41.51, 44.86]);
  assert.deepEqual(DE_LEVA_1996.forearm.mass, [1.38, 1.62]);
  for (const sex of [0, 1]) {
    const m = (id) => DE_LEVA_1996[id].mass[sex];
    close(
      m('head') + m('trunk') + 2 * (m('upperArm') + m('forearm') + m('hand') + m('thigh') + m('shank') + m('foot')),
      100,
      0.02,
      'segment masses add up to the body',
    );
    close(m('upperTrunk') + m('middleTrunk') + m('lowerTrunk'), m('trunk'), 1e-9, 'the trunk is its three parts');
  }
});

test('proportions, segment masses and coupled motions carry their sources', () => {
  const share = (id) => human.proportions.find((norm) => norm.id === id);
  // Shares of stature from the survey's means: the mean of the two sexes, with each sex beside it.
  close(share('shoulderHeight').female, 133.51 / 162.85, 1e-12, 'shoulder height, women');
  close(share('shoulderHeight').male, 144.07 / 175.62, 1e-12, 'shoulder height, men');
  close(share('shoulderHeight').share, (133.51 / 162.85 + 144.07 / 175.62) / 2, 1e-12, 'shoulder height');
  close(
    share('fingertipHeight').male,
    (84.75 - 19.33) / 175.62,
    1e-12,
    'fingertip height is wrist height less hand length',
  );
  close(share('thighLength').female, (84.54 - 46.59) / 162.85, 1e-12, 'thigh length');
  close(share('armSpan').share, (166.03 / 162.85 + 181.42 / 175.62) / 2, 1e-12, 'arm span');
  close(share('shoulderHeight').spread, (5.81 / 162.85 + 6.33 / 175.62) / 2, 1e-12, 'spread of shoulder height');
  // The survey and the older figure of Drillis and Contini agree to within 0.02 of stature wherever both speak.
  let compared = 0;
  for (const norm of human.proportions) {
    assert.ok(
      norm.rows.some((row) => row.provenance === 'dataset'),
      `${norm.id} is measured`,
    );
    for (const row of norm.rows.filter((each) => each.source === 'winter2009')) {
      close(norm.share, row.value, 0.02, `${norm.id} against Drillis and Contini`);
      compared++;
    }
  }
  assert.equal(compared, 11);
  // The fingertips of a hanging arm are at mid thigh, well above the knee: the measure that catches a dragging arm.
  assert.ok(
    share('fingertipHeight').share > share('kneeHeight').share + 0.08 &&
      share('fingertipHeight').share < share('hipHeight').share,
  );
  for (const span of human.stature) assert.ok(span.share > 0.2 && span.share < 0.5);
  // Segment masses for one limb each; the whole body adds up.
  const mass = (id) => human.segments.find((segment) => segment.id === id).mass;
  close(
    mass('head') +
      mass('trunk') +
      2 * (mass('upperArm') + mass('forearm') + mass('hand') + mass('thigh') + mass('shank') + mass('foot')),
    1,
    2e-4,
    'body mass',
  );
  close(mass('thigh'), (0.1478 + 0.1416) / 2, 1e-12, 'thigh share of body mass');
  for (const segment of human.segments)
    for (const id of segment.joints) assert.ok(byId.has(id), `${segment.id} is carried by a joint of the table`);
  assert.deepEqual(
    human.couplings.map((hook) => [hook.id, hook.kind]),
    [
      ['shoulder-girdle', 'ratio'],
      ['carrying-angle', 'offset'],
      ['forearm-rotation', 'spill'],
      ['knee-rotation', 'gate'],
      ['finger-curl', 'follow'],
      ['head-rotation', 'share'],
    ],
  );
  for (const hook of human.couplings) {
    assert.ok(hook.rows.length && hook.note.length > 40);
    for (const id of hook.joints) assert.ok(byId.has(id));
  }
  const girdle = human.couplings[0].values;
  assert.deepEqual([girdle.glenohumeral, girdle.scapulothoracic, girdle.settingAbduction], [2, 1, 30]);
});

test('a table for a sex or an age reads that group from the datasets', () => {
  const girl = humanTable({ sex: 'female', age: 6 }),
    joint = (table, id) => table.joints.find((each) => each.id === id);
  assert.equal(joint(girl, 'l_elbow').dofs[0].min.normal, 6.8);
  assert.equal(joint(girl, 'l_elbow').dofs[0].min.structural, 10);
  assert.equal(joint(girl, 'l_knee').dofs[0].max.normal, 152.6);
  assert.equal(joint(girl, 'l_elbow').dofs[0].min.rows.length, 1);
  // Men of 45 to 69 stop 0.7 of a degree short of a straight elbow on average: no hyperextension at all.
  const man = humanTable({ sex: 'male', age: 60 });
  assert.equal(joint(man, 'r_elbow').dofs[0].min.rows[0].value, -0.7);
  assert.equal(joint(man, 'r_elbow').dofs[0].min.normal, 0);
  assert.equal(joint(man, 'r_elbow').dofs[0].min.structural, 0);
  close(man.proportions.find((norm) => norm.id === 'hipHeight').share, 90.09 / 175.62, 1e-12, 'hip height, men');
  close(man.segments.find((segment) => segment.id === 'thigh').mass, 0.1416, 1e-12, 'thigh mass, men');
  assert.equal(joint(humanTable({ age: 12 }), 'l_hip').dofs[0].max.normal, 135.2);
  const child = fitHuman(bodyRig({ arms: 45 }), { sex: 'female', age: 6 });
  assert.equal(child.species.joints.find((each) => each.id === 'l_elbow').dofs[0].min.normal, 6.8);
  assert.equal(fitHuman(bodyRig({ arms: 45 })).species, human);
  assert.throws(() => humanTable({ age: -1 }), /age must be a positive number/);
  assert.throws(() => humanTable({ sex: 'x' }), /sex must be/);
});

test('bones of common rigs are found by name', () => {
  const find = (names, preset) => {
    const found = human.naming(names, preset);
    return found && [found.preset, Object.fromEntries([...found.joints].map(([joint, bone]) => [names[bone], joint]))];
  };
  const sides = (make) => ['Left', 'Right'].flatMap(make);
  // Mixamo, with its prefix.
  let [preset, map] = find(
    [
      'Hips',
      'Spine',
      'Spine1',
      'Spine2',
      'Neck',
      'Head',
      ...sides((s) =>
        [
          'Shoulder',
          'Arm',
          'ForeArm',
          'Hand',
          'HandThumb1',
          'HandIndex1',
          'HandIndex2',
          'HandPinky3',
          'UpLeg',
          'Leg',
          'Foot',
          'ToeBase',
        ].map((bone) => s + bone),
      ),
    ].map((bone) => `mixamorig:${bone}`),
  );
  assert.equal(preset, 'segments');
  assert.deepEqual(
    [
      'Hips',
      'Spine',
      'Spine1',
      'Spine2',
      'Neck',
      'Head',
      'LeftShoulder',
      'LeftArm',
      'LeftForeArm',
      'LeftHand',
      'RightHandThumb1',
      'RightHandIndex1',
      'LeftHandIndex2',
      'RightHandPinky3',
      'RightUpLeg',
      'LeftLeg',
      'RightFoot',
      'LeftToeBase',
    ].map((bone) => map[`mixamorig:${bone}`]),
    [
      'humanoid_root',
      'vl3',
      'vt12',
      'vt6',
      'vc7',
      'vc1',
      'l_sternoclavicular',
      'l_shoulder',
      'l_elbow',
      'l_radiocarpal',
      'r_carpometacarpal_1',
      'r_metacarpophalangeal_2',
      'l_carpal_proximal_interphalangeal_2',
      'r_carpal_distal_interphalangeal_5',
      'r_hip',
      'l_knee',
      'r_talocrural',
      'l_metatarsophalangeal_1',
    ],
  );
  // The BVH form of the CMU captures (tests/fixtures/cmu-mocap): LowerBack below Spine, Neck1, a finger base and LThumb.
  const cmuBVH = [
    'Hips',
    'LHipJoint',
    'LeftUpLeg',
    'LeftLeg',
    'LeftFoot',
    'LeftToeBase',
    'RHipJoint',
    'RightUpLeg',
    'RightLeg',
    'RightFoot',
    'RightToeBase',
    'LowerBack',
    'Spine',
    'Spine1',
    'Neck',
    'Neck1',
    'Head',
    'LeftShoulder',
    'LeftArm',
    'LeftForeArm',
    'LeftHand',
    'LeftFingerBase',
    'LeftHandIndex1',
    'LThumb',
    'RightShoulder',
    'RightArm',
    'RightForeArm',
    'RightHand',
    'RightFingerBase',
    'RightHandIndex1',
    'RThumb',
  ];
  [preset, map] = find(cmuBVH);
  assert.equal(preset, 'segments');
  assert.deepEqual(
    [
      map.LowerBack,
      map.Spine,
      map.Spine1,
      map.Neck1,
      map.LThumb,
      map.RightHandIndex1,
      map.LHipJoint,
      map.LeftFingerBase,
      map.LeftHand,
    ],
    [
      'vl5',
      'vl3',
      'vt12',
      'vc4',
      'l_carpometacarpal_1',
      'r_metacarpophalangeal_2',
      undefined,
      'l_radiocarpal',
      undefined,
    ],
  );
  // The 100STYLE captures name a bone for the joint it turns at: "Shoulder" is the upper arm, "Collar" the collarbone.
  const style = [
    'Hips',
    'Chest',
    'Chest2',
    'Chest3',
    'Chest4',
    'Neck',
    'Head',
    ...sides((s) => ['Collar', 'Shoulder', 'Elbow', 'Wrist', 'Hip', 'Knee', 'Ankle', 'Toe'].map((bone) => s + bone)),
  ];
  [preset, map] = find(style);
  assert.equal(preset, 'joints');
  assert.deepEqual(
    [
      map.Chest,
      map.Chest4,
      map.RightCollar,
      map.RightShoulder,
      map.LeftElbow,
      map.LeftWrist,
      map.RightHip,
      map.LeftKnee,
      map.RightAnkle,
      map.LeftToe,
    ],
    [
      'vl5',
      'vt4',
      'r_sternoclavicular',
      'r_shoulder',
      'l_elbow',
      'l_radiocarpal',
      'r_hip',
      'l_knee',
      'r_talocrural',
      'l_metatarsophalangeal_1',
    ],
  );
  assert.equal(Object.keys(map).length, 23);
  // Character Creator: the pelvis bone under the hip is the table's sacroiliac joint, which carries the legs.
  const cc = [
    'Hip',
    'Pelvis',
    'Waist',
    'Spine01',
    'Spine02',
    'NeckTwist01',
    'NeckTwist02',
    'Head',
    ...['L', 'R'].flatMap((s) =>
      ['Clavicle', 'Upperarm', 'Forearm', 'Hand', 'Thumb1', 'Mid2', 'Thigh', 'Calf', 'Foot', 'ToeBase'].map(
        (bone) => `${s}_${bone}`,
      ),
    ),
  ].map((bone) => `CC_Base_${bone}`);
  [preset, map] = find(cc);
  assert.equal(preset, 'characterCreator');
  assert.deepEqual(
    ['Hip', 'Pelvis', 'Waist', 'NeckTwist02', 'Head', 'L_Clavicle', 'R_Upperarm', 'L_Forearm', 'R_Calf', 'L_Mid2'].map(
      (bone) => map[`CC_Base_${bone}`],
    ),
    [
      'humanoid_root',
      'sacroiliac',
      'vl5',
      'vc4',
      'vc1',
      'l_sternoclavicular',
      'r_shoulder',
      'l_elbow',
      'r_knee',
      'l_carpal_proximal_interphalangeal_3',
    ],
  );
  // The CMU skeleton as its ASF file names it.
  const asf = [
    'root',
    'lowerback',
    'upperback',
    'thorax',
    'lowerneck',
    'upperneck',
    'head',
    ...['l', 'r'].flatMap((s) =>
      ['clavicle', 'humerus', 'radius', 'wrist', 'hand', 'fingers', 'thumb', 'femur', 'tibia', 'foot', 'toes'].map(
        (bone) => s + bone,
      ),
    ),
  ];
  [preset, map] = find(asf);
  assert.equal(preset, 'cmu');
  assert.deepEqual(
    [
      map.root,
      map.lowerback,
      map.thorax,
      map.lowerneck,
      map.lhumerus,
      map.rradius,
      map.lhand,
      map.rfingers,
      map.ltibia,
      map.rtoes,
    ],
    [
      'humanoid_root',
      'vl5',
      'vt6',
      'vc7',
      'l_shoulder',
      'r_elbow',
      'l_radiocarpal',
      'r_metacarpophalangeal_3',
      'l_knee',
      'r_metatarsophalangeal_1',
    ],
  );
  // The CMU skeleton has two hand bones: lwrist only twists and lhand carries the bend, so the wrist is read at lhand.
  assert.equal(map.lwrist, undefined);
  // HAnim itself: level 1 of the standard, and the HAnim 1.x names of the joints it renamed.
  [preset, map] = find(LOA[1]);
  assert.equal(preset, 'hanim');
  assert.equal(Object.keys(map).length, 18);
  for (const id of LOA[1]) assert.equal(map[id], id);
  [preset, map] = find([
    'HumanoidRoot',
    'sacroiliac',
    'l_hip',
    'l_knee',
    'l_ankle',
    'r_hip',
    'r_knee',
    'r_ankle',
    'vl5',
    'skullbase',
    'l_shoulder',
    'l_elbow',
    'l_wrist',
    'l_index1',
    'r_shoulder',
    'r_elbow',
    'r_wrist',
    'r_thumb1',
  ]);
  assert.equal(preset, 'hanim');
  assert.deepEqual(
    [map.HumanoidRoot, map.l_ankle, map.r_wrist, map.l_index1, map.r_thumb1],
    ['humanoid_root', 'l_talocrural', 'r_radiocarpal', 'l_metacarpophalangeal_2', 'r_carpometacarpal_1'],
  );
  // The humanoid names of VRM and of @margoengine/rigging/retarget.
  [preset, map] = find([
    'hips',
    'spine',
    'chest',
    'neck',
    'head',
    'leftUpperArm',
    'leftLowerArm',
    'leftHand',
    'rightUpperArm',
    'rightLowerArm',
    'rightHand',
    'leftUpperLeg',
    'leftLowerLeg',
    'leftFoot',
    'rightUpperLeg',
    'rightLowerLeg',
    'rightFoot',
  ]);
  assert.equal(preset, 'humanoid');
  assert.deepEqual([map.chest, map.leftLowerArm, map.rightLowerLeg], ['vt12', 'l_elbow', 'r_knee']);
  // A naming can be asked for by name; an unknown one is refused, and bones nobody knows give null.
  assert.equal(find(style, 'joints')[0], 'joints');
  assert.equal(find(style, 'cmu'), null);
  assert.equal(find(['a', 'b', 'c']), null);
  assert.throws(() => find(style, 'klingon'), /must be one of hanim, segments, joints, mixamo/);
  assert.deepEqual(HUMAN_NAMINGS.slice(0, 3), ['hanim', 'segments', 'joints']);
  // A coarse rig lumps: Roblox R15 has one trunk bone above the hips and no neck.
  const roblox = fitAnatomy(
    [
      ['LowerTorso', -1, [0, 1, 0]],
      ['UpperTorso', 0, [0, 1.2, 0]],
      ['Head', 1, [0, 1.6, 0]],
      ...[
        ['Left', 1],
        ['Right', -1],
      ].flatMap(([s, x], k) => [
        [`${s}UpperLeg`, 0, [0.1 * x, 0.95, 0]],
        [`${s}LowerLeg`, 3 + k * 6, [0.1 * x, 0.5, 0]],
        [`${s}Foot`, 4 + k * 6, [0.1 * x, 0.08, 0]],
        [`${s}UpperArm`, 1, [0.2 * x, 1.45, 0]],
        [`${s}LowerArm`, 6 + k * 6, [0.2 * x, 1.17, 0]],
        [`${s}Hand`, 7 + k * 6, [0.2 * x, 0.91, 0]],
      ]),
    ].map(([name, parent, position]) => ({ name, parent, position })),
    { species: human },
  );
  assert.equal(roblox.preset, 'roblox');
  assert.equal(roblox.restPose, 'arms-down');
  assert.equal(roblox.joints[roblox.index.get('vt1')].id, 'vl5', 'the one trunk bone is the whole trunk');
  assert.equal(roblox.joints[roblox.index.get('vl5')].covers.length, 17);
  assert.equal(roblox.joints[roblox.index.get('vc7')].id, 'vc1', 'the head bone is the whole neck');
  assert.deepEqual(
    roblox.joints[roblox.index.get('vc1')].normal,
    roblox.regions.find((region) => region.id === 'neck').normal,
  );
  assert.equal(
    roblox.joints[roblox.index.get('l_shoulder')].reference,
    1,
    'with no collarbone the arm is still measured against the chest',
  );
});
