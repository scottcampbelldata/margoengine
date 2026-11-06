// @margoengine/ragdoll/powered: motors drive a real rig along a real clip in a stepping Rapier world, hits knock it off
// the pose and it comes back, torque caps, limits, fading and clean removal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { conjugateQuaternion as conj, multiplyQuaternions as mul } from '../../math/dist/quat.js';
import { Ragdoll } from '../dist/index.js';
import { addRagdollMotors } from '../dist/powered.js';
import { realRig, skip } from './rig.js';

const rtest = (name, fn) => test(name, { skip, timeout: 60_000 }, fn);
const WALKER = 'kaykit/adventurers/animations/Rig_Medium/Rig_Medium_MovementBasic.glb';
const apart = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3])));
const relative = (ragdoll, part) => mul(conj(ragdoll.bones[part.parent].body.rotation), part.body.rotation);
const target = (part) => Array.from(part.animated).slice(3);
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** The knight's rig walking on its own clip, with free joints unless `joint` is given. */
async function walker({ joint = { type: 'free' }, floor = false, state = 'Walking_A', ...options } = {}) {
  const rig = await realRig(WALKER, { states: { walk: state }, floor });
  rig.frames(1);
  const ragdoll = Ragdoll.attach(rig.physics, { root: rig.node('hips'), joint }),
    motors = options.motors === false ? null : addRagdollMotors(ragdoll, { root: 1, ...options });
  rig.frames(10);
  return { rig, ragdoll, motors };
}
/** Mean angle between every non root bone and its animated pose over `frames` frames. */
function tracking(rig, ragdoll, frames) {
  let sum = 0,
    count = 0;
  rig.frames(frames, 1 / 60, () => {
    for (const part of ragdoll.bones.slice(1)) {
      sum += apart(relative(ragdoll, part), target(part));
      count++;
    }
  });
  return sum / count;
}

rtest('a real rig walks its real clip as physics: motors follow the moving pose, limp bones do not', async () => {
  const { rig, ragdoll, motors } = await walker();
  ragdoll.activate();
  // Motors track the walk at about a tenth of a radian on average; hands and feet, the lightest, take the most.
  const powered = tracking(rig, ragdoll, 180);
  assert.ok(powered < 0.15, `powered bones stay on the clip (${powered})`);
  assert.ok(motors.error > 0, 'and report how far off they are');
  // The same world with the motors off: gravity takes the arms and legs with the spring still holding the hips.
  motors.strength = 0;
  const limp = tracking(rig, ragdoll, 180);
  assert.ok(limp > 3 * powered, `limp bones leave the clip (${limp} against ${powered})`);
  rig.dispose();
});

rtest('the walk moves: the motors track it, not a still pose', async () => {
  // Stands in for a check on the clip itself: this test fails on a clip whose bones do not turn, which would make the
  // test above prove nothing (RiggedFigure's only clip is such a clip).
  const { rig, ragdoll } = await walker({ motors: false });
  const thigh = ragdoll.part(rig.node('upperleg.l')),
    before = target(thigh);
  let far = 0;
  rig.frames(40, 1 / 60, () => (far = Math.max(far, apart(before, target(thigh)))));
  assert.ok(far > 0.4, `the thigh swings ${far} rad in the clip`);
  rig.dispose();
});

rtest('a hit knocks the body off its pose, and the motors and the root spring take it back', async () => {
  const { rig, ragdoll, motors } = await walker({ state: 'T-Pose' }),
    chest = ragdoll.part(rig.node('chest')),
    root = ragdoll.bones[0].body;
  ragdoll.activate();
  rig.frames(60);
  const home = root.position,
    settled = motors.error;
  // The whole body weighs about 26 kg: 150 N s is a shove of about 6 m/s.
  motors.hit(chest, [0, 0, -150]);
  let farthest = 0,
    worst = 0;
  rig.frames(30, 1 / 60, () => {
    farthest = Math.max(farthest, distance(root.position, home));
    worst = Math.max(worst, motors.error);
  });
  // A critically damped spring at w = 37.7 rad/s peaks at v / (e w), about 0.057 m.
  assert.ok(farthest > 0.03, `the hips are knocked away (${farthest} m)`);
  assert.ok(worst > settled + 0.05, `the joints bend (${worst} rad against ${settled})`);
  // Critically damped at 6 Hz, a spring is down to 1/100 in about 7 / w = 0.2 s; the strength takes 0.6 s to come back.
  rig.frames(90);
  assert.ok(distance(root.position, home) < 0.02, 'back where the animation has it');
  assert.ok(motors.error < settled + 0.02, `and back on the pose (${motors.error})`);
  rig.dispose();
});

