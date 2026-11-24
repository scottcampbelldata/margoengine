/// <reference lib="esnext.disposable" preserve="true" />
import { MargoError } from '@margoengine/math/errors';
import type { PhysicsBody, BodyOptions } from './body.js';
import type { PhysicsJoint } from './joints.js';
import type { Physics, PhysicsAttachment } from './physics.js';
import type { ColliderSettings } from './shapes.js';
import { checkVec, type Vec3 } from './math.js';

/** Options of `new Rope(physics, options)`. Every field but `start` and `end` has a default. */
export interface RopeOptions {
  /** World position of the first end. */
  start: Vec3;
  /** World position of the second end. */
  end: Vec3;
  /** Number of capsule segments (default 12). More bend more smoothly and cost more. */
  segments?: number;
  /** Rope radius in metres (default 0.05). */
  radius?: number;
  /** Pin the start to this body (at the point `start`) or `'fixed'` to pin it in place (default free). */
  attachStart?: PhysicsBody | 'fixed';
  /** Pin the end to this body (at the point `end`) or `'fixed'` to pin it in place (default free). */
  attachEnd?: PhysicsBody | 'fixed';
  /** Linear damping per segment, so a swinging rope settles (default 0.1). */
  damping?: number;
  /** Angular damping per segment (default 0.5). */
  angularDamping?: number;
  /** Material, mass, group and event settings for every segment collider (default density 1). */
  collider?: Omit<ColliderSettings, 'offset' | 'rotation'>;
  /** Extra body options for every segment (gravity scale, CCD, user data). */
  body?: Omit<BodyOptions, 'type' | 'position' | 'rotation' | 'colliders'>;
}

/** Shortest-arc rotation taking +Y to the unit vector `d`. */
function fromUp(d: readonly number[]): [number, number, number, number] {
  const [x, y, z] = d;
  if (y < -0.999999) return [1, 0, 0, 0];
  // q = normalize(cross(Y, d), 1 + dot(Y, d))
  const qx = z,
    qy = 0,
    qz = -x,
    qw = 1 + y,
    length = Math.hypot(qx, qy, qz, qw);
  return [qx / length, qy / length, qz / length, qw / length];
}

/** Rotates `v` by the inverse of the unit quaternion `q`. */
function inverseRotate(q: readonly number[], v: readonly number[]): [number, number, number] {
  const [x, y, z, w] = [-q[0], -q[1], -q[2], q[3]];
  const tx = 2 * (y * v[2] - z * v[1]),
    ty = 2 * (z * v[0] - x * v[2]),
    tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}

/**
 * A rope or chain: capsule segments linked end to end by spherical joints (rigid links, so it does not stretch),
 * optionally pinned at either end. Segments collide with the world but not with their neighbours.
 * `new Rope(physics, {start, end})`; it is removed with the world. Import it only where you need it: the `Physics`
 * world never loads it.
 */
export class Rope implements PhysicsAttachment {
  /** The segment bodies, from `start` to `end`. */
  readonly segments: PhysicsBody[] = [];
  /** Every joint of the rope: links between segments, then the end pins. */
  readonly joints: PhysicsJoint[] = [];
  /** Length of one segment in metres. */
  readonly segmentLength: number;
  /** Fixed anchor bodies the rope created for `'fixed'` pins. */
  private readonly anchors: PhysicsBody[] = [];
  private removed = false;

