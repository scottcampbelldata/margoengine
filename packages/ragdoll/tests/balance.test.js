// @margoengine/ragdoll/balance: a powered ragdoll on the real Knight rig, on a floor in a stepping Rapier world, pushed by
// setting the upper body moving. The controller is an assist, and these tests read what it gave.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Ragdoll } from '../dist/index.js';
import { addRagdollBalance } from '../dist/balance.js';
import { fitRagdollShapes } from '../dist/hulls.js';
import { addRagdollMotors } from '../dist/powered.js';
import { humanoidProfile, ragdollOptions } from '../dist/profile.js';
import { rotateByQuaternion as rotate } from '@margoengine/math/quat';
import { realRig, skip } from './rig.js';

const rtest = (name, fn) => test(name, { skip, timeout: 60_000 }, fn);
const bones = (rig) => ({
  hips: rig.node('hips'),
  spine: rig.node('spine'),
  chest: rig.node('chest'),
  head: rig.node('head'),
  ...Object.fromEntries(
    [
      ['left', 'l'],
      ['right', 'r'],
    ].flatMap(([side, s]) => [
      [`${side}UpperArm`, rig.node(`upperarm.${s}`)],
      [`${side}LowerArm`, rig.node(`lowerarm.${s}`)],
      [`${side}Hand`, rig.node(`hand.${s}`)],
      [`${side}UpperLeg`, rig.node(`upperleg.${s}`)],
      [`${side}LowerLeg`, rig.node(`lowerleg.${s}`)],
      [`${side}Foot`, rig.node(`foot.${s}`)],
    ]),
  ),
});

/** Moves every hull point of the ragdoll by up to `ulps` 32-bit rounding steps, the same way for one seed. */
function roundDifferently(ragdoll, ulps, seed) {
  let state = seed;
  const random = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
  for (const part of ragdoll.bones) {
    if (part.shape.type !== 'hull') continue;
    const points = Array.from(part.shape.points, (p) => Math.fround(p * (1 + random() * ulps * 2.4e-7)));
    ragdoll.setShape(part, { type: 'hull', points });
  }
}

async function standing({ balance = true, rounding, ...options } = {}) {
  const rig = await realRig('kaykit/adventurers/characters/Knight.glb');
  rig.frames(1);
  const ragdoll = Ragdoll.attach(
    rig.physics,
    ragdollOptions(humanoidProfile(rig.model.nodes, { bones: bones(rig), mass: 30 }), rig.model.nodes),
  );
  fitRagdollShapes(ragdoll, rig.model);
  if (rounding) roundDifferently(ragdoll, rounding.ulps, rounding.seed);
  const motors = addRagdollMotors(ragdoll, { frequency: 8 }),
    feet = [rig.node('foot.l'), rig.node('foot.r')],
    keeper = balance ? addRagdollBalance(ragdoll, motors, { feet, ...options }) : null,
    hips = ragdoll.bones[0].body,
    height = hips.position[1],
    upper = ragdoll.bones.filter((part) => !/leg|foot|toes/.test(part.node.name));
  ragdoll.activate();
  const push = (x, z) => {
    for (const { body } of upper) {
      const v = body.linearVelocity;
      body.setLinearVelocity([v[0] + x, v[1], v[2] + z]);
    }
  };
  return { rig, ragdoll, motors, keeper, hips, height, push, feet };
}

rtest('without it the character folds up; with it the same character settles, stands and takes no more steps', async () => {
  const limp = await standing({ balance: false });
  limp.rig.frames(180);
  assert.ok(limp.hips.position[1] < limp.height * 0.85, `motors alone sink (${limp.hips.position[1]} of ${limp.height})`);
  limp.rig.dispose();

  const { rig, keeper, hips, height } = await standing();
  // Letting go of a straight-legged pose sags and takes a few steps (docs/limits.md); after that nothing moves.
  rig.frames(120);
  const start = [...hips.position],
    settled = keeper.steps;
  rig.frames(240);
  assert.equal(keeper.state, 'standing');
  assert.ok(hips.position[1] > height * 0.8, `standing (${hips.position[1]} of ${height})`);
  assert.ok(keeper.tilt < 0.15, `upright (${keeper.tilt} rad)`);
  assert.ok(Math.hypot(hips.position[0] - start[0], hips.position[2] - start[2]) < 0.1, 'and stays where it was');
  assert.equal(keeper.steps, settled, 'no step unasked');
  rig.dispose();
});

