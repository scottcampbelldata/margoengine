import type { Body2D } from './body.js';
import type { Physics2D } from './physics.js';
import type { Vec2D } from './shapes.js';

/** Options of a character controller; every field has a default. */
export interface CharacterOptions2D {
  /** Gap kept between the character and what it touches, world units (default 0.5). */
  offset?: number;
  /** Which way is up. Default [0, -1] (screen up). */
  up?: Vec2D;
  /** Step over ledges up to `maxHeight` that are at least `minWidth` wide. */
  autostep?: { maxHeight: number; minWidth: number; includeDynamic?: boolean };
  /** Steepest slope it can climb, radians (default 45 degrees). */
  maxSlopeClimbAngle?: number;
  /** Slopes steeper than this slide it down, radians (default 30 degrees). */
  minSlopeSlideAngle?: number;
  /** Stick to the ground when walking down slopes or steps up to this distance, world units. */
  snapToGround?: number;
  /** Slide along walls instead of stopping (default true). */
  slide?: boolean;
  /** Push dynamic bodies it walks into (default false). */
  pushDynamic?: boolean;
  /** Mass used when pushing, in kilograms. */
  mass?: number;
}

/** What one `move` did. */
export interface CharacterMoveResult2D {
  /** The movement that was applied, world units. */
  movement: [number, number];
  grounded: boolean;
  /** Number of contacts the move hit. */
  collisions: number;
  /** What the move hit, in order: the collider, the surface normal pointing out of it and the contact point. */
  hits: Array<{ collider: import('./body.js').Collider2D; body: Body2D; normal: [number, number]; point: [number, number] }>;
}

const EPS = 1e-5;
const MAX_ITERATIONS = 8;

/**
 * Moves a kinematic position body around obstacles. Call `move` once per fixed step (from `beforestep`).
 *
 * The algorithm is the one the Rapier user guide describes for its kinematic character controller, built on the shape
 * cast of the kernel: the character slides along what it hits keeping `offset` away from it, climbs slopes up to
 * `maxSlopeClimbAngle` keeping its horizontal speed, slides down slopes steeper than `minSlopeSlideAngle`, steps over
 * ledges (`autostep`) and sticks to the ground on the way down (`snapToGround`).
 */
export class CharacterController2D {
  private readonly up: [number, number];
  private readonly offset: number;
  private readonly climb: number;
  private readonly slideAngle: number;
  private disposed = false;
  /** @internal */
  constructor(
    private readonly physics: Physics2D,
    readonly body: Body2D,
    private readonly options: CharacterOptions2D,
    private readonly onDispose: (controller: CharacterController2D) => void,
  ) {
    const up = options.up ?? [0, -1],
      length = Math.hypot(up[0], up[1]);
    if (!(length > 0) || !Number.isFinite(length)) throw new RangeError('The up vector must be finite and not zero; try [0, -1].');
    this.up = [up[0] / length, up[1] / length];
    this.offset = (options.offset ?? 0.5) * physics.scale;
    this.climb = Math.cos(options.maxSlopeClimbAngle ?? Math.PI / 4);
    this.slideAngle = Math.cos(options.minSlopeSlideAngle ?? Math.PI / 6);
  }

  /** Casts the character's shape from `at` (metres) along the unit `dir` for `max`; the nearest hit that is not itself. */
  private cast(at: [number, number], dir: [number, number], max: number) {
    const collider = this.body.colliders[0];
    if (!collider?.described) throw new TypeError('The character body has no collider; add one with body.addCollider.');
    const angle = this.body.rotation;
    return this.physics.cast(collider.described, at[0], at[1], angle, dir[0], dir[1], max, { exclude: this.body, excludeSensors: true });
  }

