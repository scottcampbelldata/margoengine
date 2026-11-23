// @margoengine/rigging/hands: named hand poses on Mixamo, VRM and MPFB rigs, a power grip that wraps a bar, the rest
// posture blended into clips with flat fingers, and keyed hand layers that are a pure function of time.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { GLTFAsset, PBRModel } from '../../gltf/dist/pbr.js';
import { Animation } from '../../animation/dist/index.js';
import { Animator } from '../../animator/dist/index.js';
import { PalmContactRig, addPalmContact } from '../dist/contact.js';
import {
  FINGERS,
  addHands,
  fingerTurn,
  fist,
  grip,
  gripFinger,
  handRotations,
  measureHands,
  poseTable,
  relaxed,
  turnFromRest,
} from '../dist/hands.js';
import { humanoidBones } from '../dist/retarget.js';

// ---- a synthetic humanoid: a T-pose body facing +z with two five-fingered hands, in metres ----
const SIDE = { left: 1, right: -1 }; // the character's left arm reaches along +x
const DIGITS = [
  // name, knuckle offset from the wrist (along the arm, across toward +z, down), phalanx lengths
  ['thumb', [0.025, 0.03, -0.015], [0.04, 0.032, 0.026], [0.7, 0.7, -0.1]],
  ['index', [0.095, 0.025, 0], [0.045, 0.025, 0.019]],
  ['middle', [0.1, 0.004, 0], [0.048, 0.03, 0.022]],
  ['ring', [0.095, -0.016, -0.003], [0.044, 0.028, 0.02]],
  ['little', [0.085, -0.034, -0.008], [0.035, 0.02, 0.016]],
];
const NAMES = {
  mixamo: (s, part) =>
    'mixamorig:' +
    ({ hips: 'Hips', spine: 'Spine', head: 'Head' }[part] ??
      `${s === 'left' ? 'Left' : 'Right'}${{ arm: 'Arm', fore: 'ForeArm', hand: 'Hand' }[part] ?? part.replace(/^(\w+)(\d)$/, (_, f, n) => `Hand${{ thumb: 'Thumb', index: 'Index', middle: 'Middle', ring: 'Ring', little: 'Pinky' }[f]}${n}`)}`),
  vrm: (s, part) =>
    ({ hips: 'hips', spine: 'spine', head: 'head' })[part] ??
    `${s}${{ arm: 'UpperArm', fore: 'LowerArm', hand: 'Hand' }[part] ?? part.replace(/^(\w+)(\d)$/, (_, f, n) => (f === 'thumb' ? `Thumb${['Metacarpal', 'Proximal', 'Distal'][n - 1]}` : `${f[0].toUpperCase()}${f.slice(1)}${['Proximal', 'Intermediate', 'Distal'][n - 1]}`))}`,
  mpfb: (s, part) =>
    ({ hips: 'root', spine: 'spine05', head: 'head' })[part] ??
    `${{ arm: 'upperarm01', fore: 'lowerarm01', hand: 'wrist' }[part] ?? part.replace(/^(\w+)(\d)$/, (_, f, n) => `finger${FINGERS.indexOf(f) + 1}-${n}`)}.${s === 'left' ? 'L' : 'R'}`,
};
const qmul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const conj = (q) => [-q[0], -q[1], -q[2], q[3]];
const rot = (v, q) => qmul(qmul(q, [...v, 0]), conj(q)).slice(0, 3);
// A seeded rest rotation per bone, so the rig's local frames are not the world's (as in a real export).
function seeded(seed) {
  let x = seed;
  return () => ((x = (x * 1103515245 + 12345) >>> 0) / 2 ** 32) * 2 - 1;
}
function makeRig(naming, seed = 7, profiles) {
  const rnd = seeded(seed),
    names = [],
    parents = [],
    world = []; // [position, rotation] per bone
  const add = (name, parent, position) => {
    const q = [rnd() * 0.6, rnd() * 0.6, rnd() * 0.6, 1],
      l = Math.hypot(...q);
    names.push(name);
    parents.push(parent);
    world.push([position, q.map((v) => v / l)]);
    return names.length - 1;
  };
  const n = NAMES[naming];
  const hips = add(n('', 'hips'), -1, [0, 1, 0]),
    spine = add(n('', 'spine'), hips, [0, 1.3, 0]);
  add(n('', 'head'), spine, [0, 1.65, 0]);
  const fingertips = {};
  for (const side of ['left', 'right']) {
    const x = SIDE[side],
      arm = add(n(side, 'arm'), spine, [0.18 * x, 1.45, 0]),
      fore = add(n(side, 'fore'), arm, [0.46 * x, 1.45, 0]),
      hand = add(n(side, 'hand'), fore, [0.72 * x, 1.45, 0]);
    for (const [finger, [a, c, d], lengths, dir = [1, 0, 0]] of DIGITS) {
      const along = [dir[0] * x, dir[2], dir[1]],
        l = Math.hypot(...along),
        u = along.map((v) => v / l);
      const profile = profiles?.[finger];
      let p = profile
          ? [0.72 * x + profile[0][0] * x, 1.45 - profile[0][1], -profile[0][2]]
          : [0.72 * x + a * x, 1.45 + d, c],
        parent = hand;
      for (let k = 0; k < 3; k++) {
        parent = add(n(side, `${finger}${k + 1}`), parent, p);
        const offset = profile?.[k + 1];
        const vector = offset ? [offset[0] * x, -offset[1], -offset[2]] : u.map((v) => v * lengths[k]);
        p = p.map((v, i) => v + vector[i]);
      }
      fingertips[`${side}-${finger}`] = p;
    }
  }
  // Local rest: translation in the parent's frame, rotation relative to the parent's.
  const rest = new Float64Array(names.length * 10);
  names.forEach((_, i) => {
    const [p, q] = world[i],
      parent = parents[i];
    const local =
      parent < 0
        ? p
        : rot(
            p.map((v, k) => v - world[parent][0][k]),
            conj(world[parent][1]),
          );
    const lq = parent < 0 ? q : qmul(conj(world[parent][1]), q);
    rest.set([...local, ...lq, 1, 1, 1], i * 10);
  });
  return { names, parents, rest };
}
/** World positions of every bone of `rig` with `rotations` (bone to local quaternion) over the rest pose. */
function forward(rig, rotations = new Map()) {
  const out = [];
  rig.names.forEach((_, i) => {
    const o = i * 10,
      t = [rig.rest[o], rig.rest[o + 1], rig.rest[o + 2]],
      q = rotations.get(i) ?? [rig.rest[o + 3], rig.rest[o + 4], rig.rest[o + 5], rig.rest[o + 6]],
      parent = rig.parents[i];
    out[i] =
      parent < 0
        ? { p: t, q }
        : { p: out[parent].p.map((v, k) => v + rot(t, out[parent].q)[k]), q: qmul(out[parent].q, q) };
  });
  return out;
}

