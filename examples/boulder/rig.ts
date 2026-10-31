// Everything tied to one character model lives in this file: the asset, its bone names, hull settings and hand and foot
// offsets. Another GLB with the same bones replaces the climber by changing this file only. No engine imports, so
// Node tests read it. `RIG` starts at the shipped robot's numbers; the page measures them from the loaded file.
import type { Point } from './wall.ts';

export const CHARACTER = {
  /** Resolved here so the bundler finds the file. */
  asset: () => new URL('../assets/boulder-robot.glb', import.meta.url),
  bones: {
    hips: 'Hips',
    body: 'Body',
    head: 'Head',
    /** Left arm, right arm, left leg, right leg: upper joint, lower joint, end joint. */
    limbs: [
      ['UpperArm', 'Forearm', 'Hand'],
      ['RightUpperArm', 'RightForearm', 'RightHand'],
      ['LeftUpperLeg', 'LeftLowerLeg', 'LeftFoot'],
      ['RightUpperLeg', 'RightLowerLeg', 'RightFoot'],
    ],
  },
  /** Passed to rigging's jointHulls. */
  hulls: { maxPoints: 64, minWeight: 0.5 },
  /**
   * How far along an upper arm its hull starts, metres. The shoulder joint sits against the torso hull by design, so the
   * part of the link next to it is left out of the arm's own check.
   */
  shoulderTrim: 0.09,
  /** The head's look point in the head bone's space: between the eyes. */
  lens: [0, 0, -0.23] as Point,
  /** How far the middle of the face sits above the head joint, metres. */
  faceAbove: 0.17,
  /** The head's look direction in its bone's space. */
  lookAxis: [0, 0, -1] as Point,
  /** The largest head and torso turn from the animated pose, radians. */
  lookLimit: 0.8,
  /** How the turn is shared between the torso and the head. */
  lookShares: [1, 7] as [number, number],
  /**
   * The hand bones' axes, in bone space: along the fingers, out of the palm, and toward the thumb (left hand, right hand).
   * tests/boulder-robot.test.js checks them against the mesh, so a model that differs fails there and not on the wall.
   */
  hand: {
    fingers: [0, 1, 0] as Point,
    palm: [0, 0, 1] as Point,
    thumb: [
      [-1, 0, 0],
      [1, 0, 0],
    ] as Point[],
    /** How far a gripping hand tips back from flat on the wall, radians: heel of the palm in, fingers over the hold. */
    tilt: 0.35,
  },
  /** Where a knee prefers to point, in the torso's frame: out to its own side and forward. A leg never prefers behind. */
  knee: { out: 0.57, forward: 0.82 },
  /** The most a knee and an elbow fold, degrees, measured from a straight limb. Past the knee's, the armour touches. */
  fold: { knee: 110, elbow: 155 },
  /** How far a foot turns out from straight at the wall, radians. A knee that turns out takes the foot with it. */
  footTurnOut: 0.55,
  /** How far a foot on a hold points its toes down, radians: a climber stands on the toes with the heel up. */
  footPoint: 0.5,
  /** Where a wrist sits off a hold, along the wall normal and below the hold, metres. */
  wrist: { out: 0.09, below: 0.09 },
  /** Where an ankle sits for a foot on a hold: above the top of the hold, out from it, and across toward the body. */
  ankle: { up: 0.216, out: 0.165, across: 0.073 },
  /** The tip of the shoe from the ankle joint, in the character's rest space. */
  toeTip: [0, -0.115, -0.24] as Point,
  /** Ankle height above a flat floor. */
  ankleHeight: 0.145,
};

/** Bone lengths and rest offsets, metres. `measureRig` overwrites these from the loaded file. */
export const RIG = {
  /** The hips joint in the character's rest space. */
  hips: [0, 0.66, 0.025] as Point,
  /** The head joint from the hips joint. */
  head: [0, 0.49, -0.025] as Point,
  /** Shoulder and hip joints from the hips joint, in the torso's frame: left arm, right arm, left leg, right leg. */
  roots: [
    [-0.24, 0.37, -0.025],
    [0.24, 0.37, -0.025],
    [-0.13, 0, 0],
    [0.13, 0, 0],
  ] as Point[],
  upper: [0.2872, 0.2872, 0.2921, 0.2921],
  lower: [0.2532, 0.2532, 0.2264, 0.2264],
};

/** World rest position of a joint from its inverse bind matrix (rigid, column-major). */
export function restPosition(m: ArrayLike<number>, offset: number): Point {
  const t0 = m[offset + 12],
    t1 = m[offset + 13],
    t2 = m[offset + 14];
  return [
    -(m[offset] * t0 + m[offset + 1] * t1 + m[offset + 2] * t2),
    -(m[offset + 4] * t0 + m[offset + 5] * t1 + m[offset + 6] * t2),
    -(m[offset + 8] * t0 + m[offset + 9] * t1 + m[offset + 10] * t2),
  ];
}

/** Fills `RIG` from a skin: `jointNames` per skin joint, 16 values per joint in `inverseBindMatrices`. */
export function measureRig(jointNames: readonly (string | undefined)[], inverseBindMatrices: ArrayLike<number>): void {
  const at = (name: string): Point => {
    const index = jointNames.indexOf(name);
    if (index < 0) throw new Error(`The character has no bone named ${name}; set the names in examples/boulder/rig.ts`);
    return restPosition(inverseBindMatrices, index * 16);
  };
  const hips = at(CHARACTER.bones.hips);
  RIG.hips = hips;
  const head = at(CHARACTER.bones.head);
  RIG.head = [head[0] - hips[0], head[1] - hips[1], head[2] - hips[2]];
  CHARACTER.bones.limbs.forEach(([upper, lower, end], i) => {
    const a = at(upper),
      b = at(lower),
      c = at(end);
    RIG.roots[i] = [a[0] - hips[0], a[1] - hips[1], a[2] - hips[2]];
    RIG.upper[i] = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    RIG.lower[i] = Math.hypot(c[0] - b[0], c[1] - b[1], c[2] - b[2]);
  });
}
