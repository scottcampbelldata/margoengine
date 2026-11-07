// Rewound hit shapes beyond spheres: boxes and capsules that also turn. As in `LagCompensation`, the server keeps where
// every shape was at each recent tick and tests a shot against the shapes as the shooter saw them. A ray goes into each
// shape's own frame, where a box is a slab test and a capsule is the ray test of `@margoengine/math`.
import { Capsule } from '@margoengine/math/capsule';
import { OBB } from '@margoengine/math/obb';
import { Quaternion } from '@margoengine/math/quaternion';
import { Vector3 } from '@margoengine/math/vector3';
import { Timeline } from '@margoengine/net/timeline';
import type { RewindHit } from './lag.js';

/** A sphere: `position` [x, y, z] and `radius`. */
export interface RewindSphere {
  readonly position: readonly number[];
  readonly radius: number;
}
/** A box of half sizes `halfExtents` [x, y, z] around `position`, turned by the unit quaternion `rotation` [x, y, z, w]. */
export interface RewindBox {
  readonly position: readonly number[];
  readonly halfExtents: readonly number[];
  readonly rotation?: readonly number[];
}
/**
 * A capsule around `position`, `halfHeight` from the centre to the centre of each cap along its own y axis, as tall as
 * `2 * (halfHeight + radius)` in all, turned by `rotation` [x, y, z, w].
 */
export interface RewindCapsule {
  readonly position: readonly number[];
  readonly radius: number;
  readonly halfHeight: number;
  readonly rotation?: readonly number[];
}
/** One shape of {@link HitboxRewind}. */
export type RewindShape = RewindSphere | RewindBox | RewindCapsule;

/** A shape as kept: every field present, so two ticks blend number by number. */
interface Kept {
  position: number[];
  rotation: number[];
  radius: number;
  halfHeight: number;
  halfExtents: number[] | undefined;
}

const numbers = (v: unknown, n: number): v is number[] => Array.isArray(v) && v.length === n && v.every(Number.isFinite);

function keep(id: number, shape: RewindShape): Kept {
  const s = shape as Partial<RewindBox & RewindCapsule>,
    rotation = s.rotation ?? [0, 0, 0, 1];
  if (!shape || !numbers(s.position, 3))
    throw new TypeError(`HitboxRewind shape ${id} needs a position of 3 finite numbers; pass [x, y, z]`);
  if (!numbers(rotation, 4) || !(Math.hypot(...rotation) > 0))
    throw new RangeError(`HitboxRewind shape ${id} rotation is not a quaternion; pass [x, y, z, w]`);
  const length = Math.hypot(...rotation),
    box = s.halfExtents;
  if (box !== undefined && (!numbers(box, 3) || box.some((v) => v < 0)))
    throw new RangeError(`HitboxRewind shape ${id} halfExtents needs 3 numbers of 0 or more; fix them`);
  const radius = s.radius ?? 0,
    halfHeight = s.halfHeight ?? 0;
  if (!box && (typeof s.radius !== 'number' || !(radius >= 0) || radius === Infinity))
    throw new RangeError(`HitboxRewind shape ${id} radius is ${s.radius}; use a finite 0 or more, or pass halfExtents`);
  if (!(halfHeight >= 0) || halfHeight === Infinity)
    throw new RangeError(`HitboxRewind shape ${id} halfHeight is ${halfHeight}; use a finite 0 or more`);
  return {
    position: [...(s.position as number[])],
    rotation: rotation.map((v) => v / length),
    radius,
    halfHeight,
    halfExtents: box ? [...box] : undefined,
  };
}

const blendNumbers = (a: number[], b: number[], t: number): number[] => a.map((v, i) => v + (b[i] - v) * t);

const qa = new Quaternion(),
  qb = new Quaternion();
function blend(a: Kept, b: Kept, t: number): Kept {
  qa.set(a.rotation[0], a.rotation[1], a.rotation[2], a.rotation[3]);
  qb.set(b.rotation[0], b.rotation[1], b.rotation[2], b.rotation[3]);
  qa.slerp(qb, t);
  return {
    position: blendNumbers(a.position, b.position, t),
    rotation: [qa.x, qa.y, qa.z, qa.w],
    radius: a.radius + (b.radius - a.radius) * t,
    halfHeight: a.halfHeight + (b.halfHeight - a.halfHeight) * t,
    halfExtents: a.halfExtents && blendNumbers(a.halfExtents, b.halfExtents as number[], t),
  };
}

const box = new OBB(),
  capsule = new Capsule(),
  ray = { origin: new Vector3(), direction: new Vector3() },
  hit = new Vector3(),
  turn = new Quaternion();

/** How far along the ray `shape` is, in direction lengths, or undefined on a miss. */
function distanceTo(shape: Kept, origin: readonly number[], direction: readonly number[]): number | undefined {
  const [x, y, z] = shape.position,
    [i, j, k, w] = shape.rotation;
  turn.set(-i, -j, -k, w);
  ray.origin.set(origin[0] - x, origin[1] - y, origin[2] - z).applyQuaternion(turn);
  ray.direction.set(direction[0], direction[1], direction[2]).applyQuaternion(turn);
  const extents = shape.halfExtents;
  if (extents) {
    box.halfSize.set(extents[0], extents[1], extents[2]);
    if (!box.intersectRay(ray, hit)) return undefined;
  } else {
    capsule.start.set(0, -shape.halfHeight, 0);
    capsule.end.set(0, shape.halfHeight, 0);
    capsule.radius = shape.radius;
    if (!capsule.intersectRay(ray, hit)) return undefined;
  }
  return hit.sub(ray.origin).dot(ray.direction) / ray.direction.dot(ray.direction);
}

