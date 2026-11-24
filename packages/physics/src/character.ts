/// <reference lib="esnext.disposable" preserve="true" />
import { MargoError } from '@margoengine/math/errors';
import type { PhysicsCollider } from './collider.js';
import type { PhysicsBody } from './body.js';
import type { Physics, QueryFilter, ShapeCastHit } from './physics.js';
import { checkVec, type Vec3 } from './math.js';
import type { ShapeOptions } from './shapes.js';

/** Options for a kinematic character controller; every field has a default. */
export interface CharacterControllerOptions {
  /** Gap kept between the character and obstacles (default 0.01). */
  offset?: number;
  /** Up direction (default [0, 1, 0]). */
  up?: Vec3;
  /** Steepest slope the character can walk up, radians (default 45 degrees). */
  maxSlopeClimbAngle?: number;
  /** Slopes steeper than this make the character slide down, radians (default 30 degrees). */
  minSlopeSlideAngle?: number;
  /** Climb steps automatically, or false to disable (default {maxHeight: 0.3, minWidth: 0.2, includeDynamicBodies: false}). */
  autostep?: false | { maxHeight: number; minWidth: number; includeDynamicBodies?: boolean };
  /** Snap down to the ground within this distance while walking down stairs and slopes, or false (default 0.2). */
  snapToGround?: false | number;
  /** Slide along obstacles instead of stopping (default true). */
  slide?: boolean;
  /** Push dynamic bodies it walks into (default false). */
  applyImpulsesToDynamicBodies?: boolean;
  /** Mass used when pushing dynamic bodies (default 1). */
  characterMass?: number;
}

/** One obstacle a move met. */
export interface CharacterCollision {
  collider: PhysicsCollider;
  /** Contact point on the obstacle, world space. */
  point: [number, number, number];
  /** Outward normal of the obstacle at the contact, world space. */
  normal: [number, number, number];
  /** How far the character travelled before this contact. */
  translationApplied: [number, number, number];
  /** What was left of the move at the contact. */
  translationRemaining: [number, number, number];
}

/** Where a character controller ended up, and whether it is grounded. */
export interface CharacterMoveResult {
  /** The movement actually allowed this step. */
  movement: [number, number, number];
  grounded: boolean;
  /** Number of obstacles hit while computing the movement. */
  collisions: number;
}

/** What a move may hit: a query filter without the body to leave out (the character's own is always left out). */
export interface CharacterMoveFilter {
  /** Packed interaction groups, see `collisionGroups`. */
  groups?: number;
  /** Rapier's query flag bits: 1 skip fixed, 2 skip kinematic, 4 skip dynamic, 8 skip sensors, 16 skip solids. */
  flags?: number;
  /** Return false to let the character pass through a collider. */
  predicate?: (collider: PhysicsCollider) => boolean;
}

const EPS = 1e-6;
type V = [number, number, number];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const axpy = (a: Vec3, k: number, b: Vec3): V => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const scale = (a: Vec3, k: number): V => [a[0] * k, a[1] * k, a[2] * k];
function rotate(q: readonly number[], v: Vec3): V {
  const [x, y, z, w] = q as [number, number, number, number],
    tx = 2 * (y * v[2] - z * v[1]),
    ty = 2 * (z * v[0] - x * v[2]),
    tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}
