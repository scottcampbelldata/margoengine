/// <reference lib="esnext.disposable" preserve="true" />
// Character-ragdoll bridge: links a kinematic CharacterController or DynamicCharacter with a Ragdoll, optional
// Animator, RagdollMotors and GetUp. Isolates collision groups so a character never collides with its own ragdoll
// hitboxes, carries walking momentum into a knockdown while disabling the controller capsule, and recovers smoothly
// from the settled hips position back into walking with zero pop. Written clean room; no engine's source was read.
import type { Mesh } from '@margoengine/core/extension';
import type { Animator } from '@margoengine/animator';
import type {
  CharacterController,
  CharacterDebugOptions,
  CharacterMoveFilter,
  CharacterMoveResult,
  DebugLines,
  DynamicCharacter,
  PhysicsBody,
  PhysicsCollider,
} from '@margoengine/physics';
import { MargoError } from '@margoengine/math/errors';
import { ragdollError } from './errors.js';
import { addGetUp, type GetUp, type GetUpOptions, type GetUpSide } from './getup.js';
import { addRagdollMotors, type RagdollMotorOptions, type RagdollMotors } from './powered.js';
import type { Ragdoll, RagdollDebugOptions, RagdollLimb, RagdollPart } from './ragdoll.js';

/** Lifecycle state of a {@link CharacterRagdoll}. */
export type CharacterRagdollState = 'walking' | 'ragdoll' | 'recovering';

/** Options of {@link addCharacterRagdoll}. */
export interface CharacterRagdollOptions {
  /** Kinematic `CharacterController` or dynamic `DynamicCharacter` driving locomotion. */
  controller: CharacterController | DynamicCharacter;
  /** Ragdoll attached to the same `Physics` world and skeleton. */
  ragdoll: Ragdoll;
  /** Optional animator controlling the character's clips (required if `getUp` is passed as options). */
  animator?: Animator;
  /** Optional pre-created `RagdollMotors`, or options to create one automatically. */
  motors?: RagdollMotors | RagdollMotorOptions;
  /** Optional pre-created `GetUp`, or options to create one automatically (requires `animator`). */
  getUp?: GetUp | GetUpOptions;
  /**
   * Top-level visual mesh moved with the character controller while walking. Defaults to `animator.animation.model.root`
   * when an animator is provided, or `controller.body.mesh` if set.
   */
  root?: Mesh;
  /**
   * Offset from `controller.body.position` to `root` world position while walking (e.g. `[0, -0.9, 0]` when a capsule's
   * center is 0.9 m above the feet). Defaults to the initial `root.position - controller.body.position` at construction.
   */
  rootOffset?: readonly [number, number, number];
  /**
   * Collision group index (0..15) assigned to the character controller's capsule so it never collides with its own
   * ragdoll hitboxes while still colliding with the world. Default 14 (group 15 is the ragdoll's default).
   */
  characterGroup?: number;
  /** World up unit vector. Default `[0, 1, 0]`. */
  up?: readonly [number, number, number];
}

/** Options of {@link CharacterRagdoll.knockdown}. */
export interface CharacterKnockdownOptions {
  /** World point where the impact impulse lands. Default the struck bone's centre of mass. */
  point?: readonly [number, number, number];
  /**
   * When given, activates only that limb (partial ragdoll) and keeps the character walking instead of disabling the
   * controller. Omit for a full-body knockdown.
   */
  limb?: RagdollLimb;
  /** Motor strength while knocked down (when `motors` is present). Default 0 (full limp). */
  motorStrength?: number;
  /** Share of motor strength weakened on a partial-ragdoll hit. Default 0.8. */
  weaken?: number;
  /** Seconds for a partial-ragdoll hit to recover motor strength. Default 0.6. */
  recover?: number;
}

