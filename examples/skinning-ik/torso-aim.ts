import type { Mesh, Vec3 } from '@margoengine/core/extension';
import { multiplyQuaternions } from '@margoengine/math/quat';
import { localPoint, worldPosition, worldRotation } from './rig-ik';

type Rotation = [number, number, number, number];

/** Demo-only upper-body turn. All arm lengths and shoulder attachments stay authored. */
export class TorsoAim {
  readonly body: Mesh;
  readonly root: Mesh;
  readonly maxYaw: number;
  /** Original model coordinates transported rigidly with the animated torso. */
  readonly frame: Mesh;
  yaw = 0;
  desiredYaw = 0;

  private readonly rest: Rotation;
  private readonly output: Rotation = [0, 0, 0, 1];
  private readonly previous: Rotation = [NaN, NaN, NaN, NaN];
  private readonly committed: Rotation = [NaN, NaN, NaN, NaN];
  private readonly committedEuler: [number, number, number] = [NaN, NaN, NaN];
  private readonly writeRotation?: (rotation: readonly number[]) => void;

  /**
   * Optional explicit demo-owned commit for reused normal-array rotations.
   * It must synchronously validate, normalize and write quaternion/Euler state
   * without mutating the rotation. Omit to call the current public Mesh setter.
   */
  constructor(body: Mesh, root: Mesh, maxYaw = 0.85, writeRotation?: (rotation: readonly number[]) => void) {
    body.check();
    root.check();
    if (body.engine !== root.engine || body === root) throw new Error('Torso must belong to the model hierarchy');
    if (!Number.isFinite(maxYaw) || maxYaw < 0 || maxYaw > 0.95) {
      throw new RangeError('Torso travel must be between zero and 0.95 radians');
    }
    if (writeRotation !== undefined && typeof writeRotation !== 'function')
      throw new RangeError('Invalid torso rotation writer');
    this.writeRotation = writeRotation;
    const store = body.engine.store,
      t = store.transforms;
    let scale = 1,
      id = body.id,
      steps = 0;
    while (id !== root.id) {
      if (id === -1 || ++steps > store.capacity) throw new Error('Torso must be a descendant of the model root');
      scale *= t.sx[id];
      id = store.parents[id];
    }
    // These also validate the positive uniform ancestor scales required by IK.
    const bodyRotation = worldRotation(body),
      rootRotation = worldRotation(root);
    if (!Number.isFinite(Math.fround(1 / scale)) || Math.fround(1 / scale) <= 0) {
      throw new RangeError('Torso rest frame exceeds scene precision');
    }
    store.tick(false);
    const position = localPoint(body, worldPosition(root));
    const rotation = multiplyQuaternions(
      [-bodyRotation[0], -bodyRotation[1], -bodyRotation[2], bodyRotation[3]],
      rootRotation,
    );
    this.body = body;
    this.root = root;
    this.maxYaw = maxYaw;
    this.rest = [t.qx[body.id], t.qy[body.id], t.qz[body.id], t.qw[body.id]];
    // Inverse authored Body-to-model transform: initially this frame is the
    // model root. Its existing torso hull points then follow Body, not the hips.
    this.frame = body.engine
      .createMesh()
      .setParent(body)
      .setPosition(position)
      .setQuaternion(rotation)
      .setScale([1 / scale, 1 / scale, 1 / scale]);
    this.frame.name = 'Light Keeper torso collision frame';
    store.tick(false);
  }