// A character that settles settles whatever the rounding of its hull points: it stands where it stood, at the height it was
// asked for, on its own legs, with no step after the first second. The command is stance 0.97 of the height over the feet.
const HELD_HEIGHT = 0.398;
for (const ulps of [1, 4, 16])
  test(`it settles on its own legs with its hull points ${ulps} rounding steps off`, { skip, timeout: 300_000 }, async () => {
    const failures = [];
    for (let seed = 1; seed <= 8; seed++) {
      const { rig, ragdoll, keeper, hips } = await standing({ rounding: { ulps, seed } }),
        fail = (what) => failures.push(`seed ${seed}: ${what}`);
      let steps = 0,
        settled,
        drift = 0,
        off = 0,
        carried = 0;
      for (let frame = 1; frame <= 360; frame++) {
        rig.frames(1);
        if (frame === 60) {
          settled = [...hips.position];
          steps = keeper.steps;
        }
        if (settled) drift = Math.max(drift, Math.hypot(hips.position[0] - settled[0], hips.position[2] - settled[2]));
        if (frame >= 120) off = Math.max(off, Math.abs(hips.position[1] - HELD_HEIGHT));
        carried = Math.max(carried, keeper.carried);
      }
      let mass = 0;
      const speed = [0, 0, 0];
      for (const { body } of ragdoll.bones) {
        mass += body.mass;
        body.linearVelocity.forEach((v, k) => (speed[k] += v * body.mass));
      }
      const still = Math.hypot(...speed) / mass;
      if (keeper.steps !== steps) fail(`${keeper.steps - steps} steps after frame 60`);
      if (drift >= 0.05) fail(`hips drifted ${drift} m`);
      if (off >= 0.02) fail(`hips ${off} m off the height asked for`);
      if (still >= 0.02) fail(`centre of mass at ${still} m/s`);
      if (carried !== 0) fail(`an outside force carried ${carried} of its weight`);
      rig.dispose();
    }
    assert.deepEqual(failures, []);
  });

// Figures beyond Knight: its kin have other bodies on one skeleton, and RiggedFigure and Seed-san are other skeletons, 70 kg
// on bent knees and 60 kg with long feet.
const kin = (name) => [`kaykit/adventurers/characters/${name}.glb`, bones, 30];
const seedSan = [
  'vrm/Seed-san.vrm',
  (rig) => ({
    hips: rig.node('hips'),
    spine: rig.node('spine'),
    chest: rig.node('chest'),
    head: rig.node('head 1'),
    ...Object.fromEntries(
      [
        ['left', 'L'],
        ['right', 'R'],
      ].flatMap(([side, s]) => [
        [`${side}UpperArm`, rig.node(`upper_arm.${s}`)],
        [`${side}LowerArm`, rig.node(`forearm.${s}`)],
        [`${side}Hand`, rig.node(`hand.${s}`)],
        [`${side}UpperLeg`, rig.node(`thigh.${s}`)],
        [`${side}LowerLeg`, rig.node(`shin.${s}`)],
        [`${side}Foot`, rig.node(`foot.${s}`)],
      ]),
    ),
  }),
  60,
];
const figures = {
  Barbarian: kin('Barbarian'),
  Ranger: kin('Ranger'),
  Rogue: kin('Rogue'),
  Mage: kin('Mage'),
  'Seed-san': seedSan,
  RiggedFigure: [
    'khronos/RiggedFigure/RiggedFigure.glb',
    (rig) => ({
      hips: rig.node('torso_joint_1'),
      spine: rig.node('torso_joint_2'),
      chest: rig.node('torso_joint_3'),
      head: rig.node('neck_joint_2'),
      ...Object.fromEntries(
        [
          ['left', 'L'],
          ['right', 'R'],
        ].flatMap(([side, s]) => [
          [`${side}UpperArm`, rig.node(`arm_joint_${s}_1`)],
          [`${side}LowerArm`, rig.node(`arm_joint_${s}_2`)],
          [`${side}Hand`, rig.node(`arm_joint_${s}_3`)],
          [`${side}UpperLeg`, rig.node(`leg_joint_${s}_1`)],
          [`${side}LowerLeg`, rig.node(`leg_joint_${s}_2`)],
          [`${side}Foot`, rig.node(`leg_joint_${s}_3`)],
        ]),
      ),
    }),
    70,
  ],
};