rtest('a weakened limb gives way further than a strong one, and hits leave other limbs at full strength', async () => {
  const run = async (hit) => {
    const { rig, ragdoll, motors } = await walker({ state: 'T-Pose', root: 1 }),
      arm = ragdoll.part(rig.node('lowerarm.l'));
    ragdoll.activate();
    rig.frames(30);
    hit(motors, arm);
    let bend = 0;
    rig.frames(20, 1 / 60, () => (bend = Math.max(bend, apart(relative(ragdoll, arm), target(arm)))));
    rig.dispose();
    return bend;
  };
  const push = [0, 0, -3];
  const stiff = await run((motors, arm) => {
    motors.hit(arm, push, { weaken: 0 });
  });
  const weak = await run((motors, arm) => {
    motors.hit(arm, push, { weaken: 0.95, recover: 1 });
  });
  assert.ok(weak > 1.5 * stiff, `the weakened arm bends further (${weak} against ${stiff})`);
});

rtest('joint motors alone do not lift a body: without the root spring it falls, keeping its pose', async () => {
  const fall = async (strength) => {
    const { rig, ragdoll, motors } = await walker({ state: 'T-Pose', root: 0, floor: true, strength });
    ragdoll.activate();
    const start = ragdoll.bones[0].body.position[1];
    rig.frames(150);
    const lifted = ragdoll.bones.slice(1).map((part) => apart(relative(ragdoll, part), target(part))),
      result = { start, hips: ragdoll.bones[0].body.position[1], error: Math.max(...lifted), motors };
    rig.dispose();
    return result;
  };
  const stiff = await fall(1),
    limp = await fall(0);
  assert.ok(stiff.hips < stiff.start, 'the powered body does not float');
  assert.ok(stiff.error < limp.error / 2, `it keeps its pose (${stiff.error} against limp ${limp.error})`);
});

/** A straight arm of two 1 kg bones out along +x from a fixed shoulder, and a stand-in pose: this is motor maths. */
async function arm(options, joint = { type: 'free' }) {
  const rig = await realRig(WALKER, {});
  const { engine } = rig,
    root = engine.createMesh().setPosition([0, 3, 0]),
    upper = engine.createMesh(root).setQuaternion([0, 0, -Math.SQRT1_2, Math.SQRT1_2]),
    lower = engine.createMesh(upper).setPosition([0, 1, 0]);
  engine.createMesh(lower).setPosition([0, 1, 0]);
  rig.engine.store.tick(false);
  const ragdoll = Ragdoll.attach(rig.physics, {
    bones: [
      { node: root, length: 0.2, mass: 5 },
      { node: upper, length: 1, radius: 0.05, mass: 1, joint },
      { node: lower, length: 1, radius: 0.05, mass: 1, joint },
    ],
    active: true,
    angularDamping: 0,
    linearDamping: 0,
  });
  ragdoll.bones[0].body.setType('fixed');
  const motors = addRagdollMotors(ragdoll, options);
  return { rig, ragdoll, motors, upper, lower };
}

rtest('the torque cap: an arm holds itself out while its cap beats gravity, and drops when it does not', async () => {
  // Stand-in rig. About the shoulder: gravity's torque is 1 * g * 0.5 + 1 * g * 1.5 = 19.6 N m and the limb's inertia
  // is about 1 * (1/12 + 0.25) + 1 * (1/12 + 2.25) = 2.67 kg m², so the cap beats gravity above 7.4 rad/s².
  const drop = async (maxAcceleration) => {
    const { rig, ragdoll, motors } = await arm({ maxAcceleration, frequency: 8 });
    let worst = 0;
    rig.frames(90, 1 / 60, () => (worst = Math.max(worst, motors.error)));
    ragdoll.dispose();
    rig.dispose();
    return worst;
  };
  assert.ok((await drop(20)) < 0.2, 'twice the torque holds');
  assert.ok((await drop(4)) > 0.5, 'half the torque does not');
});