test('both hands align their measured palm to the surface and fail open off the geometry', () => {
  const rig = makeRig('mixamo', 78);
  const bones = humanoidBones(rig.names, 'mixamo');
  const measured = measureHands(rig, 'mixamo');
  const world = forward(rig);
  for (const side of ['left', 'right']) {
    const joints = ['UpperArm', 'LowerArm', 'Hand'].map((suffix) => bones.get(side + suffix));
    const hand = measured[side],
      wrist = world[joints[2]],
      middle = world[hand.fingers.middle.bones[0]],
      contact = new PalmContactRig(rig, {
        side,
        joints,
        preset: 'mixamo',
        elbow: { joint: joints[1], flexDirection: [0, 0, 1] },
      });
    const target = {
      point: rot(contact.anchor, wrist.q).map((n, i) => n + wrist.p[i]),
      normal: hand.palm.map((n) => -n),
      towardsFingers: middle.p.map((n, i) => n - wrist.p[i]),
      diameter: 0.032,
    };
    const local = rig.rest.slice();
    const planted = contact.solve(local, target);
    assert.equal(planted.locked, true);
    assert.ok(planted.gripWeight > 0.999);
    assert.equal(planted.point.length, 3);
    const makeMiss = () => {
      const frame = rig.rest.slice();
      const missed = contact.solve(frame, {
        ...target,
        point: target.point.map((n, i) => n + (i === 0 ? SIDE[side] * 2 : 0)),
      });
      assert.equal(missed.locked, false);
      assert.equal(missed.gripWeight, 0);
      return frame;
    };
    const miss = makeMiss();
    assert.notDeepEqual(local, miss, 'closure needs a registered palm');
    assert.deepEqual(miss, makeMiss(), 'random access produces identical results');
    assert.deepEqual(local.slice(0, 30), rig.rest.slice(0, 30), 'the procedure leaves the body keys intact');
    const zero = rig.rest.slice();
    contact.solve(zero, { ...target, weight: 0 });
    assert.deepEqual(zero, rig.rest);
    assert.throws(() => contact.solve(zero, { ...target, towardsFingers: target.normal }), /direction across/);
    assert.deepEqual(zero, rig.rest);
  }
});

