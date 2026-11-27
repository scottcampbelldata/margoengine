/// <reference lib="esnext.disposable" preserve="true" />
import { MargoError } from '@margoengine/math/errors';
import type { PhysicsCollider } from './collider.js';
import type { PhysicsBody, BodyOptions } from './body.js';
import type { Physics, QueryFilter, ShapeCastHit } from './physics.js';
import { checkVec, type Vec3 } from './math.js';
import type { ShapeOptions } from './shapes.js';
import { DebugLineWriter, drawPrimitiveOutline, type DebugLines } from './debug.js';

/** Options of {@link CharacterController.debugRender} and {@link DynamicCharacter.debugRender}. */
export interface CharacterDebugOptions {
  /** Draw the sweep collider wireframe (green grounded, orange sliding, cyan airborne). Default true. */
  capsule?: boolean;
  /** Draw the ground contact point, ground normal and slope angle indicator. Default true. */
  ground?: boolean;
  /** Draw the last autostep probe path (rise, forward reach, landing probe). Default true. */
  autostep?: boolean;
  /** Draw the inherited moving-platform velocity vector at the feet. Default true. */
  platformVelocity?: boolean;
  /** Draw contact normals from obstacles hit during the last move. Default true. */
  contacts?: boolean;
  /** Length of ground and contact normal arrows in metres. Default 0.4. */
  normalLength?: number;
  /** Seconds multiplier turning platform velocity (m/s) into line length (m). Default 0.35. */
  velocityScale?: number;
}

/**
 * A length that is absolute (metres) or relative to the character's height, Rapier's `CharacterLength`: `{relative: 0.1}` is a
 * tenth of the height of the character's collider along `up`.
 */
export type CharacterLength = number | { relative: number };

/** Options for a kinematic character controller; every field has a default. */
export interface CharacterControllerOptions {
  /** Gap kept between the character and obstacles (default 0.01). */
  offset?: CharacterLength;
  /** Up direction (default [0, 1, 0]). */
  up?: Vec3;
  /** Steepest slope the character can walk up, radians (default 45 degrees). */
  maxSlopeClimbAngle?: number;
  /** Slopes steeper than this make the character slide down, radians (default 30 degrees). */
  minSlopeSlideAngle?: number;
  /** Climb steps automatically, or false to disable (default {maxHeight: 0.3, minWidth: 0.2, includeDynamicBodies: false}). */
  autostep?: false | { maxHeight: CharacterLength; minWidth: CharacterLength; includeDynamicBodies?: boolean };
  /** Snap down to the ground within this distance while walking down stairs and slopes, or false (default 0.2). */
  snapToGround?: false | CharacterLength;
  /**
   * A small distance, along the contact normal, the character is pushed every time it slides, so it does not catch on what
   * it slides along (Rapier's `normal_nudge_factor`; default 0.0001 metres). Raise it if the character sticks.
   */
  normalNudgeFactor?: number;
  /** Slide along obstacles instead of stopping (default true). */
  slide?: boolean;
  /** Push dynamic bodies it walks into (default false). */
  applyImpulsesToDynamicBodies?: boolean;
  /** Mass used when pushing dynamic bodies (default 1). */
  characterMass?: number;
  /**
   * The most force the character puts into a body it pushes, in newtons (default no limit): a push is an impulse over one step, and
   * it is capped at `maxPushStrength * dt`, so a strong character still cannot shift what it cannot lift (Jolt's `mMaxStrength`).
   */
  maxPushStrength?: number;
  /**
   * Bodies heavier than this many times `characterMass` are not pushed at all and act as walls (default no limit): a person does
   * not shove a lorry. Lighter ones are pushed with the reduced mass of the pair, as before.
   */
  maxPushMassRatio?: number;
  /**
   * Carry the character along with the body it stands on (default true): a moving platform, a lift or a turning deck adds its
   * velocity at the foot to every move, the turn of a platform about `up` turns the character with it, and what stops the
   * platform's motion (a wall) stops the character too. The controller's `platform` is the body it stands on.
   */
  inheritPlatformVelocity?: boolean;
  /**
   * An inner body for other bodies to hit (Jolt's inner rigid body): a second `kinematicPosition` body made with these colliders
   * that follows the character's body, in whatever groups and shape the colliders give. The character's own cast never meets it, so
   * its shape can be larger (a hit box with arms) or smaller than the shape the character walks with. Removed with the controller.
   */
  innerBody?: { colliders: NonNullable<BodyOptions['colliders']> };
}

