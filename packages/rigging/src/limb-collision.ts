import type { Vec3 } from '@margoengine/math';
import { cross, dot, length, normalize, scale, sub } from '@margoengine/math/vec3';
import { parentOrder, worldFrames } from './rig.js';

/** An anatomical landmark carried by a bone. */
export interface CollisionLandmark {
  /** Bone index in the skeleton. */
  readonly joint: number;
  /** Offset in the bone's local frame, default the joint origin. */
  readonly offset?: Vec3;
}

/** A capsule or sphere carried by the body of a human or animal. */
export interface BodyCollisionVolume {
  /** First landmark of the body volume, typically on the chest, pelvis, head or another limb. */
  readonly start: CollisionLandmark;
  /** Second landmark. Omit for a sphere. */
  readonly end?: CollisionLandmark;
  /** Radius in skeleton space. Use multiple overlapping volumes for a tapered silhouette. */
  readonly radius: number;
}

/** A capsule around one limb link. Its slots index the packed candidate positions, not the skeleton. */
export interface LimbCollisionLink {
  /** First joint slot, starting from zero. */
  readonly start: number;
  /** Second joint slot, starting from zero. The same slot gives a sphere. */
  readonly end: number;
  /** Radius of the limb, including clothing or fur, in skeleton units. */
  readonly radius: number;
  /** Optional fraction range of the segment to check. Use the proximal trim for the shared shoulder or hip. Default [0, 1]. */
  readonly range?: readonly [number, number];
}

/** Bounds a joint direction against a body-relative axis, for example shoulder extension behind the chest. */
export interface LimbDirectionLimit {
  /** Origin slot in the proposed chain. */
  readonly start: number;
  /** Direction slot in the proposed chain, distinct from start. */
  readonly end: number;
  /** Bone that carries the forward axis, for example the upper chest or pelvis. */
  readonly reference: number;
  /** Direction in the reference bone's local rest axes. */
  readonly forward: Vec3;
  /** Maximum angle behind the plane normal to forward. In radians from 0 to π/2, default 0.75. */
  readonly maxBackwards?: number;
}

/** One collision sample for a swept check. Obtain it from {@link LimbCollisionRig.snapshot}. */
export interface LimbCollisionSample {
  /** Capsule endpoints of the posed body in skeleton space, six numbers per volume. */
  readonly body: Float64Array;
  /** Capsule endpoints of the candidate limb in skeleton space, six numbers per link. */
  readonly limb: Float64Array;
}

/** Precision and work limits for a check between two collision samples. */
export interface LimbSweepOptions {
  /** Gap that counts as a touch, in skeleton units. Default 0.0001. */
  readonly tolerance?: number;
  /** Positive checks budget, 1 to 4096. Default 128. */
  readonly maxSteps?: number;
}

/** Result of advancing a set of moving body and limb capsules toward contact. */
export interface LimbSweepResult {
  /** True when all motion along the supplied proxy paths was clear. */
  readonly clear: boolean;
  /** Time fraction at the first conservative hit, the work limit, or 1 when clear. */
  readonly time: number;
  /** Smallest signed distance measured so far. */
  readonly clearance: number;
  /** True when the work limit was reached before certification. */
  readonly exhausted: boolean;
}

const ZERO: Vec3 = [0, 0, 0];
const three = (a: ArrayLike<number>, i: number): Vec3 => [a[i], a[i + 1], a[i + 2]];

function vector(v: ArrayLike<number>): boolean {
  return v?.length === 3 && Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2]);
}

function endpointDistance(a: Vec3, unit: Vec3, size: number): number {
  return length(sub(a, scale(unit, Math.max(0, Math.min(size, dot(a, unit))))));
}

// The minimum lies on the boundary of the two segment parameters or at their interior stationary point (Lumelsky 1985).
function segmentDistance(a: Vec3, b: Vec3, c: Vec3, d: Vec3): number {
  const v = sub(b, a),
    w = sub(d, c),
    difference = sub(c, a),
    u = normalize(v),
    t = normalize(w),
    vLength = length(v),
    wLength = length(w);
  let best = Math.min(
    endpointDistance(scale(difference, -1), t, wLength),
    endpointDistance(sub(v, difference), t, wLength),
    endpointDistance(difference, u, vLength),
    endpointDistance(sub(d, a), u, vLength),
  );
  const span = cross(u, t),
    divisor = dot(span, span);
  if (divisor > 0) {
    const first = dot(cross(difference, t), span) / divisor,
      second = dot(cross(difference, u), span) / divisor;
    if (first >= 0 && first <= vLength && second >= 0 && second <= wLength)
      best = Math.min(best, Math.abs(dot(difference, span)) / Math.sqrt(divisor));
  }
  return best;
}

