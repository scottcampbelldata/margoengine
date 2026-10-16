import { BodyDistance, newDistance } from './body-distance';
import type { Mesh, Vec3 } from '@margoengine/core/extension';
import { multiplyQuaternions } from '@margoengine/math/quat';
import { invertMatrixStable, multiplyMatrices } from '@margoengine/math/mat4';
import { finiteVector } from '@margoengine/math/validate';
import { AvoidanceSolver, CapsuleVolume } from '@margoengine/kinematics-constraints';
import { gripPosition, localPoint, worldPosition, worldRotation } from './rig-ik';
import { RigScratch } from './rig-scratch';
import { hypot3Into, hypot4Into } from './norm';
import { upperArmPieces, forearmBind } from './body-ik-shapes';
import { headLocalHull } from './body-head-shape';
import { ArmHeadClearance } from './arm-head-clearance';

type Point = [number, number, number];
type Pose = number[][];
type Support = (direction: Point) => Point;
const newPose = (): Pose => [
  [0.1, 0.1, 0.1, 0.1],
  [0.1, 0.1, 0.1, 0.1],
  [0.1, 0.1, 0.1, 0.1],
];
const axisY: Point = [0, 1, 0],
  axisZ: Point = [0, 0, 1];
const newResult = (): BodyIKResult => ({
  safe: false,
  limited: false,
  blocked: false,
  orb: [0.1, 0.1, 0.1],
  collision: null,
});
export interface BodyIKOptions {
  frame: Mesh;
  shoulder: Mesh;
  elbow: Mesh;
  wrist: Mesh;
  /** Optional authored Head node for posed active-arm and held-orb clearance. */
  head?: Mesh;
  /** Optional shared head-only mounted/blended arm envelope, also used while choosing gaze. */
  armHeadClearance?: ArmHeadClearance;
  localGrip: Vec3;
  /** Check the borrowed held-orb point outside the torso cache; write finite signed clearance to out[0]. Do not mutate the arm or torso. */
  extraClearance?: (orb: Vec3, out: Float64Array) => void;
}
export interface BodyIKResult {
  safe: boolean;
  limited: boolean;
  blocked: boolean;
  orb: Point;
  collision: string | null;
}
const sub = (a: Vec3, b: Vec3): Point => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const dot4 = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
const conjugate = (q: readonly number[]) => [-q[0], -q[1], -q[2], q[3]];
const transform = (m: ArrayLike<number>, p: Vec3, out: Point = [0, 0, 0]): Point => {
  out[0] = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
  out[1] = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
  out[2] = m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14];
  return out;
};
const corners = (min: Point, max: Point): Point[] =>
  Array.from({ length: 8 }, (_, i) => [i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]]);

// Same surface rings as build_robot.py, rather than its much larger bounding box.
// The convex envelope includes the enamel chest thickness and rear battery panel.
const torso: Point[] = [];
for (const [y, rx, rz] of [
  [0.7, 0.13, 0.11],
  [0.75, 0.19, 0.14],
  [0.94, 0.235, 0.17],
  [1.04, 0.225, 0.16],
  [1.115, 0.16, 0.12],
]) {
  for (let k = 0; k < 40; k++) {
    const a = (2 * Math.PI * k) / 40,
      c = Math.cos(a),
      s = Math.sin(a);
    torso.push([rx * Math.sign(c) * Math.abs(c) ** 0.67, y, 0.025 + rz * Math.sign(s) * Math.abs(s) ** 0.67]);
  }
}
for (const [y, rx, rz] of [
  [0.745, 0.145, 0.133],
  [0.8, 0.19, 0.155],
  [0.95, 0.23, 0.178],
  [1.035, 0.218, 0.168],
  [1.085, 0.17, 0.143],
]) {
  for (let k = 0; k <= 28; k++) {
    const a = Math.PI + Math.PI * 0.07 + (Math.PI * 0.86 * k) / 28,
      c = Math.cos(a),
      s = Math.sin(a);
    torso.push([rx * Math.sign(c) * Math.abs(c) ** 0.67, y, 0.017 + rz * Math.sign(s) * Math.abs(s) ** 0.67]);
  }
}
torso.push(...corners([-0.145, 0.795, 0.1795], [0.145, 1.065, 0.2241]));
const supportPoints =
  (points: Point[]): Support =>
  (d) => {
    let best = points[0],
      value = dot(best, d);
    for (let i = 1; i < points.length; i++) {
      const next = dot(points[i], d);
      if (next > value) {
        best = points[i];
        value = next;
      }
    }
    return best;
  };
const bodySupport = supportPoints(torso),
  margin = 0.003,
  orbRadius = 0.10465342044830322;
