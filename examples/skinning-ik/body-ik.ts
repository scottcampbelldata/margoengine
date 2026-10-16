import type { Mesh, Vec3 } from '@margoengine/core/extension';
import { multiplyQuaternions } from '@margoengine/math/quat';
import { invertMatrixStable, multiplyMatrices } from '@margoengine/math/mat4';
import { finiteVector } from '@margoengine/math/validate';
import { AvoidanceSolver, CapsuleVolume } from '@margoengine/kinematics-constraints';
import { gripPosition, localPoint, rotateWorld, solveArm, worldPosition, worldRotation } from './rig-ik';
import { upperArmPieces, forearmBind } from './body-ik-shapes';

type Point = [number, number, number];
type Pose = number[][];
type Support = (direction: Point) => Point;
export interface BodyIKOptions {
  frame: Mesh;
  shoulder: Mesh;
  elbow: Mesh;
  wrist: Mesh;
  localGrip: Vec3;
}
export interface BodyIKResult {
  safe: boolean;
  limited: boolean;
  blocked: boolean;
  orb: Point;
  collision: string | null;
}
const sub = (a: Vec3, b: Vec3): Point => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Point => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: Vec3, s: number): Point => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const dot4 = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
const cross = (a: Vec3, b: Vec3): Point => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const mix = (a: Vec3, b: Vec3, t: number) => add(a, mul(sub(b, a), t));
const unit = (a: Vec3): Point => mul(a, 1 / Math.hypot(...a));
const conjugate = (q: readonly number[]) => [-q[0], -q[1], -q[2], q[3]];
const transform = (m: ArrayLike<number>, p: Vec3): Point => [
  m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
  m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
  m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
];
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
const capsuleSupport =
  (a: Point, b: Point, r: number): Support =>
  (d) =>
    add(dot(a, d) > dot(b, d) ? a : b, mul(unit(d), r + margin));