function transform(frames: ReturnType<typeof worldFrames>, joint: number, value: Vec3, point: boolean): Vec3 {
  const { position, linear } = frames,
    i = joint * 9;
  return [
    linear[i] * value[0] + linear[i + 3] * value[1] + linear[i + 6] * value[2] + (point ? position[joint * 3] : 0),
    linear[i + 1] * value[0] +
      linear[i + 4] * value[1] +
      linear[i + 7] * value[2] +
      (point ? position[joint * 3 + 1] : 0),
    linear[i + 2] * value[0] +
      linear[i + 5] * value[1] +
      linear[i + 8] * value[2] +
      (point ? position[joint * 3 + 2] : 0),
  ];
}

/**
 * Self-collision for a soft-bodied rig using authored anatomical landmarks and link thickness.
 * Body volumes follow their joints. The collision function can be used as a deterministic IK constraint.
 */
export class LimbCollisionRig {
  private readonly parents: readonly number[];
  private readonly order: readonly number[];
  private readonly volumes: readonly BodyCollisionVolume[];
  private readonly links: readonly Required<LimbCollisionLink>[];
  private readonly limits: readonly Required<LimbDirectionLimit>[];
  private readonly slots: number;
  private readonly body: Float64Array;
  private readonly candidate: Float64Array;
  private axes: Vec3[] = [];
  private posed = false;

  /** Configures the volumes and link ranges once, for a human, quadruped or other skeleton. */
  constructor(
    parents: readonly number[],
    volumes: readonly BodyCollisionVolume[],
    links: readonly LimbCollisionLink[],
    limits: readonly LimbDirectionLimit[] = [],
  ) {
    if (
      !parents.length ||
      parents.length > 65_536 ||
      parents.some((v) => !Number.isInteger(v) || v < -1 || v >= parents.length)
    )
      throw new RangeError('Limb collision needs 1–65,536 joints with valid parent indices or -1');
    const joint = (i: number) => Number.isInteger(i) && i >= 0 && i < parents.length;
    const slot = (i: number) => Number.isInteger(i) && i >= 0 && i < 65_536;
    const landmark = (a: CollisionLandmark): CollisionLandmark => {
      const offset = a.offset ?? ZERO;
      if (!joint(a.joint) || !vector(offset))
        throw new RangeError('Body collision landmarks need a valid bone and a finite local XYZ offset');
      return { joint: a.joint, offset: [...offset] };
    };
    const radius = (r: number) => {
      if (!(Number.isFinite(r) && r >= 0)) throw new RangeError('Collision radii must be finite and nonnegative');
      return r;
    };
    if (!volumes.length || !links.length)
      throw new RangeError('Pass at least one body volume and one limb link to check');
    this.parents = [...parents];
    this.order = parentOrder(this.parents, 'Limb collision');
    this.volumes = volumes.map(({ start, end, radius: r }) => ({
      start: landmark(start),
      end: end ? landmark(end) : undefined,
      radius: radius(r),
    }));
    this.links = links.map(({ start, end, radius: r, range = [0, 1] }) => {
      if (!(slot(start) && slot(end) && range.length === 2 && range[0] >= 0 && range[1] <= 1 && range[0] <= range[1]))
        throw new RangeError('Limb links need valid joint slots and a range of fractions with 0 ≤ start ≤ end ≤ 1');
      return { start, end, radius: radius(r), range: [...range] };
    });
    this.limits = limits.map(({ start, end, reference, forward, maxBackwards = 0.75 }) => {
      if (
        !(
          slot(start) &&
          slot(end) &&
          start !== end &&
          joint(reference) &&
          vector(forward) &&
          length(forward) > 0 &&
          maxBackwards >= 0 &&
          maxBackwards <= Math.PI / 2
        )
      )
        throw new RangeError(
          'Direction limits need distinct valid slots, a reference bone, a forward axis and an angle from 0 to π/2',
        );
      return { start, end, reference, forward: normalize(forward), maxBackwards };
    });
    this.slots = [...this.links, ...this.limits].reduce((n, { start, end }) => Math.max(n, start, end), 0) + 1;
    this.body = new Float64Array(this.volumes.length * 6);
    this.candidate = new Float64Array(this.links.length * 6);
  }

  /** Poses the body volumes from the current skeleton before checking a limb. */
  setBodyPose(local: ArrayLike<number>): void {
    if (local.length !== this.parents.length * 10)
      throw new RangeError('A collision pose needs ten local transform components per joint');
    for (let i = 0; i < local.length; i++)
      if (!Number.isFinite(local[i]))
        throw new RangeError('Give the collision rig finite translation, quaternion and scale values');
    const frames = worldFrames(this.parents, local, this.order),
      newBody = new Float64Array(this.body.length),
      point = (a: CollisionLandmark) => transform(frames, a.joint, a.offset ?? ZERO, true);
    this.volumes.forEach(({ start, end }, i) => {
      const a = point(start),
        b = end ? point(end) : a;
      if (!vector(a) || !vector(b))
        throw new RangeError('Collision body landmarks overflowed; use finite transforms at scene scale');
      newBody.set(a, i * 6);
      newBody.set(b, i * 6 + 3);
    });
    const axes = this.limits.map(({ reference, forward }) => {
      const axis = normalize(transform(frames, reference, forward, false));
      if (length(axis) < 0.9) throw new RangeError('A collision direction needs a non-degenerate reference frame');
      return axis;
    });
    this.body.set(newBody);
    this.axes = axes;
    this.posed = true;
  }

