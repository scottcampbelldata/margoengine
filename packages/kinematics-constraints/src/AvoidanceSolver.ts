import { margoError, rangeError, typeError } from '../../shared/errors.js';
import type { ConvexHullVolume } from './hull.js';
import type { ConstraintVolume, Vec3View } from './types.js';
import { length3, readVector, scaledLength3, validateVector, validateNonNegative, validatePositive } from './types.js';
import { evaluateVolumeInto, segmentVolumeInto, type SegmentDistanceResult } from './volumes.js';

/** Why a solve ended: clear, swivel-rate limited, clamped by a singularity band, or blocked by an obstacle. */
export enum SolveStatus {
  /** The evaluated discrete pose and its checked link capsules have static clearance. */
  Success = 0,
  /** A sampled clear pose requires exceeding the permitted swivel movement. */
  SwivelRateLimitExceeded = 1,
  /** The target was clamped out of a near-singular fold or reach exclusion band. */
  SingularDeadZone = 2,
  /** No clear pose was found within the search budget; this is not a nonexistence proof. */
  ObstacleOccluded = 3,
}

/** Per-solve options: swivel speed limit, reach and fold margins and the angular search budget. */
export interface SolveOptions {
  /** Maximum swivel speed, radians/second. Defaults to 2 PI. */
  swivelSpeedLimit?: number;
  /** Distance excluded at full extension. Defaults to 1e-5 scene units. */
  reachMargin?: number;
  /** Distance excluded at full compression. Defaults to 1e-5 scene units. */
  foldMargin?: number;
  /** Additional angular candidates per search pass, 0..256. Defaults to 32. */
  searchBudget?: number;
}

/**
 * A chain link checked as its own convex hull instead of a capsule. The hull's points are in the link's local space,
 * such as its bone's. The solver moves the hull to each candidate pose: `axis` along the link, `hinge` on the normal
 * of the plane through root, elbow and hand, in the direction of `(elbow - root) x (hand - elbow)`.
 */
export interface LinkHullOptions {
  /** The hull to move. The solver owns its transform; do not list it in the colliders. */
  hull: ConvexHullVolume;
  /** Local position of the link's start joint. Defaults to the local origin. */
  origin?: Vec3View;
  /** Local direction from the link's start joint toward its end joint. Defaults to +Y, as in a glTF bone. */
  axis?: Vec3View;
  /** Local direction of the elbow's hinge axis; need not be square to `axis`. Defaults to +X. */
  hinge?: Vec3View;
}

/** Options of AvoidanceSolver: the colliders, clearances, damping, iteration limit and tolerance. */
export interface AvoidanceSolverOptions {
  colliders?: readonly ConstraintVolume[];
  minClearance?: number;
  complianceMargin?: number;
  targetRadius?: number;
  /** Exponential smoothing time constant in seconds; zero disables smoothing. */
  damping?: number;
  maxIterations?: number;
  /** Numerical acceptance tolerance in scene units. Defaults to 1e-6. */
  tolerance?: number;
  /** null explicitly excludes the upper link (for an attachment within a torso). */
  upperArmRadius?: number | null;
  /** Length excluded from the root end of the checked upper link. Defaults to zero. */
  rootExclusion?: number;
  /**
   * Upper link and forearm hulls, in that order; leave either out for its capsule. An upper link hull takes the place
   * of `upperArmRadius` and `rootExclusion`, so setting those as well throws.
   */
  links?: readonly [(LinkHullOptions | null)?, (LinkHullOptions | null)?];
}

/**
 * Outcome of resolving a target: whether it resolved, the clearance, the deepest penetration and the iterations used.
 */
export interface TargetResult {
  resolved: boolean;
  clearance: number;
  maxPenetration: number;
  iterations: number;
}

/** Outcome of a solve: status, the resolved target and elbow positions and the pole angle. */
export interface SolveResult extends TargetResult {
  status: SolveStatus;
  targetResolved: boolean;
  target: Float32Array;
  elbow: Float32Array;
  poleAngle: number;
  /** Alias of poleAngle for adapters using the earlier draft terminology. */
  poleAngleOffset: number;
}

/**
 * Outcome of searching the pole angle for clearance: the elbow and pole positions, their offset, the clearance and the iterations used.
 */
export interface PoleClearanceResult {
  resolved: boolean;
  elbow: Float32Array;
  pole: Float32Array;
  poleAngleOffset: number;
  clearance: number;
  iterations: number;
}

/** Writes the elbow position for a root, a target and a pole angle into `outElbow`. */
export type ElbowEvaluator = (root: Vec3View, target: Vec3View, poleAngle: number, outElbow: Float32Array) => void;

const EMPTY_SOLVE_OPTIONS: SolveOptions = Object.freeze({});

function count(value: number, maximum: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw new RangeError(name);
}

