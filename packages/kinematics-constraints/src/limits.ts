// The `limits` entry: inverse kinematics that keeps every joint in its range and every link clear of obstacles, for a
// whole Robot. Each iteration is one small quadratic program, damped least squares on the task (C. Wampler, 1986; Y.
// Nakamura and H. Hanafusa, 1986), the joint ranges as bounds, and a velocity damper per nearby obstacle (B. Faverjon and
// P. Tournassoud, ICRA 1987): a gap may close no faster than a share of what is left of it. Hildreth's row-by-row method
// (C. Hildreth, Naval Research Logistics Quarterly 4, 1957) solves it. Written clean room from those publications.
import { rangeError, typeError } from '../../shared/errors.js';
import { Robot, type RobotJointOptions } from './robot.js';
import { sweepRobot } from './swept.js';
import type { ConstraintVolume, Vec3View } from './types.js';
import { validateVector } from './types.js';

/** Options of {@link JointLimitSolver}. */
export interface JointLimitSolverOptions {
  /** The joint that carries the end effector, by index or name. */
  tip: number | string;
  /** The end effector in that joint's frame. Default its origin. */
  point?: Vec3View;
  /** Default none. */
  colliders?: readonly ConstraintVolume[];
  /** Gap every shape keeps from every collider, in scene units. Default 0.01. */
  minClearance?: number;
  /** How far past `minClearance` an obstacle starts to count. Default 0.1. */
  influence?: number;
  /** Also keep the robot's shapes off each other. Default false. */
  selfCollision?: boolean;
  /** Most iterations. Default 100. */
  maxIterations?: number;
  /** Distance from the target that counts as reached, in scene units. Default 1e-4. */
  tolerance?: number;
  /** Angle from a target rotation that counts as reached, in radians. Default 1e-3. */
  angleTolerance?: number;
  /** Damping of the least squares step, for poses near a singularity. Default 0.01. */
  damping?: number;
  /** Most any joint moves per iteration, radians or scene units. Default 0.2. */
  maxStep?: number;
  /** A pose to lean toward where the task leaves freedom: the lean never pulls against the target. Default none. */
  rest?: ArrayLike<number>;
  /** Share of the way to `rest` to lean on each iteration, 0 to 1. Default 0.1. */
  restWeight?: number;
}

/** What the solver is asked for. */
export interface JointLimitTarget {
  /** World position of the end effector. */
  position: Vec3View;
  /** World rotation of the tip joint's frame, a unit quaternion `x, y, z, w`. Default free. */
  rotation?: readonly [number, number, number, number] | Float32Array | Float64Array;
}

/** What a solve found. All of it is reused by the next solve. */
export interface JointLimitResult {
  /** The target is met within the tolerances, inside every range, keeping the gap. */
  reached: boolean;
  /** The configuration reached, always within the joint ranges. */
  q: Float64Array;
  /** Distance left to the target. */
  error: number;
  /** Angle left to the target rotation; 0 when no rotation was asked for. */
  angleError: number;
  /** Smallest gap at `q`; Infinity with no collider. */
  clearance: number;
  /** Configuration entries a joint range held back on the last iteration. */
  limited: number[];
  /** An obstacle held the solve back on the last iteration. */
  blocked: boolean;
  /** Iterations used. */
  iterations: number;
}

/** Writes `a` lower-triangular Cholesky factor in place and solves; `damping` keeps `a` positive definite. */
function factor(a: Float64Array, n: number): void {
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = a[i * n + j];
      for (let k = 0; k < j; k++) sum -= a[i * n + k] * a[j * n + k];
      a[i * n + j] = i === j ? Math.sqrt(sum) : sum / a[j * n + j];
    }
  }
}

function solveFactored(l: Float64Array, n: number, rhs: Float64Array, out: Float64Array, at: number): void {
  for (let i = 0; i < n; i++) {
    let sum = rhs[i];
    for (let k = 0; k < i; k++) sum -= l[i * n + k] * out[at + k];
    out[at + i] = sum / l[i * n + i];
  }
  for (let i = n - 1; i >= 0; i--) {
    let sum = out[at + i];
    for (let k = i + 1; k < n; k++) sum -= l[k * n + i] * out[at + k];
    out[at + i] = sum / l[i * n + i];
  }
}