  /** Minimum signed gap for the proposed pose. Negative rejects a collision or an anatomical direction violation. */
  readonly clearance = (positions: ArrayLike<number>): number => {
    this.packLimb(positions, this.candidate);
    let gap = this.measure(this.body, this.candidate);
    this.limits.forEach(({ start, end, maxBackwards }, i) => {
      const delta = sub(three(positions, end * 3), three(positions, start * 3));
      gap = Math.min(gap, dot(delta, this.axes[i]) + length(delta) * Math.sin(maxBackwards));
    });
    return gap;
  };

  /** Captures the current obstacle shape and a candidate limb for between-frame checks. */
  snapshot(positions: ArrayLike<number>): LimbCollisionSample {
    this.packLimb(positions, this.candidate);
    return { body: this.body.slice(), limb: this.candidate.slice() };
  }

  /**
   * Tests linearly moving proxy endpoints, including motion of the body. It cannot jump over a thin contact.
   * Pass subframes when using curved joint trajectories. Direction limits are checked by {@link clearance} per pose.
   */
  sweep(
    from: LimbCollisionSample,
    to: LimbCollisionSample,
    { tolerance = 0.0001, maxSteps = 128 }: LimbSweepOptions = {},
  ): LimbSweepResult {
    if (
      !(tolerance > 0 && Number.isFinite(tolerance) && Number.isInteger(maxSteps) && maxSteps >= 1 && maxSteps <= 4096)
    )
      throw new RangeError('Swept limb collision needs positive tolerance and an integer step budget from 1 to 4096');
    for (const sample of [from, to])
      if (
        sample.body.length !== this.body.length ||
        sample.limb.length !== this.candidate.length ||
        !sample.body.every(Number.isFinite) ||
        !sample.limb.every(Number.isFinite)
      )
        throw new RangeError('Sweep samples must come from the same proxy layout and contain finite positions');
    const body = from.body.slice(),
      limb = from.limb.slice(),
      bodyMotion = to.body.map((value, i) => value - from.body[i]),
      limbMotion = to.limb.map((value, i) => value - from.limb[i]),
      translate = three(bodyMotion, 0);
    const maxMotion = (a: Float64Array) => {
      let fastest = 0;
      for (let i = 0; i < a.length; i += 3) fastest = Math.max(fastest, length(sub(three(a, i), translate)));
      return fastest;
    };
    const speed = maxMotion(bodyMotion) + maxMotion(limbMotion);
    let time = 0,
      smallest = Infinity;
    for (let step = 0; step < maxSteps; step++) {
      const gap = this.measure(body, limb);
      smallest = Math.min(smallest, gap);
      if (gap <= tolerance) return { clear: false, time, clearance: smallest, exhausted: false };
      if (time === 1 || speed === 0) return { clear: true, time: 1, clearance: smallest, exhausted: false };
      const next = Math.min(1, time + (gap - tolerance * 0.5) / speed);
      if (next <= time) break;
      time = next;
      for (let i = 0; i < body.length; i++) body[i] = from.body[i] + bodyMotion[i] * time;
      for (let i = 0; i < limb.length; i++) limb[i] = from.limb[i] + limbMotion[i] * time;
    }
    return { clear: false, time, clearance: smallest, exhausted: true };
  }

  private packLimb(positions: ArrayLike<number>, out: Float64Array): void {
    if (!this.posed) throw new RangeError('Call setBodyPose before checking a limb');
    if (positions.length < this.slots * 3)
      throw new RangeError('Pass packed XYZ positions for every configured collision joint slot');
    for (let i = 0; i < this.slots * 3; i++)
      if (!Number.isFinite(positions[i])) throw new RangeError('Limb collision needs finite candidate points');
    this.links.forEach(({ start, end, range }, i) => {
      const a = start * 3,
        b = end * 3,
        at = i * 6;
      for (let j = 0; j < 3; j++) {
        const shift = positions[b + j] - positions[a + j];
        out[at + j] = positions[a + j] + shift * range[0];
        out[at + 3 + j] = positions[a + j] + shift * range[1];
      }
    });
  }

  private measure(body: Float64Array, limb: Float64Array): number {
    let smallest = Infinity;
    this.links.forEach(({ radius }, i) => {
      const start = three(limb, i * 6),
        end = three(limb, i * 6 + 3);
      this.volumes.forEach((volume, j) => {
        const gap = segmentDistance(start, end, three(body, j * 6), three(body, j * 6 + 3)) - radius - volume.radius;
        if (!Number.isFinite(gap))
          throw new RangeError('Collision distance overflowed; use finite positions at scene scale');
        smallest = Math.min(smallest, gap);
      });
    });
    return smallest;
  }
}