/** A link hull and its frame: `basis` holds the local axis, hinge and their cross, unit and square, then the origin. */
interface LinkHull {
  hull: ConvexHullVolume;
  basis: Float64Array;
}

function linkHull(options: LinkHullOptions | null | undefined): LinkHull | null {
  if (!options) return null;
  const hull = options.hull;
  if (!hull || typeof hull.setTransform !== 'function')
    throw typeError('A link hull must be a ConvexHullVolume', 'kinematics');
  const origin = options.origin ?? [0, 0, 0],
    axis = options.axis ?? [0, 1, 0],
    hinge = options.hinge ?? [1, 0, 0];
  validateVector(origin, 'link hull origin');
  validateVector(axis, 'link hull axis');
  validateVector(hinge, 'link hull hinge');
  const axisLength = length3(axis[0], axis[1], axis[2]);
  const ax = axis[0] / axisLength,
    ay = axis[1] / axisLength,
    az = axis[2] / axisLength;
  const along = hinge[0] * ax + hinge[1] * ay + hinge[2] * az;
  const hx = hinge[0] - ax * along,
    hy = hinge[1] - ay * along,
    hz = hinge[2] - az * along;
  const hingeLength = length3(hx, hy, hz);
  // The negated form also catches a NaN length from a zero axis.
  if (!(axisLength > 0) || !(hingeLength > 1e-9 * length3(hinge[0], hinge[1], hinge[2])))
    throw rangeError('A link hull axis and hinge must be non-zero and not parallel', 'kinematics');
  const nx = hx / hingeLength,
    ny = hy / hingeLength,
    nz = hz / hingeLength;
  return {
    hull,
    basis: new Float64Array([
      ax,
      ay,
      az,
      nx,
      ny,
      nz,
      ay * nz - az * ny,
      az * nx - ax * nz,
      ax * ny - ay * nx,
      origin[0],
      origin[1],
      origin[2],
    ]),
  };
}

/**
 * One stateful solver per chain. Volumes and all coordinates share one coordinate frame.
 * Results and their buffers are reused; copy them if retaining a previous result.
 *
 * Success certifies static proxy clearance at the evaluated instant, within tolerance.
 * It does not certify swept-volume clearance between frames, arbitrary joint limits,
 * physical robot safety, or clearance of geometry outside the supplied proxies.
 */
export class AvoidanceSolver {
  private readonly volumes: ConstraintVolume[];
  readonly minClearance: number;
  readonly complianceMargin: number;
  readonly targetRadius: number;
  readonly damping: number;
  readonly maxIterations: number;
  readonly tolerance: number;
  readonly rootExclusion: number;
  private readonly upperArmRadius: number | null | undefined;
  private readonly upperHull: LinkHull | null;
  private readonly forearmHull: LinkHull | null;
  private readonly linkMatrix = new Float64Array(16);
  private readonly linkFrame = new Float64Array(3);
  private readonly measured = new Float64Array(1);
  private readonly surface = new Float64Array(3);
  private readonly normal = new Float64Array(3);
  private readonly distance = new Float64Array(1);
  private readonly poseDistance = new Float64Array(1);
  // Reach [minimum, maximum], then swivel span. Keep computed doubles off
  // the numeric argument boundaries into project/search.
  private readonly solveInputs = new Float64Array(3);
  // Retain the numeric argument already passed to the IK callback. Generic
  // slots initialized with undefined preserve its tagged value, so reusing an
  // accepted angle next frame does not box a fresh copy from Float64 storage.
  private readonly poleArguments: {
    accepted: number | undefined;
    center: number | undefined;
    candidate: number | undefined;
    best: number | undefined;
    bounded: number | undefined;
  } = { accepted: undefined, center: undefined, candidate: undefined, best: undefined, bounded: undefined };
  private readonly segmentResult: SegmentDistanceResult = {
    pointA: new Float64Array(3),
    pointB: new Float64Array(3),
    distance: 0,
    parameterA: 0,
    parameterB: 0,
  };
  private readonly point = new Float64Array(3);
  private readonly previousTarget = new Float32Array(3);
  private readonly candidate = new Float32Array(3);
  private readonly callbackRoot = new Float64Array(3);
  private readonly callbackTarget = new Float32Array(3);
  private readonly bestElbow = new Float32Array(3);
  private readonly boundedElbow = new Float32Array(3);
  private readonly trim = new Float64Array(3);
  private readonly root = new Float64Array(3);
  private readonly hand = new Float64Array(3);
  private readonly raw = new Float64Array(3);
  private readonly target = new Float32Array(3);
  private readonly outputTarget = new Float32Array(3);
  private hasTarget = false;
  private hasPole = false;
  private previousPole = 0;
  private busy = false;
  private targetClearance = Infinity;
  private targetIterations = 0;
  private singular = false;
  private bestAngle = 0;
  private bestClearance = -Infinity;
  private searchIterations = 0;
  private rotationX = 0;
  private rotationY = 0;
  private rotationZ = 0;
  private radialX = 0;
  private radialY = 0;
  private radialZ = 0;
  private crossX = 0;
  private crossY = 0;
  private crossZ = 0;
  private readonly poleResult: PoleClearanceResult = {
    resolved: false,
    elbow: new Float32Array(3),
    pole: new Float32Array(3),
    poleAngleOffset: 0,
    clearance: -Infinity,
    iterations: 0,
  };
  readonly targetResult: TargetResult = {
    resolved: false,
    clearance: -Infinity,
    maxPenetration: Infinity,
    iterations: 0,
  };
  private readonly result: SolveResult = {
    status: SolveStatus.ObstacleOccluded,
    resolved: false,
    targetResolved: false,
    target: this.outputTarget,
    elbow: new Float32Array(3),
    poleAngle: 0,
    poleAngleOffset: 0,
    clearance: -Infinity,
    maxPenetration: Infinity,
    iterations: 0,
  };

