// COLLADA 1.5 kinematics. The documents are written for this test from the element structure of the Khronos COLLADA
// 1.5.0 schema (https://www.khronos.org/files/collada_schema_1_5); no file from a robot exporter is among them. The
// expected positions are worked by hand: the arm stands 1 m up (Z_UP), the second link starts 2 m out and the tool
// point 0.5 m beyond it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { flattenDAE, parseDAE, LoaderError } from '../dist/index.js';
import { parseDAEKinematics, poseDAEJoints } from '../dist/dae-kinematics.js';

const near = (actual, expected, tolerance = 1e-6, what = '') => {
  assert.equal(actual.length, expected.length, what);
  actual.forEach((v, i) =>
    assert.ok(Math.abs(v - expected[i]) <= tolerance, `${what} [${[...actual]}] is not [${expected}]`),
  );
};

const geometry = `<library_geometries><geometry id="dot"><mesh>
  <source id="p"><float_array id="pa" count="9">0 0 0 10 0 0 0 10 0</float_array>
    <technique_common><accessor source="#pa" count="3" stride="3"/></technique_common></source>
  <vertices id="v"><input semantic="POSITION" source="#p"/></vertices>
  <triangles count="1"><input semantic="VERTEX" source="#v" offset="0"/><p>0 1 2</p></triangles>
</mesh></geometry></library_geometries>`;

const visual = `<library_visual_scenes><visual_scene id="vs">
  <node id="base">
    <node id="link1">
      <translate>0 0 100</translate>
      <rotate sid="turn">0 0 1 0</rotate>
      <node id="link2" sid="forearm">
        <translate>200 0 0</translate>
        <translate sid="slide">0 0 0</translate>
        <node id="tip"><translate>50 0 0</translate><instance_geometry url="#dot"/></node>
      </node>
    </node>
  </node>
</visual_scene></library_visual_scenes>`;

const joints = `<library_joints>
  <joint id="j0" name="shoulder" sid="joint0"><revolute sid="axis0"><axis>0 0 1</axis>
    <limits><min>-90</min><max>90</max></limits></revolute></joint>
  <joint id="j1" name="reach" sid="joint1"><prismatic sid="axis0"><axis>2 0 0</axis>
    <limits><min>0</min><max>30</max></limits></prismatic></joint>
</library_joints>`;

const models = `<library_kinematics_models><kinematics_model id="km"><technique_common>
  <instance_joint url="#j0" sid="joint0"/>
  <instance_joint url="#j1" sid="joint1"/>
  <link sid="root"><attachment_full joint="km/joint0"><link sid="upper">
    <attachment_full joint="km/joint1"><link sid="fore"/></attachment_full></link></attachment_full></link>
</technique_common></kinematics_model></library_kinematics_models>`;

// The usual export chain: scene -> motion system -> kinematics system -> model, each level re-exporting parameters.
const systems = (axisInfo = '') => `<library_articulated_systems>
  <articulated_system id="motion"><motion>
    <instance_articulated_system url="#kinematics" sid="inst_kin">
      <newparam sid="motion_axis0"><SIDREF>kinematics/kin_axis0</SIDREF></newparam>
      <newparam sid="reach_speed"><float>10</float></newparam>
    </instance_articulated_system>
    <technique_common>
      <axis_info axis="inst_kin/inst_model/joint0/axis0"><speed><float>120</float></speed>
        <acceleration><float>400</float></acceleration></axis_info>
      <axis_info axis="inst_kin/inst_model/joint1/axis0"><speed><param>reach_speed</param></speed></axis_info>
    </technique_common>
  </motion></articulated_system>
  <articulated_system id="kinematics"><kinematics>
    <instance_kinematics_model url="#km" sid="inst_model">
      <newparam sid="kin_axis0"><SIDREF>inst_model/joint0/axis0</SIDREF></newparam>
    </instance_kinematics_model>
    <technique_common>
      <axis_info axis="inst_model/joint0/axis0"><active><bool>true</bool></active><index>0</index>
        <limits><min><float>-135</float></min><max><float>135</float></max></limits></axis_info>
      ${axisInfo}
      <frame_origin link="km/root"/><frame_tip link="km/fore"/>
    </technique_common>
  </kinematics></articulated_system>
</library_articulated_systems>`;