const SWEEPS = 200;
// Rows a single iteration may hold: more nearby pairs than this keep only the closest.
const MAX_OBSTACLE_ROWS = 48;
const DAMPER = 0.5;
const GRADIENT_STEP = 1e-5;

/**
 * Inverse kinematics that owns the joint ranges and the obstacles, so the caller checks neither. From a starting pose
 * it moves the tip toward a target along a path that stays inside every range and clear of every collider, proved
 * step by step with a swept check, and stops short and says why when it cannot get there: {@link JointLimitResult.limited}
 * names the joints at their stops, {@link JointLimitResult.blocked} an obstacle. It is a local method; when it is blocked,
 * a planner can find the way round.
 *
 * @example
 * ```ts
 * import { SphereVolume } from 'margoengine/kinematics-constraints';
 * import { armRobot, JointLimitSolver } from 'margoengine/kinematics-constraints/limits';
 *
 * const arm = armRobot({ upperLength: 1, forearmLength: 1, radius: 0.05, elbow: [0, 2.6] });
 * const solver = new JointLimitSolver(arm, {
 *   tip: 'hand',
 *   colliders: [new SphereVolume({ center: [0.5, 1, 0], radius: 0.2 })],
 * });
 * const result = solver.solve([0, 0, 0, 0.5], { position: [0.8, 0.9, 0.6] });
 * if (result.reached) console.log(result.q);
 * ```
 */
export class JointLimitSolver {
  private readonly robot: Robot;
  private readonly tip: number;
  private readonly point: Float64Array;
  private readonly colliders: readonly ConstraintVolume[];
  private readonly minClearance: number;
  private readonly influence: number;
  private readonly selfCollision: boolean;
  private readonly maxIterations: number;
  private readonly tolerance: number;
  private readonly angleTolerance: number;
  private readonly damping: number;
  private readonly maxStep: number;
  private readonly rest: Float64Array | null;
  private readonly restWeight: number;
  private readonly result: JointLimitResult;

  constructor(robot: Robot, options: JointLimitSolverOptions) {
    if (!(robot instanceof Robot)) throw typeError('JointLimitSolver needs a Robot', 'kinematics');
    const tip = typeof options?.tip === 'string' ? robot.jointIndex(options.tip) : options?.tip;
    if (!Number.isInteger(tip) || tip! < 0 || tip! >= robot.jointCount)
      throw rangeError(`JointLimitSolver tip ${String(options?.tip)} is not a joint of this robot`, 'kinematics');
    this.robot = robot;
    this.tip = tip!;
    const point = options.point ?? [0, 0, 0];
    validateVector(point, 'solver point');
    this.point = Float64Array.of(point[0], point[1], point[2]);
    this.colliders = [...(options.colliders ?? [])];
    this.selfCollision = options.selfCollision === true;
    this.minClearance = positive(options.minClearance ?? 0.01, 'minClearance', true);
    this.influence = positive(options.influence ?? 0.1, 'influence', false);
    this.tolerance = positive(options.tolerance ?? 1e-4, 'tolerance', false);
    this.angleTolerance = positive(options.angleTolerance ?? 1e-3, 'angleTolerance', false);
    this.damping = positive(options.damping ?? 0.01, 'damping', false);
    this.maxStep = positive(options.maxStep ?? 0.2, 'maxStep', false);
    this.restWeight = positive(options.restWeight ?? 0.1, 'restWeight', true);
    const maxIterations = options.maxIterations ?? 100;
    if (!Number.isSafeInteger(maxIterations) || maxIterations < 1)
      throw rangeError('JointLimitSolver maxIterations must be a positive integer', 'kinematics');
    this.maxIterations = maxIterations;
    if (options.rest && options.rest.length !== robot.dof)
      throw typeError(`JointLimitSolver rest needs ${robot.dof} numbers`, 'kinematics');
    this.rest = options.rest ? Float64Array.from(options.rest) : null;
    this.result = {
      reached: false,
      q: new Float64Array(robot.dof),
      error: Infinity,
      angleError: 0,
      clearance: Infinity,
      limited: [],
      blocked: false,
      iterations: 0,
    };
  }