/** The two methods of `Physics` the inner body needs: the controller is made by `Physics.createCharacterController`, which is one. */
type BodyHost = Pick<Physics, 'addBody' | 'removeBody'>;

/** What a contact listener is told about one obstacle, as the move meets it. */
export interface CharacterContact extends CharacterCollision {
  /** The body that was met. */
  body: PhysicsBody;
  /** Set false in the listener to leave this body alone (no push) though it still blocks the character; default true for a dynamic body. */
  canPush: boolean;
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
  /** The move slid down a slope steeper than `minSlopeSlideAngle` (Rapier's `is_sliding_down_slope`). */
  slidingDownSlope: boolean;
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
/** How much of a unit motion may point into a surface for the motion to count as along it. */
const GRAZE = 1e-3;
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

/** Where a body's collider is in the world: its position and rotation, for casting the collider's shape from where it stands. */
export function colliderPose(
  body: PhysicsBody,
  collider: PhysicsCollider,
): { position: [number, number, number]; rotation: [number, number, number, number] } {
  const at = body.position,
    local = collider.translationWrtParent(),
    turn = collider.rotationWrtParent(),
    offset = rotate(body.rotation, [local.x, local.y, local.z]);
  return {
    position: [at[0] + offset[0], at[1] + offset[1], at[2] + offset[2]],
    rotation: multiply(body.rotation, [turn.x, turn.y, turn.z, turn.w]),
  };
}

/** The cast shape of a sphere, box, capsule, cylinder or cone collider (what a character is swept as). */
export function colliderShape(collider: PhysicsCollider): ShapeOptions {
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
 * A kinematic character controller on a kinematic position-based body, written over the world's shape casts: it slides
 * along obstacles, climbs slopes up to a limit, slides down steeper ones, climbs steps, snaps to the ground and can push
 * dynamic bodies. Call `move(desired)` once per fixed step (for example from `physics.on('beforestep')`).
 */
export class CharacterController {
  private disposed = false;
  private lastGrounded = false;
  private readonly offsetLength: CharacterLength;
  private readonly nudge: number;
  private sliding = false;
  private lastMovement: V = [0, 0, 0];
  private readonly up: V;
  private readonly maxClimb: number;
  private readonly minSlide: number;
  private readonly autostepLengths: {
    maxHeight: CharacterLength;
    minWidth: CharacterLength;
    includeDynamicBodies: boolean;
  } | null;
  private readonly snapLength: CharacterLength | null;
  private readonly slide: boolean;
  private readonly pushes: boolean;
  private readonly mass: number;
  private readonly maxStrength: number;
  private readonly maxRatio: number;
  private readonly inherits: boolean;
  private readonly inner: PhysicsBody | null;
  private readonly listeners = new Set<(contact: CharacterContact) => void>();
  private ground: PhysicsBody | null = null;
  private readonly hits: CharacterCollision[] = [];
  private lastGroundPoint: V | null = null;
  private lastGroundNormal: V | null = null;
  private lastSlopeAngle = 0;
  private lastPlatformVelocity: V = [0, 0, 0];
  private lastAutostepProbe: { start: V; raised: V; over: V; land: V | null; ok: boolean } | null = null;

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
    this.offsetLength = options.offset ?? 0.01;
    for (const [name, l] of [
      ['offset', this.offsetLength],
      ['autostep maxHeight', options.autostep ? options.autostep.maxHeight : 0],
      ['autostep minWidth', options.autostep ? options.autostep.minWidth : 0],
      ['snapToGround', options.snapToGround ? options.snapToGround : 0],
    ] as const) {
      const value = typeof l === 'number' ? l : l.relative;
      if (!(value >= 0))
        throw new RangeError(
          `${name} must be zero or more, in metres or as {relative: a share of the character's height}`,
        );
    }
    this.nudge = options.normalNudgeFactor ?? 1e-4;
    if (!(this.nudge >= 0)) throw new RangeError('normalNudgeFactor must be zero or more');
    this.maxClimb = options.maxSlopeClimbAngle ?? Math.PI / 4;
    this.minSlide = options.minSlopeSlideAngle ?? Math.PI / 6;
    const step =
      options.autostep === undefined
        ? { maxHeight: 0.3, minWidth: 0.2, includeDynamicBodies: false }
        : options.autostep;
    this.autostepLengths = step
      ? { maxHeight: step.maxHeight, minWidth: step.minWidth, includeDynamicBodies: step.includeDynamicBodies ?? false }
      : null;
    const snap = options.snapToGround === undefined ? 0.2 : options.snapToGround;
    this.snapLength = snap === false ? null : snap;
    this.slide = options.slide ?? true;
    this.pushes = options.applyImpulsesToDynamicBodies ?? false;
    this.mass = options.characterMass ?? 1;
    this.maxStrength = options.maxPushStrength ?? Infinity;
    this.maxRatio = options.maxPushMassRatio ?? Infinity;
    for (const [name, value] of [
      ['characterMass', this.mass],
      ['maxPushStrength', this.maxStrength],
      ['maxPushMassRatio', this.maxRatio],
    ] as const)
      if (!(value > 0)) throw new RangeError(`${name} must be more than zero (omit it for no limit)`);
    this.inherits = options.inheritPlatformVelocity ?? true;
    this.inner = options.innerBody
      ? (owner as unknown as BodyHost).addBody(null, {
          type: 'kinematicPosition',
          position: body.position,
          rotation: body.rotation,
          colliders: options.innerBody.colliders,
        })
      : null;
  }

  /** The body the character stood on at the start of the last move, or null in the air (what `inheritPlatformVelocity` carries it with). */
  get platform(): PhysicsBody | null {
    return this.ground;
  }
  /** The inner body other bodies hit, when the controller was made with `innerBody`. */
  get innerBody(): PhysicsBody | null {
    return this.inner;
  }
  /**
   * Calls `listener` for every obstacle a move meets, as it meets it, with the body, the contact and a `canPush` flag the listener
   * may clear (Jolt's contact listener). Returns a function that removes the listener.
   */
  onContact(listener: (contact: CharacterContact) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /** Whether the last move ended on ground it can stand on. */
  get grounded(): boolean {
    return this.lastGrounded;
  }
  /** The obstacles the last move met, in order. */
  get collisions(): readonly CharacterCollision[] {
    return this.hits;
  }
  /** Whether the last move slid down a slope steeper than `minSlopeSlideAngle` (Rapier's `is_sliding_down_slope`). */
  get isSlidingDownSlope(): boolean {
    return this.sliding;
  }
  /** Outward normal of the ground under the character at the end of the last move, or `up` in the air. */
  get groundNormal(): [number, number, number] {
    return this.lastGroundNormal ? [...this.lastGroundNormal] : [...this.up];
  }
  /** Slope angle of the ground under the character at the end of the last move, in radians (0 when flat or airborne). */
  get slopeAngle(): number {
    return this.lastSlopeAngle;
  }
  /** World-space velocity inherited from the platform at the start of the last move, in m/s. */
  get platformVelocity(): [number, number, number] {
    return [...this.lastPlatformVelocity];
  }
  /** The movement the last move allowed (Rapier's `computed_movement`). */
  computedMovement(): [number, number, number] {
    return [...this.lastMovement];
  }
  /** Whether the last move ended grounded (Rapier's `computed_grounded`). */
  computedGrounded(): boolean {
    return this.lastGrounded;
  }
  /** How many obstacles the last move met (Rapier's `num_computed_collisions`). */
  numComputedCollisions(): number {
    return this.hits.length;
  }
  /** The i-th obstacle the last move met (Rapier's `computed_collision`), or undefined past the last. */
  computedCollision(i: number): CharacterCollision | undefined {
    return this.hits[i];
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
      shape = colliderShape(collider),
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
    // The character's height along `up`, for lengths given relative to it.
    const box = collider.aabb(),
      height =
        Math.abs(up[0]) * (box.max[0] - box.min[0]) +
        Math.abs(up[1]) * (box.max[1] - box.min[1]) +
        Math.abs(up[2]) * (box.max[2] - box.min[2]);
    const metres = (l: CharacterLength): number => (typeof l === 'number' ? l : l.relative * height);
    const offset = metres(this.offsetLength),
      snap = this.snapLength === null ? null : metres(this.snapLength),
      autostep = this.autostepLengths
        ? {
            maxHeight: metres(this.autostepLengths.maxHeight),
            minWidth: metres(this.autostepLengths.minWidth),
            includeDynamicBodies: this.autostepLengths.includeDynamicBodies,
          }
        : null;
    let slidingDown = false;
    const flags = filter?.flags ?? 0;
    if (flags & 1) exclude.excludeFixed = true;
    if (flags & 2) exclude.excludeKinematic = true;
    if (flags & 4) exclude.excludeDynamic = true;
    if (flags & 8) exclude.excludeSensors = true;
    if (flags & 16) exclude.excludeSolids = true;
    const predicate = filter?.predicate,
      inner = this.inner;
    if (predicate || inner) exclude.predicate = (hitBody, hit) => hitBody !== inner && (!predicate || predicate(hit));
    const cast = (
      position: Vec3,
      direction: Vec3,
      max: number,
      ignoreDynamic = false,
      target = offset,
    ): ShapeCastHit | null =>
      this.owner.shapeCast(shape, position, rotation, direction, {
        ...exclude,
        excludeDynamic: exclude.excludeDynamic || ignoreDynamic,
        maxDistance: max,
        // The controller rests a skin off what it stands on and slides along it, so a shape that touches without moving into
        // a surface is not an obstacle: only a cast that closes the gap to the target distance stops it.
        stopAtPenetration: false,
        targetDistance: target,
      });
    let groundHit: ShapeCastHit | null = null;
    const probeGround = (position: Vec3): boolean => {
      const hit = cast(position, down, offset * 2 + 1e-3);
      const ok = !!hit && dot(hit.normal, up) >= cosClimb - 1e-4 && hit.distance <= offset + 1e-3;
      groundHit = ok ? hit : null;
      return ok;
    };

    this.hits.length = 0;
    this.lastAutostepProbe = null;
    const groundedBefore = probeGround(start);
    const dt = this.owner.fixedTimestep;
    // What the ground under the character does this step: a moving body carries it by its velocity at the foot, and a turn about
    // `up` turns it too.
    const standingOn = groundHit as ShapeCastHit | null;
    this.ground = standingOn ? standingOn.body : null;
    let carried: V = [0, 0, 0],
      carriedTurn = 0;
    this.lastPlatformVelocity = [0, 0, 0];
    if (this.inherits && standingOn && standingOn.body.type !== 'fixed') {
      const v = standingOn.body.velocityAtPoint(standingOn.point),
        w = standingOn.body.angularVelocity;
      this.lastPlatformVelocity = [v[0], v[1], v[2]];
      carried = scale(v, dt);
      carriedTurn = dot(w, up) * dt;
    }
    const wish: V = [desired[0] + carried[0], desired[1] + carried[1], desired[2] + carried[2]];
    let position: V = [...start],
      remaining: V = [...wish];
    for (let iteration = 0; iteration < 8; iteration++) {
      const span = length(remaining);
      if (span < EPS) break;
      const direction = scale(remaining, 1 / span),
        first = cast(position, direction, span);
      // A character resting at its skin distance from a surface is already within the target distance of it, so a cast along
      // that surface reports a hit at distance 0 although nothing is in the way. A hit that is not approached (the motion
      // goes along or away from the surface) is no obstacle: cast again to touch, so what really lies ahead still stops it.
      const hit =
        first && first.distance <= EPS && dot(direction, first.normal) > -GRAZE
          ? cast(position, direction, span, false, 0)
          : first;
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
      const contact: CharacterContact = {
        ...this.hits[this.hits.length - 1]!,
        body: hit.body,
        canPush: hit.body.type === 'dynamic',
      };
      for (const listener of this.listeners) listener(contact);
      if (this.pushes && contact.canPush && hit.body.type === 'dynamic') {
        // The character closes on the body at the speed it wants into it (the whole step's wish, not what is left after the gap
        // is crossed), less the body's own speed away from it, so a light crate soon goes at the walking pace and a heavy one
        // takes the reduced mass of the pair.
        const mb = hit.body.mass,
          closing = -dot(wish, normal) / dt + dot(hit.body.velocityAtPoint(hit.point), normal);
        if (closing > 0 && mb <= this.maxRatio * this.mass) {
          const reduced = mb > 0 ? (this.mass * mb) / (this.mass + mb) : this.mass,
            impulse = Math.min(reduced * closing, this.maxStrength * dt);
          hit.body.applyImpulse(scale(normal, -impulse), hit.point);
        }
      }
      // A step: an obstacle the character cannot walk up, with room above it and ground beyond.
      const horizontal = axpy(remaining, -dot(remaining, up), up),
        horizontalSpan = length(horizontal);
      const step = autostep;
      if (
        step &&
        cosine < cosClimb &&
        horizontalSpan > EPS &&
        (step.includeDynamicBodies || hit.body.type !== 'dynamic') &&
        (groundedBefore || probeGround(position))
      ) {
        const rise = cast(position, up, step.maxHeight, !step.includeDynamicBodies),
          height = rise ? Math.max(0, rise.distance) : step.maxHeight;
        if (height > EPS) {
          const raised = axpy(position, height, up),
            way = scale(horizontal, 1 / horizontalSpan),
            probe = Math.max(horizontalSpan, step.minWidth),
            ahead = cast(raised, way, probe, !step.includeDynamicBodies),
            room = ahead ? Math.max(0, ahead.distance) : probe;
          if (room >= step.minWidth - 1e-5) {
            const run = Math.min(room, Math.max(horizontalSpan, step.minWidth)),
              over = axpy(raised, run, way),
              land = cast(over, down, height + offset + 1e-3, !step.includeDynamicBodies);
            const landed = !!land && dot(land.normal, up) >= cosClimb - 1e-4 && land.distance < height - 1e-4;
            this.lastAutostepProbe = {
              start: [...position],
              raised: [...raised],
              over: [...over],
              land: land ? axpy(over, -Math.max(0, land.distance), up) : null,
              ok: landed,
            };
            if (landed && land) {
              position = axpy(over, -Math.max(0, land.distance), up);
              remaining = axpy([0, 0, 0], Math.max(0, horizontalSpan - run), way);
              continue;
            }
          } else {
            this.lastAutostepProbe = {
              start: [...position],
              raised: [...raised],
              over: axpy(raised, room, way),
              land: null,
              ok: false,
            };
          }
        }
      }
      if (!this.slide) {
        remaining = [0, 0, 0];
        break;
      }
      // Sliding along what it met: nudged off it a little, so it does not catch on it.
      position = axpy(position, this.nudge, normal);
      const angleDown = cosine > 0 && cosine >= cosClimb - 1e-6;
      if (angleDown) {
        // A slope it can climb: keep the horizontal distance, rising or falling with the surface.
        const along = axpy(horizontal, -dot(horizontal, normal) / cosine, up),
          vertical = scale(up, dot(remaining, up));
        let result = along;
        const wants = dot(vertical, up);
        if (cosine < cosSlide + 1e-6 || wants > 0) {
          if (wants < 0 && cosine < cosSlide + 1e-6) slidingDown = true;
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
    let finalGroundHit: ShapeCastHit | null = groundHit;
    if (snap !== null && !grounded && (groundedBefore || this.lastGrounded) && dot(desired, up) <= EPS) {
      const hit = cast(position, down, snap + offset);
      if (hit && dot(hit.normal, up) >= cosClimb - 1e-4) {
        position = axpy(position, Math.max(0, hit.distance), down);
        grounded = true;
        finalGroundHit = hit;
      }
    }
    if (finalGroundHit) {
      this.lastGroundPoint = [...finalGroundHit.point];
      this.lastGroundNormal = [...finalGroundHit.normal];
      this.lastSlopeAngle = Math.acos(Math.max(-1, Math.min(1, dot(finalGroundHit.normal, up))));
    } else {
      this.lastGroundPoint = null;
      this.lastGroundNormal = null;
      this.lastSlopeAngle = 0;
    }
    const movement: V = [position[0] - start[0], position[1] - start[1], position[2] - start[2]];
    const next: V = [bodyPosition[0] + movement[0], bodyPosition[1] + movement[1], bodyPosition[2] + movement[2]];
    body.setNextPosition(next);
    let nextRotation: readonly number[] = bodyRotation;
    if (carriedTurn !== 0) {
      const half = carriedTurn / 2,
        s = Math.sin(half);
      nextRotation = multiply([up[0] * s, up[1] * s, up[2] * s, Math.cos(half)], bodyRotation);
      body.setNextRotation(nextRotation as [number, number, number, number]);
    }
    if (inner) {
      inner.setNextPosition(next);
      inner.setNextRotation(nextRotation as [number, number, number, number]);
    }
    this.lastGrounded = grounded;
    this.sliding = slidingDown;
    this.lastMovement = movement;
    return { movement, grounded, collisions: this.hits.length, slidingDownSlope: slidingDown };
  }

  /**
   * Debug line segments for this character controller: sweep collider outline (tinted by grounded/sliding/airborne),
   * ground normal and slope angle indicator, last autostep probe, platform velocity vector, and obstacle contact normals.
   */
  debugRender(options: CharacterDebugOptions = {}): DebugLines {
    if (this.disposed || !this.body.valid || !this.body.colliders.length)
      return { vertices: new Float32Array(0), colors: new Float32Array(0) };
    const {
        capsule = true,
        ground = true,
        autostep = true,
        platformVelocity = true,
        contacts = true,
        normalLength = 0.4,
        velocityScale = 0.35,
      } = options,
      out = new DebugLineWriter(),
      collider = this.body.colliders[0]!,
      pose = colliderPose(this.body, collider);
    if (capsule) {
      const tint: readonly [number, number, number, number] = !this.lastGrounded
        ? [0.25, 0.78, 1, 1]
        : this.sliding
          ? [1, 0.55, 0.15, 1]
          : [0.2, 0.92, 0.45, 1];
      drawPrimitiveOutline(out, collider, pose.position, pose.rotation, tint);
    }
    if (ground && this.lastGroundPoint && this.lastGroundNormal) {
      const p = this.lastGroundPoint,
        n = this.lastGroundNormal,
        steep = this.lastSlopeAngle > this.maxClimb + 1e-4,
        normColor: readonly [number, number, number, number] = steep ? [1, 0.25, 0.2, 1] : [0.25, 1, 0.5, 1];
      out.cross(p, 0.05, normColor);
      out.segment(p, axpy(p, normalLength, n), normColor);
      if (this.lastSlopeAngle > 0.01) {
        // Draw slope-angle reference arc between world up and ground normal.
        const upEnd = axpy(p, normalLength * 0.7, this.up);
        out.segment(p, upEnd, [0.75, 0.75, 0.8, 0.7]);
        const steps = 6;
        let prev = upEnd;
        for (let i = 1; i <= steps; i++) {
          const t = i / steps,
            mix: V = [
              this.up[0] * (1 - t) + n[0] * t,
              this.up[1] * (1 - t) + n[1] * t,
              this.up[2] * (1 - t) + n[2] * t,
            ],
            l = length(mix) || 1,
            cur = axpy(p, (normalLength * 0.7) / l, mix);
          out.segment(prev, cur, steep ? [1, 0.3, 0.2, 1] : [1, 0.85, 0.2, 1]);
          prev = cur;
        }
      }
    }
    if (autostep && this.lastAutostepProbe) {
      const pr = this.lastAutostepProbe,
        c: readonly [number, number, number, number] = pr.ok ? [1, 0.85, 0.15, 1] : [1, 0.35, 0.25, 0.9];
      out.segment(pr.start, pr.raised, c);
      out.segment(pr.raised, pr.over, c);
      if (pr.land) {
        out.segment(pr.over, pr.land, c);
        out.cross(pr.land, 0.04, c);
      }
    }
    if (platformVelocity && length(this.lastPlatformVelocity) > 1e-4) {
      const origin = this.lastGroundPoint ?? pose.position,
        end = axpy(origin, velocityScale, this.lastPlatformVelocity);
      out.segment(origin, end, [0.95, 0.3, 0.95, 1]);
      out.cross(end, 0.04, [0.95, 0.3, 0.95, 1]);
    }
    if (contacts)
      for (const hit of this.hits) {
        out.cross(hit.point, 0.03, [1, 0.45, 0.15, 1]);
        out.segment(hit.point, axpy(hit.point, normalLength * 0.6, hit.normal), [1, 0.45, 0.15, 1]);
      }
    return out.finish();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.clear();
    if (this.inner?.valid) (this.owner as unknown as BodyHost).removeBody(this.inner);
    this.owner.removeController(this);
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