async function figure([path, boneMap, mass], rounding, passes) {
  const rig = await realRig(path);
  if (passes) rig.physics.world.numSolverIterations = passes;
  rig.frames(1);
  const map = boneMap(rig),
    ragdoll = Ragdoll.attach(rig.physics, ragdollOptions(humanoidProfile(rig.model.nodes, { bones: map, mass }), rig.model.nodes));
  fitRagdollShapes(ragdoll, rig.model);
  roundDifferently(ragdoll, rounding.ulps, rounding.seed);
  const motors = addRagdollMotors(ragdoll, { frequency: 8 }),
    keeper = addRagdollBalance(ragdoll, motors, { feet: [map.leftFoot, map.rightFoot] });
  ragdoll.activate();
  return { rig, ragdoll, keeper, hips: ragdoll.bones[0].body, feet: [ragdoll.part(map.leftFoot).body, ragdoll.part(map.rightFoot).body] };
}

// Knight's bounds as shares of the hip height, so a bigger figure is held to the same standing: 0.05 m and 0.02 m on 0.406 m.
// Feet that stand stay where they stand: a solver motor on a knee slid them 0.045 m in five seconds on RiggedFigure and 0.007 m
// on Seed-san and Mage, with a body otherwise at rest and friction nowhere near its limit.
const FOOT_SLIDE = 0.002;
for (const [name, entry] of Object.entries(figures))
  test(`${name} settles on its own legs, whatever the rounding of its hull points`, { skip, timeout: 300_000 }, async () => {
    const failures = [];
    for (const ulps of [1, 4, 16])
      for (let seed = 1; seed <= 8; seed++) {
        const { rig, ragdoll, keeper, hips, feet } = await figure(entry, { ulps, seed }),
          size = hips.position[1],
          fail = (what) => failures.push(`${ulps} steps, seed ${seed}: ${what}`);
        let steps = 0,
          settled,
          stood,
          drift = 0,
          slide = 0;
        const heights = [];
        for (let frame = 1; frame <= 360; frame++) {
          rig.frames(1);
          if (frame === 60) {
            settled = [...hips.position];
            stood = feet.map((foot) => [...foot.position]);
            steps = keeper.steps;
          }
          if (settled) {
            drift = Math.max(drift, Math.hypot(hips.position[0] - settled[0], hips.position[2] - settled[2]));
            feet.forEach(({ position }, i) => (slide = Math.max(slide, Math.hypot(position[0] - stood[i][0], position[2] - stood[i][2]))));
          }
          if (frame >= 120) heights.push(hips.position[1]);
        }
        const speed = [0, 0, 0];
        let mass = 0;
        for (const { body } of ragdoll.bones) {
          mass += body.mass;
          body.linearVelocity.forEach((v, k) => (speed[k] += v * body.mass));
        }
        const still = Math.hypot(...speed) / mass;
        if (keeper.state === 'fallen') fail('it fell');
        if (keeper.steps !== steps) fail(`${keeper.steps - steps} steps after frame 60`);
        if (drift >= (0.05 / 0.406) * size) fail(`hips drifted ${drift} m`);
        if (slide >= FOOT_SLIDE) fail(`a foot slid ${slide} m`);
        if (Math.max(...heights) - Math.min(...heights) >= (0.02 / 0.406) * size) fail('its hips did not hold their height');
        if (still >= 0.02) fail(`centre of mass at ${still} m/s`);
        if (keeper.carried !== 0) fail('an outside force carried it');
        rig.dispose();
      }
    assert.deepEqual(failures, []);
  });