rtest('a motor does not pull past a limit: its target stops at the cone and at the hinge stop', async () => {
  const cone = { type: 'cone', swing: 0.3, twist: [-0.2, 0.2] },
    { rig, ragdoll, motors, lower } = await arm({ frequency: 8 }, cone);
  // Ask for a full right angle at the elbow, past the 0.3 rad cone.
  lower.setQuaternion([0, 0, Math.sin(0.8), Math.cos(0.8)]);
  const elbow = ragdoll.bones[2];
  rig.frames(60);
  const reached = apart(relative(ragdoll, elbow), elbow.rest);
  assert.ok(reached > 0.2 && reached < 0.3 + 0.1, `the elbow bends to its 0.3 rad limit (${reached})`);
  assert.ok(motors.error < 0.15, `and the motor is content there (${motors.error})`);
  ragdoll.dispose();
  rig.dispose();

  const hinge = { type: 'hinge', axis: [0, 0, 1], limits: [-1, 0.5] },
    bent = await arm({ frequency: 8 }, hinge);
  bent.lower.setQuaternion([0, 0, Math.sin(-0.4), Math.cos(-0.4)]);
  bent.rig.frames(60);
  const joint = bent.ragdoll.bones[2],
    d = mul(conj(joint.rest), relative(bent.ragdoll, joint));
  assert.ok(Math.abs(2 * Math.atan2(d[2], d[3]) + 0.8) < 0.1, 'a hinge turns to its target, the right way round');
  bent.lower.setQuaternion([0, 0, Math.sin(0.6), Math.cos(0.6)]);
  bent.rig.frames(60);
  const e = mul(conj(joint.rest), relative(bent.ragdoll, joint));
  assert.ok(Math.abs(2 * Math.atan2(e[2], e[3]) - 0.5) < 0.1, 'and stops at its limit short of a target past it');
  bent.ragdoll.dispose();
  bent.rig.dispose();
});

rtest('strength fades, one limb can go limp alone, and dispose leaves a plain ragdoll', async () => {
  const { rig, ragdoll, motors } = await walker({ state: 'T-Pose' }),
    left = ragdoll.part(rig.node('upperarm.l')),
    right = ragdoll.part(rig.node('upperarm.r'));
  ragdoll.activate();
  rig.frames(30);
  motors.setStrength(left.node, 0);
  rig.frames(60);
  const loose = apart(relative(ragdoll, left), target(left)),
    firm = apart(relative(ragdoll, right), target(right));
  assert.ok(loose > 0.5 && firm < 0.1, `the left arm hangs (${loose}), the right holds (${firm})`);
  motors.fade(0, 0.5);
  rig.frames(15);
  assert.ok(Math.abs(motors.strength - 0.5) < 0.04, `halfway down (${motors.strength})`);
  rig.frames(16);
  assert.equal(motors.strength, 0);
  motors.strength = 1;
  const mass = ragdoll.bones.map((part) => part.body.mass);
  motors.dispose();
  motors.dispose();
  rig.frames(2);
  ragdoll.bones.forEach((part, i) => assert.ok(part.body.mass <= mass[i], 'the added mass comes off'));
  assert.throws(() => motors.fade(1, 1), { code: 'disposed' });
  rig.frames(60);
  assert.ok(apart(relative(ragdoll, right), target(right)) > 0.5, 'limp: the right arm hangs too');
  rig.dispose();
});

rtest('a hit needs a bone of this ragdoll, and options are checked', async () => {
  const { rig, ragdoll, motors } = await walker({ state: 'T-Pose' });
  assert.throws(() => addRagdollMotors({}), { name: 'TypeError', message: /needs a Ragdoll/ });
  for (const bad of [{ frequency: 0 }, { damping: -1 }, { strength: 2 }, { maxAcceleration: 0 }, { root: -1 }])
    assert.throws(() => addRagdollMotors(ragdoll, bad), { name: 'RangeError' });
  assert.throws(() => motors.hit(rig.engine.createMesh(), [0, 0, 1]), /not a bone/);
  assert.throws(() => motors.hit(ragdoll.bones[1], [0, 0, 1], { weaken: 2 }), { name: 'RangeError' });
  assert.throws(() => motors.fade(1, -1), { name: 'RangeError' });
  assert.throws(() => (motors.strength = 2), { name: 'RangeError' });
  rig.dispose();
});
