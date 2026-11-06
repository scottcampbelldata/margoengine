/// <reference lib="esnext.disposable" preserve="true" />
// Getting up from a ragdoll: compare how the body lies with the first frame of each get-up clip, turn and move the
// character so the chosen clip starts where the body is, and blend from the ragdoll's pose into the clip. Only the turn
// about the up axis is free, so the rest of the difference tells the clips apart: on its back, a face-up clip fits. The
// blend is the ragdoll's own `deactivate`, which holds the physics pose and fades to the animator's. Our own design from
// the public description of the technique; no engine's source was read.
import type { Mesh } from '@margoengine/core/extension';
import type { Animator } from '@margoengine/animator';
import { MargoError } from '@margoengine/math/errors';
import {
  conjugateQuaternion,
  multiplyQuaternions,
  normalizeQuaternion,
  rotateByQuaternion,
  rotationToQuaternion,
} from '@margoengine/math/quat';
import type { Ragdoll } from './ragdoll.js';

/** Options of {@link addGetUp}. */
export interface GetUpOptions {
  /** Animator state of the clip that gets up from lying on the back. */
  faceUp: string;
  /** Animator state of the clip that gets up from lying on the front. */
  faceDown: string;
  /** Animator state to go to when the clip ends. Default the state the animator is in when this is added. */
  then?: string;
  /** Seconds of the blend from the ragdoll's pose into the clip. Default 0.4. */
  blend?: number;
  /** Seconds of the fade from the end of the clip into `then`. Default 0.2. */
  fade?: number;
  /** The top node of the character, moved and turned to the body. Default the animator's model root. */
  root?: Mesh;
  /** World up, a unit vector. Default [0, 1, 0]. */
  up?: readonly [number, number, number];
}

/** Which way up a body lies. */
export type GetUpSide = 'faceUp' | 'faceDown';

/** Options of {@link GetUp.start}. */
export interface GetUpStartOptions {
  /** Force a clip instead of choosing by how the body lies. */
  side?: GetUpSide;
  /** Stops waiting: the promise rejects with the reason; the clip keeps playing. */
  signal?: AbortSignal;
}

/** What {@link GetUp.start} did. */
export interface GetUpResult {
  /** The clip chosen. */
  side: GetUpSide;
  /** Radians between the body and the clip's first frame, after the turn: how much the blend has to cover at the root. */
  mismatch: number;
}

type Quat = [number, number, number, number];
type Point = [number, number, number];
interface FirstFrame {
  rotation: Quat;
  position: Point;
}

const worldRotation = (m: ArrayLike<number>): Quat => {
  const sx = Math.hypot(m[0], m[1], m[2]),
    sy = Math.hypot(m[4], m[5], m[6]),
    sz = Math.hypot(m[8], m[9], m[10]);
  return normalizeQuaternion(rotationToQuaternion(m, [0, 0, 0, 1], sx, sy, sz));
};
const angleOf = (q: ArrayLike<number>): number => 2 * Math.atan2(Math.hypot(q[0], q[1], q[2]), Math.abs(q[3]));

/** The turn about the unit `up` in the rotation `q`. */
function turnAbout(q: Quat, up: readonly number[]): Quat {
  const dot = q[0] * up[0] + q[1] * up[1] + q[2] * up[2],
    length = Math.hypot(dot, q[3]);
  return length < 1e-9
    ? [0, 0, 0, 1]
    : [(up[0] * dot) / length, (up[1] * dot) / length, (up[2] * dot) / length, q[3] / length];
}

/** A character getting up ({@link addGetUp}). */
export class GetUp {
  private readonly root: Mesh;
  private readonly up: readonly [number, number, number];
  private readonly then: string;
  private readonly blend: number;
  private readonly fade: number;
  private readonly first: Record<GetUpSide, FirstFrame>;
  private readonly states: Record<GetUpSide, string>;
  private watching?: () => void;
  private disposed = false;

  /** @internal use {@link addGetUp}. */
  constructor(
    private readonly ragdoll: Ragdoll,
    private readonly animator: Animator,
    options: GetUpOptions,
  ) {
    this.states = { faceUp: options.faceUp, faceDown: options.faceDown };
    for (const name of [options.faceUp, options.faceDown, options.then ?? animator.state])
      if (!Object.hasOwn(animator.options.states, name))
        throw new RangeError(`Unknown animator state "${name}"; pass a state name from the Animator's options.`);
    this.root = options.root ?? animator.animation.model.root;
    this.then = options.then ?? animator.state;
    this.blend = options.blend ?? 0.4;
    this.fade = options.fade ?? 0.2;
    if (!(this.blend >= 0) || this.blend === Infinity || !(this.fade >= 0) || this.fade === Infinity)
      throw new RangeError('Get-up blend and fade must be finite numbers of seconds, 0 or more.');
    const up = options.up ?? [0, 1, 0],
      length = Math.hypot(up[0], up[1], up[2]);
    if (!(length > 0) || length === Infinity)
      throw new RangeError('Get-up up must be a nonzero finite [x, y, z]; pass the world up, e.g. [0, 1, 0].');
    this.up = [up[0] / length, up[1] / length, up[2] / length];
    this.first = { faceUp: this.sample('faceUp'), faceDown: this.sample('faceDown') };
  }