  constructor(volumes?: readonly ConstraintVolume[], options?: AvoidanceSolverOptions);
  constructor(options?: AvoidanceSolverOptions);
  constructor(
    volumesOrOptions: readonly ConstraintVolume[] | AvoidanceSolverOptions = [],
    options: AvoidanceSolverOptions = {},
  ) {
    const settings = Array.isArray(volumesOrOptions) ? options : (volumesOrOptions as AvoidanceSolverOptions);
    this.volumes = Array.from(Array.isArray(volumesOrOptions) ? volumesOrOptions : (settings.colliders ?? []));
    this.minClearance = settings.minClearance ?? 0.025;
    this.complianceMargin = settings.complianceMargin ?? 0.08;
    this.targetRadius = settings.targetRadius ?? 0;
    this.damping = settings.damping ?? 0;
    this.maxIterations = settings.maxIterations ?? 32;
    this.tolerance = settings.tolerance ?? 1e-6;
    this.rootExclusion = settings.rootExclusion ?? 0;
    this.upperArmRadius = settings.upperArmRadius;
    validateNonNegative(this.minClearance, 'minClearance');
    validateNonNegative(this.complianceMargin, 'complianceMargin');
    validateNonNegative(this.targetRadius, 'targetRadius');
    validateNonNegative(this.damping, 'damping');
    validateNonNegative(this.rootExclusion, 'rootExclusion');
    validatePositive(this.tolerance, 'tolerance');
    if (this.upperArmRadius !== undefined && this.upperArmRadius !== null)
      validateNonNegative(this.upperArmRadius, 'upperArmRadius');
    count(this.maxIterations, 256, 'maxIterations must be 1..256');
    if (this.maxIterations === 0) throw new RangeError('maxIterations must be 1..256');
    this.upperHull = linkHull(settings.links?.[0]);
    this.forearmHull = linkHull(settings.links?.[1]);
    if (this.upperHull && (settings.upperArmRadius !== undefined || this.rootExclusion > 0))
      throw typeError(
        'An upper link hull replaces upperArmRadius and rootExclusion; pass one or the other',
        'kinematics',
      );
    for (let i = 0; i < this.volumes.length; i++) this.checkVolume(this.volumes[i]);
  }

  private checkVolume(volume: ConstraintVolume): void {
    if (!volume || typeof volume.evaluate !== 'function' || typeof volume.segmentClearance !== 'function') {
      throw new TypeError('Volumes require evaluate and exact segmentClearance methods');
    }
    if (!this.upperHull && !this.forearmHull) return;
    if (typeof volume.hullClearanceInto !== 'function')
      throw typeError('A collider of a solver with link hulls needs a hullClearanceInto method', 'kinematics');
    if (volume === (this.upperHull?.hull as unknown) || volume === (this.forearmHull?.hull as unknown))
      throw typeError('A link hull cannot also be a collider; pass a separate ConvexHullVolume', 'kinematics');
  }

  addVolume(volume: ConstraintVolume): void {
    if (this.busy)
      throw margoError('state', 'Solver is not reentrant; do not call the solver from inside its own callback');
    this.checkVolume(volume);
    this.volumes.push(volume);
  }

  /** Clear both target and swivel history after a teleport or change of pole convention. */
  reset(): void {
    if (this.busy)
      throw margoError('state', 'Solver is not reentrant; do not call the solver from inside its own callback');
    this.hasTarget = this.hasPole = false;
    this.previousPole = 0;
    this.poleArguments.accepted = undefined;
  }

  private enter(): void {
    if (this.busy)
      throw margoError('state', 'Solver is not reentrant; do not call the solver from inside its own callback');
    this.busy = true;
  }

  private copyInput(value: Vec3View, output: Float64Array): void {
    validateVector(value);
    readVector(value, output, 0);
    // Past this size Math.fround gives Infinity; compared directly because that call boxes on some V8 tiers.
    const limit = 3.4028235677973366e38;
    if (
      !(output[0] < limit && output[0] > -limit) ||
      !(output[1] < limit && output[1] > -limit) ||
      !(output[2] < limit && output[2] > -limit)
    )
      throw new RangeError('Position exceeds Float32 output range; move the target closer to the origin');
  }