test('a coincident but upside-down palm cannot trigger finger closure', () => {
  const rig = makeRig('vrm'),
    bones = humanoidBones(rig.names, 'humanoid'),
    hand = measureHands(rig, 'humanoid').right,
    joints = ['UpperArm', 'LowerArm', 'Hand'].map((suffix) => bones.get('right' + suffix)),
    wrist = hand.world(hand.hand),
    contact = new PalmContactRig(rig, {
      side: 'right',
      joints,
      preset: 'humanoid',
      anchor: [0, 0, 0],
      limits: joints.map((joint) => ({
        joint,
        neutral: [...rig.rest.subarray(joint * 10 + 3, joint * 10 + 7)],
        limit: { type: 'hinge', axis: [1, 0, 0], min: 0, max: 0 },
      })),
    });
  const local = rig.rest.slice();
  const result = contact.solve(local, {
    point: wrist.position,
    normal: hand.palm,
    towardsFingers: hand.world(hand.fingers.middle.bones[0]).position.map((n, i) => n - wrist.position[i]),
    diameter: 0.036,
  });
  assert.equal(result.gripWeight, 0);
  assert.equal(result.locked, false);
  assert.ok(result.distance < 1e-6);
  assert.ok(result.angle > Math.PI - 1e-6);
});

test('a palm cannot register when its wrist is locked at a right angle to the forearm', () => {
  const rig = makeRig('mixamo', 78);
  const bones = humanoidBones(rig.names, 'mixamo');
  const bySide = measureHands(rig, 'mixamo');
  const world = forward(rig);
  for (const side of ['left', 'right']) {
    const hand = bySide[side];
    const joints = ['UpperArm', 'LowerArm', 'Hand'].map((part) => bones.get(side + part));
    const wrist = world[hand.hand],
      middle = world[hand.fingers.middle.bones[0]];
    const turn = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
    const turned = qmul(turn, wrist.q);
    const inner = qmul(conj(world[joints[1]].q), turned);
    const local = rig.rest.slice();
    local.set(inner, joints[2] * 10 + 3);
    const calibration = {
      side,
      joints,
      preset: 'mixamo',
      anchor: [0, 0, 0],
      limits: joints.map((joint) => ({
        joint,
        neutral: [...local.subarray(joint * 10 + 3, joint * 10 + 7)],
        limit: { type: 'hinge', axis: [1, 0, 0], min: 0, max: 0 },
      })),
    };
    const point = {
      point: wrist.p,
      normal: rot(hand.palm, turn).map((x) => -x),
      towardsFingers: rot(
        middle.p.map((x, i) => x - wrist.p[i]),
        turn,
      ),
      diameter: 0.035,
    };
    const rejected = new PalmContactRig(rig, calibration).solve(local.slice(), point);
    assert.ok(rejected.blocked, JSON.stringify(rejected));
    assert.ok(rejected.distance < 1e-8 && rejected.angle < 1e-6);
    assert.equal(rejected.locked, false);
    assert.equal(rejected.gripWeight, 0);
    const unconstrained = new PalmContactRig(rig, { ...calibration, wrist: false }).solve(local.slice(), point);
    assert.ok(unconstrained.locked && unconstrained.gripWeight > 0.999);
  }
});
/** The fingertip of a digit at rest or posed: its distal bone's end, 3/4 of the middle phalanx past the distal joint. */
function tip(rig, frames, finger) {
  const [, middle, distal] = finger.bones,
    length = 0.75 * Math.hypot(...[0, 1, 2].map((k) => rig.rest[distal * 10 + k])),
    // The distal bone's own frame: the rest direction from the middle joint, carried by the pose.
    restWorld = forward(rig),
    dir = restWorld[distal].p.map((v, k) => v - restWorld[middle].p[k]),
    local = rot(dir, conj(restWorld[distal].q)),
    l = Math.hypot(...local);
  return frames[distal].p.map((v, k) => v + (rot(local, frames[distal].q)[k] / l) * length);
}