  /**
   * Moves from `start` toward `target`. A `start` outside a range is first brought inside it. A `start` already closer
   * to a collider than `minClearance` is pushed out first. The path from `start` to the result is a chain of straight
   * joint-space steps, each swept clear.
   */
  solve(start: ArrayLike<number>, target: JointLimitTarget): JointLimitResult {
    const { robot, tip, point, colliders, result, maxStep, minClearance, tolerance, angleTolerance } = this,
      n = robot.dof,
      q = result.q;
    robot.clamp(start, q);
    validateVector(target?.position, 'target position');
    const goal = target.rotation ? rotationMatrix(target.rotation) : null,
      rows = goal ? 6 : 3,
      jacobian = new Float64Array(6 * n),
      task = new Float64Array(6),
      h = new Float64Array(n * n),
      g = new Float64Array(n),
      step = new Float64Array(n),
      next = new Float64Array(n),
      probe = new Float64Array(n),
      tipPoint = new Float64Array(3),
      lean = new Float64Array(n);
    result.reached = false;
    result.blocked = false;
    result.limited = [];
    let last = Infinity;
    for (let iteration = 0; ; iteration++) {
      let gap = robot.clearance(q, colliders, this.selfCollision);
      robot.pointOn(tip, point, tipPoint);
      task[0] = target.position[0] - tipPoint[0];
      task[1] = target.position[1] - tipPoint[1];
      task[2] = target.position[2] - tipPoint[2];
      const error = Math.hypot(task[0], task[1], task[2]),
        angle = goal ? rotationError(goal, robot.frames, tip * 12, task) : 0;
      result.error = error;
      result.angleError = angle;
      result.clearance = gap;
      result.iterations = iteration;
      const met = error <= tolerance && angle <= angleTolerance && gap >= minClearance - tolerance;
      result.reached = met;
      if (met) {
        result.limited = [];
        result.blocked = false;
        if (!this.rest) return result;
      }
      if (iteration >= this.maxIterations) return result;

      robot.jacobian(tip, point, jacobian);
      h.fill(0);
      g.fill(0);
      for (let a = 0; a < n; a++) {
        for (let r = 0; r < rows; r++) g[a] += jacobian[r * n + a] * task[r];
        for (let b = 0; b <= a; b++) {
          let sum = 0;
          for (let r = 0; r < rows; r++) sum += jacobian[r * n + a] * jacobian[r * n + b];
          h[a * n + b] = sum;
        }
        h[a * n + a] += this.damping * this.damping;
      }
      for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) h[a * n + b] = h[b * n + a];
      if (this.rest) {
        const size = this.lean(h, jacobian, rows, q, g, lean, probe);
        if (met && size < tolerance) return result;
      }
      factor(h, n);
      const near = this.obstacleRows(q, gap, next),
        m = 2 * n + near.count,
        lines = new Float64Array(m * n),
        limits = new Float64Array(m);
      for (let i = 0; i < n; i++) {
        lines[i * n + i] = 1;
        limits[i] = Math.min(robot.upper[i] - q[i], maxStep);
        lines[(n + i) * n + i] = -1;
        limits[n + i] = Math.min(q[i] - robot.lower[i], maxStep);
      }
      lines.set(near.lines.subarray(0, near.count * n), 2 * n * n);
      limits.set(near.limits.subarray(0, near.count), 2 * n);
      const multipliers = hildreth(h, n, g, lines, limits, m, step);
      result.limited = [];
      for (let i = 0; i < n; i++) {
        if (multipliers[i] > 1e-9 && limits[i] < maxStep) result.limited.push(i);
        else if (multipliers[n + i] > 1e-9 && limits[n + i] < maxStep) result.limited.push(i);
      }
      result.blocked = false;
      for (let i = 2 * n; i < m; i++) if (multipliers[i] > 1e-9) result.blocked = true;
      let size = 0;
      for (let i = 0; i < n; i++) {
        next[i] = Math.min(Math.max(q[i] + step[i], robot.lower[i]), robot.upper[i]);
        size = Math.max(size, Math.abs(next[i] - q[i]));
      }
      if (size < 1e-9) return result;
      // The step must not break the gap anywhere along it. From a pose inside the gap, it must at least not sink.
      const sweep = gap > tolerance * 2 ? Math.min(minClearance, gap - tolerance) : -1;
      if (sweep >= 0) {
        const swept = sweepRobot(robot, q, next, colliders, {
          minClearance: sweep,
          tolerance,
          selfCollision: this.selfCollision,
        });
        if (!swept.clear) {
          result.blocked = true;
          if (swept.time <= 0) return result;
          for (let i = 0; i < n; i++) next[i] = q[i] + (next[i] - q[i]) * swept.time;
        }
      } else {
        const after = robot.clearance(next, colliders, this.selfCollision);
        if (after < gap) {
          result.blocked = true;
          return result;
        }
      }
      q.set(next);
      // A step that gains nothing on the task: stuck against a stop or an obstacle.
      const measure = error + angle;
      if (last - measure < 1e-9 && size < 1e-5) return result;
      last = measure;
      gap = Infinity;
    }
  }

  /**
   * Adds to `g` the lean toward `rest`, with the part that would move the task taken out: the projector on the Jacobian's
   * null space, applied twice so the damping's leak through it is of the damping's fourth power. Returns the lean's size.
   */
  private lean(
    h: Float64Array,
    jacobian: Float64Array,
    rows: number,
    q: Float64Array,
    g: Float64Array,
    out: Float64Array,
    scratch: Float64Array,
  ): number {
    const n = q.length,
      factored = h.slice();
    factor(factored, n);
    for (let i = 0; i < n; i++) out[i] = (this.rest![i] - q[i]) * this.restWeight;
    const task = new Float64Array(n);
    for (let pass = 0; pass < 2; pass++) {
      // task = J'J out, then out -= H^-1 task.
      for (let a = 0; a < n; a++) {
        let sum = 0;
        for (let r = 0; r < rows; r++) {
          let dot = 0;
          for (let b = 0; b < n; b++) dot += jacobian[r * n + b] * out[b];
          sum += jacobian[r * n + a] * dot;
        }
        task[a] = sum;
      }
      solveFactored(factored, n, task, scratch, 0);
      for (let i = 0; i < n; i++) out[i] -= scratch[i];
    }
    let size = 0;
    for (let a = 0; a < n; a++) {
      let sum = 0;
      for (let b = 0; b < n; b++) sum += h[a * n + b] * out[b];
      g[a] += sum;
      size = Math.max(size, Math.abs(out[a]));
    }
    return size;
  }

  /** One row per nearby pair: the gap's gradient in joint space, by finite differences, so any collider works. */
  private obstacleRows(q: Float64Array, gap: number, probe: Float64Array) {
    const { robot, colliders, influence, minClearance } = this,
      n = robot.dof,
      reach = minClearance + influence;
    const pairs: { a: number; b: number; gap: number }[] = [];
    if (gap < reach) {
      // `clearance` left the shapes at q.
      for (let s = 0; s < robot.shapeCount; s++) {
        for (let c = 0; c < colliders.length; c++) {
          const value = robot.shapeGap(s, colliders[c]);
          if (value < reach) pairs.push({ a: s, b: c, gap: value });
        }
      }
      if (this.selfCollision) {
        const self = robot.selfCollisionPairs;
        for (let i = 0; i < self.length; i += 2) {
          const value = robot.pairGap(self[i], self[i + 1]);
          if (value < reach) pairs.push({ a: self[i], b: -1 - self[i + 1], gap: value });
        }
      }
      pairs.sort((x, y) => x.gap - y.gap);
      pairs.length = Math.min(pairs.length, MAX_OBSTACLE_ROWS);
    }
    const count = pairs.length,
      lines = new Float64Array(count * n),
      limits = new Float64Array(count);
    const read = (pair: { a: number; b: number }): number =>
      pair.b >= 0 ? robot.shapeGap(pair.a, colliders[pair.b]) : robot.pairGap(pair.a, -1 - pair.b);
    probe.set(q);
    for (let j = 0; j < n; j++) {
      probe[j] = q[j] + GRADIENT_STEP;
      robot.place(probe);
      for (let i = 0; i < count; i++) lines[i * n + j] = -(read(pairs[i]) - pairs[i].gap) / GRADIENT_STEP;
      probe[j] = q[j];
    }
    robot.place(q);
    // gap'(q) dq >= -DAMPER (gap - minClearance), written as a row of `a x <= b`.
    for (let i = 0; i < count; i++) limits[i] = DAMPER * (pairs[i].gap - minClearance);
    return { count, lines, limits };
  }
}

