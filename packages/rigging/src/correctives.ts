// Corrective shapes: blend shapes driven by joint rotation, to fix what linear skinning does to elbows, knees and
// shoulders. A hinge joint reads a single pose: the joint's rotation from rest is taken as a rotation vector and
// measured along the vector of the pose where the shape is full, and across it for a cone of influence. A joint that
// swings every way, a shoulder, reads pose-space deformation (J. P. Lewis, M. Cordner and N. Fong, SIGGRAPH 2000):
// sculpted poses with their shape weights are interpolated by Gaussian radial basis functions of the angle between
// rotations, solved so each sample gives exactly its own weights.
import { multiplyQuaternions, normalizeQuaternion } from '@margoengine/math/quat';
import type { Animator } from '@margoengine/animator';

/** A morph target of a model: glTF node with the mesh, and target index. */
export interface ShapeTarget {
  /** glTF node index of the mesh. */
  node: number;
  /** Morph target index. */
  target: number;
}

/** A shape driven by one joint's rotation toward one pose: elbows and knees. */
export interface CorrectiveShape extends ShapeTarget {
  /** The driving bone (glTF node index with {@link addCorrectives}). */
  joint: number;
  /** The joint's local rotation at which the shape is full, quaternion xyzw. */
  pose: readonly number[];
  /** The joint's local rotation at which the shape is off. Default its rest rotation, or identity with no rig. */
  rest?: readonly number[];
  /**
   * How far from the line from `rest` to `pose` the joint can go, radians, before the shape fades out. Default none:
   * only the bend along that line counts, so a hinge's twist does nothing.
   */
  cone?: number | null;
  /** Reading at which the shape starts, 0 to below 1 (default 0): 0.5 keeps it off for the first half of the bend. */
  start?: number;
  /** `smooth` eases in and out, `linear` follows the angle (default). */
  curve?: 'linear' | 'smooth';
  /** Weight at full bend, 0 to 1 (default 1). */
  amount?: number;
}

/** A pose of a {@link PoseSpace}. */
export interface PoseSample {
  /** The joint's local rotation, quaternion xyzw. */
  rotation: readonly number[];
  /** Weight of each of the space's `shapes`, by position, at this pose. */
  weights: readonly number[];
}

/** Several shapes driven together by a joint that swings every way: shoulders and hips. */
export interface PoseSpace {
  /** The driving bone. */
  joint: number;
  /** The shapes the samples mix. */
  shapes: readonly ShapeTarget[];
  /** Sculpted poses, 1 to 64. Include the rest pose with zero weights, or the shapes hold outside the samples. */
  samples: readonly PoseSample[];
  /** Gaussian width, radians. Default the mean angle from each sample to its nearest neighbour. */
  width?: number;
}

/** What {@link Correctives} drives. */
export interface CorrectivesOptions {
  shapes?: readonly CorrectiveShape[];
  spaces?: readonly PoseSpace[];
}

/** One morph weight. */
export interface ShapeWeight extends ShapeTarget {
  weight: number;
}

const IDENTITY = [0, 0, 0, 1];
const conjugate = (q: ArrayLike<number>): number[] => [-q[0], -q[1], -q[2], q[3]];

function quaternion(value: unknown, label: string): void {
  const q = value as ArrayLike<number> | undefined;
  if (!q || q.length !== 4) throw new RangeError(`${label} must be a quaternion: four numbers, x y z w`);
  for (let i = 0; i < 4; i++) if (!Number.isFinite(q[i])) throw new RangeError(`${label} must be finite`);
  if (!(Math.hypot(q[0], q[1], q[2], q[3]) > 0)) throw new RangeError(`${label} must not be all zeros`);
}

/** The rotation vector of a quaternion: axis times angle, angle up to half a turn. */
function rotationVector(q: readonly number[]): [number, number, number] {
  const sign = q[3] < 0 ? -1 : 1,
    s = Math.hypot(q[0], q[1], q[2]),
    angle = 2 * Math.atan2(s, q[3] * sign);
  if (s < 1e-12) return [0, 0, 0];
  const k = (sign * angle) / s;
  return [q[0] * k, q[1] * k, q[2] * k];
}

/** Angle between two rotations, 0 to half a turn. */
const between = (a: readonly number[], b: readonly number[]): number =>
  2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3])));