test('a registered power grip brings each thumb around the actual bar surface', () => {
  const rig = makeRig('mixamo', 78);
  const bones = humanoidBones(rig.names, 'mixamo');
  const world = forward(rig);
  const direction = (v) => {
    const n = Math.hypot(...v);
    return v.map((x) => x / n);
  };
  const subtract = (a, b) => a.map((x, i) => x - b[i]);
  const dot = (a, b) => a.reduce((sum, x, i) => sum + x * b[i], 0);
  const cross = ([x, y, z], [a, b, c]) => [y * c - z * b, z * a - x * c, x * b - y * a];
  for (const side of ['left', 'right']) {
    const hand = measureHands(rig, 'mixamo')[side];
    const joints = ['UpperArm', 'LowerArm', 'Hand'].map((name) => bones.get(side + name));
    const wrist = world[hand.hand];
    const contact = new PalmContactRig(rig, { side, joints, preset: 'mixamo' });
    const diameter = 0.035;
    const point = rot(contact.anchor, wrist.q).map((x, i) => x + wrist.p[i]);
    const bar = point.map((x, i) => x + (hand.palm[i] * diameter) / 2);
    const fingers = direction(subtract(world[hand.fingers.middle.bones[0]].p, wrist.p));
    const axis = direction(cross(fingers, hand.palm));
    const pad = hand.fingers.thumb.lengths[1] * 0.23;
    const clearance = (frames) => {
      const delta = subtract(tip(rig, frames, hand.fingers.thumb), bar);
      const along = dot(delta, axis);
      return Math.hypot(...delta.map((v, i) => v - along * axis[i])) - diameter / 2 - pad;
    };
    const prior = clearance(forward(rig, handRotations(hand, poseTable(grip(diameter), hand))));
    const target = {
      point,
      normal: hand.palm.map((x) => -x),
      towardsFingers: fingers,
      diameter,
    };
    const pose = rig.rest.slice();
    const landed = contact.solve(pose, target);
    const solved = new Map(rig.names.map((_, i) => [i, Array.from(pose.subarray(i * 10 + 3, i * 10 + 7))]));
    const gap = clearance(forward(rig, solved));
    assert.ok(landed.gripWeight > 0.999);
    assert.ok(
      Math.abs(gap) < 0.004 && Math.abs(gap) < Math.abs(prior) / 2,
      `${side}: thumb clearance after fitting ${gap} m, previous ${prior} m`,
    );
    const radial = (point) => {
      const delta = subtract(point, bar),
        along = dot(delta, axis);
      return delta.map((x, i) => x - along * axis[i]);
    };
    for (const close of [0, 0.16, 0.32, 0.49, 0.66, 0.83, 1]) {
      const local = rig.rest.slice();
      contact.solve(local, { ...target, close });
      const rotations = new Map(rig.names.map((_, i) => [i, Array.from(local.subarray(i * 10 + 3, i * 10 + 7))]));
      const frames = forward(rig, rotations);
      for (const [name, finger] of Object.entries(hand.fingers)) {
        const radius = diameter / 2 + finger.lengths[1] * (name === 'thumb' ? 0.23 : 0.28);
        const points = [...finger.bones.map((bone) => frames[bone].p), tip(rig, frames, finger)].map(radial);
        for (let i = 0; i < 3; i++) {
          const delta = subtract(points[i + 1], points[i]);
          const t = Math.max(0, Math.min(1, -dot(points[i], delta) / (dot(delta, delta) || 1)));
          const clearance = Math.hypot(...points[i].map((x, k) => x + delta[k] * t)) - radius;
          assert.ok(clearance >= -0.0001, `${side} ${name} segment ${i} at ${close} closure: ${clearance} m`);
        }
      }
    }
  }
});