  private evaluateInto(volume: ConstraintVolume, point: Vec3View): void {
    this.distance[0] = NaN;
    evaluateVolumeInto(volume, point, this.surface, this.normal, this.distance);
    if (!Number.isFinite(this.distance[0]))
      throw new RangeError('Non-finite volume distance; check the collider for NaN or infinite values');
    validateVector(this.surface);
    validateVector(this.normal);
    // Inline, as below: a double returned by a call V8 did not inline is boxed, once per proxy per candidate.
    const nx = this.normal[0],
      ny = this.normal[1],
      nz = this.normal[2];
    if (Math.abs(Math.sqrt(nx * nx + ny * ny + nz * nz) - 1) > 1e-6)
      throw new RangeError('Volume normal must be unit length');
  }

  /** The point's clearance from every volume, into `targetClearance`. */
  private updateTargetClearance(point: Vec3View): void {
    let clearance = Infinity;
    for (let i = 0; i < this.volumes.length; i++) {
      this.evaluateInto(this.volumes[i], point);
      const gap = this.distance[0] - this.minClearance - this.targetRadius;
      if (gap < clearance) clearance = gap;
    }
    this.targetClearance = clearance;
  }

  /** The distance from `from` (root or elbow) to `to`, into `measured`. */
  private measure(from: Vec3View, to: Vec3View): void {
    const x = from[0] - to[0],
      y = from[1] - to[1],
      z = from[2] - to[2],
      squared = x * x + y * y + z * z;
    // Two stores, not a conditional: a value merged from a call's result is boxed.
    if (squared >= 1e-300 && squared < Infinity) this.measured[0] = Math.sqrt(squared);
    else this.measured[0] = scaledLength3(x, y, z);
  }

  private clampReach(): void {
    const minimum = this.solveInputs[0],
      maximum = this.solveInputs[1];
    let x = this.point[0] - this.root[0],
      y = this.point[1] - this.root[1],
      z = this.point[2] - this.root[2];
    const atRoot = x === 0 && y === 0 && z === 0;
    if (atRoot) {
      x = this.hand[0] - this.root[0];
      y = this.hand[1] - this.root[1];
      z = this.hand[2] - this.root[2];
      if (x === 0 && y === 0 && z === 0) {
        x = 1;
        y = z = 0;
      }
    }
    // Keep the norm at this call site, including length3's exact scaling order.
    // The selected direction is nonzero, even for a coincident root and hand.
    const squared = x * x + y * y + z * z;
    let directionLength: number;
    if (squared >= 1e-300 && squared < Infinity) directionLength = Math.sqrt(squared);
    else {
      const scale = Math.max(Math.abs(x), Math.abs(y), Math.abs(z));
      const sx = x / scale,
        sy = y / scale,
        sz = z / scale;
      directionLength = scale * Math.sqrt(sx * sx + sy * sy + sz * sz);
    }
    const distance = atRoot ? 0 : directionLength;
    if (distance >= minimum && distance <= maximum) return;
    this.singular = true;
    // Move into the band far enough to survive conversion to Float32 storage.
    const magnitude = Math.max(maximum, Math.abs(this.root[0]), Math.abs(this.root[1]), Math.abs(this.root[2]));
    const inset = Math.min((maximum - minimum) * 0.25, magnitude * 2 ** -22);
    const reach = distance < minimum ? minimum + inset : maximum - inset;
    this.point[0] = this.root[0] + (x / directionLength) * reach;
    this.point[1] = this.root[1] + (y / directionLength) * reach;
    this.point[2] = this.root[2] + (z / directionLength) * reach;
  }

