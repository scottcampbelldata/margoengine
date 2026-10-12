import type {PhysicsBody} from './body.js';
import {checkVec, tuple, vec, type Vec3} from './math.js';

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
  autostep?: false | {maxHeight: number; minWidth: number; includeDynamicBodies?: boolean};
  /** Snap down to the ground within this distance while walking down stairs and slopes, or false (default 0.2). */
  snapToGround?: false | number;
  /** Slide along obstacles instead of stopping (default true). */
  slide?: boolean;
  /** Push dynamic bodies it walks into (default false). */
  applyImpulsesToDynamicBodies?: boolean;
  /** Mass used when pushing dynamic bodies. */
  characterMass?: number;
}

export interface CharacterMoveResult {
  /** The movement actually allowed this step. */
  movement: [number, number, number];
  grounded: boolean;
  /** Number of obstacles hit while computing the movement. */
  collisions: number;
}

/**
 * Rapier's KinematicCharacterController driving a kinematic position-based body.
 * Call `move(desired)` once per fixed step (for example from `physics.on('beforestep')`).
 */
export class CharacterController {
  readonly raw: any;
  private disposed = false;
  private lastGrounded = false;

  /** @internal */
  constructor(private readonly owner: {readonly world: any; removeController(controller: CharacterController): void}, readonly body: PhysicsBody, options: CharacterControllerOptions = {}) {
    if (body.type !== 'kinematicPosition') throw new TypeError('A character controller needs a kinematicPosition body');
    if (!body.colliders.length) throw new TypeError('A character controller body needs a collider');
    const raw = owner.world.createCharacterController(options.offset ?? 0.01);
    this.raw = raw;
    if (options.up) {checkVec(options.up, 'Up'); raw.setUp(vec(options.up));}
    raw.setMaxSlopeClimbAngle(options.maxSlopeClimbAngle ?? Math.PI / 4);
    raw.setMinSlopeSlideAngle(options.minSlopeSlideAngle ?? Math.PI / 6);
    const step = options.autostep === undefined ? {maxHeight: 0.3, minWidth: 0.2, includeDynamicBodies: false} : options.autostep;
    if (step) raw.enableAutostep(step.maxHeight, step.minWidth, step.includeDynamicBodies ?? false);
    const snap = options.snapToGround === undefined ? 0.2 : options.snapToGround;
    if (snap !== false) raw.enableSnapToGround(snap);
    raw.setSlideEnabled(options.slide ?? true);
    raw.setApplyImpulsesToDynamicBodies(options.applyImpulsesToDynamicBodies ?? false);
    if (options.characterMass !== undefined) raw.setCharacterMass(options.characterMass);
  }

  get grounded(): boolean {return this.lastGrounded;}

  /**
   * Computes how far the character can move toward `desired` (a translation for this step, gravity included)
   * and schedules it as the body's next kinematic position.
   */
  move(desired: Vec3, filter?: {groups?: number; flags?: number; predicate?: (collider: any) => boolean}): CharacterMoveResult {
    if (this.disposed) throw new Error('Character controller is disposed');
    if (!this.body.valid) throw new Error('Character body was removed');
    checkVec(desired, 'Desired movement');
    const collider = this.body.colliders[0];
    this.raw.computeColliderMovement(collider, vec(desired), filter?.flags, filter?.groups, filter?.predicate);
    const movement = tuple(this.raw.computedMovement()), t = this.body.raw.translation();
    this.body.raw.setNextKinematicTranslation({x: t.x + movement[0], y: t.y + movement[1], z: t.z + movement[2]});
    this.lastGrounded = this.raw.computedGrounded();
    return {movement, grounded: this.lastGrounded, collisions: this.raw.numComputedCollisions()};
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.owner.removeController(this);
  }
}