test('a forward thumb base moves the contact above its web and both thumb hinges articulate', () => {
  const digitProfile = {
    thumb: [
      [0.0391, 0.0042, -0.0255],
      [0.012, 0.0214, -0.0206],
      [0.0265, 0.0187, -0.02],
    ],
    index: [
      [0.1083, 0.0046, -0.0272],
      [0.0258, 0.0073, -0.0039],
      [0.0213, 0.0113, -0.0022],
    ],
    middle: [
      [0.1074, 0, 0],
      [0.0331, 0.0114, 0.0047],
      [0.0261, 0.0123, 0.002],
    ],
    ring: [
      [0.1013, -0.0004, 0.0204],
      [0.0284, 0.0088, 0.0094],
      [0.023, 0.0108, 0.0057],
    ],
    little: [
      [0.0914, 0.0046, 0.0397],
      [0.0188, 0.0084, 0.0089],
      [0.0127, 0.0087, 0.0054],
    ],
  };
  const rig = makeRig('mixamo', 78, digitProfile),
    measurements = measureHands(rig, 'mixamo'),
    bones = humanoidBones(rig.names, 'mixamo');
  for (const side of ['left', 'right']) {
    const hand = measurements[side],
      wrist = hand.world(hand.hand);
    const joints = ['UpperArm', 'LowerArm', 'Hand'].map((name) => bones.get(side + name));
    const grip = new PalmContactRig(rig, { side, joints, preset: 'mixamo' });
    const normal = hand.palm.map((v) => -v),
      forward = [SIDE[side], 0, 0];
    const offset = rot(grip.anchor, wrist.rotation);
    const point = wrist.position.map((v, i) => v + offset[i]);
    const target = { point, normal, towardsFingers: forward, diameter: 0.029 };
    const open = rig.rest.slice(),
      closed = rig.rest.slice();
    grip.solve(open, { ...target, close: 0 });
    const result = grip.solve(closed, target);
    assert.ok(result.locked && result.gripWeight > 0.99);
    assert.ok(offset[0] * SIDE[side] > 0.07 && offset[0] * SIDE[side] < 0.076);
    for (const joint of hand.fingers.thumb.bones.slice(1)) {
      const at = joint * 10 + 3;
      const flex = turnFromRest(closed.subarray(at, at + 4), open.subarray(at, at + 4));
      assert.ok(flex >= 10, `${side} thumb joint ${joint} flexes ${flex} degrees during closure`);
    }
  }
});

test('the relaxed pose curls every finger inside the rest posture ranges, more toward the little finger, tip 2/3 of middle', () => {
  const rig = makeRig('mixamo'),
    { right } = measureHands(rig),
    table = poseTable(relaxed(), right);
  assert.equal(table.flex.thumb, undefined, 'the relaxed pose leaves the thumb to the clip (a bind pose splays it)');
  let last = 0;
  for (const finger of ['index', 'middle', 'ring', 'little']) {
    const [base, middle, tipFlex] = table.flex[finger];
    assert.ok(base >= 10 && base <= 45, `${finger} knuckle ${base}`);
    assert.ok(middle >= 25 && middle <= 60, `${finger} middle joint ${middle}`);
    assert.ok(Math.abs(tipFlex - (2 / 3) * middle) <= 1, `${finger} tip joint is 2/3 of the middle joint`);
    assert.ok(base + middle + tipFlex > last, `${finger} curls more than the finger before it`);
    last = base + middle + tipFlex;
  }
  // Applied on the rig, each joint turns from rest by its table angle (spread included at the knuckles).
  const rotations = handRotations(right, table);
  for (const finger of ['index', 'middle', 'ring', 'little']) {
    const f = right.fingers[finger];
    f.bones.forEach((bone, k) => {
      const turn = turnFromRest(rotations.get(bone), right.rest.get(bone)),
        want = Math.hypot(table.flex[finger][k], k === 0 ? (table.spread?.[finger] ?? 0) : 0);
      assert.ok(Math.abs(turn - want) < 0.5, `${finger} joint ${k}: ${turn.toFixed(2)} against ${want.toFixed(2)}`);
    });
  }
});