function multiply(a: readonly number[], b: readonly number[]): [number, number, number, number] {
  const [ax, ay, az, aw] = a as [number, number, number, number],
    [bx, by, bz, bw] = b as [number, number, number, number];
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/**
 * A kinematic character controller on a kinematic position-based body, written over the world's shape casts: it slides
 * along obstacles, climbs slopes up to a limit, slides down steeper ones, climbs steps, snaps to the ground and can push
 * dynamic bodies. Call `move(desired)` once per fixed step (for example from `physics.on('beforestep')`).
 */
export class CharacterController {
  private disposed = false;
  private lastGrounded = false;
  private readonly offset: number;
  private readonly up: V;
  private readonly maxClimb: number;
  private readonly minSlide: number;
  private readonly autostep: { maxHeight: number; minWidth: number; includeDynamicBodies: boolean } | null;
  private readonly snap: number | null;
  private readonly slide: boolean;
  private readonly pushes: boolean;
  private readonly mass: number;
  private readonly hits: CharacterCollision[] = [];

  /** @internal */
  constructor(
    private readonly owner: Pick<Physics, 'shapeCast' | 'fixedTimestep'> & {
      removeController(controller: CharacterController): void;
    },
    readonly body: PhysicsBody,
    options: CharacterControllerOptions = {},
  ) {
    if (body.type !== 'kinematicPosition') throw new TypeError('A character controller needs a kinematicPosition body');
    if (!body.colliders.length) throw new TypeError('A character controller body needs a collider');
    const up = options.up ?? [0, 1, 0];
    checkVec(up, 'Up');
    const upLength = length(up);
    if (!(upLength > 0)) throw new RangeError('Up must not be the zero vector');
    this.up = scale(up, 1 / upLength);
    this.offset = options.offset ?? 0.01;
    if (!(this.offset >= 0)) throw new RangeError('offset must be zero or more');
    this.maxClimb = options.maxSlopeClimbAngle ?? Math.PI / 4;
    this.minSlide = options.minSlopeSlideAngle ?? Math.PI / 6;
    const step =
      options.autostep === undefined
        ? { maxHeight: 0.3, minWidth: 0.2, includeDynamicBodies: false }
        : options.autostep;
    this.autostep = step
      ? { maxHeight: step.maxHeight, minWidth: step.minWidth, includeDynamicBodies: step.includeDynamicBodies ?? false }
      : null;
    const snap = options.snapToGround === undefined ? 0.2 : options.snapToGround;
    this.snap = snap === false ? null : snap;
    this.slide = options.slide ?? true;
    this.pushes = options.applyImpulsesToDynamicBodies ?? false;
    this.mass = options.characterMass ?? 1;
  }

  /** Whether the last move ended on ground it can stand on. */
  get grounded(): boolean {
    return this.lastGrounded;
  }
  /** The obstacles the last move met, in order. */
  get collisions(): readonly CharacterCollision[] {
    return this.hits;
  }

  private shapeOf(collider: PhysicsCollider): ShapeOptions {
    switch (collider.shape) {
      case 'sphere':
        return { shape: 'sphere', radius: collider.radius() };
      case 'box': {
        const h = collider.halfExtents()!;
        return { shape: 'box', halfExtents: [h.x, h.y, h.z], borderRadius: collider.borderRadius() };
      }
      case 'capsule':
        return { shape: 'capsule', halfHeight: collider.halfHeight(), radius: collider.radius() };
      case 'cylinder':
      case 'cone':
        return {
          shape: collider.shape,
          halfHeight: collider.halfHeight(),
          radius: collider.radius(),
          borderRadius: collider.borderRadius(),
        };
      default:
        throw new MargoError(
          'unsupported',
          `A character collider can be a sphere, box, capsule, cylinder or cone; this one is a ${collider.shape}. Give the body a primitive collider as its first.`,
        );
    }
  }

  /**
   * Computes how far the character can move toward `desired` (a translation for this step, gravity included)
   * and schedules it as the body's next kinematic position.
   * @throws MargoError (`disposed`) on a disposed controller; (`state`) when the body was removed; (`unsupported`) when
   * the body's first collider is not a sphere, box, capsule, cylinder or cone.
   */
  move(desired: Vec3, filter?: CharacterMoveFilter): CharacterMoveResult {
    if (this.disposed)
      throw new MargoError(
        'disposed',
        'Character controller is disposed; create a new one with physics.createCharacterController.',
      );
    if (!this.body.valid)
      throw new MargoError('state', 'Character body was removed; create a new body and controller.');
    checkVec(desired, 'Desired movement');
    const body = this.body,
      collider = body.colliders[0]!,
      shape = this.shapeOf(collider),
      bodyPosition = body.position,
      bodyRotation = body.rotation,
      local = collider.translationWrtParent(),
      turn = collider.rotationWrtParent(),
      offsetWorld = rotate(bodyRotation, [local.x, local.y, local.z]),
      rotation = multiply(bodyRotation, [turn.x, turn.y, turn.z, turn.w]),
      start: V = [bodyPosition[0] + offsetWorld[0], bodyPosition[1] + offsetWorld[1], bodyPosition[2] + offsetWorld[2]],
      up = this.up,
      down = scale(up, -1),
      cosClimb = Math.cos(this.maxClimb),
      cosSlide = Math.cos(this.minSlide),
      exclude: QueryFilter = { exclude: body, excludeSensors: true, groups: filter?.groups };
    const flags = filter?.flags ?? 0;
    if (flags & 1) exclude.excludeFixed = true;
    if (flags & 2) exclude.excludeKinematic = true;
    if (flags & 4) exclude.excludeDynamic = true;
    if (flags & 8) exclude.excludeSensors = true;
    if (flags & 16) exclude.excludeSolids = true;
    const predicate = filter?.predicate;
    if (predicate) exclude.predicate = (_body, hit) => predicate(hit);
    const cast = (position: Vec3, direction: Vec3, max: number, ignoreDynamic = false): ShapeCastHit | null =>
      this.owner.shapeCast(shape, position, rotation, direction, {
        ...exclude,
        excludeDynamic: exclude.excludeDynamic || ignoreDynamic,
        maxDistance: max,
        // The controller rests a skin off what it stands on and slides along it, so a shape that touches without moving into
        // a surface is not an obstacle: only a cast that closes the gap to the target distance stops it.
        stopAtPenetration: false,
        targetDistance: this.offset,
      });
    const probeGround = (position: Vec3): boolean => {
      const hit = cast(position, down, this.offset * 2 + 1e-3);
      return !!hit && dot(hit.normal, up) >= cosClimb - 1e-4 && hit.distance <= this.offset + 1e-3;
    };

    this.hits.length = 0;
    const groundedBefore = probeGround(start);
    let position: V = [...start],
      remaining: V = [desired[0], desired[1], desired[2]];
    const dt = this.owner.fixedTimestep;
    for (let iteration = 0; iteration < 8; iteration++) {
      const span = length(remaining);
      if (span < EPS) break;
      const direction = scale(remaining, 1 / span),
        hit = cast(position, direction, span);
      if (!hit) {
        position = axpy(position, 1, remaining);
        remaining = [0, 0, 0];
        break;
      }
      const travelled = Math.min(span, Math.max(0, hit.distance));
      position = axpy(position, travelled, direction);
      remaining = axpy(remaining, -travelled, direction);
      const normal = hit.normal,
        cosine = dot(normal, up);
      this.hits.push({
        collider: hit.collider,
        point: hit.point,
        normal,
        translationApplied: scale(direction, travelled),
        translationRemaining: [...remaining],
      });
      if (this.pushes && hit.body.type === 'dynamic') {
        const into = -dot(remaining, normal) / dt;
        if (into > 0) {
          const mb = hit.body.mass,
            reduced = mb > 0 ? (this.mass * mb) / (this.mass + mb) : this.mass;
          hit.body.applyImpulse(scale(normal, -reduced * into * dt), hit.point);
        }
      }
      // A step: an obstacle the character cannot walk up, with room above it and ground beyond.
      const horizontal = axpy(remaining, -dot(remaining, up), up),
        horizontalSpan = length(horizontal);
      const step = this.autostep;
      if (
        step &&
        cosine < cosClimb &&
        horizontalSpan > EPS &&
        (step.includeDynamicBodies || hit.body.type !== 'dynamic') &&
        (groundedBefore || probeGround(position))
      ) {
        const rise = cast(position, up, step.maxHeight, true),
          height = rise ? Math.max(0, rise.distance) : step.maxHeight;
        if (height > EPS) {
          const raised = axpy(position, height, up),
            way = scale(horizontal, 1 / horizontalSpan),
            probe = Math.max(horizontalSpan, step.minWidth),
            ahead = cast(raised, way, probe, true),
            room = ahead ? Math.max(0, ahead.distance) : probe;
          if (room >= step.minWidth - 1e-5) {
            const run = Math.min(room, Math.max(horizontalSpan, step.minWidth)),
              over = axpy(raised, run, way),
              land = cast(over, down, height + this.offset + 1e-3, true);
            if (land && dot(land.normal, up) >= cosClimb - 1e-4 && land.distance < height - 1e-4) {
              position = axpy(over, -Math.max(0, land.distance), up);
              remaining = axpy([0, 0, 0], Math.max(0, horizontalSpan - run), way);
              continue;
            }
          }
        }
      }
      if (!this.slide) {
        remaining = [0, 0, 0];
        break;
      }
      const angleDown = cosine > 0 && cosine >= cosClimb - 1e-6;
      if (angleDown) {
        // A slope it can climb: keep the horizontal distance, rising or falling with the surface.
        const along = axpy(horizontal, -dot(horizontal, normal) / cosine, up),
          vertical = scale(up, dot(remaining, up));
        let result = along;
        const wants = dot(vertical, up);
        if (cosine < cosSlide + 1e-6 || wants > 0) {
          // Steeper than the slide angle lets gravity pull along the surface; a push upward follows it too.
          result = axpy(along, 1, axpy(vertical, -dot(vertical, normal), normal));
        }
        remaining = result;
      } else {
        // A wall, a ceiling or a slope too steep: stop going into it, and do not gain height against it.
        const sideways = axpy(normal, -cosine, up),
          sideLength = length(sideways),
          plane: V = cosine < 0 || sideLength < 1e-4 ? [...normal] : scale(sideways, 1 / sideLength),
          into = dot(remaining, plane);
        if (into < 0) remaining = axpy(remaining, -into, plane);
      }
    }
    // Walking down stairs and slopes: follow the ground within the snap distance unless moving up on purpose.
    let grounded = probeGround(position);
    if (this.snap !== null && !grounded && (groundedBefore || this.lastGrounded) && dot(desired, up) <= EPS) {
      const hit = cast(position, down, this.snap + this.offset);
      if (hit && dot(hit.normal, up) >= cosClimb - 1e-4) {
        position = axpy(position, Math.max(0, hit.distance), down);
        grounded = true;
      }
    }
    const movement: V = [position[0] - start[0], position[1] - start[1], position[2] - start[2]];
    body.setNextPosition([bodyPosition[0] + movement[0], bodyPosition[1] + movement[1], bodyPosition[2] + movement[2]]);
    this.lastGrounded = grounded;
    return { movement, grounded, collisions: this.hits.length };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.owner.removeController(this);
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
