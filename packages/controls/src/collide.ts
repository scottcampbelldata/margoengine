import type { EngineKernel, Mesh } from '@margoengine/core';
import { Raycaster, type ModelLike } from '@margoengine/bvh';
import { OrbitControls as Orbit, MOUSE, TOUCH } from './orbit.js';
import type { ControlElement } from './controls.js';
import { normalize, sub } from '@margoengine/math/vec3';
import { madd, type V3 } from './math.js';
import { rollFrame } from './view.js';

/** Mesh or model whose triangles can shorten an orbit camera's arm. */
export type OrbitCollider = Mesh | ModelLike;
/** Collision options, independent from the inherited orbit options. */
export interface OrbitCollisionOptions {
  /** Explicit blockers. Default [] (none); null queries every visible scene mesh and model. */
  colliders?: readonly OrbitCollider[] | null;
  /** Extra distance before a hit. Default 0.01 world units. */
  clearance?: number;
  /** Time constant for extending a shortened arm once clear, in seconds. Default 0.2; zero restores immediately. */
  returnTime?: number;
  /** Query settings such as layers and filter. Default new Raycaster with both triangle sides. */
  raycaster?: Raycaster;
  /** Input element. Default engine canvas. */
  element?: ControlElement | null;
}

/** Orbit controls which shorten the eye-to-target arm before the centre or near-plane corners hit a blocker. */
export class OrbitControls extends Orbit {
  /** Explicit blockers, [] for none or null for the scene. Default []. */
  colliders: readonly OrbitCollider[] | null;
  /** Additional world clearance before a hit. Default 0.01. */
  clearance: number;
  /** Clear-arm extension time constant, in seconds. Default 0.2. */
  returnTime: number;
  /** Collision query, with configurable layers, sides and filter. */
  readonly raycaster: Raycaster;
  /** Distance requested by orbit input before collision. */
  get desiredDistance(): number {
    return this.wanted ? Math.hypot(...sub(this.wanted, this.camera.target)) : this.getDistance();
  }
  /** Camera arm's actual distance after collision. */
  get armLength(): number {
    return this.getDistance();
  }
  /** Number of rays in the last update, 0 with no blockers, otherwise 5. */
  rays = 0;
  private wanted: V3 | null = null;
  private actual: V3 | null = null;
  private targetBefore: V3 | null = null;
  private muting = false;
  private dead = false;
  constructor(engine: EngineKernel, options: OrbitCollisionOptions = {}) {
    const clearance = options.clearance ?? 0.01,
      returnTime = options.returnTime ?? 0.2;
    if (!Number.isFinite(clearance) || clearance < 0 || !Number.isFinite(returnTime) || returnTime < 0)
      throw new RangeError('Orbit collision clearance and returnTime must be finite and nonnegative');
    if (!engine || typeof engine.use !== 'function')
      throw new TypeError('Orbit collision needs an Engine; pass the engine to attach');
    super(engine, options.element);
    this.colliders = options.colliders === undefined ? [] : options.colliders;
    this.clearance = clearance;
    this.returnTime = returnTime;
    this.raycaster = options.raycaster ?? new Raycaster();
    if (!options.raycaster) this.raycaster.side = 'double';
  }
  override dispatchEvent(event: { type: string; [key: string]: unknown }): void {
    if (!this.muting || event.type !== 'change') super.dispatchEvent(event);
  }
  override update(delta = 1 / 60): boolean {
    if (this.dead) return false;
    if (
      !Number.isFinite(delta) ||
      delta < 0 ||
      !Number.isFinite(this.clearance) ||
      this.clearance < 0 ||
      !Number.isFinite(this.returnTime) ||
      this.returnTime < 0
    )
      throw new RangeError('Orbit collision delta, clearance and returnTime must be finite and nonnegative');
    const cam = this.camera,
      old = [...cam.position] as V3,
      oldTarget = [...cam.target] as V3;
    let prior = this.actual ? Math.hypot(...sub(this.actual, this.targetBefore!)) : Infinity;
    if (this.wanted && this.actual && this.targetBefore) {
      const shift = sub(cam.target, this.targetBefore),
        movement = sub(cam.position, this.actual);
      if (shift.every((v, i) => Math.abs(v - movement[i]) < 1e-10)) cam.position = madd(this.wanted, shift, 1);
      else prior = Infinity; // An external setLookAt/teleport supplies a new requested orbit.
    }
    this.muting = true;
    let orbitChanged;
    try {
      orbitChanged = super.update(delta);
    } finally {
      this.muting = false;
    }
    this.wanted = [...cam.position] as V3;
    const eye = sub(cam.position, cam.target),
      full = Math.hypot(...eye),
      along = normalize(eye);
    let free: number;
    try {
      free = this.freeDistance(along, full);
    } catch (error) {
      cam.position = old;
      cam.target = oldTarget;
      throw error;
    }
    let length = free;
    if (prior < free && this.returnTime > 0) length = prior + (free - prior) * -Math.expm1(-delta / this.returnTime);
    // A nonzero eye is required by Camera, even when a blocker coincides with the target.
    length = Math.max(Math.min(full, 1e-6), Math.min(full, length));
    cam.position = madd(cam.target, along, length);
    this.actual = [...cam.position] as V3;
    this.targetBefore = [...cam.target] as V3;
    const changed = old.some((v, i) => v !== cam.position[i]) || oldTarget.some((v, i) => v !== cam.target[i]);
    if (changed || orbitChanged) super.dispatchEvent({ type: 'change' });
    return changed || !!orbitChanged;
  }
  private freeDistance(along: V3, full: number): number {
    this.rays = 0;
    if (this.colliders?.length === 0) return full;
    const b = rollFrame(this.camera),
      height = b.ortho ?? this.camera.near * b.tanHalf,
      aspect = this.element && this.element.clientHeight ? this.element.clientWidth / this.element.clientHeight : 1;
    const offsets: V3[] = [[0, 0, 0]];
    for (const x of [-1, 1])
      for (const y of [-1, 1]) offsets.push(madd(madd([0, 0, 0], b.right, x * height * aspect), b.up, y * height));
    let free = full;
    const ray = this.raycaster,
      saved = {
        origin: [...ray.origin],
        direction: [...ray.direction],
        near: ray.near,
        far: ray.far,
        first: ray.firstHitOnly,
      };
    try {
      for (const offset of offsets) {
        ray.set(madd(this.camera.target, offset, 1), along);
        ray.near = 0;
        ray.far = full + this.clearance;
        ray.firstHitOnly = true;
        const [hit] = this.colliders
          ? ray.intersectObjects(this.engine!, this.colliders, { refresh: this.rays === 0 })
          : ray.intersectEngine(this.engine!, { refresh: this.rays === 0 });
        this.rays++;
        if (hit) free = Math.min(free, Math.max(0, hit.distance - this.clearance));
      }
    } finally {
      ray.set(saved.origin, saved.direction);
      ray.near = saved.near;
      ray.far = saved.far;
      ray.firstHitOnly = saved.first;
    }
    return free;
  }
  override reset(): void {
    this.wanted = null;
    this.actual = null;
    this.targetBefore = null;
    super.reset();
  }
  override dispose(): void {
    this.dead = true;
    this.wanted = null;
    this.actual = null;
    this.targetBefore = null;
    super.dispose();
  }
}
/** Map input bindings with the same collision and clear-arm restoration behavior. */
export class MapControls extends OrbitControls {
  constructor(engine: EngineKernel, options: OrbitCollisionOptions = {}) {
    super(engine, options);
    this.screenSpacePanning = false;
    this.mouseButtons = { LEFT: MOUSE.PAN, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.ROTATE };
    this.touches = { ONE: TOUCH.PAN, TWO: TOUCH.DOLLY_ROTATE };
  }
}