test('grip(0.03) wraps a 30 mm bar: every fingertip within 2 mm of it, no finger more than 1 mm into it', () => {
  for (const naming of ['mixamo', 'vrm', 'mpfb'])
    for (const side of ['left', 'right']) {
      const rig = makeRig(naming),
        hand = measureHands(rig)[side],
        rotations = handRotations(hand, poseTable(grip(0.03), hand)),
        frames = forward(rig, rotations),
        rest = forward(rig);
      for (const name of ['index', 'middle', 'ring', 'little']) {
        const f = hand.fingers[name],
          g = gripFinger(f.lengths, 0.03),
          base = rest[f.bones[0]].p,
          along = rest[f.bones[1]].p.map((v, k) => v - base[k]),
          l = Math.hypot(...along),
          // The bar's centre, from the finger's plane into the rig: along the rest finger, out of the palm.
          centre = base.map((v, k) => v + (along[k] / l) * g.along + hand.palm[k] * g.depth),
          // Its axis runs across the hand (the knuckle line), perpendicular to the finger and the palm normal.
          axis = [
            along[1] * hand.palm[2] - along[2] * hand.palm[1],
            along[2] * hand.palm[0] - along[0] * hand.palm[2],
            along[0] * hand.palm[1] - along[1] * hand.palm[0],
          ].map((v) => v / l);
        const fromAxis = (p) => {
          const d = p.map((v, k) => v - centre[k]),
            a = d[0] * axis[0] + d[1] * axis[1] + d[2] * axis[2];
          return Math.hypot(...d.map((v, k) => v - a * axis[k]));
        };
        const thickness = 0.18 * f.lengths[0],
          reach = 0.015 + thickness,
          joints = [...f.bones.map((b) => frames[b].p), tip(rig, frames, f)];
        const gap = fromAxis(joints[3]) - reach;
        assert.ok(
          gap <= 0.002 && gap >= -0.001,
          `${naming} ${side} ${name} fingertip ${(gap * 1000).toFixed(2)} mm from the bar`,
        );
        for (let k = 0; k < 3; k++)
          for (let s = 0; s <= 20; s++) {
            const p = joints[k].map((v, i) => v + (joints[k + 1][i] - v) * (s / 20));
            assert.ok(
              fromAxis(p) >= reach - 0.001,
              `${naming} ${side} ${name} segment ${k} is ${((reach - fromAxis(p)) * 1000).toFixed(2)} mm into the bar`,
            );
          }
      }
    }
});

test('the same pose gives the same hand on Mixamo, VRM and MPFB namings', () => {
  const tips = (naming, pose) => {
    const rig = makeRig(naming),
      hands = measureHands(rig),
      out = [];
    for (const side of ['left', 'right']) {
      const hand = hands[side],
        frames = forward(rig, handRotations(hand, poseTable(pose, hand)));
      for (const name of FINGERS) out.push(...tip(rig, frames, hand.fingers[name]));
    }
    return out;
  };
  for (const pose of [relaxed(), grip(0.03), fist()]) {
    const mixamo = tips('mixamo', pose);
    assert.equal(mixamo.length, 30);
    for (const naming of ['vrm', 'mpfb'])
      tips(naming, pose).forEach((v, i) =>
        assert.ok(Math.abs(v - mixamo[i]) < 1e-9, `${naming} ${pose.name} coordinate ${i}`),
      );
  }
  // A VRM's humanoid section names the bones when the node names follow no preset.
  const rig = makeRig('vrm'),
    map = humanoidBones(rig.names, 'humanoid'),
    renamed = { ...rig, names: rig.names.map((_, i) => `J_Bip_${i}`) };
  assert.deepEqual(Object.keys(measureHands(renamed, undefined, map)), ['left', 'right']);
});