/** Solves min x'Hx/2 - g'x subject to A x <= b. `l` is H's Cholesky factor. Returns the multipliers. */
function hildreth(
  l: Float64Array,
  n: number,
  g: Float64Array,
  lines: Float64Array,
  limits: Float64Array,
  m: number,
  x: Float64Array,
): Float64Array {
  solveFactored(l, n, g, x, 0);
  const shifted = new Float64Array(m * n),
    weight = new Float64Array(m),
    multipliers = new Float64Array(m),
    row = new Float64Array(n);
  for (let i = 0; i < m; i++) {
    row.set(lines.subarray(i * n, (i + 1) * n));
    solveFactored(l, n, row, shifted, i * n);
    let sum = 0;
    for (let k = 0; k < n; k++) sum += row[k] * shifted[i * n + k];
    weight[i] = sum;
  }
  for (let sweep = 0; sweep < SWEEPS; sweep++) {
    let changed = 0;
    for (let i = 0; i < m; i++) {
      if (!(weight[i] > 1e-14)) continue;
      let value = -limits[i];
      for (let k = 0; k < n; k++) value += lines[i * n + k] * x[k];
      const updated = Math.max(0, multipliers[i] + value / weight[i]),
        delta = updated - multipliers[i];
      if (delta === 0) continue;
      multipliers[i] = updated;
      for (let k = 0; k < n; k++) x[k] -= shifted[i * n + k] * delta;
      changed = Math.max(changed, Math.abs(delta) * weight[i]);
    }
    if (changed < 1e-12) break;
  }
  return multipliers;
}