  private project(current: Vec3View, dt: number, boundedReach: boolean): void {
    const minimum = this.solveInputs[0],
      maximum = this.solveInputs[1];
    const alpha = this.damping === 0 ? 1 : -Math.expm1(-dt / this.damping);
    for (let a = 0; a < 3; a++) {
      this.point[a] =
        alpha === 1
          ? this.raw[a]
          : alpha > 0.5
            ? this.raw[a] + (current[a] - this.raw[a]) * (1 - alpha)
            : current[a] + (this.raw[a] - current[a]) * alpha;
    }
    // Normal compliance only. Adding the full tangential displacement again would double it.
    for (let i = 0; i < this.volumes.length; i++) {
      this.evaluateInto(this.volumes[i], this.point);
      const distance = this.distance[0] - this.targetRadius - this.minClearance;
      if (distance < this.complianceMargin) {
        const shell = this.targetRadius + this.minClearance + Math.sqrt(this.complianceMargin * Math.max(0, distance));
        for (let a = 0; a < 3; a++) this.point[a] = this.surface[a] + this.normal[a] * shell;
      }
    }
    this.targetIterations = 0;
    for (let iteration = 0; iteration < this.maxIterations; iteration++) {
      for (let i = 0; i < this.volumes.length; i++) {
        this.evaluateInto(this.volumes[i], this.point);
        const distance = this.distance[0] - this.targetRadius - this.minClearance;
        if (distance < 0) {
          const shell = this.targetRadius + this.minClearance + this.tolerance * 0.25;
          for (let a = 0; a < 3; a++) this.point[a] = this.surface[a] + this.normal[a] * shell;
        }
      }
      if (boundedReach) this.clampReach();
      for (let a = 0; a < 3; a++) this.target[a] = this.point[a];
      validateVector(this.target);
      this.updateTargetClearance(this.target);
      this.targetIterations = iteration + 1;
      this.measure(this.target, this.root);
      const reach = this.measured[0];
      if (this.targetClearance >= -this.tolerance && (!boundedReach || (reach >= minimum && reach <= maximum))) break;
      // Include output rounding in the next projection pass.
      for (let a = 0; a < 3; a++) this.point[a] = this.target[a];
    }
    const state = this.targetResult;
    state.clearance = this.targetClearance;
    state.resolved = this.targetClearance >= -this.tolerance;
    if (boundedReach) {
      this.measure(this.target, this.root);
      const reach = this.measured[0];
      state.resolved &&= reach >= minimum && reach <= maximum;
    }
    state.maxPenetration = Math.max(0, -state.clearance);
    state.iterations = this.targetIterations;
  }

  /** Target-only projection; it does not check reach, links, or motion between frames. */
  resolveTarget(rawTarget: Vec3View, dt: number): Float32Array {
    this.enter();
    this.targetResult.resolved = false;
    try {
      validatePositive(dt, 'dt');
      this.copyInput(rawTarget, this.raw);
      this.project(this.hasTarget ? this.previousTarget : this.raw, dt, false);
      if (this.targetResult.resolved) {
        this.previousTarget.set(this.target);
        this.hasTarget = true;
      }
      this.outputTarget.set(this.target);
      return this.outputTarget;
    } finally {
      this.busy = false;
    }
  }

  private segmentInto(volume: ConstraintVolume, start: Vec3View, end: Vec3View, radius: number): void {
    this.distance[0] = NaN;
    segmentVolumeInto(volume, start, end, radius, this.distance, this.segmentResult);
  }

  /**
   * The bend-plane normal for this pose goes to `linkFrame`. A straight chain has none, and the search never accepts
   * one (the reach margin keeps it out), so any axis across the chain serves; this one is repeatable.
   */
  private bendNormal(root: Vec3View, elbow: Vec3View, end: Vec3View): void {
    const ux = elbow[0] - root[0],
      uy = elbow[1] - root[1],
      uz = elbow[2] - root[2],
      vx = end[0] - elbow[0],
      vy = end[1] - elbow[1],
      vz = end[2] - elbow[2];
    let nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx;
    let squared = nx * nx + ny * ny + nz * nz;
    if (squared < 1e-300) {
      const small = Math.abs(ux) <= Math.abs(uy) && Math.abs(ux) <= Math.abs(uz);
      nx = small ? 0 : -uz;
      ny = small ? -uz : 0;
      nz = small ? uy : ux;
      squared = nx * nx + ny * ny + nz * nz;
      if (squared < 1e-300) {
        nx = 1;
        ny = nz = 0;
        squared = 1;
      }
    }
    const length = Math.sqrt(squared);
    this.linkFrame[0] = nx / length;
    this.linkFrame[1] = ny / length;
    this.linkFrame[2] = nz / length;
  }

  /** Moves a link hull onto segment start-end and writes the worst gap to the colliders into `distance`. */
  private linkGapInto(link: LinkHull, start: Vec3View, end: Vec3View): void {
    const x = end[0] - start[0],
      y = end[1] - start[1],
      z = end[2] - start[2];
    this.measure(end, start);
    const length = this.measured[0];
    const ax = length > 0 ? x / length : 1,
      ay = length > 0 ? y / length : 0,
      az = length > 0 ? z / length : 0;
    // The normal is square to both links of a two-bone chain, so the frame below is a pure rotation.
    const hx = this.linkFrame[0],
      hy = this.linkFrame[1],
      hz = this.linkFrame[2];
    const cx = ay * hz - az * hy,
      cy = az * hx - ax * hz,
      cz = ax * hy - ay * hx;
    const b = link.basis,
      m = this.linkMatrix;
    // World frame times the transposed local frame: each local axis lands on its world axis.
    for (let column = 0; column < 3; column++) {
      const p = b[column],
        q = b[column + 3],
        r = b[column + 6];
      m[column * 4] = ax * p + hx * q + cx * r;
      m[column * 4 + 1] = ay * p + hy * q + cy * r;
      m[column * 4 + 2] = az * p + hz * q + cz * r;
    }
    m[12] = start[0] - (m[0] * b[9] + m[4] * b[10] + m[8] * b[11]);
    m[13] = start[1] - (m[1] * b[9] + m[5] * b[10] + m[9] * b[11]);
    m[14] = start[2] - (m[2] * b[9] + m[6] * b[10] + m[10] * b[11]);
    m[15] = 1;
    link.hull.setTransform(m);
  }