// ---- on an Animator: a glTF of the rig with clips ----
function animated(rig, clips) {
  const buffers = [],
    accessors = [],
    bufferViews = [];
  const accessor = (data, type) => {
    buffers.push(new Uint8Array(data.buffer));
    bufferViews.push({ buffer: buffers.length - 1, byteLength: data.byteLength });
    accessors.push({
      bufferView: bufferViews.length - 1,
      componentType: 5126,
      count: data.length / { VEC4: 4, VEC3: 3, SCALAR: 1 }[type],
      type,
    });
    if (type === 'SCALAR') Object.assign(accessors.at(-1), { min: [data[0]], max: [data.at(-1)] });
    return accessors.length - 1;
  };
  const nodes = rig.names.map((name, i) => ({
    name,
    translation: [...rig.rest.subarray(i * 10, i * 10 + 3)],
    rotation: [...rig.rest.subarray(i * 10 + 3, i * 10 + 7)],
    children: rig.names.map((_, c) => c).filter((c) => rig.parents[c] === i),
  }));
  for (const n of nodes) if (!n.children.length) delete n.children;
  const animations = clips.map(({ name, turn }) => {
    const times = new Float32Array([0, 0.5, 1]),
      input = accessor(times, 'SCALAR'),
      channels = [],
      samplers = [];
    // Every finger joint turns `turn` degrees about its parent-frame x, then back: a clip keys its fingers.
    rig.names.forEach((n, i) => {
      if (!/Hand(Thumb|Index|Middle|Ring|Pinky)/.test(n)) return;
      const r = [...rig.rest.subarray(i * 10 + 3, i * 10 + 7)],
        a = (turn * Math.PI) / 360,
        bent = qmul(r, [Math.sin(a), 0, 0, Math.cos(a)]);
      samplers.push({ input, output: accessor(new Float32Array([...bent, ...bent, ...bent]), 'VEC4') });
      channels.push({ sampler: samplers.length - 1, target: { node: i, path: 'rotation' } });
    });
    return { name, channels, samplers };
  });
  // One triangle, so the file has something to draw.
  const position = accessor(new Float32Array([0, 0, 0, 0.1, 0, 0, 0, 0.1, 0]), 'VEC3');
  Object.assign(accessors[position], { min: [0, 0, 0], max: [0.1, 0.1, 0] });
  nodes.push({ name: 'mesh', mesh: 0 });
  const doc = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0, nodes.length - 1] }],
    meshes: [{ primitives: [{ attributes: { POSITION: position } }] }],
    nodes,
    animations,
    accessors,
    bufferViews,
    buffers: buffers.map((b) => ({ byteLength: b.byteLength })),
  };
  return { doc, buffers };
}
async function animator(t, clips, initial) {
  const rig = makeRig('mixamo'),
    store = await TransformStore.create(256),
    engine = new Engine({ width: 16, height: 16, clientWidth: 16, clientHeight: 16 }, store, {
      backend: 'webgl2',
      add() {},
      remove() {},
      render() {},
      dispose() {},
    }),
    { doc, buffers } = animated(rig, clips),
    model = new PBRModel(engine, new GLTFAsset(doc, buffers)),
    animation = new Animation(model),
    a = new Animator(animation, { initial, states: Object.fromEntries(clips.map((c) => [c.name, c.name])) });
  engine.use({ name: animation.name, setup() {} });
  engine.use(a);
  t.after(() => {
    a.dispose();
    animation.dispose();
    model.dispose();
    engine.dispose();
  });
  const fingerBones = rig.names.flatMap((n, i) => (/Hand(Thumb|Index|Middle|Ring|Pinky)/.test(n) ? [i] : []));
  const rotationOf = (i) => {
    const id = model.nodes[i].id,
      q = store.transforms;
    return [q.qx[id], q.qy[id], q.qz[id], q.qw[id]];
  };
  const meanTurn = () =>
    fingerBones.reduce((s, i) => s + turnFromRest(rotationOf(i), a.restRotation(i)), 0) / fingerBones.length;
  return { a, rig, store, fingerBones, rotationOf, meanTurn };
}

test('Animator palm contact reopens pre-keyed fingers off the hold, then releases the layer cleanly', async (t) => {
  const run = await animator(t, [{ name: 'clench', turn: 50 }], 'clench');
  const hand = measureHands(run.rig, 'mixamo').right;
  const bones = humanoidBones(run.rig.names, 'mixamo');
  const joints = ['rightUpperArm', 'rightLowerArm', 'rightHand'].map((name) => bones.get(name));
  const wrist = hand.world(hand.hand);
  const target = {
    point: wrist.position,
    normal: hand.palm.map((v) => -v),
    towardsFingers: hand.world(hand.fingers.middle.bones[0]).position.map((v, i) => v - wrist.position[i]),
    diameter: 0.035,
  };
  const side = 'right';
  const calibration = { side, joints, preset: 'mixamo', anchor: [0, 0, 0] };
  const relaxedRotations = handRotations(hand, poseTable(relaxed(), hand));
  let input = { ...target, point: [4, 1.45, 0], weight: 0.3 };
  let result;
  const remove = addPalmContact(
    run.a,
    calibration,
    () => input,
    (value) => {
      result = value;
    },
  );
  run.store.grow(512);
  run.a.onPreUpdate(1 / 30);
  assert.equal(result.gripWeight, 0);
  for (const [joint, q] of relaxedRotations) {
    assert.ok(Math.abs(q.reduce((sum, v, i) => sum + v * run.rotationOf(joint)[i], 0)) > 1 - 1e-6);
  }
  input = target;
  run.a.onPreUpdate(1 / 30);
  assert.equal(result.locked, true);
  assert.ok(result.gripWeight > 0.999);
  remove();
  run.a.onPreUpdate(1 / 30);
  assert.ok(Math.abs(run.meanTurn() - 50) < 0.5);
});

