import { Animation } from '@margoengine/animation';
import { Animator } from '@margoengine/animator';
import { addFullBodyIK } from '@margoengine/animator/fbik';
import { createStepper, upperBodyMotion } from '@margoengine/animator/stepping';
import {
  axisAngleToQuaternion, conjugateQuaternion, multiplyQuaternions,
  normalizeQuaternion, rotateByQuaternion, rotationToQuaternion,
} from '@margoengine/math/quat';
import { landHeight, movableStone, stones } from './creek.js';

const sides = ['Left', 'Right'];
const X = [1, 0, 0], Y = [0, 1, 0], Z = [0, 0, 1];
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const point = (node) => Array.from(node.matrix.subarray(12, 15));

// Standing spots on the banks, chosen where the ground under both boots is close to level.
function ground(x, z) { return [x, landHeight(x, z), z]; }
const startFeet = [ground(.174, -2.15), ground(-.170, -1.94)];
const endFeet = [ground(.23, 1.94), ground(-.20, 2.19)];
const stepCount = stones.length + endFeet.length;

function nodeRotation(node) {
  const m = node.matrix;
  return normalizeQuaternion(rotationToQuaternion(m, [0, 0, 0, 1],
    Math.hypot(m[0], m[1], m[2]), Math.hypot(m[4], m[5], m[6]), Math.hypot(m[8], m[9], m[10])));
}