/**
 * Where every sphere, box and capsule was at each of the last `history` ticks: `LagCompensation` for shapes that are
 * not round. Shapes are 3D; a 2D game passes z as 0.
 *
 * @example
 * ```ts
 * const rewind = new HitboxRewind({ history: 32 });
 * // each server tick, after the step:
 * rewind.record(server.tick, [...state.players].map(([id, p]) => [id, { position: [p.x, p.y, p.z], radius: 0.4, halfHeight: 0.5 }]));
 * // a shot from a player who saw the world at (fractional) tick input.viewTick:
 * const hit = rewind.raycast(input.viewTick, eye, aim, { ignore: shooter });
 * ```
 */
export class HitboxRewind {
  /** Ticks kept. */
  readonly history: number;
  private readonly frames: Timeline<Map<number, Kept>>;

  /** @throws RangeError for a history that is not an integer from 2 to 4096. */
  constructor({ history = 32 }: { history?: number } = {}) {
    if (!Number.isInteger(history) || history < 2 || history > 4096)
      throw new RangeError(`HitboxRewind history is ${history}; pass an integer from 2 to 4096 ticks`);
    this.history = history;
    this.frames = new Timeline(history);
  }

  /** The oldest and newest ticks held, or undefined while empty. */
  get range(): [number, number] | undefined {
    const f = this.frames;
    return f.count ? [f.oldest, f.newest] : undefined;
  }

  /**
   * Records the shapes at `tick` (copies them). Ticks must increase; recording the same tick again replaces it.
   * @throws RangeError for a tick older than the newest or a size or rotation out of range; TypeError for a shape
   * with no position of 3 numbers.
   */
  record(tick: number, shapes: Iterable<readonly [number, RewindShape]>): void {
    if (!Number.isFinite(tick)) throw new RangeError(`HitboxRewind tick is ${tick}; pass a finite tick`);
    const frames = this.frames;
    if (tick < frames.newest)
      throw new RangeError(`HitboxRewind tick ${tick} is older than ${frames.newest}; record ticks in order`);
    const kept = new Map<number, Kept>();
    for (const [id, shape] of shapes) kept.set(id, keep(id, shape));
    if (!frames.add(tick, kept)) frames.replace(tick, kept);
  }

  private shapes(tick: number): Map<number, Kept> {
    const out = new Map<number, Kept>(),
      f = this.frames;
    if (!Number.isFinite(tick) || !f.locate(tick)) return out;
    if (f.a === f.b) return f.from as Map<number, Kept>;
    const a = f.from as Map<number, Kept>,
      b = f.to as Map<number, Kept>,
      t = f.u;
    for (const [id, nb] of b) {
      const na = a.get(id);
      // A box does not blend into a capsule: it is one or the other, whichever tick is nearer.
      if (!na || !na.halfExtents !== !nb.halfExtents) out.set(id, t < 0.5 && na ? na : nb);
      else out.set(id, blend(na, nb, t));
    }
    for (const [id, na] of a) if (!out.has(id) && t < 0.5) out.set(id, na);
    return out;
  }

  /**
   * The shapes at fractional tick `tick`, blended between the two recorded ticks around it: positions and sizes in a
   * line, rotations the short way round. A new shape counts at once and one that went counts up to halfway, as in
   * `LagCompensation`. A tick older than the history is clamped to the oldest frame, so a client cannot rewind further
   * than `history` ticks.
   */
  at(tick: number): Map<number, RewindShape> {
    const out = new Map<number, RewindShape>();
    for (const [id, s] of this.shapes(tick)) {
      const { position, rotation } = s;
      out.set(
        id,
        s.halfExtents
          ? { position, rotation, halfExtents: s.halfExtents }
          : { position, rotation, radius: s.radius, halfHeight: s.halfHeight },
      );
    }
    return out;
  }

  /**
   * The nearest shape a ray from `origin` along `direction` hits at fractional tick `tick`, within `maxDistance`
   * (default Infinity, in direction lengths) and not in `ignore` (an id or a set of ids, the shooter). A ray that starts
   * inside a shape hits it at distance 0. Undefined when it hits nothing.
   * @throws RangeError for an origin or direction that is not 3 finite numbers, or a zero direction.
   */
  raycast(
    tick: number,
    origin: readonly number[],
    direction: readonly number[],
    {
      maxDistance = Number.POSITIVE_INFINITY,
      ignore,
    }: { maxDistance?: number; ignore?: number | ReadonlySet<number> } = {},
  ): RewindHit | undefined {
    if (!numbers(origin, 3) || !numbers(direction, 3))
      throw new RangeError('HitboxRewind raycast needs origin and direction of 3 finite numbers; fix them');
    if (!(Math.hypot(...direction) > 0)) throw new RangeError('HitboxRewind raycast direction is zero; pass a direction');
    const skip = (id: number) => (typeof ignore === 'number' ? id === ignore : ignore?.has(id) === true);
    let best: RewindHit | undefined;
    for (const [id, shape] of this.shapes(tick)) {
      if (skip(id)) continue;
      const s = distanceTo(shape, origin, direction);
      if (s === undefined || s > maxDistance || (best && s >= best.distance)) continue;
      best = { id, distance: s, point: origin.map((v, k) => v + direction[k] * s) };
    }
    return best;
  }

  /** Drops every recorded tick. */
  clear(): void {
    this.frames.clear();
  }
}