test('a clip with flat fingers comes out at 20 degrees mean or more; a clip that keys its fingers is left as keyed', async (t) => {
  const run = await animator(
    t,
    [
      { name: 'wave', turn: 6 },
      { name: 'hold', turn: 50 },
    ],
    'wave',
  );
  const hands = addHands(run.a);
  assert.deepEqual(hands.flat, { left: ['wave'], right: ['wave'] });
  const hand = measureHands(run.rig).right;
  assert.ok(fingerTurn({ tracks: [] }, hand) === 0, 'no finger tracks count as flat');
  run.a.onPreUpdate(1 / 30);
  const flat = run.meanTurn();
  assert.ok(flat >= 20, `the flat clip's fingers turn ${flat.toFixed(1)} degrees on average`);
  run.a.transition('hold', 0);
  run.a.onPreUpdate(1 / 30);
  assert.ok(Math.abs(run.meanTurn() - 50) < 0.5, `the keyed clip keeps its own fingers: ${run.meanTurn().toFixed(2)}`);
  hands.dispose();
  run.a.transition('wave', 0);
  run.a.onPreUpdate(1 / 30);
  assert.ok(run.meanTurn() < 7, 'disposed, the hands leave the clip alone');
});

test('a keyed hand is a pure function of time: a seek gives what playing gives', async (t) => {
  const keys = (hands) => {
    hands.right.keys = [
      { time: 0, pose: relaxed(), blend: 0 },
      { time: 0.5, pose: grip(0.03), blend: 0.4 },
      { time: 1.2, pose: fist(), blend: 0.3, weight: 0.8 },
      { time: 1.6, pose: null, blend: 0.2 },
    ];
  };
  const step = 1 / 32;
  for (const frames of [10, 24, 45, 60]) {
    const played = await animator(t, [{ name: 'wave', turn: 6 }], 'wave'),
      seeked = await animator(t, [{ name: 'wave', turn: 6 }], 'wave');
    const a = addHands(played.a, { auto: false }),
      b = addHands(seeked.a, { auto: false });
    keys(a);
    keys(b);
    for (let i = 0; i < frames; i++) played.a.onPreUpdate(step);
    seeked.a.playing = false;
    b.time = frames * step;
    seeked.a.time = played.a.time;
    seeked.a.onPreUpdate(step);
    assert.equal(a.time, b.time);
    for (const bone of played.fingerBones) {
      const p = played.rotationOf(bone),
        s = seeked.rotationOf(bone);
      p.forEach((v, k) => assert.ok(Math.abs(v - s[k]) < 1e-6, `frame ${frames} bone ${bone}`));
    }
  }
});

test('a digit a pose leaves out fades back to the clip: relaxed to grip brings the thumb in over the blend, no pop', async (t) => {
  const run = await animator(t, [{ name: 'wave', turn: 6 }], 'wave'),
    hands = addHands(run.a, { auto: false }),
    thumb = measureHands(run.rig).right.fingers.thumb.bones,
    thumbTurn = () =>
      thumb.reduce((s, i) => s + turnFromRest(run.rotationOf(i), run.a.restRotation(i)), 0) / thumb.length;
  hands.right.keys = [
    { time: 0, pose: relaxed(), blend: 0 },
    { time: 0.5, pose: grip(0.03), blend: 0.4 },
  ];
  for (let i = 0; i < 26; i++) run.a.onPreUpdate(1 / 50); // 0.52 s, 5 percent into the blend
  assert.ok(Math.abs(thumbTurn() - 6) < 2, `the thumb starts from the clip's own 6 degrees: ${thumbTurn().toFixed(2)}`);
  for (let i = 0; i < 25; i++) run.a.onPreUpdate(1 / 50); // 1.02 s, past the blend
  assert.ok(thumbTurn() > 25, `the grip's thumb is in: ${thumbTurn().toFixed(2)}`);
});