// The torques go through the solver's passes as forces. As impulses before the first pass, 16 passes crept every figure
// at about 0.03 m/s where 10 held, and RiggedFigure and Seed-san fell: more solver work must never read worse.
async function creep(entry, passes, rounding) {
  const { rig, ragdoll, keeper, hips } = await figure(entry, rounding, passes),
    size = hips.position[1];
  rig.frames(60);
  const start = [...hips.position],
    steps = keeper.steps;
  rig.frames(300);
  const drift = Math.hypot(hips.position[0] - start[0], hips.position[2] - start[2]),
    mass = ragdoll.bones.reduce((sum, { body }) => sum + body.mass, 0),
    momentum = [0, 0, 0];
  for (const { body } of ragdoll.bones) body.linearVelocity.forEach((v, k) => (momentum[k] += v * body.mass));
  const read = { drift, size, speed: Math.hypot(...momentum) / mass, state: keeper.state, late: keeper.steps - steps };
  rig.dispose();
  return read;
}
for (const [name, entry] of Object.entries({ Knight: kin('Knight'), ...figures }))
  test(`${name} at 16 solver passes reads no worse than at 10`, { skip, timeout: 120_000 }, async () => {
    for (const seed of [1, 2, 3]) {
      const rounding = { ulps: 4, seed },
        ten = await creep(entry, 10, rounding),
        sixteen = await creep(entry, 16, rounding);
      assert.equal(sixteen.state, 'standing', `seed ${seed} stands`);
      assert.equal(sixteen.late, 0, `seed ${seed} takes no late step`);
      assert.ok(sixteen.speed < 0.02, `seed ${seed} is still (${sixteen.speed} m/s)`);
      // Under a millimetre the two are the same: rounding picks which reads smaller.
      assert.ok(sixteen.drift <= Math.max(ten.drift, 0.001), `seed ${seed} drifts ${sixteen.drift} m at 16, ${ten.drift} m at 10`);
    }
  });

// The controller reads how the hips moved from where they went. What a body reports at the end of a step is what the solver's
// last pass left: Seed-san's hips reported 0.02 m/s one way while moving 0.008 m/s the other, and at 10 passes the height's
// spring rang on that at half the frame rate, 0.026 m/s, for as long as it stood.
test('Seed-san stands quiet at 10 solver passes, whatever the rounding of its hull points', { skip, timeout: 120_000 }, async () => {
  const failures = [];
  for (const ulps of [1, 4, 16])
    for (let seed = 1; seed <= 8; seed++) {
      const { rig, ragdoll } = await figure(seedSan, { ulps, seed }, 10),
        mass = ragdoll.bones.reduce((sum, { body }) => sum + body.mass, 0);
      let most = 0;
      rig.frames(300);
      for (let frame = 0; frame < 60; frame++) {
        rig.frames(1);
        const momentum = [0, 0, 0];
        for (const { body } of ragdoll.bones) body.linearVelocity.forEach((v, k) => (momentum[k] += v * body.mass));
        most = Math.max(most, Math.hypot(...momentum) / mass);
      }
      if (most >= 0.005) failures.push(`${ulps} steps, seed ${seed}: ${most} m/s`);
      rig.dispose();
    }
  assert.deepEqual(failures, []);
});