function positive(value: number, name: string, zero: boolean): number {
  if (!Number.isFinite(value) || value < 0 || (!zero && value === 0))
    throw rangeError(`JointLimitSolver ${name} must be ${zero ? '0 or more' : 'above 0'}`, 'kinematics');
  return value;
}

function rotationMatrix(q: ArrayLike<number>): Float64Array {
  if (!q || q.length !== 4) throw typeError('A target rotation is a quaternion of four numbers', 'kinematics');
  const size = Math.hypot(q[0], q[1], q[2], q[3]);
  if (!(size > 0) || !Number.isFinite(size))
    throw rangeError('A target rotation must be a non-zero quaternion', 'kinematics');
  const x = q[0] / size,
    y = q[1] / size,
    z = q[2] / size,
    w = q[3] / size;
  return Float64Array.of(
    1 - 2 * (y * y + z * z),
    2 * (x * y + w * z),
    2 * (x * z - w * y),
    2 * (x * y - w * z),
    1 - 2 * (x * x + z * z),
    2 * (y * z + w * x),
    2 * (x * z + w * y),
    2 * (y * z - w * x),
    1 - 2 * (x * x + y * y),
  );
}

/** Writes the rotation vector from the frame at `f[at]` to `goal` into `task[3..5]`, and returns its angle. */
function rotationError(goal: Float64Array, f: Float64Array, at: number, task: Float64Array): number {
  // E = goal * frame^T, column by column of 3x3 matrices stored by column.
  const e = new Float64Array(9);
  for (let c = 0; c < 3; c++) {
    for (let r = 0; r < 3; r++) {
      let sum = 0;
      for (let k = 0; k < 3; k++) sum += goal[k * 3 + r] * f[at + k * 3 + c];
      e[c * 3 + r] = sum;
    }
  }
  const x = (e[5] - e[7]) / 2,
    y = (e[6] - e[2]) / 2,
    z = (e[1] - e[3]) / 2,
    sine = Math.hypot(x, y, z),
    cosine = (e[0] + e[4] + e[8] - 1) / 2,
    angle = Math.atan2(sine, cosine);
  if (sine > 1e-9) {
    const scale = angle / sine;
    task[3] = x * scale;
    task[4] = y * scale;
    task[5] = z * scale;
  } else if (cosine > 0) {
    task[3] = task[4] = task[5] = 0;
  } else {
    // Half a turn: the axis is the widest column of E + I.
    const k = e[0] >= e[4] && e[0] >= e[8] ? 0 : e[4] >= e[8] ? 1 : 2,
      ax = e[k * 3] + (k === 0 ? 1 : 0),
      ay = e[k * 3 + 1] + (k === 1 ? 1 : 0),
      az = e[k * 3 + 2] + (k === 2 ? 1 : 0),
      size = Math.hypot(ax, ay, az);
    task[3] = (ax / size) * angle;
    task[4] = (ay / size) * angle;
    task[5] = (az / size) * angle;
  }
  return angle;
}