  /** Computes the movement for `delta` (world units) and sets the body's next position. */
  move(delta: Vec2D): CharacterMoveResult2D {
    if (this.disposed) throw new TypeError('This character controller was disposed; create a new one.');
    if (!Number.isFinite(delta[0]) || !Number.isFinite(delta[1])) throw new TypeError('delta must be two finite numbers [x, y].');
    const k = this.physics.scale,
      inv = 1 / k;
    const start: [number, number] = [this.body.position[0] * k, this.body.position[1] * k];
    const pos: [number, number] = [start[0], start[1]];
    let remaining: [number, number] = [delta[0] * k, delta[1] * k];
    const desired = remaining;
    let grounded = false,
      collisions = 0;
    const hits: CharacterMoveResult2D['hits'] = [];
    const up = this.up;
    const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1];
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const dist = Math.hypot(remaining[0], remaining[1]);
      if (dist < EPS) break;
      const dir: [number, number] = [remaining[0] / dist, remaining[1] / dist];
      const hit = this.cast(pos, dir, dist + this.offset);
      if (!hit) {
        pos[0] += remaining[0];
        pos[1] += remaining[1];
        remaining = [0, 0];
        break;
      }
      // The hit's normal points out of the obstacle; the gap to keep along the way is offset over the angle of approach.
      const o = hit.normal as [number, number];
      const against = Math.max(-dot(dir, o), 0.1);
      const travelled = Math.max(0, Math.min(dist, hit.distance * k - this.offset / against));
      pos[0] += dir[0] * travelled;
      pos[1] += dir[1] * travelled;
      collisions++;
      hits.push({ collider: hit.collider, body: hit.body, normal: [o[0], o[1]], point: [hit.point[0], hit.point[1]] });
      const left = dist - travelled;
      const rest: [number, number] = [dir[0] * left, dir[1] * left];
      const cosine = dot(o, up);
      const walkable = cosine >= this.climb - 1e-6;
      if (walkable) grounded = true;
      this.pushDynamic(hit.body, o, rest);
      if (this.options.slide === false) {
        remaining = [0, 0];
        break;
      }
      if (!walkable && this.options.autostep && cosine > -0.5) {
        const stepped = this.step(pos, rest);
        if (stepped) {
          pos[0] = stepped.pos[0];
          pos[1] = stepped.pos[1];
          remaining = stepped.remaining;
          grounded = true;
          continue;
        }
      }
      if (walkable && cosine < this.slideAngle - 1e-6) {
        // A slope steeper than `minSlopeSlideAngle`: what pushes into it slides down along it.
        remaining = [rest[0] - o[0] * dot(rest, o), rest[1] - o[1] * dot(rest, o)];
      } else if (walkable) {
        // Climb it, keeping the horizontal part of the movement.
        const h: [number, number] = [rest[0] - up[0] * dot(rest, up), rest[1] - up[1] * dot(rest, up)];
        const lambda = -dot(h, o) / Math.max(cosine, 1e-3);
        remaining = [h[0] + up[0] * lambda, h[1] + up[1] * lambda];
        // Moving down the slope onto it, not along it, leaves nothing to climb.
        if (dot(rest, up) < 0 && Math.abs(dot(h, h)) < EPS * EPS) remaining = [0, 0];
      } else {
        remaining = [rest[0] - o[0] * dot(rest, o), rest[1] - o[1] * dot(rest, o)];
      }
      if (dot(remaining, remaining) < EPS * EPS) break;
    }
    if (this.options.snapToGround !== undefined && !grounded && dot(desired, up) <= EPS) {
      const snap = this.options.snapToGround * k;
      const hit = this.cast(pos, [-up[0], -up[1]], snap + this.offset);
      if (hit && dot(hit.normal as [number, number], up) >= this.climb - 1e-6) {
        const travelled = Math.max(0, hit.distance * k - this.offset);
        pos[0] -= up[0] * travelled;
        pos[1] -= up[1] * travelled;
        grounded = true;
      }
    }
    const movement: [number, number] = [(pos[0] - start[0]) * inv, (pos[1] - start[1]) * inv];
    this.body.moveTo([this.body.position[0] + movement[0], this.body.position[1] + movement[1]]);
    return { movement, grounded, collisions, hits };
  }

  /** Tries to climb a ledge in the way of `rest`: up by at most `maxHeight`, across by at least `minWidth`, down onto ground. */
  private step(pos: [number, number], rest: [number, number]): { pos: [number, number]; remaining: [number, number] } | null {
    const auto = this.options.autostep;
    if (!auto) return null;
    const k = this.physics.scale,
      up = this.up;
    const upDot = rest[0] * up[0] + rest[1] * up[1];
    const h: [number, number] = [rest[0] - up[0] * upDot, rest[1] - up[1] * upDot];
    const width = Math.hypot(h[0], h[1]);
    if (width < EPS) return null;
    const hdir: [number, number] = [h[0] / width, h[1] / width];
    const height = auto.maxHeight * k,
      minWidth = auto.minWidth * k;
    // Up, with room for the gap to the ceiling.
    const ceiling = this.cast(pos, up, height + this.offset);
    const lift = ceiling ? Math.max(0, ceiling.distance * k - this.offset) : height;
    if (lift < EPS) return null;
    const top: [number, number] = [pos[0] + up[0] * lift, pos[1] + up[1] * lift];
    // Across, at least `minWidth` (or the movement, if that is longer).
    const reach = Math.max(width, minWidth);
    const wall = this.cast(top, hdir, reach + this.offset);
    const across = wall ? Math.max(0, wall.distance * k - this.offset) : reach;
    if (across < minWidth - EPS) return null;
    const over: [number, number] = [top[0] + hdir[0] * across, top[1] + hdir[1] * across];
    // Down onto something to stand on.
    const ground = this.cast(over, [-up[0], -up[1]], lift + this.offset);
    if (!ground || ground.normal[0] * up[0] + ground.normal[1] * up[1] < this.climb - 1e-6) return null;
    const drop = Math.max(0, ground.distance * k - this.offset);
    const landed: [number, number] = [over[0] - up[0] * drop, over[1] - up[1] * drop];
    if (lift - drop < EPS) return null;
    const used = Math.min(across, width);
    const remains = Math.max(0, width - used);
    return { pos: landed, remaining: [hdir[0] * remains, hdir[1] * remains] };
  }

  /** Pushes a dynamic body the character walks into, with the character's mass behind the movement. */
  private pushDynamic(other: Body2D, o: [number, number], rest: [number, number]): void {
    if (!this.options.pushDynamic || other.type !== 'dynamic') return;
    const into = -(rest[0] * o[0] + rest[1] * o[1]);
    if (into <= 0) return;
    const mass = this.options.mass ?? (this.body.mass || 1);
    const impulse = (mass * into) / this.physics.fixedTimestep;
    other.applyImpulse([-o[0] * impulse, -o[1] * impulse]);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.onDispose(this);
  }
  declare [Symbol.dispose]: () => void;
}
CharacterController2D.prototype[Symbol.dispose] = CharacterController2D.prototype.dispose;