// A contact keeps four points for the solver. A fitted boot's sole has many, a few millimetres apart in height, and which
// four were kept changed with the slightest turn: the foot dropped on a point left out and the body shook.
rtest('a foot stands on a flat sole of four corners, every one of them in the solver, and dispose puts its hull back', async () => {
  const { rig, ragdoll, keeper, feet } = await standing(),
    world = rig.physics.world,
    parts = feet.map((foot) => ragdoll.part(foot));
  for (const part of parts) {
    const heights = [];
    for (let i = 0; i < part.shape.points.length; i += 3) {
      const at = [part.shape.points[i], part.shape.points[i + 1], part.shape.points[i + 2]];
      heights.push(rotate(at, part.body.rotation)[1]);
    }
    const lowest = Math.min(...heights);
    assert.equal(heights.filter((height) => height < lowest + 1e-5).length, 4, 'four corners on one plane');
  }
  rig.frames(120);
  for (const part of parts) {
    const collider = part.body.raw.collider(0);
    const corners = new Set();
    world.contactPairsWith(collider, (other) =>
      world.contactPair(collider, other, (manifold) => {
        for (let i = 0; i < manifold.numSolverContacts(); i++) {
          const { x, z } = manifold.solverContactPoint(i);
          corners.add(`${x.toFixed(3)} ${z.toFixed(3)}`);
        }
      }),
    );
    assert.equal(corners.size, 4, 'and the solver has all four');
  }
  keeper.dispose();
  rig.dispose();

  const plain = await standing({ balance: false }),
    fitted = plain.ragdoll.part(plain.feet[0]).shape;
  plain.rig.dispose();
  const again = await standing(),
    foot = again.ragdoll.part(again.feet[0]);
  again.keeper.dispose();
  assert.deepEqual([...foot.shape.points], [...fitted.points], 'dispose gives the fitted hull back');
  again.rig.dispose();
});

rtest('it holds its torques as forces: they leave with dispose and with a bone gone kinematic, and leave a force of yours alone', async () => {
  const { rig, ragdoll, keeper, feet } = await standing(),
    foot = ragdoll.part(feet[0]).body,
    torque = () => Math.hypot(...Object.values(foot.raw.userTorque()));
  rig.frames(120);
  assert.ok(torque() > 0, 'the ankle holds a torque while it stands');
  foot.addForce([3, 0, 0]);
  rig.frames(2);
  keeper.dispose();
  assert.equal(torque() < 1e-4, true, `dispose takes the torque off (${torque()} N m)`);
  assert.ok(Math.abs(foot.raw.userForce().x - 3) < 1e-4, 'and leaves the force of yours');
  rig.dispose();

  const second = await standing(),
    body = second.ragdoll.part(second.feet[0]).body;
  second.rig.frames(120);
  second.ragdoll.deactivate(0);
  second.rig.frames(2);
  second.keeper.dispose();
  second.ragdoll.activate();
  assert.ok(Math.hypot(...Object.values(body.raw.userTorque())) < 1e-4, 'nothing is left to come back with the body');
  second.rig.dispose();
});

rtest('what it adds to the solver stays on the character and goes with dispose', async () => {
  const plain = await standing({ balance: false }),
    foot = (ragdoll) => ragdoll.bones.find((part) => part.node.name === 'foot.l').body,
    inertia = (body) => body.raw.principalInertia().x;
  plain.rig.frames(1);
  const alone = inertia(foot(plain.ragdoll));
  plain.rig.dispose();
  const { rig, ragdoll, keeper } = await standing(),
    passes = rig.physics.world.numSolverIterations;
  rig.frames(1);
  assert.ok(inertia(foot(ragdoll)) > alone * 2, 'the foot is harder to spin while it balances');
  assert.ok(foot(ragdoll).raw.additionalSolverIterations() > 0, 'and its island gets more solver passes');
  keeper.dispose();
  rig.frames(1);
  assert.ok(Math.abs(inertia(foot(ragdoll)) - alone) < 1e-6 * alone, 'dispose puts the inertia back');
  assert.equal(foot(ragdoll).raw.additionalSolverIterations(), 0, 'and the passes');
  assert.equal(rig.physics.world.numSolverIterations, passes, 'the world is never touched');
  rig.dispose();
});