/** Options of {@link armRobot}. Ranges are `[lower, upper]` in radians. */
export interface ArmRobotOptions {
  upperLength: number;
  forearmLength: number;
  /** Capsule radius of both links. */
  radius: number;
  /** Turn about +Z at the shoulder. Default `[-PI, PI]`. */
  yaw?: readonly [number, number];
  /** Lift about +X at the shoulder. Default `[-PI, PI]`. */
  pitch?: readonly [number, number];
  /** Twist along the upper link at the shoulder. Default `[-PI / 2, PI / 2]`. */
  twist?: readonly [number, number];
  /** Bend of the elbow about +X. Default `[0, 2.8]`. */
  elbow?: readonly [number, number];
  /** Column-major matrix of 16 values placing the shoulder. Defaults to the identity. */
  base?: ArrayLike<number>;
}

/**
 * The two-bone arm of `AvoidanceSolver` as a {@link Robot} with joint ranges: a three-axis shoulder, an elbow hinge and
 * a fixed `hand` at the end, bones along +Y as in a glTF rig. A configuration is yaw, pitch, twist, elbow.
 */
export function armRobot(options: ArmRobotOptions): Robot {
  const { upperLength, forearmLength, radius } = options;
  if (!(upperLength > 0) || !(forearmLength > 0))
    throw rangeError('armRobot needs bone lengths above 0', 'kinematics');
  const range = (value: readonly [number, number] | undefined, low: number, high: number) => ({
    lower: value?.[0] ?? low,
    upper: value?.[1] ?? high,
  });
  const along = (length: number) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, length, 0, 1];
  const joints: RobotJointOptions[] = [
    { name: 'yaw', axis: [0, 0, 1], ...range(options.yaw, -Math.PI, Math.PI) },
    { name: 'pitch', axis: [1, 0, 0], ...range(options.pitch, -Math.PI, Math.PI) },
    { name: 'twist', axis: [0, 1, 0], ...range(options.twist, -Math.PI / 2, Math.PI / 2) },
    { name: 'elbow', axis: [1, 0, 0], origin: along(upperLength), ...range(options.elbow, 0, 2.8) },
    { name: 'hand', type: 'fixed', origin: along(forearmLength) },
  ];
  return new Robot({
    joints,
    shapes: [
      { joint: 'twist', end: [0, upperLength, 0], radius },
      { joint: 'elbow', end: [0, forearmLength, 0], radius },
    ],
    base: options.base,
  });
}