/** Solves `matrix * x = rhs` in place by Gaussian elimination with partial pivoting; `rhs` holds `columns` per row. */
function solve(matrix: Float64Array, rhs: Float64Array, n: number, columns: number): void {
  for (let k = 0; k < n; k++) {
    let pivot = k;
    for (let r = k + 1; r < n; r++) if (Math.abs(matrix[r * n + k]) > Math.abs(matrix[pivot * n + k])) pivot = r;
    if (Math.abs(matrix[pivot * n + k]) < 1e-12)
      throw new RangeError('Pose samples repeat; give each sample a different rotation');
    if (pivot !== k) {
      for (let c = 0; c < n; c++) [matrix[k * n + c], matrix[pivot * n + c]] = [matrix[pivot * n + c], matrix[k * n + c]];
      for (let c = 0; c < columns; c++)
        [rhs[k * columns + c], rhs[pivot * columns + c]] = [rhs[pivot * columns + c], rhs[k * columns + c]];
    }
    for (let r = 0; r < n; r++) {
      if (r === k) continue;
      const f = matrix[r * n + k] / matrix[k * n + k];
      if (f === 0) continue;
      for (let c = k; c < n; c++) matrix[r * n + c] -= f * matrix[k * n + c];
      for (let c = 0; c < columns; c++) rhs[r * columns + c] -= f * rhs[k * columns + c];
    }
  }
  for (let r = 0; r < n; r++) for (let c = 0; c < columns; c++) rhs[r * columns + c] /= matrix[r * n + r];
}

/** A solved {@link PoseSpace}. */
interface SolvedSpace {
  readonly spec: PoseSpace;
  readonly rotations: number[][];
  readonly width: number;
  /** Basis coefficients, one row per sample, one column per shape. */
  readonly coefficients: Float64Array;
}

function solveSpace(spec: PoseSpace): SolvedSpace {
  const { samples, shapes } = spec,
    n = samples?.length,
    columns = shapes?.length;
  if (!Array.isArray(samples) || n < 1 || n > 64) throw new RangeError('A pose space needs 1 to 64 samples');
  if (!Array.isArray(shapes) || !columns) throw new RangeError('A pose space needs at least one shape');
  const rotations = samples.map((sample, i) => {
    quaternion(sample?.rotation, `Pose sample ${i} rotation`);
    if (sample.weights?.length !== columns || !sample.weights.every(Number.isFinite))
      throw new RangeError(`Pose sample ${i} needs one finite weight per shape`);
    return normalizeQuaternion([...sample.rotation]);
  });
  let width = spec.width;
  if (width === undefined) {
    let total = 0;
    rotations.forEach((a, i) => {
      let nearest = Infinity;
      rotations.forEach((b, j) => {
        if (i !== j) nearest = Math.min(nearest, between(a, b));
      });
      total += nearest === Infinity ? 1 : nearest;
    });
    width = total / n;
  }
  if (!(width > 0 && width < Infinity)) throw new RangeError('Pose space width must be above 0; separate the samples');
  const matrix = new Float64Array(n * n),
    coefficients = new Float64Array(n * columns);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) matrix[i * n + j] = Math.exp(-((between(rotations[i], rotations[j]) / width) ** 2));
    for (let c = 0; c < columns; c++) coefficients[i * columns + c] = samples[i].weights[c];
  }
  solve(matrix, coefficients, n, columns);
  return { spec, rotations, width, coefficients };
}

const clamp = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Shape weights from joint rotations, as plain data: no engine or GPU. {@link addCorrectives} runs it on a model.
 * Shapes are read every call, so settings change live; pose spaces are solved once, here.
 */
export class Correctives {
  private readonly spaces: SolvedSpace[];
  /**
   * @param options what to drive.
   * @throws RangeError for bad poses, samples or settings.
   */
  constructor(readonly options: CorrectivesOptions) {
    this.spaces = (options?.spaces ?? []).map(solveSpace);
    this.check();
  }

  private check(): void {
    for (const shape of this.options?.shapes ?? []) {
      quaternion(shape?.pose, 'Corrective pose');
      if (shape.rest !== undefined) quaternion(shape.rest, 'Corrective rest');
      const { cone = null, start = 0, curve = 'linear', amount = 1 } = shape;
      if (cone !== null && !(cone > 0 && cone < Infinity)) throw new RangeError('Corrective cone must be above 0');
      if (!(start >= 0 && start < 1)) throw new RangeError('Corrective start must be from 0 to below 1');
      if (curve !== 'linear' && curve !== 'smooth') throw new RangeError("Corrective curve must be 'linear' or 'smooth'");
      if (!(amount >= 0 && amount <= 1)) throw new RangeError('Corrective amount must be from 0 to 1');
    }
  }

