// URDF and MJCF robots onto bodies and joints: the tree comes out as the file says, the masses and joint frames are the file's, a
// pendulum swings as a pendulum does, and the two joint modes (one multibody, or impulse joints) agree.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';
import { addMJCF, addURDF } from '../dist/robots.js';

await Physics.load();

// A pendulum: a fixed post, and an arm hanging 1 m from a revolute joint about x. The arm's 1 kg sits at its far end, as a point.
const pendulum = (type = 'revolute') => `<?xml version="1.0"?>
<robot name="pendulum">
  <link name="post"><collision><geometry><box size="0.2 0.2 0.2"/></geometry></collision></link>
  <link name="arm">
    <inertial><origin xyz="0 0 -1" rpy="0 0 0"/><mass value="1"/><inertia ixx="0.001" ixy="0" ixz="0" iyy="0.001" iyz="0" izz="0.001"/></inertial>
    <collision><origin xyz="0 0 -0.5"/><geometry><cylinder radius="0.03" length="1"/></geometry></collision>
  </link>
  <joint name="hinge" type="${type}"><parent link="post"/><child link="arm"/><origin xyz="0 0 0" rpy="0 0 0"/><axis xyz="1 0 0"/><limit lower="-3.2" upper="3.2" effort="10" velocity="10"/></joint>
</robot>`;

/** Lets go from a quarter turn out (the arm level, along +y after the z-up turn) and reports the lowest speed and the arm's length. */
function swing(joints) {
  const physics = new Physics(null, { gravity: [0, -9.81, 0] });
  const robot = addURDF(physics, pendulum(), { joints, fixBase: true, position: [0, 2, 0] });
  const arm = robot.bodies.get('arm'),
    pivot = robot.bodies.get('post').position;
  // The arm hangs along -y (the file's -z turned to y up); turning its body back by that quarter turn lays it level along -z.
  assert.deepEqual(
    pivot.map((v) => Math.round(v * 1e6) / 1e6),
    [0, 2, 0],
  );
  arm.setRotation([0, 0, 0, 1]);
  physics.step();
  let fastest = 0,
    worstLength = 0;
  for (let i = 0; i < 120; i++) {
    physics.step();
    const centre = rotateCom(arm);
    worstLength = Math.max(
      worstLength,
      Math.abs(Math.hypot(centre[0] - pivot[0], centre[1] - pivot[1], centre[2] - pivot[2]) - 1),
    );
    fastest = Math.max(fastest, Math.hypot(...arm.linearVelocity));
  }
  physics.dispose();
  return { fastest, worstLength, robot };
}

/** The arm's centre of mass in the world: its inertial origin, 1 m along its own -z, turned by the body's rotation. */
function rotateCom(body) {
  const [x, y, z, w] = body.rotation,
    v = [0, 0, -1],
    t = [2 * (y * v[2] - z * v[1]), 2 * (z * v[0] - x * v[2]), 2 * (x * v[1] - y * v[0])],
    r = [
      v[0] + w * t[0] + (y * t[2] - z * t[1]),
      v[1] + w * t[1] + (z * t[0] - x * t[2]),
      v[2] + w * t[2] + (x * t[1] - y * t[0]),
    ],
    p = body.position;
  return [p[0] + r[0], p[1] + r[1], p[2] + r[2]];
}

test('a URDF pendulum is built as the file says, turned to y up, and swings at the speed energy gives', () => {
  for (const joints of ['multibody', 'impulse']) {
    const { fastest, worstLength, robot } = swing(joints);
    assert.deepEqual([...robot.bodies.keys()], ['post', 'arm']);
    assert.ok(robot.joints.has('hinge'), `${joints}: the joint is named as the file names it`);
    assert.equal(robot.multibody !== null, joints === 'multibody');
    assert.ok(worstLength < 2e-3, `${joints}: the arm's centre stays 1 m from the pivot (${worstLength})`);
    // Released level, the point mass falls 1 m: v = sqrt(2 g h), 4.43 m/s at the bottom.
    assert.ok(
      Math.abs(fastest - Math.sqrt(2 * 9.81)) < 0.25,
      `${joints}: lowest speed ${fastest} against ${Math.sqrt(2 * 9.81)}`,
    );
  }
});

test("masses, centres and inertia are the file's, and a link with none weighs its shapes at the density of water", () => {
  const physics = new Physics(null);
  const robot = addURDF(physics, pendulum(), { fixBase: true });
  const arm = robot.bodies.get('arm');
  assert.ok(Math.abs(arm.mass - 1) < 1e-6, `the file's mass (${arm.mass})`);
  const post = robot.bodies.get('post');
  assert.ok(Math.abs(post.mass - 1000 * 0.2 ** 3) < 1e-3, `a 0.2 m box of water (${post.mass})`);
  // Along the file's -z, which the turn to y up makes -y... the arm hangs 1 m down from the post, so its centre is 1 m below the origin in world terms.
  assert.ok(Math.abs(arm.position[1]) < 1e-6 && Math.abs(arm.position[2]) < 1e-6);
  physics.dispose();
  const flat = new Physics(null);
  const kept = addURDF(flat, pendulum(), { upAxis: 'y', fixBase: true });
  assert.ok(Math.abs(kept.bodies.get('arm').centerOfMass[2] - -1) < 1e-6, 'with upAxis y the file is kept as it is');
  flat.dispose();
});