/** Options of {@link CharacterRagdoll.recover}. */
export interface CharacterRecoverOptions {
  /** Force `'faceUp'` or `'faceDown'` get-up clip instead of picking automatically. */
  side?: GetUpSide;
  /** Blend duration in seconds when recovering without a `GetUp` clip. Default 0.4. */
  blend?: number;
  /** Motor strength to restore once recovery finishes (when `motors` is present). Default the strength before knockdown. */
  motorStrength?: number;
  /** Cancels waiting on recovery; rejects the promise with `signal.reason`. */
  signal?: AbortSignal;
}

/** Result returned when {@link CharacterRagdoll.recover} finishes. */
export interface CharacterRecoverResult {
  /** The get-up clip chosen, or `null` when recovered via direct ragdoll blend without `GetUp`. */
  side: GetUpSide | null;
  /** Root orientation mismatch in radians reported by `GetUp`, or 0 without `GetUp`. */
  mismatch: number;
  /** World position the controller capsule settled onto. */
  capsulePosition: [number, number, number];
}

/** Combined debug render options for {@link CharacterRagdoll.debugRender}. */
export interface CharacterRagdollDebugOptions {
  /** Controller debug options, or `false` to hide the controller overlay. */
  controller?: boolean | CharacterDebugOptions;
  /** Ragdoll debug options, or `false` to hide the ragdoll overlay. */
  ragdoll?: boolean | RagdollDebugOptions;
}

type Vec3 = [number, number, number];

function isKinematicController(c: CharacterController | DynamicCharacter): c is CharacterController {
  return typeof (c as CharacterController).move === 'function';
}

function isMotorsInstance(value: RagdollMotors | RagdollMotorOptions): value is RagdollMotors {
  return typeof (value as RagdollMotors).hit === 'function' && typeof (value as RagdollMotors).fade === 'function';
}

function isGetUpInstance(value: GetUp | GetUpOptions): value is GetUp {
  return typeof (value as GetUp).start === 'function' && typeof (value as GetUp).pick === 'function';
}

function packGroups(memberships: number, filter: number): number {
  return (((memberships & 0xffff) << 16) | (filter & 0xffff)) >>> 0;
}

function concatDebugLines(a: DebugLines, b: DebugLines): DebugLines {
  if (!a.vertices.length) return b;
  if (!b.vertices.length) return a;
  const vertices = new Float32Array(a.vertices.length + b.vertices.length),
    colors = new Float32Array(a.colors.length + b.colors.length);
  vertices.set(a.vertices, 0);
  vertices.set(b.vertices, a.vertices.length);
  colors.set(a.colors, 0);
  colors.set(b.colors, a.colors.length);
  return { vertices, colors };
}

/**
 * First-class bridge between a physics character controller (`CharacterController` or `DynamicCharacter`) and a
 * {@link Ragdoll} (plus optional {@link Animator}, {@link RagdollMotors}, and {@link GetUp}).
 *
 * - Automatically isolates collision groups so the character capsule never self-collides with its own ragdoll hitboxes
 *   while still interacting with floors, slopes, stairs, moving platforms, and pushable crates.
 * - `knockdown()` carries walking momentum into a full ragdoll (disabling controller sweep while limp) or triggers a
 *   partial-limb hit while walking continues.
 * - `recover()` relocates the controller capsule onto the ground beneath `ragdoll.rootPosition`, blends smoothly out of
 *   ragdoll (through `GetUp` when available), and re-enables locomotion with zero pop.
 */
export class CharacterRagdoll {
  /** The linked kinematic or dynamic character controller. */
  readonly controller: CharacterController | DynamicCharacter;
  /** The linked ragdoll. */
  readonly ragdoll: Ragdoll;
  /** The optional animator. */
  readonly animator: Animator | null;
  /** The optional ragdoll motors (passed in or created automatically). */
  readonly motors: RagdollMotors | null;
  /** The optional get-up helper (passed in or created automatically). */
  readonly getUp: GetUp | null;
  /** Visual root mesh synced with the controller while walking, if any. */
  readonly root: Mesh | null;
  /** Packed collision groups assigned to the character controller's colliders. */
  readonly characterGroups: number;