  /** How far `rotation` has gone from `shape.rest` to `shape.pose`, with the shape's settings: the shape's weight. */
  private reading(shape: CorrectiveShape, rotation: readonly number[], rest: readonly number[]): number {
    const inverse = conjugate(shape.rest ?? rest),
      pose = rotationVector(normalizeQuaternion(multiplyQuaternions(inverse, shape.pose))),
      now = rotationVector(normalizeQuaternion(multiplyQuaternions(inverse, rotation))),
      length2 = pose[0] ** 2 + pose[1] ** 2 + pose[2] ** 2;
    if (!(length2 > 0)) throw new RangeError('A corrective pose must differ from its rest; turn the joint');
    const along = (now[0] * pose[0] + now[1] * pose[1] + now[2] * pose[2]) / length2,
      { start = 0, curve = 'linear', amount = 1, cone = null } = shape;
    let value = clamp((along - start) / (1 - start));
    if (curve === 'smooth') value = value * value * (3 - 2 * value);
    if (cone !== null) {
      const off = Math.hypot(
        now[0] - pose[0] * along,
        now[1] - pose[1] * along,
        now[2] - pose[2] * along,
      );
      const fade = clamp(1 - off / cone);
      value *= fade * fade * (3 - 2 * fade);
    }
    return value * amount;
  }

  /**
   * Every driven shape's weight. Shapes on one target add up, then clamp to 0 to 1.
   * @param rotationOf the current local rotation of a joint.
   * @param restOf a joint's rest rotation, for shapes with no `rest`. Default identity.
   */
  evaluate(
    rotationOf: (joint: number) => readonly number[],
    restOf: (joint: number) => readonly number[] = () => IDENTITY,
  ): ShapeWeight[] {
    this.check();
    const out = new Map<string, ShapeWeight>(),
      add = (shape: ShapeTarget, weight: number): void => {
        const key = `${shape.node}:${shape.target}`,
          entry = out.get(key) ?? { node: shape.node, target: shape.target, weight: 0 };
        out.set(key, entry);
        entry.weight += weight;
      };
    for (const shape of this.options.shapes ?? [])
      add(shape, this.reading(shape, rotationOf(shape.joint), restOf(shape.joint)));
    for (const { spec, rotations, width, coefficients } of this.spaces) {
      const now = normalizeQuaternion([...rotationOf(spec.joint)]),
        columns = spec.shapes.length,
        sums = new Float64Array(columns);
      rotations.forEach((rotation, i) => {
        const basis = Math.exp(-((between(now, rotation) / width) ** 2));
        for (let c = 0; c < columns; c++) sums[c] += basis * coefficients[i * columns + c];
      });
      spec.shapes.forEach((shape, c) => add(shape, sums[c]));
    }
    for (const entry of out.values()) entry.weight = clamp(entry.weight);
    return [...out.values()];
  }
}

/** A running {@link addCorrectives}. */
export interface CorrectivesHandle {
  readonly correctives: Correctives;
  /** Stops driving and sets the shapes to 0. */
  dispose(): void;
  [Symbol.dispose](): void;
}

/**
 * Drives corrective shapes on `animator` (`@margoengine/animator`), every frame after the pose and the solvers added
 * before it, so IK and foot placement count. Joints and mesh nodes are glTF node indices of the animator's model. A
 * driven morph target belongs to this: a clip's track on the same target is overwritten. Returns the handle.
 * @throws RangeError for bad settings or a target the model lacks.
 */
export function addCorrectives(animator: Animator, options: CorrectivesOptions): CorrectivesHandle {
  const correctives = new Correctives(options),
    animation = animator.animation,
    nodes = animation.model.nodes,
    t = animation.model.root.engine.store.transforms,
    rotationOf = (joint: number): number[] => {
      const node = nodes[joint];
      if (!node) throw new RangeError(`Corrective joint ${joint} is not a node of this model; pass a glTF node index`);
      const id = node.id;
      return [t.qx[id], t.qy[id], t.qz[id], t.qw[id]];
    },
    restOf = (joint: number): readonly number[] => animator.restRotation(joint);
  let targets = correctives.evaluate(rotationOf, restOf);
  for (const { node, target } of targets) animation.setMorph(node, target, 0);
  let remove: (() => void) | null = animator.addSolver(() => {
    targets = correctives.evaluate(rotationOf, restOf);
    for (const { node, target, weight } of targets) animation.setMorph(node, target, weight);
  });
  const stop = (): void => {
    remove?.();
    remove = null;
    unsubscribe?.();
    unsubscribe = null;
  };
  // A model disposed first takes the shapes with it: nothing is left to put back.
  let unsubscribe: (() => void) | null = animation.model.onDispose(stop);
  const dispose = (): void => {
    if (!remove) return;
    stop();
    for (const { node, target } of targets) animation.setMorph(node, target, 0);
  };
  return { correctives, dispose, [Symbol.dispose]: dispose };
}