  private poseClearanceInto(
    root: Vec3View,
    elbow: Vec3View,
    end: Vec3View,
    elbowRadius: number,
    forearmRadius: number,
    upperLength: number,
  ): void {
    let clearance = Infinity;
    const upperHull = this.upperHull,
      forearmHull = this.forearmHull;
    const upperRadius = upperHull ? 0 : this.upperArmRadius === undefined ? elbowRadius : this.upperArmRadius;
    const fraction = Math.min(1, this.rootExclusion / upperLength);
    for (let a = 0; a < 3; a++) this.trim[a] = root[a] + (elbow[a] - root[a]) * fraction;
    if (upperHull || forearmHull) this.bendNormal(root, elbow, end);
    if (upperHull) this.linkGapInto(upperHull, root, elbow);
    if (forearmHull) this.linkGapInto(forearmHull, elbow, end);
    for (let i = 0; i < this.volumes.length; i++) {
      const volume = this.volumes[i];
      this.evaluateInto(volume, elbow);
      const elbowGap = this.distance[0] - elbowRadius;
      if (forearmHull) volume.hullClearanceInto!(forearmHull.hull, this.distance);
      else this.segmentInto(volume, elbow, end, forearmRadius);
      const lowerGap = this.distance[0];
      let upperGap = Infinity;
      if (upperHull) {
        volume.hullClearanceInto!(upperHull.hull, this.distance);
        upperGap = this.distance[0];
      } else if (upperRadius !== null) {
        this.segmentInto(volume, this.trim, elbow, upperRadius);
        upperGap = this.distance[0];
      }
      if (!Number.isFinite(lowerGap) || (upperRadius !== null && !Number.isFinite(upperGap)))
        throw new RangeError('Non-finite segment clearance; check the collider for NaN or infinite values');
      clearance = Math.min(
        clearance,
        elbowGap - this.minClearance,
        lowerGap - this.minClearance,
        upperGap - this.minClearance,
      );
    }
    this.poseDistance[0] = clearance;
  }

  private testPoseInto(
    angle: number,
    upper: number,
    lower: number,
    radius: number,
    forearmRadius: number,
    evaluate: ElbowEvaluator,
  ): void {
    this.poleArguments.candidate = angle;
    this.candidate.fill(NaN);
    this.callbackRoot.set(this.root);
    this.callbackTarget.set(this.target);
    evaluate(this.callbackRoot, this.callbackTarget, angle, this.candidate);
    validateVector(this.candidate, 'IK elbow');
    // Validate the callback rather than silently certifying an arbitrary elbow location.
    this.measure(this.candidate, this.root);
    const upperActual = this.measured[0];
    this.measure(this.candidate, this.target);
    const lowerActual = this.measured[0];
    const lengthTolerance = Math.min(this.tolerance * 4, Math.min(upper, lower) * 1e-5);
    this.poseDistance[0] = -Infinity;
    if (Math.abs(upperActual - upper) > lengthTolerance || Math.abs(lowerActual - lower) > lengthTolerance) return;
    this.poseClearanceInto(this.root, this.candidate, this.target, radius, forearmRadius, upper);
  }

  private search(
    budget: number,
    upper: number,
    lower: number,
    radius: number,
    forearmRadius: number,
    evaluate: ElbowEvaluator,
  ): void {
    const center = this.poleArguments.center!,
      span = this.solveInputs[2];
    this.bestAngle = center;
    this.testPoseInto(center, upper, lower, radius, forearmRadius, evaluate);
    this.bestClearance = this.poseDistance[0];
    this.poleArguments.best = this.poleArguments.candidate;
    this.bestElbow.set(this.candidate);
    this.searchIterations = 1;
    if (this.bestClearance >= -this.tolerance) return;
    const bands = Math.ceil(budget / 2);
    for (let i = 1; i <= budget; i++) {
      const angle = center + (((i % 2 === 1 ? 1 : -1) * Math.ceil(i / 2)) / bands) * span;
      // Zero or sub-ULP spans can produce the same angle repeatedly. Reuse its
      // existing primitive without skipping observable callback evaluations.
      // Distinguish signed zero, and still pass a number for every new angle.
      const previousArgument = this.poleArguments.candidate!;
      const repeated = angle === previousArgument && (angle !== 0 || 1 / angle === 1 / previousArgument);
      this.testPoseInto(repeated ? previousArgument : angle, upper, lower, radius, forearmRadius, evaluate);
      const clearance = this.poseDistance[0];
      this.searchIterations++;
      if (clearance > this.bestClearance) {
        this.bestClearance = clearance;
        this.bestAngle = angle;
        this.bestElbow.set(this.candidate);
        this.poleArguments.best = this.poleArguments.candidate;
      }
      // Samples progress in angular distance from the previous successful pole.
      if (clearance >= -this.tolerance) return;
    }
  }