  private currentState: CharacterRagdollState = 'walking';
  private readonly up: Vec3;
  private readonly rootOffset: Vec3;
  private readonly ownsMotors: boolean;
  private readonly ownsGetUp: boolean;
  private readonly ragdollBodies: ReadonlySet<PhysicsBody>;
  private readonly savedGroups = new Map<PhysicsCollider, number>();
  private readonly offAfterStep: () => void;
  private savedMotorStrength = 1;
  private pendingRecovery?: () => void;
  private disposed = false;

  /** @internal use {@link addCharacterRagdoll}. */
  constructor(options: CharacterRagdollOptions) {
    if (!options?.controller?.body || !options.ragdoll?.bones)
      throw ragdollError(
        'addCharacterRagdoll needs { controller, ragdoll }; pass a CharacterController or DynamicCharacter and a Ragdoll.',
      );
    this.controller = options.controller;
    this.ragdoll = options.ragdoll;
    this.animator = options.animator ?? null;

    const up = options.up ?? [0, 1, 0],
      upLen = Math.hypot(up[0], up[1], up[2]);
    if (!(upLen > 0) || !Number.isFinite(upLen))
      throw ragdollError('CharacterRagdoll up must be a nonzero finite [x, y, z]; pass e.g. [0, 1, 0].');
    this.up = [up[0] / upLen, up[1] / upLen, up[2] / upLen];

    this.root =
      options.root ?? this.animator?.animation.model.root ?? (this.controller.body.mesh as Mesh | null) ?? null;
    if (options.rootOffset) {
      if (options.rootOffset.length !== 3 || !options.rootOffset.every(Number.isFinite))
        throw ragdollError('CharacterRagdoll rootOffset must be three finite numbers [x, y, z].');
      this.rootOffset = [options.rootOffset[0], options.rootOffset[1], options.rootOffset[2]];
    } else if (this.root) {
      this.root.engine.store.tick(false);
      const m = this.root.matrix,
        bp = this.controller.body.position;
      this.rootOffset = [m[12]! - bp[0], m[13]! - bp[1], m[14]! - bp[2]];
    } else {
      this.rootOffset = [0, 0, 0];
    }

    if (options.motors) {
      if (isMotorsInstance(options.motors)) {
        this.motors = options.motors;
        this.ownsMotors = false;
      } else {
        this.motors = addRagdollMotors(this.ragdoll, options.motors);
        this.ownsMotors = true;
      }
      this.savedMotorStrength = this.motors.strength;
    } else {
      this.motors = null;
      this.ownsMotors = false;
    }

    if (options.getUp) {
      if (isGetUpInstance(options.getUp)) {
        this.getUp = options.getUp;
        this.ownsGetUp = false;
      } else {
        if (!this.animator)
          throw ragdollError(
            'CharacterRagdoll getUp options need an animator; pass { animator, getUp: { faceUp, faceDown } }.',
          );
        this.getUp = addGetUp(this.ragdoll, this.animator, {
          root: this.root ?? undefined,
          up: this.up,
          ...options.getUp,
        });
        this.ownsGetUp = true;
      }
    } else {
      this.getUp = null;
      this.ownsGetUp = false;
    }

    // Isolate character controller colliders from ragdoll hitboxes so they never self-collide.
    const ragdollMask = (this.ragdoll.settings.collisionGroups >>> 16) & 0xffff;
    let groupIndex = options.characterGroup ?? 14;
    if (!Number.isInteger(groupIndex) || groupIndex < 0 || groupIndex > 15)
      throw ragdollError(`CharacterRagdoll characterGroup must be an integer from 0 to 15 (got ${groupIndex}).`);
    if (ragdollMask & (1 << groupIndex)) {
      let free = -1;
      for (let bit = 15; bit >= 0; bit--)
        if ((ragdollMask & (1 << bit)) === 0) {
          free = bit;
          break;
        }
      if (free < 0)
        throw ragdollError(
          'Ragdoll occupies all 16 collision groups, leaving none for the character capsule; give the ragdoll a single group bit.',
        );
      groupIndex = free;
    }
    const charBit = 1 << groupIndex;
    const bodyBodies: PhysicsBody[] = [this.controller.body];
    if (isKinematicController(this.controller) && this.controller.innerBody) bodyBodies.push(this.controller.innerBody);

    let assignedGroups = packGroups(charBit, 0xffff & ~ragdollMask & ~charBit);
    for (const body of bodyBodies)
      for (const collider of body.colliders) {
        const prev = collider.collisionGroups();
        this.savedGroups.set(collider, prev);
        const filter = prev & 0xffff & ~ragdollMask & ~charBit;
        assignedGroups = packGroups(charBit, filter);
        collider.setCollisionGroups(assignedGroups);
      }
    this.characterGroups = assignedGroups;

    const ragdollBodySet = new Set<PhysicsBody>();
    for (const part of this.ragdoll.bones) {
      ragdollBodySet.add(part.body);
      for (const collider of part.body.colliders) {
        const prev = collider.collisionGroups();
        this.savedGroups.set(collider, prev);
        const mem = (prev >>> 16) & 0xffff,
          filter = prev & 0xffff & ~charBit;
        collider.setCollisionGroups(packGroups(mem, filter));
      }
    }
    this.ragdollBodies = ragdollBodySet;

    this.offAfterStep = this.ragdoll.physics.on('afterstep', () => this.onAfterStep());
  }

