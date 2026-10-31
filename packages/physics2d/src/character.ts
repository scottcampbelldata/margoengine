import type { Body2D } from './body.js';
import type { KinematicCharacterController2D, World2D } from './rapier-types.js';
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
  /** Mass used when pushing, Rapier units. */
  mass?: number;
}

/** What one `move` did. */
export interface CharacterMoveResult2D {
  /** The movement that was applied, world units. */
  movement: [number, number];
  grounded: boolean;
  /** Number of contacts the move hit. */
  collisions: number;
}

/** Moves a kinematic position body around obstacles. Call `move` once per fixed step (from `beforestep`). */
export class CharacterController2D {
  /** @internal */
  constructor(
    private readonly world: World2D,
    private readonly raw: KinematicCharacterController2D,
    readonly body: Body2D,
    private readonly scale: number,
    private readonly onDispose: (controller: CharacterController2D) => void,
    private readonly refresh: () => void,
  ) {}
  /** Computes the movement for `delta` (world units) and sets the body's next position. */
  move(delta: Vec2D): CharacterMoveResult2D {
    const collider = this.body.colliders[0];
    if (!collider) throw new TypeError('The character body has no collider; add one with body.addCollider.');
    const k = this.scale;
    this.refresh();
    this.raw.computeColliderMovement(collider, { x: delta[0] * k, y: delta[1] * k });
    const m = this.raw.computedMovement(),
      t = this.body.raw.translation();
    this.body.raw.setNextKinematicTranslation({ x: t.x + m.x, y: t.y + m.y });
    return {
      movement: [m.x / k, m.y / k],
      grounded: this.raw.computedGrounded(),
      collisions: this.raw.numComputedCollisions(),
    };
  }
  dispose(): void {
    this.world.removeCharacterController(this.raw);
    this.onDispose(this);
  }
  declare [Symbol.dispose]: () => void;
}
CharacterController2D.prototype[Symbol.dispose] = CharacterController2D.prototype.dispose;