  /**
   * dt is caller supplied in seconds and must be positive. The callback must use a
   * stable pole-angle convention across calls and write a valid two-bone elbow.
   * No callback should commit transforms; commit only a successful returned pose.
   *
   * Success describes this discrete endpoint pose, not a continuous trajectory.
   */
  solve(
    rootPos: Vec3View,
    currentHandPos: Vec3View,
    rawTarget: Vec3View,
    upperArmLen: number,
    forearmLen: number,
    elbowRadius: number,
    forearmRadius: number,
    dt: number,
    evaluateElbowIK: ElbowEvaluator,
    options: SolveOptions = EMPTY_SOLVE_OPTIONS,
  ): SolveResult {
    this.enter();
    const result = this.result;
    result.resolved = result.targetResolved = false;
    result.status = SolveStatus.ObstacleOccluded;
    try {
      this.copyInput(rootPos, this.root);
      this.copyInput(currentHandPos, this.hand);
      this.copyInput(rawTarget, this.raw);
      validatePositive(upperArmLen, 'upperArmLen');
      validatePositive(forearmLen, 'forearmLen');
      validateNonNegative(elbowRadius, 'elbowRadius');
      validateNonNegative(forearmRadius, 'forearmRadius');
      validatePositive(dt, 'dt');
      if (typeof evaluateElbowIK !== 'function')
        throw new TypeError(
          'An elbow evaluator is required; pass an evaluator to the constructor or use the two-bone solver',
        );
      const speed = options.swivelSpeedLimit ?? Math.PI * 2;
      const fold = options.foldMargin ?? 1e-5,
        reach = options.reachMargin ?? 1e-5;
      const budget = options.searchBudget ?? 32;
      validateNonNegative(speed, 'swivelSpeedLimit');
      validatePositive(fold, 'foldMargin');
      validatePositive(reach, 'reachMargin');
      count(budget, 256, 'searchBudget must be 0..256');
      const minimum = Math.abs(upperArmLen - forearmLen) + fold,
        maximum = upperArmLen + forearmLen - reach;
      if (minimum >= maximum || !Number.isFinite(Math.fround(maximum)))
        throw new RangeError('Singularity margins leave no operational reach; lower reachMargin or foldMargin');
      this.singular = false;
      this.measure(this.raw, this.root);
      const rawDistance = this.measured[0];
      if (rawDistance < minimum || rawDistance > maximum) this.singular = true;
      this.solveInputs[0] = minimum;
      this.solveInputs[1] = maximum;
      this.project(this.hand, dt, true);
      const center = this.hasPole ? this.previousPole : 0;
      const span = this.hasPole ? Math.min(Math.PI, speed * dt) : Math.PI;
      this.poleArguments.center = this.hasPole ? this.poleArguments.accepted : 0;
      this.solveInputs[2] = span;
      this.search(budget, upperArmLen, forearmLen, elbowRadius, forearmRadius, evaluateElbowIK);
      this.boundedElbow.set(this.bestElbow);
      this.poleArguments.bounded = this.poleArguments.best;
      let boundedAngle = this.bestAngle;
      let boundedLengthValid = this.bestClearance !== -Infinity;
      let iterations = this.targetIterations + this.searchIterations;
      let status = SolveStatus.ObstacleOccluded;
      this.updateTargetClearance(this.target);
      this.measure(this.target, this.root);
      const targetReach = this.measured[0];
      const targetValid = this.targetClearance >= -this.tolerance && targetReach >= minimum && targetReach <= maximum;
      if (targetValid && this.bestClearance >= -this.tolerance) {
        status = this.singular ? SolveStatus.SingularDeadZone : SolveStatus.Success;
      } else if (targetValid && this.hasPole && span < Math.PI) {
        // Diagnostic search only. Never return or remember an out-of-rate candidate.
        this.solveInputs[2] = Math.PI;
        this.search(budget, upperArmLen, forearmLen, elbowRadius, forearmRadius, evaluateElbowIK);
        iterations += this.searchIterations;
        if (this.bestClearance >= -this.tolerance) {
          if (Math.abs(this.bestAngle - center) <= span) {
            // The wider grid can hit a narrow clear arc missed by the local grid.
            boundedAngle = this.bestAngle;
            boundedLengthValid = true;
            this.boundedElbow.set(this.bestElbow);
            this.poleArguments.bounded = this.poleArguments.best;
            status = this.singular ? SolveStatus.SingularDeadZone : SolveStatus.Success;
          } else status = SolveStatus.SwivelRateLimitExceeded;
        }
      }
      // Recheck after all user callbacks. They may update a moving obstacle or
      // retain and write earlier public results while evaluating a candidate.
      this.updateTargetClearance(this.target);
      this.poseDistance[0] = -Infinity;
      if (boundedLengthValid)
        this.poseClearanceInto(this.root, this.boundedElbow, this.target, elbowRadius, forearmRadius, upperArmLen);
      const finalGap = this.poseDistance[0];
      result.targetResolved =
        this.targetClearance >= -this.tolerance && targetReach >= minimum && targetReach <= maximum;
      if (!result.targetResolved || finalGap < -this.tolerance) {
        if (status === SolveStatus.Success || status === SolveStatus.SingularDeadZone)
          status = SolveStatus.ObstacleOccluded;
      }
      if (status === SolveStatus.Success && this.hasPole && Math.abs(boundedAngle - this.previousPole) > speed * dt) {
        status = SolveStatus.SwivelRateLimitExceeded;
      }
      result.target.set(this.target);
      result.elbow.set(this.boundedElbow);
      result.poleAngle = result.poleAngleOffset = boundedAngle;
      result.iterations = iterations;
      result.clearance = Math.min(this.targetClearance, finalGap);
      result.maxPenetration = Math.max(0, -result.clearance);
      result.status = status;
      result.resolved = result.status === SolveStatus.Success;
      if (result.resolved) {
        this.previousPole = result.poleAngle;
        this.hasPole = true;
        this.poleArguments.accepted = this.poleArguments.bounded;
        this.previousTarget.set(result.target);
        this.hasTarget = true;
      }
      return result;
    } finally {
      this.busy = false;
    }
  }

