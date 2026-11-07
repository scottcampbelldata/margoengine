// Lag compensation (server-side rewind): the server keeps where every hit shape was at each recent tick, and checks a
// shot against the shapes as they were at the moment the shooter saw them (its interpolated view), not where they
// are now. That is what makes a shot that looked like a hit on screen count as one.

import { Timeline } from '@margoengine/net/timeline';

/** One hit shape: a circle (2 coordinates) or a sphere (3) of `radius`. */
export interface Hitbox {
  /** Centre: [x, y] or [x, y, z]. */
  readonly position: readonly number[];
  /** Radius, 0 or more. */
  readonly radius: number;
}

/** What {@link LagCompensation.raycast} found. */
export interface RewindHit {
  /** The id of the shape hit. */
  id: number;
  /** Distance along the ray (in direction lengths: pass a unit direction for world units). */
  distance: number;
  /** The point hit. */
  point: number[];
}

type Shapes = Map<number, { position: number[]; radius: number }>;

/**
 * Where every hit shape was at each of the last `history` ticks.
 *
 * @example
 * ```ts
 * const lag = new LagCompensation({ history: 32 });
 * // each server tick, after the step:
 * lag.record(server.tick, [...state.players].map(([id, p]) => [id, { position: [p.x, p.y], radius: 0.5 }]));
 * // a shot from a player who saw the world at (fractional) tick input.viewTick:
 * const hit = lag.raycast(input.viewTick, [p.x, p.y], [input.aimX, input.aimY], { ignore: shooter });
 * ```
 */
export class LagCompensation {
  /** Ticks kept. */
  readonly history: number;
  private readonly frames: Timeline<Shapes>;
  /** @throws RangeError for a history that is not an integer from 2 to 4096. */
  constructor({ history = 32 }: { history?: number } = {}) {
    if (!Number.isInteger(history) || history < 2 || history > 4096)
      throw new RangeError(`LagCompensation history is ${history}; pass an integer from 2 to 4096 ticks`);
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
   * @throws RangeError for a tick older than the newest, a shape with a non-finite coordinate or a negative radius;
   * TypeError for a shape that is not `{ position, radius }`.
   */
  record(tick: number, shapes: Iterable<readonly [number, Hitbox]>): void {
    if (!Number.isFinite(tick)) throw new RangeError(`LagCompensation tick is ${tick}; pass a finite tick`);
    const frames = this.frames;
    if (tick < frames.newest)
      throw new RangeError(`LagCompensation tick ${tick} is older than ${frames.newest}; record ticks in order`);
    const boxes: Shapes = new Map();
    for (const [id, shape] of shapes) {
      if (!shape || !Array.isArray(shape.position) || typeof shape.radius !== 'number')
        throw new TypeError('LagCompensation shapes need { position: [x, y] or [x, y, z], radius }; pass that shape');
      if (shape.position.length < 2 || shape.position.length > 3 || !shape.position.every(Number.isFinite))
        throw new RangeError(`LagCompensation shape ${id} needs 2 or 3 finite coordinates; fix its position`);
      if (!(shape.radius >= 0))
        throw new RangeError(`LagCompensation shape ${id} radius is ${shape.radius}; use 0 or more`);
      boxes.set(id, { position: [...shape.position], radius: shape.radius });
    }
    if (!frames.add(tick, boxes)) frames.replace(tick, boxes);
  }

  /**
   * The shapes at fractional tick `tick`, blended linearly between the two recorded ticks around it (a shape present
   * in only one of them is taken as it is there). A tick older than the history is clamped to the oldest frame, so
   * a client cannot rewind further than `history` ticks; a newer one to the newest.
   */
  at(tick: number): Map<number, Hitbox> {
    const out = new Map<number, Hitbox>(),
      f = this.frames;
    if (!Number.isFinite(tick) || !f.locate(tick)) return out;
    if (f.a === f.b) return new Map(f.from);
    const a = f.from as Shapes,
      b = f.to as Shapes,
      t = f.u;
    for (const [id, nb] of b) {
      const na = a.get(id);
      if (!na || na.position.length !== nb.position.length) {
        out.set(id, t < 0.5 && na ? na : nb);
        continue;
      }
      out.set(id, {
        position: nb.position.map((v, k) => na.position[k] + (v - na.position[k]) * t),
        radius: na.radius + (nb.radius - na.radius) * t,
      });
    }
    for (const [id, na] of a) if (!out.has(id) && t < 0.5) out.set(id, na);
    return out;
  }

  /**
   * The nearest shape a ray from `origin` along `direction` hits at fractional tick `tick`, within `maxDistance`
   * (default Infinity) and not in `ignore` (an id or a set of ids, the shooter). Undefined when it hits nothing.
   * @throws RangeError for an origin or direction of another dimension than 2 or 3, or a zero direction.
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
    const n = origin.length;
    if ((n !== 2 && n !== 3) || direction.length !== n)
      throw new RangeError('LagCompensation raycast needs origin and direction of 2 or 3 numbers each; fix them');
    let dd = 0;
    for (let k = 0; k < n; k++) dd += direction[k] * direction[k];
    if (!(dd > 0)) throw new RangeError('LagCompensation raycast direction is zero; pass a direction');
    const skip = (id: number) => (typeof ignore === 'number' ? id === ignore : ignore?.has(id) === true);
    let best: RewindHit | undefined;
    for (const [id, shape] of this.at(tick)) {
      if (skip(id) || shape.position.length !== n) continue;
      // |o + s d - c|^2 = r^2: dd s^2 + 2 (m . d) s + (m . m - r^2) = 0 with m = o - c.
      let md = 0,
        mm = 0;
      for (let k = 0; k < n; k++) {
        const m = origin[k] - shape.position[k];
        md += m * direction[k];
        mm += m * m;
      }
      const c = mm - shape.radius * shape.radius,
        disc = md * md - dd * c;
      if (disc < 0) continue;
      let s = (-md - Math.sqrt(disc)) / dd;
      if (s < 0) s = c <= 0 ? 0 : (-md + Math.sqrt(disc)) / dd;
      if (s < 0 || s > maxDistance || (best && s >= best.distance)) continue;
      best = { id, distance: s, point: origin.map((v, k) => v + direction[k] * s) };
    }
    return best;
  }

  /** Drops every recorded tick. */
  clear(): void {
    this.frames.clear();
  }
}