  /** Current lifecycle state: `'walking'`, `'ragdoll'`, or `'recovering'`. */
  get state(): CharacterRagdollState {
    return this.currentState;
  }

  /** Whether the character is currently standing on ground (false while knocked down or recovering). */
  get grounded(): boolean {
    return this.currentState === 'walking' && this.controller.grounded;
  }

  /** The body the character is standing on, or null while airborne, knocked down, or recovering. */
  get platform(): PhysicsBody | null {
    return this.currentState === 'walking' ? this.controller.platform : null;
  }

  /**
   * Moves a kinematic `CharacterController` for one fixed step while `'walking'`, automatically excluding this
   * character's own ragdoll hitboxes from the sweep. No-op returning zero movement while `'ragdoll'` or `'recovering'`.
   * @throws TypeError if constructed with a `DynamicCharacter` instead of a `CharacterController`.
   */
  move(desired: readonly [number, number, number], filter?: CharacterMoveFilter): CharacterMoveResult {
    this.live();
    if (!isKinematicController(this.controller))
      throw ragdollError(
        'move() is for a kinematic CharacterController; use setTargetVelocity() and update() with a DynamicCharacter.',
      );
    if (this.currentState !== 'walking')
      return { movement: [0, 0, 0], grounded: false, collisions: 0, slidingDownSlope: false };
    const userPredicate = filter?.predicate,
      merged: CharacterMoveFilter = {
        ...filter,
        groups: filter?.groups ?? this.characterGroups,
        predicate: (collider) => !this.ragdollBodies.has(collider.body) && (!userPredicate || userPredicate(collider)),
      };
    return this.controller.move(desired, merged);
  }

  /**
   * Sets target velocity on a `DynamicCharacter` while `'walking'` (ignored while `'ragdoll'` or `'recovering'`).
   * @throws TypeError if constructed with a kinematic `CharacterController`.
   */
  setTargetVelocity(velocity: readonly [number, number, number]): this {
    this.live();
    if (isKinematicController(this.controller))
      throw ragdollError(
        'setTargetVelocity() is for a DynamicCharacter; call move(desired) for a kinematic CharacterController.',
      );
    if (this.currentState === 'walking') this.controller.setTargetVelocity(velocity);
    return this;
  }