  private readonly rotateElbow: ElbowEvaluator = (_root, _target, angle, out) => {
    const cosine = Math.cos(angle),
      sine = Math.sin(angle);
    out[0] = this.rotationX + this.radialX * cosine + this.crossX * sine;
    out[1] = this.rotationY + this.radialY * cosine + this.crossY * sine;
    out[2] = this.rotationZ + this.radialZ * cosine + this.crossZ * sine;
  };

  /** Geometric swivel of an already solved pose; this helper does not apply temporal limits. */
  calculatePoleClearance(root: Vec3View, elbow: Vec3View, end: Vec3View, radius: number): PoleClearanceResult {
    this.enter();
    const result = this.poleResult;
    result.resolved = false;
    try {
      this.copyInput(root, this.root);
      this.copyInput(end, this.hand);
      this.copyInput(elbow, this.raw);
      validateNonNegative(radius, 'radius');
      this.target.set(this.hand);
      const upper = length3(this.raw[0] - this.root[0], this.raw[1] - this.root[1], this.raw[2] - this.root[2]);
      const lower = length3(this.raw[0] - this.hand[0], this.raw[1] - this.hand[1], this.raw[2] - this.hand[2]);
      validatePositive(upper, 'upper length');
      validatePositive(lower, 'lower length');
      let x = this.hand[0] - this.root[0],
        y = this.hand[1] - this.root[1],
        z = this.hand[2] - this.root[2];
      let length = length3(x, y, z);
      if (length === 0) {
        // A fully folded chain has a sphere of solutions. Search one deterministic great circle.
        const px = this.raw[0] - this.root[0],
          py = this.raw[1] - this.root[1],
          pz = this.raw[2] - this.root[2];
        if (Math.abs(px) < Math.abs(py)) {
          x = 0;
          y = -pz;
          z = py;
        } else {
          x = -pz;
          y = 0;
          z = px;
        }
        length = length3(x, y, z);
        if (length === 0) {
          x = 0;
          y = 1;
          z = 0;
          length = 1;
        }
      }
      x /= length;
      y /= length;
      z /= length;
      const px = this.raw[0] - this.root[0],
        py = this.raw[1] - this.root[1],
        pz = this.raw[2] - this.root[2];
      const along = px * x + py * y + pz * z;
      this.rotationX = this.root[0] + along * x;
      this.rotationY = this.root[1] + along * y;
      this.rotationZ = this.root[2] + along * z;
      this.radialX = px - along * x;
      this.radialY = py - along * y;
      this.radialZ = pz - along * z;
      this.crossX = y * this.radialZ - z * this.radialY;
      this.crossY = z * this.radialX - x * this.radialZ;
      this.crossZ = x * this.radialY - y * this.radialX;
      this.poleArguments.center = 0;
      this.solveInputs[2] = Math.PI;
      this.search(64, upper, lower, radius, radius, this.rotateElbow);
      result.elbow.set(this.bestElbow);
      result.pole.set(this.bestElbow);
      result.poleAngleOffset = this.bestAngle;
      result.clearance = this.bestClearance;
      result.iterations = this.searchIterations;
      result.resolved = this.bestClearance >= -this.tolerance;
      return result;
    } finally {
      this.busy = false;
    }
  }
}