const scenes = `<library_kinematics_scenes><kinematics_scene id="ks">
  <instance_articulated_system url="#motion" sid="inst_arm">
    <newparam sid="scene_axis0"><SIDREF>inst_arm/inst_kin/motion_axis0</SIDREF></newparam>
    <setparam ref="inst_kin/reach_speed"><float>20</float></setparam>
  </instance_articulated_system>
</kinematics_scene></library_kinematics_scenes>`;

const binding = `<instance_kinematics_scene url="#ks" sid="inst_ks">
  <newparam sid="reach_value"><float>0</float></newparam>
  <bind_joint_axis target="link1/turn"><axis><param>scene_axis0</param></axis>
    <value><float>0</float></value></bind_joint_axis>
  <bind_joint_axis target="link2/slide.X">
    <axis><SIDREF>ks/inst_arm/inst_kin/inst_model/joint1/axis0</SIDREF></axis>
    <value><param>reach_value</param></value></bind_joint_axis>
</instance_kinematics_scene>`;

const document = (parts = {}) => `<?xml version="1.0"?>
<COLLADA xmlns="http://www.collada.org/2008/03/COLLADASchema" version="1.5.0">
<asset><unit meter="0.01"/><up_axis>Z_UP</up_axis></asset>
${geometry}${visual}
${parts.joints ?? joints}${parts.models ?? models}${parts.systems ?? systems()}${parts.scenes ?? scenes}
<scene><instance_visual_scene url="#vs"/>${parts.binding ?? binding}</scene></COLLADA>`;

const tip = (dae, pose) => {
  const node = dae.nodes[0].children[0].children[0].children[0];
  assert.equal(node.id, 'tip');
  return pose.world.get(node).slice(12, 15);
};

test('parseDAEKinematics resolves parameters through the instance tree and binds node transforms', () => {
  const dae = parseDAEKinematics(document());
  assert.deepEqual(dae.warnings, []);
  assert.equal(dae.joints.length, 2);
  const [shoulder, reach] = dae.joints;
  assert.deepEqual(
    [shoulder.name, shoulder.joint, shoulder.type, shoulder.path],
    ['joint0', 'shoulder', 'revolute', 'inst_ks/inst_arm/inst_kin/inst_model/joint0/axis0'],
  );
  near(shoulder.axis, [0, 1, 0], 1e-12, 'a Z_UP file axis turns Y-up');
  // axis_info limits replace the joint's own; motion bounds and index come with them.
  assert.deepEqual([shoulder.min, shoulder.max, shoulder.index, shoulder.speed], [-135, 135, 0, 120]);
  assert.deepEqual([shoulder.acceleration, shoulder.active, shoulder.locked, shoulder.value], [400, true, false, 0]);
  assert.deepEqual([reach.name, reach.type, reach.joint], ['joint1', 'prismatic', 'reach']);
  near(reach.axis, [1, 0, 0], 1e-12);
  // Centimetres to metres; setparam gives the speed 20 cm/s.
  near([reach.min, reach.max, reach.speed, reach.value], [0, 0.3, 0.2, 0], 1e-12);
  assert.deepEqual(
    dae.joints.map((j) => j.targets.map((t) => [t.node.id, t.transform])),
    [[['link1', 1]], [['link2', 1]]],
  );
});

test('poseDAEJoints turns and slides the bound transforms', () => {
  const dae = parseDAEKinematics(document());
  near(tip(dae, poseDAEJoints(dae)), [2.5, 1, 0], 1e-6, 'rest');
  near(tip(dae, poseDAEJoints(dae, { joint0: 90 })), [0, 1, -2.5], 1e-6, 'a quarter turn');
  near(tip(dae, poseDAEJoints(dae, { joint0: 90, joint1: 0.2 })), [0, 1, -2.7], 1e-6, 'turned and reached');
  const pose = poseDAEJoints(dae, { joint0: -90 });
  near(tip(dae, pose), [0, 1, 2.5]);
  // The flattened mesh moves with the pose: its second vertex is 10 cm further along the turned arm.
  near([...flattenDAE(dae, pose).positions.slice(3, 6)], [0, 1, 2.6], 1e-5, 'flattened vertex');
  // The document is not changed by posing.
  near(tip(dae, poseDAEJoints(dae)), [2.5, 1, 0]);
  assert.deepEqual(dae.nodes[0].children[0].transforms[1].values, [0, 0, 1, 0]);
});

