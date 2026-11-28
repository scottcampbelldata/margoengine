import { Animation } from '@margoengine/animation';
import { Animator } from '@margoengine/animator';
import { addFullBodyIK } from '@margoengine/animator/fbik';
import {
  axisAngleToQuaternion, conjugateQuaternion, multiplyQuaternions,
  normalizeQuaternion, rotateByQuaternion, rotationToQuaternion,
} from '@margoengine/math/quat';
import { landHeight, movableStone, stones } from './creek.js';
import { clamp, createCrossing, initialFootfalls, planPelvis, sampleGait } from './gait.js';

const settleTime = .58;
const sides = ['Left', 'Right'];
const X = [1, 0, 0], Y = [0, 1, 0], Z = [0, 0, 1];
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const point = (node) => Array.from(node.matrix.subarray(12, 15));

function ground(x, z) { return [x, landHeight(x, z), z]; }
const startFeet = [ground(.154, -2.22), ground(-.150, -1.97)];
const endFeet = [ground(.21, 2.02), ground(-.18, 2.27)];
const stepCount = stones.length + endFeet.length;

function roundedMinimum(a, b, radius = .036) {
  const gap = Math.max(0, radius - Math.abs(a - b));
  return Math.min(a, b) - gap * gap / (4 * radius);
}

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
      hipOffset: hip.map((value, axis) => value - rootPosition[axis]),
      reach: distance(hip, knee) + distance(knee, ankle) - .031,
      target: [0, 0, 0], pole: [0, 0, 0], support: true,
      sole: null,
    };
  });
  // The path and reference pose already account for weight transfer and reach.
  // Solve the foot contacts with the spine out of the stationary balance solve.
  const ik = addFullBodyIK(animator, {
    pelvis, spine: [], legs, balance: false, reach: .995, iterations: 1, tolerance: .003,
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
  const path = createCrossing(startFeet, centeredRoute);
  const routes = [movableRange[0], 0, movableRange[1]].map((offset) => centeredRoute.map((foot, index) =>
    index === movableStone ? [foot[0] + offset, foot[1], foot[2]] : foot));
  const pelvisHeight = planPelvis(path, startFeet, routes, settleTime, (pose) =>
    roundedMinimum(pose.y, roundedMinimum(...legs.map((leg, i) => reachHeight(leg, pose, pose.feet[i].ankle)))));
  const position = [0, 0, 0];
  let placed = initialFootfalls(startFeet), pathOffset = 0, elapsed = 0, step = 0, time = 0;
  let moving = false, completed = false, phase = 0;
  let gait = sampleGait(path, placed, null, 0, 0);
  const removeBodyPose = animator.addPoseStep((_, rotations) => {
    const { activity, sway, rhythm, brace, lean, absorb, coming, anticipation, settling } = gait;
    const settle = Math.sin(Math.PI * settling) ** 2;
    turn(rotations, pelvisYaw, -.060 * sway);
    turn(rotations, pelvisRoll, -.16 * lean);
    turn(rotations, lumbar, .043 + .088 * brace + .041 * absorb - .021 * settle);
    turn(rotations, chestYaw, .101 * sway - .056 * coming * anticipation);
    turn(rotations, chestRoll, .34 * lean - .018 * Math.sin(rhythm) * activity);
    turn(rotations, headPitch, .019 + .11 * anticipation - .038 * absorb - .035 * settle);
    turn(rotations, headYaw, .135 * coming * anticipation - .040 * sway);
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? 1 : -1, arm = arms[i];
      const stroke = -side * Math.cos(rhythm - (i === 0 ? .18 : .33)) * activity;
      const follow = -side * Math.cos(rhythm - (i === 0 ? .47 : .63)) * activity;
      turn(rotations, arm.swing, (i === 0 ? .244 : .218) * stroke - .048 * brace - .031 * settle);
      turn(rotations, arm.spread, side * (-.036 + .115 * brace + .11 * Math.max(0, side * lean)));
      turn(rotations, arm.elbow, -.079 + .087 * follow - .122 * brace - .025 * settle);
      turn(rotations, arm.wrist, .032 * follow + .028 * absorb);
      for (const finger of arm.curl)
        turn(rotations, finger, finger.bend * (1 + .21 * follow - .14 * brace));
    }
  });

  function goal(index) {
    if (index >= stones.length) return endFeet[index - stones.length];
    const { x, top, z } = stones[index];
    return [x + (index === movableStone ? pathOffset : 0), top, z];
  }

  function reachHeight(leg, pose, target) {
    const [x, y, z] = leg.hipOffset;
    const gap = Math.hypot(pose.x + x - target[0], pose.z + z - target[2]);
    return target[1] - y + Math.sqrt(Math.max(0, leg.reach ** 2 - gap ** 2));
  }

  function pose(dt) {
    if (moving) {
      elapsed += dt;
      time += dt;
    }
    while (moving && step < stepCount && elapsed >= path.durations[step]) {
      elapsed -= path.durations[step];
      placed[step % 2] = sampleGait(path, placed, goal(step), step, 1).next;
      step++;
    }
    if (moving && step === stepCount && elapsed >= settleTime) {
      moving = false;
      completed = true;
    }
    const stepping = moving && step < stepCount;
    const settling = step === stepCount ? clamp(elapsed / settleTime) : 0;
    phase = stepping ? elapsed / path.durations[step] : settling;
    gait = sampleGait(path, placed, stepping ? goal(step) : null, step, phase, settling);
    position[0] = gait.x;
    position[2] = gait.z;
    for (const [index, leg] of legs.entries()) {
      const foot = gait.feet[index];
      leg.sole = foot;
      leg.target = foot.ankle;
      leg.support = foot.pin !== null;
      leg.pole[0] = position[0] + leg.hipOffset[0] * 1.22;
      leg.pole[1] = gait.y + .60;
      leg.pole[2] = position[2] + 1.35;
      const roll = multiplyQuaternions(axisAngleToQuaternion(Y, foot.yaw), axisAngleToQuaternion(X, foot.pitch));
      leg.rotation = multiplyQuaternions(roll, leg.base);
    }
    position[1] = pelvisHeight(time);
    model.root.setPosition(position);
  }

  pose(0);
  return {
    position, stepCount,
    get moving() { return moving; },
    get completed() { return completed; },
    get index() { return step; },
    get phase() { return phase; },
    get time() { return time; },
    get contact() { return sides.filter((_, index) => legs[index].support).join(' + '); },
    get fit() { return ik.result; },
    get swingLift() {
      if (!moving || step >= stepCount) return 0;
      const foot = gait.feet[step % 2];
      return Math.max(0, foot.ankle[1] - .074 - Math.max(placed[step % 2].location[1], gait.next.location[1]));
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
    start() {
      if (moving) return;
      if (completed) this.reset();
      moving = true;
    },
    reset() {
      placed = initialFootfalls(startFeet);
      elapsed = 0;
      step = 0;
      time = 0;
      moving = false;
      completed = false;
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