  /**
   * The root bone at the first frame of `side`'s clip, in the top node's frame. The animator is the sampler, so layers
   * and blend trees count; it is put back as it was, and a `statechange` listener sees the visit.
   */
  private sample(side: GetUpSide): FirstFrame {
    const { animator } = this,
      was = animator.state,
      time = animator.time,
      entry = animator.entryTime,
      node = this.ragdoll.bones[0].node,
      store = node.engine.store;
    animator.cancelFade();
    animator.transition(this.states[side], 0);
    animator.onPreUpdate(0);
    store.tick(false);
    const m = this.root.matrix,
      b = node.matrix,
      inverse = conjugateQuaternion(worldRotation(m)),
      frame: FirstFrame = {
        rotation: multiplyQuaternions(inverse, worldRotation(b)),
        position: rotateByQuaternion([b[12] - m[12], b[13] - m[13], b[14] - m[14]], inverse) as Point,
      };
    animator.transition(was, 0);
    animator.enterAt(entry);
    animator.time = time;
    animator.onPreUpdate(0);
    store.tick(false);
    return frame;
  }

  /** The turn that best fits `side`'s first frame to the body, and what is left over. */
  private fit(side: GetUpSide): { turn: Quat; mismatch: number } {
    const body = this.ragdoll.bones[0].body.rotation,
      standing = multiplyQuaternions(worldRotation(this.root.matrix), this.first[side].rotation),
      turn = turnAbout(multiplyQuaternions(body, conjugateQuaternion(standing)), this.up),
      left = multiplyQuaternions(conjugateQuaternion(body), multiplyQuaternions(turn, standing));
    return { turn, mismatch: angleOf(left) };
  }

  /** Radians between the body and `side`'s first frame at the root bone, after the free turn. */
  mismatch(side: GetUpSide): number {
    this.live();
    return this.fit(side).mismatch;
  }

  /** Which clip fits the body as it lies now. */
  pick(): GetUpSide {
    this.live();
    return this.fit('faceUp').mismatch <= this.fit('faceDown').mismatch ? 'faceUp' : 'faceDown';
  }

  /**
   * Gets up: chooses the clip, turns and moves the character so the clip's first frame lies on the body, on the ground
   * under it, starts the clip and hands the bones back over `blend` seconds. Resolves when the clip has played and the
   * animator is on its way to `then`.
   * @throws MargoError with code `state` when no bone is limp or a get-up is already running.
   */
  start(options: GetUpStartOptions = {}): Promise<GetUpResult> {
    this.live();
    if (!this.ragdoll.active)
      throw new MargoError('state', 'The ragdoll is not limp, so there is nothing to get up from; call activate first.');
    if (this.watching) throw new MargoError('state', 'A get-up is already running; wait for its promise.');
    options.signal?.throwIfAborted();
    const side = options.side ?? this.pick(),
      { turn, mismatch } = this.fit(side),
      { animator, ragdoll, root } = this,
      rootBone = ragdoll.bones[0],
      store = root.engine.store;
    // Where the root bone would be with the turn made, then the move that puts it over the body.
    const position = rootBone.body.position,
      m = root.matrix,
      top: Point = [m[12], m[13], m[14]],
      first = this.first[side].position,
      turned = multiplyQuaternions(turn, worldRotation(m)),
      reach = rotateByQuaternion(first, turned) as Point,
      down = this.up.map((v) => -v) as unknown as Point,
      hit = ragdoll.physics.raycast(position, down, { maxDistance: 100, excludeDynamic: true, excludeKinematic: true }),
      along = (v: ArrayLike<number>): number => v[0] * this.up[0] + v[1] * this.up[1] + v[2] * this.up[2],
      height = hit ? along(hit.point) : along(top),
      flat = [0, 1, 2].map((k) => position[k] - reach[k]),
      lift = height - along(flat);
    root.setQuaternion(turned);
    root.setPosition([flat[0] + this.up[0] * lift, flat[1] + this.up[1] * lift, flat[2] + this.up[2] * lift]);
    store.tick(false);
    animator.cancelFade();
    animator.transition(this.states[side], 0);
    ragdoll.deactivate(this.blend);
    return new Promise((resolve, reject) => {
      const stop = (): void => {
        this.watching?.();
        this.watching = undefined;
        options.signal?.removeEventListener('abort', abort);
      };
      const abort = (): void => {
        stop();
        reject(options.signal!.reason);
      };
      options.signal?.addEventListener('abort', abort, { once: true });
      const off = animator.addLateStep(() => {
        if (animator.state !== this.states[side]) {
          stop();
          resolve({ side, mismatch });
        } else if (animator.normalizedTime >= 1) {
          animator.transition(this.then, this.fade);
          stop();
          resolve({ side, mismatch });
        }
      });
      this.watching = off;
    });
  }

  private live(): void {
    if (this.disposed) throw new MargoError('disposed', 'This get-up is disposed; call addGetUp again.');
  }

  /** Stops watching for the end of a clip. The animator and the ragdoll stay as they are. Safe to call twice. */
  dispose(): void {
    this.disposed = true;
    this.watching?.();
    this.watching = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}

/**
 * Adds getting up to a ragdoll: `start()` picks the face-up or face-down clip by how the body lies, matches the character
 * to the body and blends into the clip. Build the ragdoll on the same skeleton as the animator.
 * @example
 * const getUp = addGetUp(ragdoll, animator, { faceUp: 'getUpBack', faceDown: 'getUpFront', then: 'idle' });
 * ragdoll.activate();
 * setTimeout(() => getUp.start(), 2000);
 * @throws TypeError without a ragdoll and an animator, RangeError for an unknown state or an option out of range.
 */
export function addGetUp(ragdoll: Ragdoll, animator: Animator, options: GetUpOptions): GetUp {
  if (!ragdoll?.bones || typeof animator?.transition !== 'function' || !options)
    throw new TypeError("addGetUp needs a Ragdoll, an Animator and options: addGetUp(ragdoll, animator, {faceUp, faceDown}).");
  return new GetUp(ragdoll, animator, options);
}