// BodyDistance copies each returned support point before requesting the next one.
// Keep each shape's temporary output private and preserve the original operation order.
function capsuleSupport(a: Point, b: Point, r: number): Support {
  const out: Point = [0, 0, 0];
  const length = new Float64Array(1);
  return function capsuleShapeSupport(d) {
    const point = dot(a, d) > dot(b, d) ? a : b;
    hypot3Into(d, length);
    const inverseLength = 1 / length[0];
    out[0] = point[0] + d[0] * inverseLength * (r + margin);
    out[1] = point[1] + d[1] * inverseLength * (r + margin);
    out[2] = point[2] + d[2] * inverseLength * (r + margin);
    return out;
  };
}
function translatedSupport(points: Point[], center: Point): Support {
  const support = supportPoints(points),
    out: Point = [0, 0, 0];
  const length = new Float64Array(1);
  return function translatedShapeSupport(d) {
    const point = support(d);
    hypot3Into(d, length);
    const inverseLength = 1 / length[0];
    out[0] = center[0] + (point[0] + d[0] * inverseLength * margin);
    out[1] = center[1] + (point[1] + d[1] * inverseLength * margin);
    out[2] = center[2] + (point[2] + d[2] * inverseLength * margin);
    return out;
  };
}
function surfaceSupport(matrix: Float64Array, points: Point[], padding = margin): Support {
  const support = supportPoints(points),
    direction: Point = [0, 0, 0],
    out: Point = [0, 0, 0];
  const length = new Float64Array(1);
  return function surfaceShapeSupport(d) {
    direction[0] = matrix[0] * d[0] + matrix[1] * d[1] + matrix[2] * d[2];
    direction[1] = matrix[4] * d[0] + matrix[5] * d[1] + matrix[6] * d[2];
    direction[2] = matrix[8] * d[0] + matrix[9] * d[1] + matrix[10] * d[2];
    const point = support(direction);
    transform(matrix, point, out);
    if (padding !== 0) {
      hypot3Into(d, length);
      const inverseLength = 1 / length[0];
      out[0] = out[0] + d[0] * inverseLength * padding;
      out[1] = out[1] + d[1] * inverseLength * padding;
      out[2] = out[2] + d[2] * inverseLength * padding;
    }
    return out;
  };
}