/** Closest origin point on a triangle, including all edge and vertex regions. */
function triangle(a: Point, b: Point, c: Point): { point: Point; simplex: Point[] } {
  const ab = sub(b, a),
    ac = sub(c, a),
    ap = mul(a, -1),
    d1 = dot(ab, ap),
    d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return { point: a, simplex: [a] };
  const bp = mul(b, -1),
    d3 = dot(ab, bp),
    d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return { point: b, simplex: [b] };
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const p = add(a, mul(ab, d1 / (d1 - d3)));
    return { point: p, simplex: [a, b] };
  }
  const cp = mul(c, -1),
    d5 = dot(ab, cp),
    d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return { point: c, simplex: [c] };
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const p = add(a, mul(ac, d2 / (d2 - d6)));
    return { point: p, simplex: [a, c] };
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const p = add(b, mul(sub(c, b), (d4 - d3) / (d4 - d3 + (d5 - d6))));
    return { point: p, simplex: [b, c] };
  }
  const denom = va + vb + vc;
  if (Math.abs(denom) < 1e-24) return { point: a, simplex: [a] };
  return { point: add(a, add(mul(ab, vb / denom), mul(ac, vc / denom))), simplex: [a, b, c] };
}
function closest(simplex: Point[]): { point: Point; simplex: Point[] } {
  if (simplex.length === 1) return { point: simplex[0], simplex };
  if (simplex.length === 2) {
    const [a, b] = simplex,
      d = sub(b, a),
      t = Math.max(0, Math.min(1, -dot(a, d) / dot(d, d)));
    return { point: mix(a, b, t), simplex: t === 0 ? [a] : t === 1 ? [b] : simplex };
  }
  if (simplex.length === 3) return triangle(...(simplex as [Point, Point, Point]));
  const [a, b, c, d] = simplex,
    ab = sub(b, a),
    ac = sub(c, a),
    ad = sub(d, a),
    ao = mul(a, -1),
    det = dot(ab, cross(ac, ad));
  if (Math.abs(det) > 1e-18) {
    const u = dot(ao, cross(ac, ad)) / det,
      v = dot(ab, cross(ao, ad)) / det,
      w = dot(ab, cross(ac, ao)) / det;
    if (u >= -1e-9 && v >= -1e-9 && w >= -1e-9 && u + v + w <= 1 + 1e-9) return { point: [0, 0, 0], simplex };
  }
  return [
    [a, b, c],
    [a, b, d],
    [a, c, d],
    [b, c, d],
  ]
    .map((face) => triangle(...(face as [Point, Point, Point])))
    .reduce((best, p) => (dot(p.point, p.point) < dot(best.point, best.point) ? p : best));
}
/** GJK distance iteration handles a curved convex torso without square proxy corners. */
function bodyQuery(shape: Support): { overlap: boolean; distance: number; normal: Point } {
  const support = (d: Point) => sub(shape(d), bodySupport(mul(d, -1)));
  let simplex = [support([1, 0, 0])],
    near = simplex[0],
    normal: Point = [1, 0, 0];
  const result = (overlap: boolean) => ({ overlap, distance: overlap ? 0 : Math.hypot(...near), normal });
  for (let step = 0; step < 28; step++) {
    const squared = dot(near, near);
    if (squared < 1e-12) return result(true);
    normal = mul(near, 1 / Math.sqrt(squared));
    const next = support(mul(near, -1));
    if (squared - dot(near, next) < 1e-9 * Math.max(squared, 1)) return result(false);
    if (simplex.some((p) => dot(sub(p, next), sub(p, next)) < 1e-18)) return result(false);
    const closestPoint = closest([...simplex, next]);
    simplex = closestPoint.simplex;
    near = closestPoint.point;
  }
  return result(dot(near, near) < 1e-10);
}
const bodyOverlap = (shape: Support) => bodyQuery(shape).overlap;

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
  private lastFrame?: number[];
  private cached?: BodyIKResult;
  private recovering = false;
  // This capsule is contained by the authored torso. The exact hull queries
  // below still check the complete torso, posed armor, hand, and held orb.
  private readonly targetAvoidance = new AvoidanceSolver(
    [new CapsuleVolume({ start: [0, 0.81, 0.025], end: [0, 1, 0.025], radius: 0.11 })],
    { targetRadius: orbRadius + margin, minClearance: 0, complianceMargin: 0, damping: 0 },
  );
  constructor(options: BodyIKOptions) {
    this.options = options;
    const { frame, shoulder, elbow, wrist, localGrip } = options;
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
    this.preferredPole = sub(localPoint(frame, worldPosition(elbow)), localPoint(frame, worldPosition(shoulder)));
    this.rest = this.capture();
    this.lastSafe = this.capture();
    const contact = this.collision();
    if (contact) throw new Error('Initial arm/body contact: ' + contact);
  }
  private capture(): Pose {
    const t = this.options.frame.engine.store.transforms;
    return this.nodes.map(({ id }) => [t.qx[id], t.qy[id], t.qz[id], t.qw[id]]);
  }
  private restore(pose: Pose): void {
    this.nodes.forEach((node, i) => node.setQuaternion(pose[i]));
    this.options.frame.engine.store.tick(false);
  }
  private orb(): Point {
    return gripPosition(this.options.wrist, this.grip);
  }
  /** Restore the authored arm pose and discard contact/recovery history, including its elbow preference. */
  reset(): void {
    this.targetAvoidance.reset();
    this.restore(this.rest);
    const { frame, shoulder, elbow } = this.options;
    this.lastSafe = this.capture();
    this.preferredPole = sub(localPoint(frame, worldPosition(elbow)), localPoint(frame, worldPosition(shoulder)));
    this.cached = undefined;
    this.lastDesired = undefined;
    this.lastFrame = undefined;
    this.recovering = false;
  }
  private gripQuery(center: Point): ReturnType<typeof bodyQuery> {
    const support = supportPoints(this.gripCorners),
      sphere = bodyQuery(capsuleSupport(center, center, orbRadius)),
      hand = bodyQuery((d) => add(center, add(support(d), mul(unit(d), margin))));
    if (sphere.overlap) return sphere;
    if (hand.overlap) return hand;
    return sphere.distance < hand.distance ? sphere : hand;
  }
  /** Sweep to real contact, then carry the remaining request along its tangent instead of pinning the old pose. */
  private slideGrip(start: Point, desired: Point): Point {
    if (!this.gripQuery(desired).overlap) return desired;
    const advance = (position: Point, goal: Point): Point => {
      if (!this.gripQuery(goal).overlap) return goal;
      let low = 0,
        high = 1;
      for (let i = 0; i < 9; i++) {
        const t = (low + high) / 2;
        if (this.gripQuery(mix(position, goal, t)).overlap) high = t;
        else low = t;
      }
      const at = mix(position, goal, low);
      return add(at, mul(this.gripQuery(at).normal, 0.0002));
    };
    let position = advance(start, desired);
    for (let step = 0; step < 8; step++) {
      const at = this.gripQuery(position),
        normal = at.normal,
        remaining = sub(desired, position),
        tangent = sub(remaining, mul(normal, dot(remaining, normal)));
      if (Math.hypot(...tangent) < 0.0001) break;
      const candidate = advance(position, add(position, mul(tangent, 0.6))),
        separation = this.gripQuery(candidate),
        surface = add(candidate, mul(separation.normal, -Math.max(0, separation.distance - 0.0002)));
      position = this.gripQuery(surface).overlap ? candidate : surface;
    }
    return position;
  }
  private poseQuery(): { collision: string | null; distance: number } {
    const { frame, shoulder, elbow, wrist } = this.options;
    frame.engine.store.tick(false);
    const frameInverse = new Float64Array(16);
    if (!invertMatrixStable(frame.matrix, frameInverse)) throw new Error('Singular body IK frame');
    const orb = transform(frameInverse, this.orb());
    // Posed surface hulls preserve the armor taper and thin lateral joint washers.
    // The authored shoulder bearing is deliberately mounted through the torso side.
    const surface = (joint: Mesh, points: Point[]): Support => {
      const support = supportPoints(points),
        m = new Float64Array(16);
      multiplyMatrices(frameInverse, joint.matrix, m);
      return (d) => {
        const localDirection: Point = [
          dot([m[0], m[1], m[2]], d),
          dot([m[4], m[5], m[6]], d),
          dot([m[8], m[9], m[10]], d),
        ];
        return add(transform(m, support(localDirection)), mul(unit(d), margin));
      };
    };
    let distance = Infinity;
    for (const [name, shape] of [
      ...this.upperPieces.map((piece) => ['upper arm / body', surface(shoulder, piece)] as const),
      ['forearm / body', surface(elbow, this.forearmPoints)],
      ['hand / body', surface(wrist, this.handCorners)],
      ['orb / body', capsuleSupport(orb, orb, orbRadius)],
    ] as const) {
      const query = bodyQuery(shape);
      if (query.overlap) return { collision: name, distance: 0 };
      distance = Math.min(distance, query.distance);
    }
    return { collision: null, distance };
  }
  collision(): string | null {
    return this.poseQuery().collision;
  }
  solve(desiredOrb: Vec3, dt = 1 / 60): BodyIKResult {
    finiteVector(desiredOrb, 3, 'Body IK target');
    if (!Number.isFinite(dt) || dt <= 0) throw new RangeError('Body IK dt must be positive and finite');
    const desired: Point = [...desiredOrb],
      { frame, shoulder, elbow, wrist } = this.options;
    frame.engine.store.tick(false);
    const frameValues = Array.from(frame.matrix);
    if (
      !this.recovering &&
      this.cached &&
      this.lastDesired &&
      this.lastFrame &&
      Math.hypot(...sub(desired, this.lastDesired)) < 1e-5 &&
      frameValues.every((v, i) => Math.abs(v - this.lastFrame![i]) < 1e-7)
    ) {
      this.restore(this.lastSafe);
      return { ...this.cached, orb: this.orb() };
    }
    this.restore(this.lastSafe);
    const previousPose = this.lastSafe,
      previousCenter = this.orb(),
      previousLocal = localPoint(frame, previousCenter),
      rawStep = this.lastDesired
        ? Math.hypot(...sub(localPoint(frame, desired), localPoint(frame, this.lastDesired)))
        : Infinity,
      continuousContact = rawStep < 0.08 && (this.cached?.blocked || this.recovering);
    const requestedDistance = Math.hypot(...sub(localPoint(frame, desired), previousLocal)),
      chase = continuousContact && requestedDistance > 0.018,
      solveDesired = chase
        ? gripPosition(
            frame,
            add(previousLocal, mul(sub(localPoint(frame, desired), previousLocal), 0.018 / requestedDistance)),
          )
        : desired;
    const base = this.rest,
      orientation = multiplyQuaternions(worldRotation(frame), this.wristInFrame),
      offset = sub(gripPosition(frame, this.gripOffset), worldPosition(frame)),
      root = localPoint(frame, worldPosition(shoulder));
    const startCenter = localPoint(frame, this.orb()),
      requestedCenter = localPoint(frame, solveDesired),
      projectedCenter = this.targetAvoidance.resolveTarget(requestedCenter, dt),
      // Target projection is a coarse preconditioner. Contact sliding and the
      // posed surface oracle retain responsibility for accepting a final pose.
      constrainedCenter: Point = this.targetAvoidance.targetResult.resolved
        ? [projectedCenter[0], projectedCenter[1], projectedCenter[2]]
        : requestedCenter,
      slidCenter = this.slideGrip(startCenter, constrainedCenter);
    const slidWorld = gripPosition(frame, slidCenter),
      gripLimited = Math.hypot(...sub(slidCenter, requestedCenter)) > 1e-5;
    let lastCollision: string | null = null;
    const place = (center: Vec3, poleOffset: Point) => {
      this.restore(base);
      solveArm({
        shoulder,
        elbow,
        wrist,
        target: sub(center, offset),
        pole: gripPosition(frame, add(root, poleOffset)),
      });
      rotateWorld(wrist, multiplyQuaternions(orientation, conjugate(worldRotation(wrist))));
      frame.engine.store.tick(false);
      const query = this.poseQuery();
      if (query.collision) lastCollision = query.collision;
      return query;
    };
    const evaluate = (center: Point, full: boolean): Pose | undefined => {
      const wristTarget = localPoint(frame, sub(center, offset)),
        direction = sub(wristTarget, root),
        axis = Math.hypot(...direction) > 1e-8 ? unit(direction) : unit(this.preferredPole);
      let perpendicular = sub(this.preferredPole, mul(axis, dot(this.preferredPole, axis)));
      if (Math.hypot(...perpendicular) < 1e-6)
        perpendicular = cross(axis, Math.abs(axis[1]) < 0.8 ? [0, 1, 0] : [0, 0, 1]);
      perpendicular = unit(perpendicular);
      const other = cross(axis, perpendicular);
      const atAngle = (angle: number): Pose | undefined => {
        const pole = add(mul(perpendicular, Math.cos(angle)), mul(other, Math.sin(angle)));
        if (!place(center, pole).collision) return this.capture();
        return undefined;
      };
      const cost = (pose: Pose) =>
        pose.reduce((sum, q, i) => sum + 1 - Math.abs(q.reduce((s, v, j) => s + v * this.lastSafe[i][j], 0)), 0);
      for (let band = 0; band <= (full ? 12 : 1); band++) {
        let best: Pose | undefined;
        for (const sign of band === 0 || band === 12 ? [1] : [1, -1]) {
          const angle = (sign * band * Math.PI) / 12;
          let pose = atAngle(angle);
          if (!pose) continue;
          if (band) {
            let low = (band - 1) / band,
              high = 1;
            for (let i = 0; i < 4; i++) {
              const t = (low + high) / 2,
                candidate = atAngle(angle * t);
              if (candidate) {
                pose = candidate;
                high = t;
              } else low = t;
            }
          }
          if (!best || cost(pose) < cost(best)) best = pose;
        }
        if (best) {
          this.restore(best);
          return best;
        }
      }
      return undefined;
    };
    let pose = evaluate(slidWorld, true),
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
          candidate = evaluate(mix(start, slidWorld, t), false);
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
          contactLocal = localPoint(frame, contactCenter),
          goalLocal = localPoint(frame, slidWorld),
          remaining = sub(goalLocal, contactLocal);
        if (Math.hypot(...remaining) < 0.001) break;
        const gradient: Point = [0, 0, 0],
          epsilon = 0.003;
        for (let axis = 0; axis < 3; axis++) {
          const delta: Point = [0, 0, 0];
          delta[axis] = epsilon;
          const positive = place(gripPosition(frame, add(contactLocal, delta)), this.preferredPole).distance,
            negative = place(gripPosition(frame, sub(contactLocal, delta)), this.preferredPole).distance;
          gradient[axis] = (positive - negative) / (2 * epsilon);
        }
        const length = Math.hypot(...gradient);
        if (length < 1e-5) break;
        const normal = mul(gradient, 1 / length),
          tangent = sub(remaining, mul(normal, Math.min(0, dot(remaining, normal)))),
          stepLength = Math.hypot(...tangent);
        if (stepLength < 0.0002) break;
        const goal = gripPosition(frame, add(contactLocal, mul(tangent, Math.min(1, 0.025 / stepLength))));
        let candidate = evaluate(goal, false);
        if (!candidate) {
          let lo = 0,
            hi = 1;
          for (let i = 0; i < 5; i++) {
            const alpha = (lo + hi) / 2,
              partial = evaluate(mix(contactCenter, goal, alpha), false);
            if (partial) {
              lo = alpha;
              candidate = partial;
            } else hi = alpha;
          }
        }
        if (!candidate) break;
        this.restore(candidate);
        if (Math.hypot(...sub(this.orb(), contactCenter)) < 0.0001) break;
        pose = candidate;
      }
    }
    this.restore(pose);
    let recovering = chase;
    if (continuousContact) {
      const distance = Math.hypot(...sub(localPoint(frame, this.orb()), previousLocal)),
        angle = Math.max(...pose.map((q, i) => 2 * Math.acos(Math.min(1, Math.abs(dot4(q, previousPose[i]))))));
      let alpha = Math.min(1, 0.018 / Math.max(distance, 1e-8), 0.12 / Math.max(angle, 1e-8));
      if (alpha < 1) {
        const destination = pose;
        recovering = true;
        for (let attempt = 0; attempt < 7; attempt++) {
          const intermediate = destination.map((q, i) => {
            const sign = dot4(q, previousPose[i]) < 0 ? -1 : 1,
              values = q.map((v, j) => previousPose[i][j] * (1 - alpha) + v * sign * alpha),
              length = Math.hypot(...values);
            return values.map((v) => v / length);
          });
          this.restore(intermediate);
          rotateWorld(wrist, multiplyQuaternions(orientation, conjugate(worldRotation(wrist))));
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
    const progress = Math.hypot(...sub(localPoint(frame, this.orb()), previousLocal));
    this.recovering = recovering && progress > 0.00005;
    this.restore(pose);
    this.lastSafe = this.capture();
    this.preferredPole = sub(localPoint(frame, worldPosition(elbow)), root);
    const orb = this.orb(),
      result = {
        safe: !this.collision(),
        limited: Math.hypot(...sub(orb, desired)) > 0.002,
        blocked: blocked || recovering,
        orb,
        collision: blocked ? (lastCollision ?? 'grip / body') : null,
      };
    this.cached = result;
    this.lastDesired = desired;
    this.lastFrame = frameValues;
    return result;
  }
  /** Off/manual branches retain the latest body-clear pose, while the orb stays attached to the palm. */
  enforce(): BodyIKResult {
    const contact = this.collision();
    if (contact) {
      this.restore(this.lastSafe);
      this.cached = undefined;
    } else {
      const pose = this.capture();
      if (pose.some((q, i) => q.some((v, j) => Math.abs(v - this.lastSafe[i][j]) > 1e-6))) this.cached = undefined;
      this.lastSafe = pose;
    }
    return { safe: !this.collision(), limited: !!contact, blocked: !!contact, orb: this.orb(), collision: contact };
  }
}