for (const [label, x, z] of [
  ['forward', 0, 1.5],
  ['backward', 0, -1.5],
  ['to its left', 1.5, 0],
  ['to its right', -1.5, 0],
])
  rtest(`pushed ${label} it steps that way, catches itself and stands`, async () => {
    const { rig, ragdoll, keeper, hips, height, push, feet } = await standing();
    rig.frames(120);
    const before = keeper.steps,
      was = hips.position,
      bodies = feet.map((foot) => ragdoll.part(foot).body),
      feetWere = bodies.map((body) => [...body.position]);
    const along = (a, b) => ((a[0] - b[0]) * x + (a[2] - b[2]) * z) / Math.hypot(x, z);
    let went = 0,
      moved = 0;
    push(x, z);
    rig.frames(240, 1 / 60, () => {
      went = Math.max(went, along(hips.position, was));
      bodies.forEach((body, i) => (moved = Math.max(moved, along(body.position, feetWere[i]))));
    });
    assert.notEqual(keeper.state, 'fallen');
    assert.ok(keeper.steps > before, 'it stepped');
    assert.ok(hips.position[1] > height * 0.8, `still up (${hips.position[1]} of ${height})`);
    assert.ok(keeper.tilt < 0.3, `upright (${keeper.tilt} rad)`);
    assert.ok(went > 0.02, `the body went with the push (${went} m)`);
    assert.ok(moved > 0.02, `and a foot went that way (${moved} m)`);
    rig.frames(120);
    const speed = Math.hypot(...hips.linearVelocity);
    assert.ok(speed < 0.5, `and it has stopped (${speed} m/s)`);
    rig.dispose();
  });

rtest('a harder blow than the caps hold knocks it over, the assist stops, and reset stands it again', async () => {
  const { rig, keeper, push, ragdoll } = await standing({ maxUpright: 10 });
  rig.frames(120);
  push(0, 6);
  rig.frames(180);
  assert.equal(keeper.state, 'fallen');
  assert.equal(keeper.carried, 0, 'no help is given once down');
  assert.ok(keeper.tilt > 1, `down (${keeper.tilt} rad)`);
  assert.equal(ragdoll.active, true);
  keeper.reset();
  assert.equal(keeper.state, 'standing');
  rig.dispose();
});

rtest('the help it gives is capped and reported', async () => {
  const { rig, keeper } = await standing({ carry: 0.5 });
  let most = 0;
  rig.frames(240, 1 / 60, () => (most = Math.max(most, keeper.carried)));
  // At most 1.5 times the carried share of the upper body's weight: the upper body is about 0.6 of the mass.
  assert.ok(most > 0.1 && most <= 0.5 * 1.5, `carried ${most} of the body's weight at most`);
  rig.dispose();
});

rtest('options and rigs are checked, and dispose hands the legs back', async () => {
  const { rig, ragdoll, motors, keeper, feet } = await standing();
  assert.throws(() => addRagdollBalance(null, motors, { feet }), { name: 'TypeError' });
  assert.throws(() => addRagdollBalance(ragdoll, {}, { feet }), { name: 'TypeError' });
  assert.throws(() => addRagdollBalance(ragdoll, motors, {}), { name: 'TypeError' });
  assert.throws(() => addRagdollBalance(ragdoll, motors, { feet: [rig.engine.createMesh(), feet[1]] }), {
    name: 'RangeError',
    message: /not a bone/,
  });
  assert.throws(() => addRagdollBalance(ragdoll, motors, { feet: [rig.node('head'), feet[1]] }), {
    name: 'RangeError',
    message: /knee hinge/,
  });
  assert.throws(() => addRagdollBalance(ragdoll, motors, { feet, carry: 2 }), { name: 'RangeError' });
  keeper.dispose();
  keeper.dispose();
  assert.throws(() => keeper.reset(), { code: 'disposed' });
  rig.frames(120);
  assert.equal(keeper.steps, 0, 'nothing runs after dispose');
  rig.dispose();
});