  /**
   * Requests a jump on a `DynamicCharacter` while `'walking'`. Returns false while knocked down or recovering.
   * @throws TypeError if constructed with a kinematic `CharacterController`.
   */
  jump(speed: number): boolean {
    this.live();
    if (isKinematicController(this.controller))
      throw ragdollError('jump() is for a DynamicCharacter; add vertical velocity to move() for CharacterController.');
    return this.currentState === 'walking' ? this.controller.jump(speed) : false;
  }

  /**
   * Steps a `DynamicCharacter` controller before the physics step while `'walking'` (no-op while `'ragdoll'` or `'recovering'`).
   * @throws TypeError if constructed with a kinematic `CharacterController`.
   */
  update(): void {
    this.live();
    if (isKinematicController(this.controller))
      throw ragdollError('update() is for a DynamicCharacter; call move(desired) for a kinematic CharacterController.');
    if (this.currentState === 'walking') this.controller.update();
  }

  /**
   * Transitions to full ragdoll (default) or triggers a partial-limb ragdoll hit (`options.limb`).
   *
   * - Full knockdown: disables the controller body so its standing capsule never obstructs the fall, activates the ragdoll
   *   (each limp bone keeps the velocity the walk gave its hit box, so the fall carries the walking momentum), and applies
   *   `impulse` to `bone` (defaults to the root bone).
   * - Partial knockdown (`options.limb` set): activates only the specified limb and applies `impulse` while the
   *   character continues walking under controller locomotion.
   */
  knockdown(
    bone?: Mesh | RagdollPart,
    impulse?: readonly [number, number, number],
    options: CharacterKnockdownOptions = {},
  ): this {
    this.live();
    const target = this.resolveBone(bone);
    if (options.limb !== undefined) {
      this.ragdoll.activate(options.limb);
      if (impulse) {
        if (this.motors)
          this.motors.hit(target, impulse, {
            point: options.point,
            weaken: options.weaken,
            recover: options.recover,
          });
        else target.body.applyImpulse(impulse, options.point);
      }
      return this;
    }

    this.cancelPendingRecovery();
    this.currentState = 'ragdoll';
    this.setControllerEnabled(false);
    this.ragdoll.activate();

    if (this.motors) {
      this.savedMotorStrength = this.motors.strength;
      this.motors.strength = options.motorStrength ?? 0;
    }

    if (impulse) target.body.applyImpulse(impulse, options.point);
    return this;
  }

  /**
   * True when knocked down and every limp bone has slowed below `linearSpeed` (default 0.15 m/s) and `angularSpeed`
   * (default 0.3 rad/s), ready for {@link CharacterRagdoll.recover}.
   */
  isSettled(linearSpeed = 0.15, angularSpeed = 0.3): boolean {
    if (this.disposed || this.currentState !== 'ragdoll') return false;
    const linSq = linearSpeed * linearSpeed,
      angSq = angularSpeed * angularSpeed;
    for (const part of this.ragdoll.bones) {
      if (!part.limp || !part.body.valid) continue;
      const v = part.body.linearVelocity,
        w = part.body.angularVelocity;
      if (v[0] * v[0] + v[1] * v[1] + v[2] * v[2] > linSq) return false;
      if (w[0] * w[0] + w[1] * w[1] + w[2] * w[2] > angSq) return false;
    }
    return true;
  }