  /** Model-local orb center. Probe renders pass zero or call applyHeld(). */
  update(target: Vec3, dt: number): this {
    if (
      !target ||
      target.length !== 3 ||
      !Number.isFinite(target[0]) ||
      !Number.isFinite(target[1]) ||
      !Number.isFinite(target[2]) ||
      !Number.isFinite(Math.fround(target[0])) ||
      !Number.isFinite(Math.fround(target[1])) ||
      !Number.isFinite(Math.fround(target[2]))
    ) {
      throw new RangeError('Torso aim requires a finite model-local target');
    }
    if (!Number.isFinite(dt) || dt < 0) throw new RangeError('Torso aim dt must be finite and nonnegative');
    this.check();
    // Start turning before the hand crosses the center. Smoothstep keeps the
    // own-side authored Home unchanged and eases into the full opposite reach.
    const progress = Math.max(0, Math.min(1, (target[0] + 0.35) / 0.585));
    const desired = -this.maxYaw * progress * progress * (3 - 2 * progress);
    if (dt > 0) {
      const delta = desired - this.yaw;
      const advance = delta * -Math.expm1(-8 * dt),
        limit = 1.6 * dt;
      this.yaw =
        Math.abs(delta) < 1e-7 && Math.abs(delta) <= limit
          ? desired
          : this.yaw + Math.max(-limit, Math.min(limit, advance));
      this.desiredYaw = desired;
    }
    return this.commit();
  }

  /** Reapply the presented Body pose after animation without advancing time. */
  applyHeld(): this {
    this.check();
    return this.commit();
  }

  private check(): void {
    this.body.check();
    this.root.check();
    this.frame.check();
    const store = this.body.engine.store,
      t = store.transforms;
    let found = false,
      steps = 0;
    for (let id = this.frame.id; id !== -1; id = store.parents[id]) {
      if (++steps > store.capacity) throw new RangeError('Invalid torso hierarchy');
      found ||= id === this.root.id;
      const x = t.sx[id],
        y = t.sy[id],
        z = t.sz[id],
        tolerance = Math.max(x, y, z) * 1e-5;
      if (
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        !Number.isFinite(z) ||
        x <= 0 ||
        y <= 0 ||
        z <= 0 ||
        Math.abs(x - y) > tolerance ||
        Math.abs(x - z) > tolerance
      ) {
        throw new RangeError('Torso aim requires positive uniform ancestor scales');
      }
    }
    if (!found || store.parents[this.frame.id] !== this.body.id)
      throw new Error('Invalid torso collision frame hierarchy');
    store.tick(false);
  }

  private commit(): this {
    const r = this.rest,
      sine = Math.sin(this.yaw / 2),
      cosine = Math.cos(this.yaw / 2),
      out = this.output;
    out[0] = r[0] * cosine - r[2] * sine;
    out[1] = r[3] * sine + r[1] * cosine;
    out[2] = r[0] * sine + r[2] * cosine;
    out[3] = r[3] * cosine - r[1] * sine;
    const t = this.body.engine.store.transforms,
      euler = this.body.euler,
      id = this.body.id;
    if (
      out[0] !== this.previous[0] ||
      out[1] !== this.previous[1] ||
      out[2] !== this.previous[2] ||
      out[3] !== this.previous[3] ||
      t.qx[id] !== this.committed[0] ||
      t.qy[id] !== this.committed[1] ||
      t.qz[id] !== this.committed[2] ||
      t.qw[id] !== this.committed[3] ||
      !Object.is(euler[0], this.committedEuler[0]) ||
      !Object.is(euler[1], this.committedEuler[1]) ||
      !Object.is(euler[2], this.committedEuler[2])
    ) {
      if (this.writeRotation) this.writeRotation(out);
      else this.body.setQuaternion(out);
      for (let i = 0; i < 4; i++) this.previous[i] = out[i];
      this.committed[0] = t.qx[id];
      this.committed[1] = t.qy[id];
      this.committed[2] = t.qz[id];
      this.committed[3] = t.qw[id];
      this.committedEuler[0] = euler[0];
      this.committedEuler[1] = euler[1];
      this.committedEuler[2] = euler[2];
    }
    this.body.engine.store.tick(false);
    return this;
  }

  reset(): this {
    this.check();
    this.yaw = this.desiredYaw = 0;
    return this.commit();
  }

  dispose(): void {
    this.frame.dispose();
  }
}