export function choreograph(model, movableRange) {
  const animation = Animation.attach(model);
  const animator = Animator.attach(animation, { initial: 'balance', states: { balance: 'Balance' } });
  animator.playing = false;
  const joint = (name) => {
    const index = model.asset.doc.nodes.findIndex((node) => node.name?.endsWith(':' + name));
    if (index < 0) throw new Error('Missing walker joint ' + name);
    return index;
  };
  const pelvis = joint('Hips'), neck = joint('Neck');
  const parents = model.root.engine.store.parents;
  const rootPosition = point(model.root);
  const legs = sides.map((side) => {
    const upper = joint(side + 'UpLeg'), lower = joint(side + 'Leg'), end = joint(side + 'Foot');
    const hip = point(model.nodes[upper]), knee = point(model.nodes[lower]), ankle = point(model.nodes[end]);
    const base = nodeRotation(model.nodes[end]);
    return {
      upper, lower, end, base, rotation: base,
      hip: hip.map((value, axis) => value - rootPosition[axis]),
      thigh: distance(hip, knee), shin: distance(knee, ankle),
      target: [0, 0, 0], pole: [0, 0, 0], support: true,
      sole: null,
    };
  });
  // Margo Animator's stepper plans the footfalls, boot contacts and pelvis height; the full-body solve only bends
  // the legs to its targets, so its torso reach is the whole leg.
  const ik = addFullBodyIK(animator, {
    pelvis, spine: [], legs, balance: false, reach: 1, iterations: 1, tolerance: .003,
  });

  function poseAxis(name, axis) {
    const index = joint(name), node = model.nodes[index];
    const parent = model.root.engine.meshes.get(parents[node.id]);
    const localAxis = rotateByQuaternion(axis, conjugateQuaternion(nodeRotation(parent)));
    return { index, localAxis };
  }
  const lumbar = poseAxis('Spine', X);
  const chestYaw = poseAxis('Spine2', Y), chestRoll = poseAxis('Spine2', Z);
  const pelvisYaw = poseAxis('Hips', Y), pelvisRoll = poseAxis('Hips', Z);
  const headPitch = poseAxis('Head', X), headYaw = poseAxis('Head', Y);
  const arms = sides.map((side, i) => {
    const fingerRoot = (name) => point(model.nodes[joint(side + 'Hand' + name + '1')]);
    const a = fingerRoot('Index'), b = fingerRoot('Pinky');
    const across = a.map((v, j) => (i === 0 ? -1 : 1) * (v - b[j]) / distance(a, b));
    return {
      swing: poseAxis(side + 'Arm', X), spread: poseAxis(side + 'Arm', Z),
      elbow: poseAxis(side + 'ForeArm', X), wrist: poseAxis(side + 'Hand', X),
      curl: ['Index', 'Middle', 'Ring', 'Pinky'].flatMap((finger, number) =>
        [.20, .41, .25].map((bend, segment) => ({
          ...poseAxis(side + 'Hand' + finger + (segment + 1), across),
          bend: bend * (1 + number * .11),
        }))),
    };
  });
  function turn(rotations, { index, localAxis }, angle) {
    rotations[index] = multiplyQuaternions(axisAngleToQuaternion(localAxis, angle), rotations[index]);
  }

  const centeredRoute = [...stones.map(({ x, top, z }) => [x, top, z]), ...endFeet];
  const routes = [movableRange[0], 0, movableRange[1]].map((offset) => centeredRoute.map((foot, index) =>
    index === movableStone ? [foot[0] + offset, foot[1], foot[2]] : foot));
  let pathOffset = 0;
  const stepper = createStepper({ legs, start: startFeet, routes, footfall: goal });
  const removeBodyPose = animator.addPoseStep((_, rotations) => {
    const body = upperBodyMotion(stepper.motion);
    turn(rotations, pelvisYaw, body.pelvisYaw);
    turn(rotations, pelvisRoll, body.pelvisRoll);
    turn(rotations, lumbar, body.lumbar);
    turn(rotations, chestYaw, body.chestYaw);
    turn(rotations, chestRoll, body.chestRoll);
    turn(rotations, headPitch, body.headPitch);
    turn(rotations, headYaw, body.headYaw);
    for (let i = 0; i < 2; i++) {
      const arm = arms[i], angles = body.arms[i];
      turn(rotations, arm.swing, angles.swing);
      turn(rotations, arm.spread, angles.spread);
      turn(rotations, arm.elbow, angles.elbow);
      turn(rotations, arm.wrist, angles.wrist);
      for (const finger of arm.curl) turn(rotations, finger, finger.bend * angles.curl);
    }
  });

  function goal(index) {
    if (index >= stones.length) return endFeet[index - stones.length];
    const { x, top, z } = stones[index];
    return [x + (index === movableStone ? pathOffset : 0), top, z];
  }

  function pose(dt) {
    stepper.update(dt);
    const position = stepper.root;
    for (const [index, leg] of legs.entries()) {
      const foot = stepper.feet[index];
      leg.sole = foot;
      leg.target = foot.ankle;
      leg.support = foot.pin !== null;
      leg.pole[0] = position[0] + leg.hip[0] * 1.22;
      leg.pole[1] = position[1] + .60;
      leg.pole[2] = position[2] + 1.35;
      const roll = multiplyQuaternions(axisAngleToQuaternion(Y, foot.yaw), axisAngleToQuaternion(X, foot.pitch));
      leg.rotation = multiplyQuaternions(roll, leg.base);
    }
    model.root.setPosition(position);
  }

  pose(0);
  return {
    position: stepper.root, stepCount,
    get moving() { return stepper.moving; },
    get completed() { return stepper.completed; },
    get index() { return stepper.step; },
    get phase() { return stepper.phase; },
    get time() { return stepper.time; },
    get contact() { return sides.filter((_, index) => legs[index].support).join(' + '); },
    get fit() { return ik.result; },
    get swingLift() {
      const step = stepper.step;
      if (!stepper.moving || step >= stepCount) return 0;
      const left = step < 2 ? startFeet[step] : goal(step - 2);
      return Math.max(0, stepper.feet[step % 2].ankle[1] - .074 - Math.max(left[1], goal(step)[1]));
    },
    get leftAnkleX() { return model.nodes[legs[0].end].matrix[12]; },
    get posture() {
      const a = point(model.nodes[pelvis]), b = point(model.nodes[neck]);
      const [dx, dy, dz] = b.map((value, axis) => value - a[axis]);
      return {
        pitch: Math.atan2(dz, dy) * 180 / Math.PI,
        lean: Math.atan2(Math.hypot(dx, dz), dy) * 180 / Math.PI,
        forward: a[2],
        ankles: legs.map((leg) => point(model.nodes[leg.end])),
        root: a,
        wrists: arms.map((arm) => point(model.nodes[arm.wrist.index])),
        footPins: legs.map((leg) => {
          if (!leg.sole.pin) return [0, 0, 0, 0];
          const ankle = model.nodes[leg.end];
          const rotation = multiplyQuaternions(nodeRotation(ankle), conjugateQuaternion(leg.base));
          const offset = rotateByQuaternion(leg.sole.pin, rotation);
          const actual = point(ankle).map((value, axis) => value + offset[axis]);
          return [1, ...actual.map((value, axis) => value - leg.sole.reference[axis])];
        }),
      };
    },
    get span() {
      const a = goal(movableStone), b = goal(movableStone - 1);
      return Math.hypot(a[0] - b[0], a[2] - b[2]);
    },
    offset(value) { pathOffset = value; },
    start() { stepper.start(); },
    reset() {
      stepper.reset();
      pose(0);
    },
    update: pose,
    dispose() {
      removeBodyPose();
      ik.dispose();
      animator.dispose();
      animation.dispose();
    },
  };
}