  /**
   * Recovers from a full knockdown: finds the ground under `ragdoll.rootPosition`, relocates the controller capsule
   * there, blends back into animation (through `GetUp` if provided, or `ragdoll.deactivate(blend)`), and re-enables the
   * controller with zero pop once standing.
   * @throws MargoError with code `state` if the character is not currently in `'ragdoll'` state.
   */
  async recover(options: CharacterRecoverOptions = {}): Promise<CharacterRecoverResult> {
    this.live();
    if (this.currentState !== 'ragdoll')
      throw new MargoError('state', 'Character is not knocked down; call knockdown() before recover().');
    options.signal?.throwIfAborted();
    this.currentState = 'recovering';

    const hips = this.ragdoll.rootPosition,
      groundPoint = this.groundBeneath(hips);

    // Park controller capsule at the settled ground location (still disabled during blend so it cannot bump limbs).
    const initialCapsule: Vec3 = [
      groundPoint[0] - this.rootOffset[0],
      groundPoint[1] - this.rootOffset[1],
      groundPoint[2] - this.rootOffset[2],
    ];
    this.placeController(initialCapsule);

    let side: GetUpSide | null = null,
      mismatch = 0;

    try {
      if (this.getUp) {
        const result = await this.getUp.start({ side: options.side, signal: options.signal });
        side = result.side;
        mismatch = result.mismatch;
      } else {
        const blend = options.blend ?? 0.4;
        if (this.root) {
          this.root.setPosition(groundPoint);
          this.root.engine.store.tick(false);
        }
        this.ragdoll.deactivate(blend);
        if (blend > 0) await this.waitForBlend(options.signal);
      }
    } catch (error) {
      if (!this.disposed) this.currentState = this.ragdoll.active ? 'ragdoll' : 'walking';
      throw error;
    }

    if (this.disposed) return { side, mismatch, capsulePosition: initialCapsule };

    // Align the controller capsule to the final standing root with zero pop before re-enabling locomotion.
    let finalCapsule = initialCapsule;
    if (this.root) {
      this.root.engine.store.tick(false);
      const m = this.root.matrix;
      finalCapsule = [m[12]! - this.rootOffset[0], m[13]! - this.rootOffset[1], m[14]! - this.rootOffset[2]];
    }
    this.placeController(finalCapsule);
    this.setControllerEnabled(true);
    if (this.motors) this.motors.strength = options.motorStrength ?? this.savedMotorStrength;
    this.currentState = 'walking';
    return { side, mismatch, capsulePosition: finalCapsule };
  }

  /**
   * Combined debug lines for the character controller (while walking) and the ragdoll (always, tinted by mode).
   */
  debugRender(options: CharacterRagdollDebugOptions = {}): DebugLines {
    this.live();
    const empty: DebugLines = { vertices: new Float32Array(0), colors: new Float32Array(0) };
    const ctrlLines =
      options.controller !== false && this.currentState === 'walking'
        ? this.controller.debugRender(typeof options.controller === 'object' ? options.controller : undefined)
        : empty;
    const ragLines =
      options.ragdoll !== false
        ? this.ragdoll.debugRender(typeof options.ragdoll === 'object' ? options.ragdoll : undefined)
        : empty;
    return concatDebugLines(ctrlLines, ragLines);
  }

  private resolveBone(bone?: Mesh | RagdollPart): RagdollPart {
    if (!bone) return this.ragdoll.bones[0]!;
    if ('body' in bone) {
      if (!this.ragdoll.bones.includes(bone))
        throw ragdollError('That part does not belong to this ragdoll; pass one of ragdoll.bones.');
      return bone;
    }
    const found = this.ragdoll.part(bone);
    if (!found) throw ragdollError('That node is not a bone of this ragdoll; pass a node from ragdoll.bones.');
    return found;
  }

  private groundBeneath(hips: Vec3): Vec3 {
    const down: Vec3 = [-this.up[0], -this.up[1], -this.up[2]],
      hit = this.ragdoll.physics.raycast(hips, down, {
        maxDistance: 100,
        excludeDynamic: true,
        excludeKinematic: true,
        predicate: (body) => !this.ragdollBodies.has(body) && body !== this.controller.body,
      });
    if (hit) return [hit.point[0], hit.point[1], hit.point[2]];
    if (this.root) {
      this.root.engine.store.tick(false);
      const m = this.root.matrix,
        along = (v: readonly number[]): number => v[0]! * this.up[0] + v[1]! * this.up[1] + v[2]! * this.up[2],
        lift = along([m[12]!, m[13]!, m[14]!]) - along(hips);
      return [hips[0] + this.up[0] * lift, hips[1] + this.up[1] * lift, hips[2] + this.up[2] * lift];
    }
    return [hips[0], hips[1], hips[2]];
  }