  /**
   * @param physics The world to add the segments to.
   * @param options Ends, segment count, radius, pins and segment settings.
   */
  constructor(
    private readonly owner: Physics,
    options: RopeOptions,
  ) {
    if (typeof owner?.addBody !== 'function' || owner.isDisposed)
      throw new TypeError('A rope needs a live Physics world: new Rope(physics, {start, end}).');
    checkVec(options?.start, 'Rope start');
    checkVec(options.end, 'Rope end');
    const segments = options.segments ?? 12,
      radius = options.radius ?? 0.05;
    if (!Number.isInteger(segments) || segments < 1 || segments > 1000)
      throw new RangeError('Rope segments must be an integer from 1 to 1000');
    if (!(radius > 0) || !Number.isFinite(radius)) throw new RangeError('Rope radius must be a positive finite number');
    const { start, end } = options,
      delta = [end[0] - start[0], end[1] - start[1], end[2] - start[2]],
      length = Math.hypot(delta[0], delta[1], delta[2]);
    if (!(length > 0))
      throw new RangeError('Rope start and end must differ; pass two points the rope stretches between.');
    const dir = [delta[0] / length, delta[1] / length, delta[2] / length],
      step = length / segments,
      half = step / 2,
      rotation = fromUp(dir);
    this.segmentLength = step;
    // The capsule's straight part, so neighbouring caps overlap their shared joint instead of leaving gaps.
    const capsuleHalf = Math.max(half - radius, half * 0.25),
      capsuleRadius = Math.min(radius, half);
    try {
      for (let i = 0; i < segments; i++) {
        const t = (i + 0.5) * step;
        this.segments.push(
          owner.addBody(null, {
            linearDamping: options.damping ?? 0.1,
            angularDamping: options.angularDamping ?? 0.5,
            ...options.body,
            type: 'dynamic',
            position: [start[0] + dir[0] * t, start[1] + dir[1] * t, start[2] + dir[2] * t],
            rotation,
            colliders: {
              density: 1,
              ...options.collider,
              shape: 'capsule',
              halfHeight: capsuleHalf,
              radius: capsuleRadius,
            },
          }),
        );
      }
      for (let i = 0; i + 1 < segments; i++)
        this.joints.push(
          owner.addJoint(this.segments[i], this.segments[i + 1], {
            type: 'spherical',
            anchorA: [0, half, 0],
            anchorB: [0, -half, 0],
          }),
        );
      this.pin(options.attachStart, start, this.segments[0], [0, -half, 0]);
      this.pin(options.attachEnd, end, this.segments[segments - 1], [0, half, 0]);
    } catch (error) {
      this.release();
      throw error;
    }
    owner.attach(this);
  }

  private pin(target: PhysicsBody | 'fixed' | undefined, point: Vec3, segment: PhysicsBody, anchor: Vec3): void {
    if (target === undefined) return;
    let body: PhysicsBody;
    if (target === 'fixed') {
      body = this.owner.addBody(null, { type: 'fixed', position: point, colliders: [] });
      this.anchors.push(body);
    } else {
      if (!target?.valid)
        throw new MargoError('state', 'Rope attachment body was removed; pass a body from physics.addBody.');
      body = target;
    }
    // The pin point in the attached body's local frame.
    const p = body.position,
      local = inverseRotate(body.rotation, [point[0] - p[0], point[1] - p[1], point[2] - p[2]]);
    this.joints.push(this.owner.addJoint(body, segment, { type: 'spherical', anchorA: local, anchorB: anchor }));
  }

  /** False after `remove()`. */
  get valid(): boolean {
    return !this.removed;
  }

  /**
   * The rope's centre line as `segments + 1` packed xyz points from start to end, at the last physics step. Writes
   * into `out` when given (length `(segments + 1) * 3`), so a per-frame `lines.setPositions` allocates nothing.
   */
  points(out: Float32Array = new Float32Array((this.segments.length + 1) * 3)): Float32Array {
    if (this.removed)
      throw new MargoError('state', 'Rope was removed; create a new one with new Rope(physics, options).');
    if (out.length < (this.segments.length + 1) * 3)
      throw new RangeError('Rope points buffer is too short; pass a Float32Array of (segments + 1) * 3 numbers.');
    const half = this.segmentLength / 2;
    for (let i = 0; i < this.segments.length; i++) {
      const raw = this.segments[i].raw,
        t = raw.translation(),
        q = raw.rotation();
      // Segment +Y axis in world space: the second column of its rotation matrix.
      const ux = 2 * (q.x * q.y - q.w * q.z),
        uy = 1 - 2 * (q.x * q.x + q.z * q.z),
        uz = 2 * (q.y * q.z + q.w * q.x);
      if (i === 0) {
        out[0] = t.x - ux * half;
        out[1] = t.y - uy * half;
        out[2] = t.z - uz * half;
      }
      out[(i + 1) * 3] = t.x + ux * half;
      out[(i + 1) * 3 + 1] = t.y + uy * half;
      out[(i + 1) * 3 + 2] = t.z + uz * half;
    }
    return out;
  }

  private release(): void {
    for (const body of this.segments) this.owner.removeBody(body);
    for (const body of this.anchors) this.owner.removeBody(body);
    this.segments.length = this.joints.length = this.anchors.length = 0;
  }

  /** Removes every segment, joint and fixed anchor of the rope. Attached bodies stay. */
  remove(): void {
    if (this.removed) return;
    this.removed = true;
    this.release();
    this.owner.detach(this);
  }
  /** Same as `remove()`; the world calls it when it is disposed. */
  dispose(): void {
    this.remove();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.remove();
  }
}