test('values are held inside the limits unless clamp is false', () => {
  const dae = parseDAEKinematics(document());
  near(tip(dae, poseDAEJoints(dae, { joint1: 5 })), [2.8, 1, 0], 1e-6, 'upper limit 0.3 m');
  near(tip(dae, poseDAEJoints(dae, { joint1: -1 })), [2.5, 1, 0], 1e-6, 'lower limit');
  near(tip(dae, poseDAEJoints(dae, { joint1: 1 }, { clamp: false })), [3.5, 1, 0]);
});

test('poseDAEJoints refuses unknown names, non-finite values and locked axes', () => {
  const dae = parseDAEKinematics(document());
  assert.throws(() => poseDAEJoints(dae, { elbow: 1 }), /DAE joint "elbow" does not exist; pass one of joint0, joint1/);
  assert.throws(() => poseDAEJoints(dae, { joint0: Number.NaN }), /pass a finite number/);
  const locked = parseDAEKinematics(
    document({
      systems: systems(`<axis_info axis="inst_model/joint1/axis0"><locked><bool>true</bool></locked></axis_info>`),
    }),
  );
  assert.equal(locked.joints[1].locked, true);
  assert.throws(() => poseDAEJoints(locked, { joint1: 0.1 }), /is locked at 0/);
  near(tip(locked, poseDAEJoints(locked, { joint1: 0, joint0: 90 })), [0, 1, -2.5]);
});

test('the bound value is where an axis stands when it is left out', () => {
  const dae = parseDAEKinematics(
    document({
      binding: binding.replace('<value><float>0</float></value>', '<value><float>90</float></value>'),
    }),
  );
  assert.equal(dae.joints[0].value, 90);
  near(tip(dae, poseDAEJoints(dae)), [0, 1, -2.5]);
});

test('compound joints and two instances of one model keep their own names', () => {
  const compound = `<library_joints><joint id="wrist" sid="wrist">
    <revolute sid="pitch"><axis>0 1 0</axis></revolute><revolute sid="roll"><axis>1 0 0</axis></revolute>
  </joint></library_joints>`;
  const model = `<library_kinematics_models><kinematics_model id="km"><technique_common>
    <instance_joint url="#wrist" sid="wrist"/><link sid="root"/></technique_common></kinematics_model>
    </library_kinematics_models>`;
  const one = `<library_kinematics_scenes><kinematics_scene id="ks">
    <instance_kinematics_model url="#km" sid="left"/></kinematics_scene></library_kinematics_scenes>`;
  const bound = `<instance_kinematics_scene url="#ks"/>`;
  const single = parseDAEKinematics(
    document({
      joints: compound,
      models: model,
      systems: '',
      scenes: one,
      binding: bound,
    }),
  );
  assert.deepEqual(
    single.joints.map((j) => j.name),
    ['wrist/pitch', 'wrist/roll'],
  );
  assert.deepEqual(
    single.joints.map((j) => [j.min, j.max, j.targets.length]),
    [
      [undefined, undefined, 0],
      [undefined, undefined, 0],
    ],
  );
  const two = one.replace('sid="left"/>', 'sid="left"/><instance_kinematics_model url="#km" sid="right"/>');
  const pair = parseDAEKinematics(
    document({
      joints: compound,
      models: model,
      systems: '',
      scenes: two,
      binding: bound,
    }),
  );
  assert.deepEqual(
    pair.joints.map((j) => j.name),
    ['left/wrist/pitch', 'left/wrist/roll', 'right/wrist/pitch', 'right/wrist/roll'],
  );
});

test('an axis without a bound value starts where its transform stands', () => {
  const dae = parseDAEKinematics(
    document({
      binding: binding
        .replace('<value><float>0</float></value>', '<value><param>nowhere</param></value>')
        .replace('<value><param>reach_value</param></value>', '<value><float>10</float></value>'),
    }),
  );
  assert.match(dae.warnings.join('\n'), /<value> has no finite value/);
  assert.equal(dae.joints[0].value, 0);
  near([dae.joints[1].value], [0.1], 1e-12);
});