/** Torso contact only. Every 3D direction, including across the chest and over the head, remains available. */
export class BodyIK {
  readonly options: BodyIKOptions;
  private readonly nodes: Mesh[];
  private readonly grip: Point;
  private readonly gripOffset: Point;
  private readonly wristInFrame: number[];
  private readonly handCorners: Point[];
  private readonly gripCorners: Point[];
  private readonly upperPieces: Point[][];
  private readonly forearmPoints: Point[];
  private lastSafe: Pose;
  private readonly rest: Pose;
  private preferredPole: Point;
  private lastDesired?: Point;
  private readonly lastDesiredPoint: Point = [0, 0, 0];
  private lastFrame?: Float32Array;
  private readonly lastFrameValues = new Float32Array(16);
  private readonly frameValues = new Float32Array(16);
  private cached?: BodyIKResult;
  private readonly cachedResult = newResult();
  // All search loops are bounded: fewer than 810 poses and 7,000 temporary
  // points per solve. Snapshots retained across calls live outside these pools.
  private readonly posePool = Array.from({ length: 1024 }, newPose);
  private readonly pointPool: Point[] = Array.from({ length: 8192 }, () => [0.1, 0.1, 0.1]);
  private readonly presentedPose = newPose();
  private readonly localInverse = new Float64Array(16);
  private readonly inverseWorkspace = new Float64Array(52);
  private readonly lengthValue = new Float64Array(1);
  private readonly lengthInput = new Float64Array(3);
  private readonly rig = new RigScratch();
  private readonly solveOrientation = [0.1, 0.1, 0.1, 0.1];
  private readonly wristRotation = [0.1, 0.1, 0.1, 0.1];
  private readonly inverseWrist = [0.1, 0.1, 0.1, 0.1];
  private readonly wristCorrection = [0.1, 0.1, 0.1, 0.1];
  private solveOffset: Point = [0.1, 0.1, 0.1];
  private solveRoot: Point = [0.1, 0.1, 0.1];
  private lastSolveCollision: string | null = null;
  private poseCursor = 0;
  private pointCursor = 0;
  private busy = false;
  private checkingExtra = false;
  private recovering = false;
  private readonly queryMatrices = new Float32Array(64);
  private hasPoseQuery = false;
  private poseCollision: string | null = null;
  private readonly poseDistance = new Float64Array(1);
  private torsoCollision: string | null = null;
  private readonly torsoDistance = new Float64Array(1);
  private readonly extraDistance = new Float64Array(1);
  private computedCollision: string | null = null;
  private readonly computedDistance = new Float64Array(1);
  private readonly distanceKernel = new BodyDistance(bodySupport);
  private readonly poseScratch = newDistance();
  private readonly gripSphereResult = newDistance();
  private readonly gripHandResult = newDistance();
  private readonly slideQuery = newDistance();
  private readonly advanceQuery = newDistance();
  private readonly slideAtQuery = newDistance();
  private readonly separationQuery = newDistance();
  private readonly slidePosition: Point = [0, 0, 0];
  private readonly slideGoal: Point = [0, 0, 0];
  private readonly slideCandidate: Point = [0, 0, 0];
  private readonly slideSurface: Point = [0, 0, 0];
  private readonly advancePoint: Point = [0, 0, 0];
  private readonly slideOutput: Point = [0, 0, 0];
  private readonly worldOrb: Point = [0, 0, 0];
  private readonly headKernel?: BodyDistance;
  private readonly armHeadClearance?: ArmHeadClearance;
  private readonly headMatrix = new Float64Array(16);
  private readonly headFrameInverse = new Float64Array(16);
  private readonly headQueryMatrices = new Float32Array(80);
  private hasHeadQuery = false;
  private headCollision: string | null = null;
  private readonly headDistance = new Float64Array(1);
  private readonly headScratch = newDistance();
  private readonly headNames = [
    'upper arm / head',
    'upper arm / head',
    'upper arm / head',
    'upper arm / head',
    'forearm / head',
    'hand / head',
    'orb / head',
  ];
  private readonly frameInverse = new Float64Array(16);
  private readonly shoulderMatrix = new Float64Array(16);
  private readonly elbowMatrix = new Float64Array(16);
  private readonly wristMatrix = new Float64Array(16);
  private readonly poseOrb: Point = [0, 0, 0];
  private readonly poseShapes: (readonly [string, Support])[];
  private readonly gripCenter: Point = [0, 0, 0];
  private readonly gripSphere = capsuleSupport(this.gripCenter, this.gripCenter, orbRadius);
  private readonly gripHand: Support;
  // This capsule is contained by the authored torso. The exact hull queries
  // below still check the complete torso, posed armor, hand, and held orb.
  private readonly targetAvoidance = new AvoidanceSolver(
    [new CapsuleVolume({ start: [0, 0.81, 0.025], end: [0, 1, 0.025], radius: 0.11 })],
    { targetRadius: orbRadius + margin, minClearance: 0, complianceMargin: 0, damping: 0 },
  );
  constructor(options: BodyIKOptions) {
    if (options.extraClearance !== undefined && typeof options.extraClearance !== 'function') {
      throw new TypeError('Body IK extraClearance must be a function');
    }
    this.options = options;
    const { frame, shoulder, elbow, wrist, localGrip } = options;
    if (options.head) {
      options.head.check();
      if (options.head.engine !== frame.engine) throw new Error('Body IK head must use the same engine');
      worldRotation(options.head);
      this.headKernel = new BodyDistance(surfaceSupport(this.headMatrix, headLocalHull, 0));
      const shared = options.armHeadClearance;
      if (
        shared &&
        (shared.frame !== frame ||
          shared.head !== options.head ||
          shared.shoulder !== shoulder ||
          shared.elbow !== elbow)
      )
        throw new Error('Arm/head clearance must use the same body IK nodes');
      this.armHeadClearance = shared ?? new ArmHeadClearance(frame, options.head, shoulder, elbow);
    }
    this.nodes = [shoulder, elbow, wrist];
    if (this.nodes.some((node) => node.engine !== frame.engine)) throw new Error('Body IK nodes must use one engine');
    frame.engine.store.tick(false);
    worldRotation(wrist);
    this.grip = [...localGrip];
    this.gripOffset = sub(localPoint(frame, gripPosition(wrist, this.grip)), localPoint(frame, worldPosition(wrist)));
    this.wristInFrame = multiplyQuaternions(conjugate(worldRotation(frame)), worldRotation(wrist));
    const bindCorners = corners([-0.553, 0.989, -0.368], [-0.363, 1.155, -0.179]),
      initialGrip = localPoint(frame, this.orb());
    this.gripCorners = bindCorners.map((p) => sub(p, initialGrip));
    this.handCorners = bindCorners.map((p) => localPoint(wrist, gripPosition(frame, p)));
    this.upperPieces = upperArmPieces.map((piece) => piece.map((p) => localPoint(shoulder, gripPosition(frame, p))));
    this.forearmPoints = forearmBind.map((p) => localPoint(elbow, gripPosition(frame, p)));
    this.gripHand = translatedSupport(this.gripCorners, this.gripCenter);
    this.poseShapes = [
      ...this.upperPieces.map((piece) => ['upper arm / body', surfaceSupport(this.shoulderMatrix, piece)] as const),
      ['forearm / body', surfaceSupport(this.elbowMatrix, this.forearmPoints)],
      ['hand / body', surfaceSupport(this.wristMatrix, this.handCorners)],
      ['orb / body', capsuleSupport(this.poseOrb, this.poseOrb, orbRadius)],
    ];
    this.preferredPole = sub(localPoint(frame, worldPosition(elbow)), localPoint(frame, worldPosition(shoulder)));
    this.rest = this.writePose(newPose());
    this.lastSafe = this.writePose(newPose());
    const contact = this.collision();
    if (contact) throw new Error('Initial arm/body contact: ' + contact);
  }
  private writePose(out: Pose): Pose {
    const t = this.options.frame.engine.store.transforms;
    for (let i = 0; i < 3; i++) {
      const id = this.nodes[i].id,
        q = out[i];
      q[0] = t.qx[id];
      q[1] = t.qy[id];
      q[2] = t.qz[id];
      q[3] = t.qw[id];
    }
    return out;
  }
  private nextPose(): Pose {
    if (this.poseCursor === this.posePool.length) throw new Error('Body IK pose scratch exhausted');
    return this.posePool[this.poseCursor++];
  }
  private capture(): Pose {
    return this.writePose(this.nextPose());
  }
  private point(): Point {
    if (this.pointCursor === this.pointPool.length) throw new Error('Body IK point scratch exhausted');
    return this.pointPool[this.pointCursor++];
  }
  private sub(a: Vec3, b: Vec3): Point {
    const out = this.point();
    for (let i = 0; i < 3; i++) out[i] = a[i] - b[i];
    return out;
  }
  private add(a: Vec3, b: Vec3): Point {
    const out = this.point();
    for (let i = 0; i < 3; i++) out[i] = a[i] + b[i];
    return out;
  }
  private mul(a: Vec3, k: number): Point {
    const out = this.point();
    for (let i = 0; i < 3; i++) out[i] = a[i] * k;
    return out;
  }
  private mix(a: Vec3, b: Vec3, t: number): Point {
    const out = this.point();
    for (let i = 0; i < 3; i++) out[i] = a[i] + (b[i] - a[i]) * t;
    return out;
  }
  // Return a retained destination reference, rather than boxing a scalar at
  // the private call boundary. Every caller consumes slot zero immediately.
  private length3(value: ArrayLike<number>): Float64Array {
    hypot3Into(value, this.lengthValue);
    return this.lengthValue;
  }
  private length4(value: ArrayLike<number>): Float64Array {
    hypot4Into(value, this.lengthValue);
    return this.lengthValue;
  }
  private unit(a: Vec3): Point {
    const inverse = 1 / this.length3(a)[0],
      out = this.point();
    for (let i = 0; i < 3; i++) out[i] = a[i] * inverse;
    return out;
  }
  private cross(a: Vec3, b: Vec3): Point {
    const out = this.point();
    out[0] = a[1] * b[2] - a[2] * b[1];
    out[1] = a[2] * b[0] - a[0] * b[2];
    out[2] = a[0] * b[1] - a[1] * b[0];
    return out;
  }
  private position(mesh: Mesh): Point {
    mesh.check();
    const out = this.point();
    out[0] = mesh.matrix[12];
    out[1] = mesh.matrix[13];
    out[2] = mesh.matrix[14];
    return out;
  }
  private local(mesh: Mesh, value: Vec3): Point {
    mesh.check();
    if (!invertMatrixStable(mesh.matrix, this.localInverse, this.inverseWorkspace))
      throw new Error('Singular grip transform');
    return transform(this.localInverse, value, this.point());
  }
  private gripPoint(mesh: Mesh, value: Vec3): Point {
    mesh.check();
    return transform(mesh.matrix, value, this.point());
  }
  private copyPose(source: Pose, out: Pose): void {
    for (let i = 0; i < 3; i++) for (let j = 0; j < 4; j++) out[i][j] = source[i][j];
  }
  private result(
    out: BodyIKResult | undefined,
    safe: boolean,
    limited: boolean,
    blocked: boolean,
    orb: Point,
    collision: string | null,
  ): BodyIKResult {
    const result = out ?? newResult();
    result.safe = safe;
    result.limited = limited;
    result.blocked = blocked;
    result.collision = collision;
    for (let axis = 0; axis < 3; axis++) result.orb[axis] = orb[axis];
    return result;
  }
  private restore(pose: Pose): void {
    for (let i = 0; i < 3; i++) this.rig.setQuaternion(this.nodes[i], pose[i]);
    this.options.frame.engine.store.tick(false);
  }
  private orientWrist(): void {
    const wrist = this.options.wrist,
      rotation = this.wristRotation,
      inverse = this.inverseWrist;
    this.rig.worldRotation(wrist, rotation);
    inverse[0] = -rotation[0];
    inverse[1] = -rotation[1];
    inverse[2] = -rotation[2];
    inverse[3] = rotation[3];
    this.rig.multiply(this.solveOrientation, inverse, this.wristCorrection);
    this.rig.rotateWorld(wrist, this.wristCorrection);
  }
  private place(center: Vec3, poleOffset: Point): void {
    const { frame, shoulder, elbow, wrist } = this.options;
    this.restore(this.rest);
    this.rig.solve(
      shoulder,
      elbow,
      wrist,
      this.sub(center, this.solveOffset),
      this.gripPoint(frame, this.add(this.solveRoot, poleOffset)),
    );
    this.orientWrist();
    frame.engine.store.tick(false);
    this.poseQuery();
    if (this.poseCollision) this.lastSolveCollision = this.poseCollision;
  }
  private atAngle(center: Point, perpendicular: Point, other: Point, angle: number): Pose | undefined {
    const pole = this.add(this.mul(perpendicular, Math.cos(angle)), this.mul(other, Math.sin(angle)));
    this.place(center, pole);
    return this.poseCollision ? undefined : this.capture();
  }
  private poseCost(pose: Pose): number {
    let sum = 0;
    for (let i = 0; i < 3; i++) {
      const q = pose[i],
        previous = this.lastSafe[i];
      let product = 0;
      for (let j = 0; j < 4; j++) product = product + q[j] * previous[j];
      sum = sum + 1 - Math.abs(product);
    }
    return sum;
  }
  private evaluate(center: Point, full: boolean): Pose | undefined {
    const wristTarget = this.local(this.options.frame, this.sub(center, this.solveOffset)),
      direction = this.sub(wristTarget, this.solveRoot),
      axis = this.length3(direction)[0] > 1e-8 ? this.unit(direction) : this.unit(this.preferredPole);
    let perpendicular = this.sub(this.preferredPole, this.mul(axis, dot(this.preferredPole, axis)));
    if (this.length3(perpendicular)[0] < 1e-6)
      perpendicular = this.cross(axis, Math.abs(axis[1]) < 0.8 ? axisY : axisZ);
    perpendicular = this.unit(perpendicular);
    const other = this.cross(axis, perpendicular);
    for (let band = 0; band <= (full ? 12 : 1); band++) {
      let best: Pose | undefined;
      for (let side = 0; side < (band === 0 || band === 12 ? 1 : 2); side++) {
        const angle = ((side === 0 ? 1 : -1) * band * Math.PI) / 12;
        let pose = this.atAngle(center, perpendicular, other, angle);
        if (!pose) continue;
        if (band) {
          let low = (band - 1) / band,
            high = 1;
          for (let i = 0; i < 4; i++) {
            const t = (low + high) / 2,
              candidate = this.atAngle(center, perpendicular, other, angle * t);
            if (candidate) {
              pose = candidate;
              high = t;
            } else low = t;
          }
        }
        if (!best || this.poseCost(pose) < this.poseCost(best)) best = pose;
      }
      if (best) {
        this.restore(best);
        return best;
      }
    }
    return undefined;
  }
  private orb(): Point {
    return this.gripPoint(this.options.wrist, this.grip);
  }
  /** Restore the authored arm pose and discard contact/recovery history, including its elbow preference. */
  reset(): void {
    if (this.busy) throw new Error('Body IK is not reentrant');
    this.pointCursor = this.poseCursor = 0;
    this.targetAvoidance.reset();
    this.restore(this.rest);
    const { frame, shoulder, elbow } = this.options;
    this.writePose(this.lastSafe);
    const pole = this.sub(this.local(frame, this.position(elbow)), this.local(frame, this.position(shoulder)));
    for (let axis = 0; axis < 3; axis++) this.preferredPole[axis] = pole[axis];
    this.cached = undefined;
    this.lastDesired = undefined;
    this.lastFrame = undefined;
    this.recovering = false;
  }
  private gripQuery(center: Point, out: Float64Array): void {
    this.gripCenter[0] = center[0];
    this.gripCenter[1] = center[1];
    this.gripCenter[2] = center[2];
    const sphere = this.gripSphereResult,
      hand = this.gripHandResult;
    this.distanceKernel.query(this.gripSphere, sphere);
    this.distanceKernel.query(this.gripHand, hand);
    out.set(sphere[1] !== 0 ? sphere : hand[1] !== 0 ? hand : sphere[0] < hand[0] ? sphere : hand);
  }
  private advanceGrip(position: Point, goal: Point, out: Point): void {
    const query = this.advanceQuery;
    this.gripQuery(goal, query);
    if (query[1] === 0) {
      for (let axis = 0; axis < 3; axis++) out[axis] = goal[axis];
      return;
    }
    let low = 0,
      high = 1;
    for (let i = 0; i < 9; i++) {
      const t = (low + high) / 2;
      for (let axis = 0; axis < 3; axis++) this.advancePoint[axis] = position[axis] + (goal[axis] - position[axis]) * t;
      this.gripQuery(this.advancePoint, query);
      if (query[1] !== 0) high = t;
      else low = t;
    }
    for (let axis = 0; axis < 3; axis++) out[axis] = position[axis] + (goal[axis] - position[axis]) * low;
    this.gripQuery(out, query);
    for (let axis = 0; axis < 3; axis++) out[axis] = out[axis] + query[axis + 2] * 0.0002;
  }
  /** Sweep to real contact, then carry the remaining request along its tangent instead of pinning the old pose. */
  private slideGrip(start: Point, desired: Point): Point {
    this.gripQuery(desired, this.slideQuery);
    if (this.slideQuery[1] === 0) return desired;
    const position = this.slidePosition,
      candidate = this.slideCandidate,
      surface = this.slideSurface;
    this.advanceGrip(start, desired, position);
    for (let step = 0; step < 8; step++) {
      const at = this.slideAtQuery;
      this.gripQuery(position, at);
      const rx = desired[0] - position[0],
        ry = desired[1] - position[1],
        rz = desired[2] - position[2],
        projection = rx * at[2] + ry * at[3] + rz * at[4],
        tx = rx - at[2] * projection,
        ty = ry - at[3] * projection,
        tz = rz - at[4] * projection;
      const lengthInput = this.lengthInput;
      lengthInput[0] = tx;
      lengthInput[1] = ty;
      lengthInput[2] = tz;
      if (this.length3(lengthInput)[0] < 0.0001) break;
      this.slideGoal[0] = position[0] + tx * 0.6;
      this.slideGoal[1] = position[1] + ty * 0.6;
      this.slideGoal[2] = position[2] + tz * 0.6;
      this.advanceGrip(position, this.slideGoal, candidate);
      const separation = this.separationQuery;
      this.gripQuery(candidate, separation);
      const correction = -Math.max(0, separation[0] - 0.0002);
      for (let axis = 0; axis < 3; axis++) surface[axis] = candidate[axis] + separation[axis + 2] * correction;
      this.gripQuery(surface, this.slideQuery);
      const selected = this.slideQuery[1] !== 0 ? candidate : surface;
      for (let axis = 0; axis < 3; axis++) position[axis] = selected[axis];
    }
    for (let axis = 0; axis < 3; axis++) this.slideOutput[axis] = position[axis];
    return this.slideOutput;
  }
  private sameQueryMatrix(matrix: Float32Array, offset: number): boolean {
    for (let i = 0; i < 16; i++) if (matrix[i] !== this.queryMatrices[offset + i]) return false;
    return true;
  }
  private poseQuery(): void {
    const { frame, shoulder, elbow, wrist } = this.options;
    frame.check();
    shoulder.check();
    elbow.check();
    wrist.check();
    frame.engine.store.tick(false);
    if (
      !(
        this.hasPoseQuery &&
        this.sameQueryMatrix(frame.matrix, 0) &&
        this.sameQueryMatrix(shoulder.matrix, 16) &&
        this.sameQueryMatrix(elbow.matrix, 32) &&
        this.sameQueryMatrix(wrist.matrix, 48)
      )
    ) {
      this.computePoseQuery();
      // Copy values only after a completed query. Mesh matrix views can be replaced
      // when the transform store grows; always compare its current views above.
      this.queryMatrices.set(frame.matrix, 0);
      this.queryMatrices.set(shoulder.matrix, 16);
      this.queryMatrices.set(elbow.matrix, 32);
      this.queryMatrices.set(wrist.matrix, 48);
      this.torsoCollision = this.computedCollision;
      this.torsoDistance[0] = this.computedDistance[0];
      this.hasPoseQuery = true;
    }
    this.poseCollision = this.torsoCollision;
    this.poseDistance[0] = this.torsoDistance[0];
    const extra = this.options.extraClearance;
    if (extra) {
      // The head/look state can change without any torso or arm matrix changing.
      // Never memoize this callback with the four-matrix torso query.
      transform(wrist.matrix, this.grip, this.worldOrb);
      this.extraDistance[0] = NaN;
      if (this.checkingExtra) throw new Error('Body IK clearance is not reentrant');
      this.checkingExtra = true;
      try {
        extra(this.worldOrb, this.extraDistance);
      } finally {
        this.checkingExtra = false;
      }
      if (!Number.isFinite(this.extraDistance[0])) throw new RangeError('Body IK extra clearance must be finite');
      if (this.extraDistance[0] < 0 && !this.poseCollision) this.poseCollision = 'orb / head';
      this.poseDistance[0] = Math.min(this.poseDistance[0], this.extraDistance[0]);
    }
    if (this.options.head) {
      this.queryHead();
      if (this.headCollision && !this.poseCollision) this.poseCollision = this.headCollision;
      this.poseDistance[0] = Math.min(this.poseDistance[0], this.headDistance[0]);
    }
  }
  private sameHeadMatrix(matrix: Float32Array, offset: number): boolean {
    for (let i = 0; i < 16; i++) if (matrix[i] !== this.headQueryMatrices[offset + i]) return false;
    return true;
  }
  private queryHead(): void {
    const { frame, shoulder, elbow, wrist, head } = this.options;
    head!.check();
    frame.engine.store.tick(false);
    if (
      this.hasHeadQuery &&
      this.sameHeadMatrix(frame.matrix, 0) &&
      this.sameHeadMatrix(head!.matrix, 16) &&
      this.sameHeadMatrix(shoulder.matrix, 32) &&
      this.sameHeadMatrix(elbow.matrix, 48) &&
      this.sameHeadMatrix(wrist.matrix, 64)
    )
      return;
    if (!invertMatrixStable(frame.matrix, this.headFrameInverse, this.inverseWorkspace))
      throw new Error('Singular body IK frame');
    multiplyMatrices(this.headFrameInverse, head!.matrix, this.headMatrix);
    multiplyMatrices(this.headFrameInverse, shoulder.matrix, this.shoulderMatrix);
    multiplyMatrices(this.headFrameInverse, elbow.matrix, this.elbowMatrix);
    multiplyMatrices(this.headFrameInverse, wrist.matrix, this.wristMatrix);
    transform(wrist.matrix, this.grip, this.worldOrb);
    transform(this.headFrameInverse, this.worldOrb, this.poseOrb);
    let collision: string | null = null,
      distance = Infinity;
    for (let index = 0; index < this.poseShapes.length; index++) {
      this.headKernel!.query(this.poseShapes[index][1], this.headScratch);
      if (this.headScratch[1] !== 0) {
        collision = this.headNames[index];
        distance = 0;
        break;
      }
      distance = Math.min(distance, this.headScratch[0]);
    }
    if (!collision) {
      this.armHeadClearance!.evaluateCurrent(this.headScratch);
      if (this.headScratch[0] < 0) {
        collision = 'shoulder mount / head';
        distance = 0;
      } else distance = Math.min(distance, this.headScratch[0]);
    }
    this.headQueryMatrices.set(frame.matrix, 0);
    this.headQueryMatrices.set(head!.matrix, 16);
    this.headQueryMatrices.set(shoulder.matrix, 32);
    this.headQueryMatrices.set(elbow.matrix, 48);
    this.headQueryMatrices.set(wrist.matrix, 64);
    this.headCollision = collision;
    this.headDistance[0] = distance;
    this.hasHeadQuery = true;
  }
  private computePoseQuery(): void {
    const { frame, shoulder, elbow, wrist } = this.options;
    if (!invertMatrixStable(frame.matrix, this.frameInverse, this.inverseWorkspace))
      throw new Error('Singular body IK frame');
    wrist.check();
    transform(wrist.matrix, this.grip, this.worldOrb);
    transform(this.frameInverse, this.worldOrb, this.poseOrb);
    multiplyMatrices(this.frameInverse, shoulder.matrix, this.shoulderMatrix);
    multiplyMatrices(this.frameInverse, elbow.matrix, this.elbowMatrix);
    multiplyMatrices(this.frameInverse, wrist.matrix, this.wristMatrix);
    // Posed surface hulls preserve the armor taper and thin lateral joint washers.
    // The authored shoulder bearing is deliberately mounted through the torso side.
    let distance = Infinity;
    for (let index = 0; index < this.poseShapes.length; index++) {
      const entry = this.poseShapes[index];
      this.distanceKernel.query(entry[1], this.poseScratch);
      if (this.poseScratch[1] !== 0) {
        this.computedCollision = entry[0];
        this.computedDistance[0] = 0;
        return;
      }
      distance = Math.min(distance, this.poseScratch[0]);
    }
    this.computedCollision = null;
    this.computedDistance[0] = distance;
  }
  collision(): string | null {
    this.poseQuery();
    return this.poseCollision;
  }
  solve(desiredOrb: Vec3, dt = 1 / 60, out?: BodyIKResult): BodyIKResult {
    if (this.busy) throw new Error('Body IK is not reentrant');
    this.busy = true;
    try {
      finiteVector(desiredOrb, 3, 'Body IK target');
      if (!Number.isFinite(dt) || dt <= 0) throw new RangeError('Body IK dt must be positive and finite');
      this.pointCursor = this.poseCursor = 0;
      const desired = this.point(),
        { frame, shoulder, elbow, wrist: _wrist } = this.options;
      for (let axis = 0; axis < 3; axis++) desired[axis] = desiredOrb[axis];
      frame.engine.store.tick(false);
      const frameValues = this.frameValues;
      frameValues.set(frame.matrix);
      let sameFrame = !!this.lastFrame;
      if (this.lastFrame)
        for (let i = 0; i < 16; i++) if (Math.abs(frameValues[i] - this.lastFrame[i]) >= 1e-7) sameFrame = false;
      if (
        !this.recovering &&
        this.cached &&
        this.lastDesired &&
        this.lastFrame &&
        this.length3(this.sub(desired, this.lastDesired))[0] < 1e-5 &&
        sameFrame
      ) {
        this.restore(this.lastSafe);
        if (this.cached.safe && !this.collision()) {
          return this.result(
            out,
            this.cached.safe,
            this.cached.limited,
            this.cached.blocked,
            this.orb(),
            this.cached.collision,
          );
        }
        this.cached = undefined;
      }
      this.restore(this.lastSafe);
      const previousPose = this.lastSafe,
        previousCenter = this.orb(),
        previousLocal = this.local(frame, previousCenter),
        rawStep = this.lastDesired
          ? this.length3(this.sub(this.local(frame, desired), this.local(frame, this.lastDesired)))[0]
          : Infinity,
        continuousContact = rawStep < 0.08 && (this.cached?.blocked || this.recovering);
      const requestedDistance = this.length3(this.sub(this.local(frame, desired), previousLocal))[0],
        chase = continuousContact && requestedDistance > 0.018,
        solveDesired = chase
          ? this.gripPoint(
              frame,
              this.add(
                previousLocal,
                this.mul(this.sub(this.local(frame, desired), previousLocal), 0.018 / requestedDistance),
              ),
            )
          : desired;
      this.rig.worldRotation(frame, this.solveOrientation);
      this.rig.multiply(this.solveOrientation, this.wristInFrame, this.solveOrientation);
      const offset = this.sub(this.gripPoint(frame, this.gripOffset), this.position(frame)),
        root = this.local(frame, this.position(shoulder));
      this.solveOffset = offset;
      this.solveRoot = root;
      const startCenter = this.local(frame, this.orb()),
        requestedCenter = this.local(frame, solveDesired),
        projectedCenter = this.targetAvoidance.resolveTarget(requestedCenter, dt),
        // Target projection is a coarse preconditioner. Contact sliding and the
        // posed surface oracle retain responsibility for accepting a final pose.
        constrainedCenter = this.targetAvoidance.targetResult.resolved ? this.point() : requestedCenter;
      if (this.targetAvoidance.targetResult.resolved)
        for (let axis = 0; axis < 3; axis++) constrainedCenter[axis] = projectedCenter[axis];
      const slidCenter = this.slideGrip(startCenter, constrainedCenter);
      const slidWorld = this.gripPoint(frame, slidCenter),
        gripLimited = this.length3(this.sub(slidCenter, requestedCenter))[0] > 1e-5;
      this.lastSolveCollision = null;
      let pose = this.evaluate(slidWorld, true),
        blocked = gripLimited;
      if (!pose) {
        blocked = true;
        this.restore(this.lastSafe);
        const start = this.orb();
        pose = this.lastSafe;
        let low = 0,
          high = 1;
        for (let i = 0; i < 7; i++) {
          const t = (low + high) / 2,
            candidate = this.evaluate(this.mix(start, slidWorld, t), false);
          if (candidate) {
            low = t;
            pose = candidate;
          } else high = t;
        }
        // At limb contact, estimate the actual IK-workspace normal and slide the remaining target along it.
        // This uses posed geometry, including the proximal armor, rather than a prescribed arm cone or side plane.
        for (let iteration = 0; iteration < 12; iteration++) {
          this.restore(pose);
          const contactCenter = this.orb(),
            contactLocal = this.local(frame, contactCenter),
            goalLocal = this.local(frame, slidWorld),
            remaining = this.sub(goalLocal, contactLocal);
          if (this.length3(remaining)[0] < 0.001) break;
          const gradient = this.point(),
            epsilon = 0.003;
          for (let axis = 0; axis < 3; axis++) {
            const delta = this.point();
            delta[0] = delta[1] = delta[2] = 0;
            delta[axis] = epsilon;
            this.place(this.gripPoint(frame, this.add(contactLocal, delta)), this.preferredPole);
            const positive = this.poseDistance[0];
            this.place(this.gripPoint(frame, this.sub(contactLocal, delta)), this.preferredPole);
            const negative = this.poseDistance[0];
            gradient[axis] = (positive - negative) / (2 * epsilon);
          }
          const length = this.length3(gradient)[0];
          if (length < 1e-5) break;
          const normal = this.mul(gradient, 1 / length),
            tangent = this.sub(remaining, this.mul(normal, Math.min(0, dot(remaining, normal)))),
            stepLength = this.length3(tangent)[0];
          if (stepLength < 0.0002) break;
          const goal = this.gripPoint(
            frame,
            this.add(contactLocal, this.mul(tangent, Math.min(1, 0.025 / stepLength))),
          );
          let candidate = this.evaluate(goal, false);
          if (!candidate) {
            let lo = 0,
              hi = 1;
            for (let i = 0; i < 5; i++) {
              const alpha = (lo + hi) / 2,
                partial = this.evaluate(this.mix(contactCenter, goal, alpha), false);
              if (partial) {
                lo = alpha;
                candidate = partial;
              } else hi = alpha;
            }
          }
          if (!candidate) break;
          this.restore(candidate);
          if (this.length3(this.sub(this.orb(), contactCenter))[0] < 0.0001) break;
          pose = candidate;
        }
      }
      this.restore(pose);
      let recovering = chase;
      if (continuousContact) {
        const distance = this.length3(this.sub(this.local(frame, this.orb()), previousLocal))[0];
        let angle = -Infinity;
        for (let i = 0; i < 3; i++)
          angle = Math.max(angle, 2 * Math.acos(Math.min(1, Math.abs(dot4(pose[i], previousPose[i])))));
        let alpha = Math.min(1, 0.018 / Math.max(distance, 1e-8), 0.12 / Math.max(angle, 1e-8));
        if (alpha < 1) {
          const destination = pose;
          recovering = true;
          for (let attempt = 0; attempt < 7; attempt++) {
            const intermediate = this.nextPose();
            for (let i = 0; i < 3; i++) {
              const q = destination[i],
                values = intermediate[i],
                sign = dot4(q, previousPose[i]) < 0 ? -1 : 1;
              for (let j = 0; j < 4; j++) values[j] = previousPose[i][j] * (1 - alpha) + q[j] * sign * alpha;
              const length = this.length4(values)[0];
              for (let j = 0; j < 4; j++) values[j] = values[j] / length;
            }
            this.restore(intermediate);
            this.orientWrist();
            frame.engine.store.tick(false);
            if (!this.collision()) {
              pose = this.capture();
              break;
            }
            alpha *= 0.5;
            this.restore(previousPose);
            pose = previousPose;
          }
        }
      }
      const progress = this.length3(this.sub(this.local(frame, this.orb()), previousLocal))[0];
      this.recovering = recovering && progress > 0.00005;
      this.restore(pose);
      if (this.collision()) this.restore(previousPose);
      const safe = !this.collision();
      if (safe) {
        this.writePose(this.lastSafe);
        const pole = this.sub(this.local(frame, this.position(elbow)), root);
        for (let axis = 0; axis < 3; axis++) this.preferredPole[axis] = pole[axis];
      }
      const orb = this.orb(),
        result = this.result(
          out,
          safe,
          this.length3(this.sub(orb, desired))[0] > 0.002,
          blocked || recovering || !safe,
          orb,
          blocked ? (this.lastSolveCollision ?? 'grip / body') : null,
        );
      this.cached = this.result(
        this.cachedResult,
        result.safe,
        result.limited,
        result.blocked,
        result.orb,
        result.collision,
      );
      for (let axis = 0; axis < 3; axis++) this.lastDesiredPoint[axis] = desired[axis];
      this.lastDesired = this.lastDesiredPoint;
      this.lastFrameValues.set(frameValues);
      this.lastFrame = this.lastFrameValues;
      return result;
    } finally {
      this.busy = false;
    }
  }
  /** Off/manual branches retain the latest body-clear pose, while the orb stays attached to the palm. */
  enforce(out?: BodyIKResult): BodyIKResult {
    if (this.busy) throw new Error('Body IK is not reentrant');
    this.busy = true;
    try {
      this.pointCursor = this.poseCursor = 0;
      const contact = this.collision();
      if (contact) {
        this.restore(this.lastSafe);
        this.cached = undefined;
        if (this.collision()) {
          this.restore(this.rest);
          if (!this.collision()) this.writePose(this.lastSafe);
        }
      } else {
        const pose = this.writePose(this.presentedPose);
        for (let i = 0; i < 3; i++)
          for (let j = 0; j < 4; j++) {
            if (Math.abs(pose[i][j] - this.lastSafe[i][j]) > 1e-6) this.cached = undefined;
          }
        this.copyPose(pose, this.lastSafe);
      }
      return this.result(out, !this.collision(), !!contact, !!contact, this.orb(), contact);
    } finally {
      this.busy = false;
    }
  }
}