  private placeController(position: Vec3): void {
    const body = this.controller.body;
    if (!body.valid) return;
    body.setPosition(position, false);
    if (body.type === 'kinematicPosition') body.setNextPosition(position);
    else if (body.type === 'dynamic') {
      body.setLinearVelocity([0, 0, 0], false);
      body.setAngularVelocity([0, 0, 0], false);
    }
    if (isKinematicController(this.controller) && this.controller.innerBody?.valid) {
      this.controller.innerBody.setPosition(position, false);
      this.controller.innerBody.setNextPosition(position);
    }
  }

  private setControllerEnabled(enabled: boolean): void {
    const body = this.controller.body;
    if (body.valid) {
      body.enabled = enabled;
      for (const collider of body.colliders) collider.setEnabled(enabled);
    }
    if (isKinematicController(this.controller) && this.controller.innerBody?.valid) {
      this.controller.innerBody.enabled = enabled;
      for (const collider of this.controller.innerBody.colliders) collider.setEnabled(enabled);
    }
  }

  private onAfterStep(): void {
    if (this.disposed || this.currentState !== 'walking') return;
    if (!this.root || this.controller.body.mesh === this.root || !this.controller.body.valid) return;
    const bp = this.controller.body.position;
    this.root.setPosition([bp[0] + this.rootOffset[0], bp[1] + this.rootOffset[1], bp[2] + this.rootOffset[2]]);
  }

  private waitForBlend(signal?: AbortSignal): Promise<void> {
    if (this.ragdoll.weight <= 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        off();
        this.pendingRecovery = undefined;
        signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = (): void => {
        cleanup();
        reject(signal!.reason);
      };
      const off = this.ragdoll.physics.on('afterstep', () => {
        if (this.disposed || this.ragdoll.weight <= 0) {
          cleanup();
          resolve();
        }
      });
      this.pendingRecovery = cleanup;
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private cancelPendingRecovery(): void {
    this.pendingRecovery?.();
    this.pendingRecovery = undefined;
  }

  private live(): void {
    if (this.disposed)
      throw new MargoError('disposed', 'CharacterRagdoll is disposed; create a new one with addCharacterRagdoll.');
  }

  /**
   * Detaches the bridge, restores original collision groups on live colliders, re-enables the controller body, and
   * disposes any `motors` or `getUp` instances it created internally. Safe to call twice.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelPendingRecovery();
    this.offAfterStep();
    for (const [collider, groups] of this.savedGroups) if (collider.valid) collider.setCollisionGroups(groups);
    this.savedGroups.clear();
    this.setControllerEnabled(true);
    if (this.ownsMotors) this.motors?.dispose();
    if (this.ownsGetUp) this.getUp?.dispose();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}

/**
 * Links a character controller (`CharacterController` or `DynamicCharacter`) with a {@link Ragdoll} (and optional
 * {@link Animator}, {@link RagdollMotors}, and {@link GetUp}): isolates collision groups, disables controller sweep
 * while limp, and recovers smoothly from the settled hips position back into walking with zero pop.
 * @example
 * const bridge = addCharacterRagdoll({ controller, ragdoll, animator, getUp: { faceUp: 'back', faceDown: 'front' } });
 * bridge.knockdown(head, [0, 2, -40]);
 * await bridge.recover();
 */
export function addCharacterRagdoll(options: CharacterRagdollOptions): CharacterRagdoll {
  return new CharacterRagdoll(options);
}