test('what cannot be resolved is reported, never guessed', () => {
  const dae = parseDAEKinematics(
    document({
      binding: `<instance_kinematics_scene url="#ks">
        <bind_joint_axis target="link1/turn"><axis><param>missing</param></axis><value><float>0</float></value></bind_joint_axis>
        <bind_joint_axis target="link1/nothing"><axis><param>scene_axis0</param></axis><value><float>0</float></value></bind_joint_axis>
        <bind_joint_axis target="link2/slide"><axis><param>scene_axis0</param></axis><value><float>0</float></value></bind_joint_axis>
      </instance_kinematics_scene>`,
      models: models.replace('<link sid="root">', '<formula/><link sid="root">'),
    }),
  );
  const text = dae.warnings.join('\n');
  assert.match(text, /bind_joint_axis "link1\/turn" names no joint axis/);
  assert.match(text, /target "link1\/nothing" names no node transform/);
  assert.match(text, /target "link2\/slide" is not a <rotate>/);
  assert.match(text, /formulas \(coupled joints\) are not evaluated/);
  assert.deepEqual(dae.joints[0].targets, []);
});

test('a document without kinematics has no joints and parses as parseDAE does', () => {
  const plain = document({
    joints: '',
    models: '',
    systems: '',
    scenes: '',
    binding: '',
  });
  const dae = parseDAEKinematics(plain);
  assert.deepEqual(dae.joints, []);
  assert.deepEqual(dae.warnings, parseDAE(plain).warnings);
  assert.deepEqual(dae.geometries, parseDAE(plain).geometries);
  const unscened = parseDAEKinematics(document({ scenes: '', binding: '' }));
  assert.deepEqual(unscened.joints, []);
  assert.match(unscened.warnings.join('\n'), /no kinematics scene/);
  // A library scene the <scene> does not instance still lists its joints, bound to nothing.
  const unbound = parseDAEKinematics(document({ binding: '' }));
  assert.equal(unbound.joints.length, 2);
  assert.match(unbound.warnings.join('\n'), /joints drive no node/);
});

test('hostile kinematics fail with coded errors', () => {
  const cycle = `<library_articulated_systems><articulated_system id="motion"><motion>
    <instance_articulated_system url="#motion" sid="again"/><technique_common/></motion></articulated_system>
    </library_articulated_systems>`;
  assert.throws(
    () => parseDAEKinematics(document({ systems: cycle })),
    (e) => e instanceof LoaderError && e.code === 'limit',
  );
  assert.throws(
    () =>
      parseDAEKinematics(
        document({
          joints: joints.replace('<axis>0 0 1</axis>', '<axis>0 0 0</axis>'),
        }),
      ),
    (e) => e instanceof LoaderError && e.code === 'syntax',
  );
  // Parameters that name each other end in a warning.
  const loop = parseDAEKinematics(
    document({
      binding: `<instance_kinematics_scene url="#ks">
        <newparam sid="a"><SIDREF>b</SIDREF></newparam><newparam sid="b"><SIDREF>a</SIDREF></newparam>
        <bind_joint_axis target="link1/turn"><axis><param>a</param></axis><value><param>b</param></value></bind_joint_axis>
      </instance_kinematics_scene>`,
    }),
  );
  assert.match(loop.warnings.join('\n'), /names no joint axis/);
});

test('a transform SID that holds a dot is found before it is read as a member selector', () => {
  const dae = parseDAEKinematics(
    document({ binding: binding.replace('link1/turn', 'link1/turn.z') }).replace('sid="turn"', 'sid="turn.z"'),
  );
  assert.deepEqual(dae.warnings, []);
  near(tip(dae, poseDAEJoints(dae, { joint0: 90 })), [0, 1, -2.5]);
});

test('thousands of bindings over a deep scene end at the visit limit, not in quadratic time', () => {
  const nodes = '<node/>'.repeat(20_000),
    binds =
      '<bind_joint_axis target="base/nothing"><axis><param>scene_axis0</param></axis><value><float>0</float></value></bind_joint_axis>'.repeat(
        2_000,
      );
  const text = document({
    binding: `<instance_kinematics_scene url="#ks">${binds}</instance_kinematics_scene>`,
  }).replace('<node id="base">', `<node id="base">${nodes}`);
  assert.throws(
    () => parseDAEKinematics(text),
    (e) => e instanceof LoaderError && e.code === 'limit',
  );
});

test('a chain of many links is not an instance cycle', () => {
  let chain = '<link sid="end"/>';
  for (let i = 0; i < 60; i++) chain = `<link><attachment_full joint="km/joint0">${chain}</attachment_full></link>`;
  const from = models.indexOf('<link sid="root">'),
    to = models.indexOf('</technique_common>');
  const dae = parseDAEKinematics(document({ models: models.slice(0, from) + chain + models.slice(to) }));
  assert.deepEqual(dae.warnings, []);
  assert.equal(dae.joints.length, 2);
});