test('joint kinds, a tree of three links and a file that cannot be read', () => {
  const physics = new Physics(null);
  const tree = `<robot name="t">
    <link name="a"><collision><geometry><sphere radius="0.1"/></geometry></collision></link>
    <link name="b"><collision><geometry><box size="0.1 0.1 0.1"/></geometry></collision></link>
    <link name="c"><collision><geometry><box size="0.1 0.1 0.1"/></geometry></collision></link>
    <joint name="slide" type="prismatic"><parent link="a"/><child link="b"/><origin xyz="1 0 0"/><axis xyz="0 0 1"/><limit lower="0" upper="0.5"/></joint>
    <joint name="weld" type="fixed"><parent link="b"/><child link="c"/><origin xyz="0 0 0.3" rpy="0 0 1.5707963"/></joint>
  </robot>`;
  const robot = addURDF(physics, tree, { fixBase: true, joints: 'impulse' });
  assert.deepEqual([...robot.joints.keys()], ['slide', 'weld']);
  assert.equal(robot.joints.get('slide').type, 'prismatic');
  assert.equal(robot.joints.get('weld').type, 'fixed');
  // The second joint's origin puts c 0.3 m up the file's z from b, which is y in the engine; b is 1 m along x.
  assert.ok(Math.abs(robot.bodies.get('b').position[0] - 1) < 1e-6);
  assert.ok(Math.abs(robot.bodies.get('c').position[1] - 0.3) < 1e-6, `${robot.bodies.get('c').position}`);
  assert.throws(() => addURDF(physics, '<nothing/>'), /not a URDF file/);
  assert.throws(
    () =>
      addURDF(
        physics,
        '<robot><link name="a"/><joint name="j" type="fixed"><parent link="a"/><child link="zz"/></joint></robot>',
      ),
    /names a link the file does not have/,
  );
  assert.throws(
    () =>
      addURDF(
        physics,
        '<robot><link name="a"/><link name="b"/><joint name="j" type="planar"><parent link="a"/><child link="b"/></joint></robot>',
      ),
    (error) => error.code === 'unsupported' && /revolute, prismatic, fixed or floating/.test(error.message),
  );
  const skipping = addURDF(
    new Physics(null),
    '<robot><link name="a"><collision><geometry><mesh filename="a.stl"/></geometry></collision></link></robot>',
  );
  assert.deepEqual(skipping.skipped, ['mesh a.stl of link a: pass loadMesh to read it']);
  physics.dispose();
});

test('an MJCF hinge arm hangs from the world and is built from bodies, geoms, a joint and an inertial', () => {
  const mjcf = `<mujoco model="arm"><compiler angle="degree"/>
    <worldbody>
      <geom name="floor" type="plane" size="5 5 0.1"/>
      <body name="base" pos="0 0 2"><geom type="box" size="0.1 0.1 0.1" mass="2"/>
        <body name="arm" pos="0 0 0"><joint name="elbow" type="hinge" axis="1 0 0" range="-90 90" damping="0.5"/>
          <geom type="capsule" fromto="0 0 0 0 0 -1" size="0.05" mass="1"/>
          <inertial pos="0 0 -0.5" mass="1" diaginertia="0.08 0.08 0.001"/>
        </body>
      </body>
    </worldbody></mujoco>`;
  const physics = new Physics(null);
  const robot = addMJCF(physics, mjcf, { joints: 'impulse' });
  assert.deepEqual([...robot.bodies.keys()], ['base', 'arm']);
  assert.ok(robot.joints.has('elbow'));
  assert.equal(robot.root.type, 'fixed', 'a body of the worldbody with no free joint is welded to the world');
  assert.ok(Math.abs(robot.bodies.get('base').position[1] - 2) < 1e-6, 'z up in the file is y up here');
  assert.ok(Math.abs(robot.bodies.get('arm').mass - 1) < 1e-6, 'the inertial wins');
  assert.ok(Math.abs(robot.bodies.get('base').mass - 2) < 1e-6);
  // The floor plane is scenery: something dropped on it rests on it.
  const ball = physics.addBody(null, { position: [0, 1, 1], colliders: { shape: 'sphere', radius: 0.2 } });
  for (let i = 0; i < 120; i++) physics.step();
  assert.ok(ball.position[1] < 0.25 && ball.position[1] > 0.15, `rests on the plane (${ball.position[1]})`);
  assert.throws(
    () =>
      addMJCF(
        physics,
        '<mujoco><worldbody><body name="b"><joint type="hinge"/><joint type="slide"/></body></worldbody></mujoco>',
      ),
    (error) => error.code === 'unsupported' && /one joint/.test(error.message),
  );
  assert.throws(() => addMJCF(physics, '<robot/>'), /not an MJCF file/);
  physics.dispose();
});
