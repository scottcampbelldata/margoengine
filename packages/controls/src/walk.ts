/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel, Mesh } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import {
  engineModels,
  getGeometryBVH,
  getPrimitiveBVH,
  isModel,
  type GeometryLike,
  type MeshBVH,
  type ModelLike,
  type ModelPrimitiveLike,
} from '@margoengine/bvh';
import { invertMatrix, multiplyMatrices } from '@margoengine/math/mat4';
import { clamp } from '@margoengine/math/mathutils';
import { Controls, documentOf, type ControlElement, type EventTargetLike } from './controls.js';
import { OrbitControls } from './orbit.js';
import { MAX_PITCH, turn } from './fly.js';
import { basis } from './view.js';
import type { V3 } from './math.js';

// The base class and the dollhouse orbit class, typed from this entry too.
export type { Controls, OrbitControls };

/** A core mesh or a gltf-pro `PBRModel` (also @margoengine/materials meshes) the walker collides with. */
export type WalkCollider = Mesh | ModelLike;
export type WalkMode = 'walk' | 'dollhouse';
export interface WalkControlsOptions {
  /** Element for pointer and touch input. Default: the engine canvas. */
  element?: ControlElement | null;
  /** Keyboard target. Default: the element's document. */
  keyTarget?: EventTargetLike | null;
  /** What the walker collides with. Default: every visible core mesh and every attached gltf-pro model. */
  colliders?: readonly WalkCollider[] | null;
  /** An @margoengine/cameras `FloatingOrigin`, so the saved walk pose survives a rebase. */
  origin?: { onRebase(listener: (shift: readonly number[]) => void): () => void } | null;
  /** An @margoengine/cameras `CameraProjection`: the dollhouse view becomes orthographic. */
  projection?: { mode: 'perspective' | 'orthographic' } | null;
}
interface Pose {
  p: V3;
  yaw: number;
  pitch: number;
  distance: number;
}
interface Candidate {
  bvh: MeshBVH | null;
  geometry: GeometryLike | null;
  primitive: ModelPrimitiveLike | null;
  m: Float64Array;
  inv: Float64Array;
}

const HEAD = 0.1; // top of the head above the eye
const SKIN = 1e-4; // extra clearance left after a push
const STEP_SLACK = 1e-3; // float tolerance on the step height
const RING = 0.9; // ground rays sit on a ring at 0.9 x radius around the centre
const MOUSE = 0.0022,
  TOUCH = 0.005,
  STICK_RATE = 2.2,
  STICK_PIXELS = 60;
const RX = [0, 1, Math.SQRT1_2, 0, -Math.SQRT1_2, -1, -Math.SQRT1_2, 0, Math.SQRT1_2];
const RZ = [0, 0, Math.SQRT1_2, 1, Math.SQRT1_2, 0, -Math.SQRT1_2, -1, -Math.SQRT1_2];
const STACK = new Int32Array(256),
  T = new Float64Array(9),
  Q = new Float64Array(6),
  LB = new Float64Array(6),
  BOX = new Float64Array(6),
  WB = new Float64Array(6),
  OB = new Float64Array(6),
  INSTANCE = new Float64Array(16);
const localBoxes = new WeakMap<object, Float64Array>(),
  modelBoxes = new WeakMap<readonly ModelPrimitiveLike[], Float64Array>();
const pose = (p: V3, yaw: number, pitch: number, distance: number): Pose => ({ p, yaw, pitch, distance });
const deadzone = (v: number | undefined): number =>
  !v || Math.abs(v) < 0.15 ? 0 : (Math.sign(v) * (Math.abs(v) - 0.15)) / 0.85;

/**
 * Kinematic first-person walker for architectural walkthroughs and simple games, Wasm-free: collision runs on the CPU
 * against the cached @margoengine/bvh trees of core meshes and gltf-pro models (the Raycaster's own caches).
 * Eye height is held by nine vertical ground rays (centre + a ring at 0.9 x radius), steps up to `stepHeight` are
 * climbed and eased, steeper than `maxSlope` is not walkable, and a capsule from `stepHeight` to the top of the head
 * slides along walls, counters and glass in sub-steps of at most half the radius (no tunnelling).
 * Input: WASD/arrows, Shift runs, Space jumps (`jumpSpeed` > 0), C crouches; click for pointer-lock mouse look (or drag);
 * a gamepad's sticks; touch: left half is a floating thumbstick, right half drag-looks; `axes` for anything else.
 * `setMode('dollhouse')` eases out to an orbit view of the colliders (`orbit`, an OrbitControls) and back.
 */
export class WalkControls extends Controls {
  /** Eye above the floor, metres. */
  eyeHeight = 1.65;
  /** Eye height while crouching (C, gamepad B or `crouch`). */
  crouchHeight = 1.0;
  /** Capsule radius: doorways narrower than twice this block. */
  radius = 0.25;
  /** Tallest step climbed, metres (a stair riser is about 0.18). */
  stepHeight = 0.19;
  /** Steepest walkable floor, radians. */
  maxSlope = Math.PI / 4;
  /** Walking speed, m/s. */
  speed = 1.5;
  /** Speed factor while Shift (or the left stick button) is held. */
  runMultiplier = 2.5;
  /** How fast speed follows the input, 1/s (higher is snappier). */
  acceleration = 10;
  /** m/s². Applies whenever the floor drops away by more than `stepHeight`. */
  gravity = 9.81;
  /** Take-off speed in m/s; 0 (default, walkthroughs) disables jumping. */
  jumpSpeed = 0;
  /** Multiplies mouse, touch and stick look rates. */
  lookSpeed = 1;
  /** Lock the mouse pointer on click (else mouse look is by dragging). */
  pointerLock = true;
  /** Poll the first connected gamepad. */
  gamepad = true;
  /** Crouch while true (in addition to the C key). */
  crouch = false;
  /** Seconds the camera takes between the walk view and the dollhouse view. */
  transitionTime = 0.9;
  /** Dollhouse view angle above the horizon, radians. */
  dollhouseElevation = 0.9;
  /** Flat world bounds [minX, minY, minZ, maxX, maxY, maxZ] the dollhouse frames (e.g. `model.bounds`). Default: the colliders. */
  dollhouseBounds: ArrayLike<number> | null = null;
  /** What the walker collides with; null (default) is every visible core mesh and attached gltf-pro model. */
  colliders: readonly WalkCollider[] | null;
  /** A `CameraProjection` switched to orthographic in the dollhouse view, or null for a perspective dollhouse. */
  projection: { mode: 'perspective' | 'orthographic' } | null;
  /** Extra analog input, stick convention (x right, y down = back), e.g. from @margoengine/input; look in stick units (2.2 rad/s at 1). */
  readonly axes = { x: 0, y: 0, lookX: 0, lookY: 0 };
  /** World velocity, m/s. */
  readonly velocity: V3 = [0, 0, 0];
  /** Orbit controls for the dollhouse view, enabled only there. */
  readonly orbit: OrbitControls;
  /** Work done by the last update: sub-steps, ground rays, collider candidates and triangles tested. */
  readonly stats = { substeps: 0, rays: 0, candidates: 0, triangles: 0 };
  /** True while the pointer is locked to the element (mouse look without dragging). */
  isLocked = false;
  /** `KeyboardEvent.code`s held down. */
  readonly pressed = new Set<string>();
  private grounded_ = false;
  private height = 1.65;
  private smooth = 0;
  private yaw = 0;
  private pitch = 0;
  private jumpHeld = false;
  private modeValue: WalkMode = 'walk';
  private anim: { from: Pose; to: Pose; t: number } | null = null;
  private saved: Pose | null = null;
  private ticked = false;
  private fresh = false;
  private readonly pointers = new Map<number, { stick: boolean; x: number; y: number; x0: number; y0: number }>();
  private stickView: HTMLDivElement | null = null;
  private readonly keyTarget: EventTargetLike | null;
  private doc: any = null;
  private previousTouchAction = '';
  private readonly unsubscribe: (() => void) | null;
  private readonly pool: Candidate[] = [];
  private count = 0;
  // Per-query state read by the triangle visitors (kept on the instance so visiting allocates nothing).
  private px = 0;
  private pz = 0;
  private y0 = 0;
  private y1 = 0;
  private mx = 0;
  private mz = 0;
  private lo = 0;
  private hi = 0;
  private best = 0;
  private ceiling = false;
  private cosSlope = 0;
  private pushed = false;

  constructor(engine: EngineKernel, options: WalkControlsOptions = {}) {
    super(engine, options.element);
    if (!this.engine) throw new TypeError('WalkControls needs an Engine');
    this.keyTarget = options.keyTarget ?? null;
    this.colliders = options.colliders ?? null;
    this.projection = options.projection ?? null;
    this.unsubscribe =
      options.origin?.onRebase((shift) => {
        for (const p of [this.saved, this.anim?.from, this.anim?.to])
          if (p) for (let i = 0; i < 3; i++) p.p[i] -= shift[i];
      }) ?? null;
    this.orbit = new OrbitControls(engine, options.element);
    this.orbit.enabled = false;
    this.orbit.maxPolarAngle = Math.PI / 2 - 0.05;
    this.init();
  }
  protected get kind(): string {
    return 'walk';
  }
  protected bind(element: ControlElement) {
    if (element.style) {
      this.previousTouchAction = element.style.touchAction;
      element.style.touchAction = 'none';
    }
    const doc = documentOf(element),
      keys = this.keyTarget ?? doc;
    this.doc = doc;
    return [
      [element, 'pointerdown', this.onDown],
      [element, 'pointermove', this.onMove],
      [element, 'pointerup', this.onUp],
      [element, 'pointercancel', this.onUp],
      [doc, 'pointerlockchange', this.onLockChange],
      [keys, 'keydown', this.onKeyDown],
      [keys, 'keyup', this.onKeyUp],
    ] as Array<[EventTargetLike, string, (event: any) => void, AddEventListenerOptions?]>;
  }
  protected onDisconnect(): void {
    this.pressed.clear();
    this.pointers.clear();
    this.showStick(null);
    if (this.element?.style) this.element.style.touchAction = this.previousTouchAction;
  }
  // The orbit controls bound first, so they restore the element's touch-action last.
  dispose(): void {
    this.unsubscribe?.();
    this.stickView?.remove();
    this.stickView = null;
    super.dispose();
    this.orbit.dispose();
  }

  /** `'walk'`, or `'dollhouse'` from the moment `setMode` starts the transition there. */
  get mode(): WalkMode {
    return this.modeValue;
  }
  /** True while the camera moves between the walk and dollhouse views. */
  get transitioning(): boolean {
    return !!this.anim;
  }
  /** True while standing on a walkable floor. */
  get grounded(): boolean {
    return this.grounded_;
  }

  /** Eases to the dollhouse orbit view (framing `dollhouseBounds` or the colliders) or back to the saved walk pose. */
  setMode(mode: WalkMode): this {
    if (mode !== 'walk' && mode !== 'dollhouse') throw new RangeError(`Unknown walk mode ${mode}`);
    if (mode === this.modeValue) return this;
    const c = this.camera,
      from = this.current();
    let to: Pose;
    if (mode === 'dollhouse') {
      this.saved = this.anim ? this.anim.to : from;
      const b = this.dollhouseBounds ?? this.bounds();
      if (b && (b.length !== 6 || !Array.from(b).every(Number.isFinite)))
        throw new RangeError('dollhouseBounds must be 6 finite numbers');
      const centre: V3 = b ? [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2] : ([...c.position] as V3);
      const radius = b ? Math.max(Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]) / 2, 1) : 10;
      const half = (c.fov * Math.PI) / 360,
        element = this.element,
        aspect = element && element.clientHeight ? element.clientWidth / element.clientHeight : 1;
      const distance = (radius * 1.05) / Math.sin(Math.min(half, Math.atan(Math.tan(half) * aspect)));
      const pitch = -this.dollhouseElevation,
        yaw = this.saved.yaw;
      to = pose(sub3(centre, direction(yaw, pitch), distance), yaw, pitch, distance);
      this.doc?.exitPointerLock?.();
    } else {
      to = this.saved ?? from;
      if (this.projection) this.projection.mode = 'perspective';
    }
    this.orbit.enabled = false;
    this.pressed.clear();
    this.pointers.clear();
    this.showStick(null);
    this.modeValue = mode;
    this.anim = { from, to, t: 0 };
    return this;
  }
  /** Switches between walk and dollhouse. */
  toggleDollhouse(): this {
    return this.setMode(this.modeValue === 'walk' ? 'dollhouse' : 'walk');
  }
  /** Requests pointer lock. Clicking the element in walk mode does this when `pointerLock` is true. */
  lock(): void {
    const result = (this.element?.requestPointerLock as (() => unknown) | undefined)?.call(this.element) as
      | Promise<void>
      | undefined;
    if (result && typeof result.catch === 'function') result.catch(() => this.dispatchEvent({ type: 'error' }));
  }

  update(delta = 1 / 60): boolean {
    const runtime = engineRuntime(this.engine!);
    if (runtime.disposed) return false;
    this.check();
    if (this.anim) return this.animate(delta);
    if (this.modeValue !== 'walk') return false;
    this.fresh = !this.ticked;
    if (!this.ticked) {
      runtime.store.tick(false);
      this.ticked = true;
    }
    const c = this.camera,
      dt = clamp(delta, 0, 0.1),
      keys = this.pressed,
      r = this.radius;
    const before = [...c.position, ...c.target];
    // Look: pointer deltas collected since the last frame, then stick rates.
    const pads = this.gamepad ? (globalThis.navigator as Navigator | undefined)?.getGamepads?.() : null;
    let pad: Gamepad | null = null;
    if (pads)
      for (const p of pads)
        if (p && p.axes.length >= 2) {
          pad = p;
          break;
        }
    const button = (i: number) => !!pad?.buttons[i]?.pressed,
      ax = (i: number) => deadzone(pad?.axes[i]);
    const rate = STICK_RATE * this.lookSpeed * dt;
    const yaw = this.yaw - (ax(2) + this.axes.lookX) * rate,
      pitch = this.pitch - (ax(3) + this.axes.lookY) * rate;
    this.yaw = this.pitch = 0;
    if (yaw || pitch) turn(c, yaw, pitch);
    // Movement input in the view's ground plane.
    const stick = this.stick();
    let ix =
      +keys.has('KeyD') +
      +keys.has('ArrowRight') -
      +keys.has('KeyA') -
      +keys.has('ArrowLeft') +
      stick[0] +
      ax(0) +
      this.axes.x;
    let iz =
      +keys.has('KeyW') +
      +keys.has('ArrowUp') -
      +keys.has('KeyS') -
      +keys.has('ArrowDown') -
      stick[1] -
      ax(1) -
      this.axes.y;
    const length = Math.hypot(ix, iz);
    if (length > 1) {
      ix /= length;
      iz /= length;
    }
    const crouching = this.crouch || keys.has('KeyC') || button(1),
      running = keys.has('ShiftLeft') || keys.has('ShiftRight') || button(10);
    const b = basis(c),
      h = Math.hypot(b.forward[0], b.forward[2]) || 1,
      fx = b.forward[0] / h,
      fz = b.forward[2] / h;
    const top = this.speed * (running ? this.runMultiplier : 1) * (crouching ? 0.5 : 1),
      a = 1 - Math.exp(-this.acceleration * dt),
      v = this.velocity;
    v[0] += ((-fz * ix + fx * iz) * top - v[0]) * a;
    v[2] += ((fx * ix + fz * iz) * top - v[2]) * a;
    const jump = keys.has('Space') || button(0);
    if (jump && !this.jumpHeld && this.grounded_ && this.jumpSpeed > 0) {
      v[1] = this.jumpSpeed;
      this.grounded_ = false;
    }
    this.jumpHeld = jump;
    // Simulate in sub-steps no longer than half the radius, so a thin wall is always met before it can be crossed.
    const x0 = c.position[0],
      z0 = c.position[2],
      standing = crouching ? this.crouchHeight : this.eyeHeight;
    let feet = c.position[1] - this.height - this.smooth,
      dx = v[0] * dt,
      dz = v[2] * dt;
    const steps = Math.min(32, Math.max(1, Math.ceil(Math.hypot(dx, dz) / (0.5 * r))));
    if (steps === 32) {
      const s = (16 * r) / Math.hypot(dx, dz);
      dx *= s;
      dz *= s;
    } // ponytail: caps one frame at 16 radii (40 m/s at 10 fps)
    const fall = Math.abs(v[1]) * dt + this.gravity * dt * dt,
      pad2 = r + 0.1;
    BOX[0] = Math.min(x0, x0 + dx) - pad2;
    BOX[3] = Math.max(x0, x0 + dx) + pad2;
    BOX[2] = Math.min(z0, z0 + dz) - pad2;
    BOX[5] = Math.max(z0, z0 + dz) + pad2;
    BOX[1] = feet - this.stepHeight - fall - 0.1;
    BOX[4] = feet + Math.max(this.height, standing) + HEAD + fall + 0.1;
    this.gather(BOX);
    this.stats.substeps = steps;
    this.stats.rays = 0;
    this.stats.candidates = this.count;
    this.stats.triangles = 0;
    let x = x0,
      z = z0;
    for (let i = 0; i < steps; i++) {
      this.mx = dx / steps;
      this.mz = dz / steps;
      x += this.mx;
      z += this.mz;
      this.collide(x, z, feet);
      x = this.px;
      z = this.pz;
      feet = this.vertical(x, z, feet, dt / steps);
    }
    // Crouch and stand up, but not into a ceiling.
    if (standing > this.height) {
      const head = feet + this.height + HEAD,
        limit = this.probe(x, z, head, feet + standing + HEAD, true);
      this.height += (Math.min(standing, limit - HEAD - feet) - this.height) * (1 - Math.exp(-10 * dt));
    } else this.height += (standing - this.height) * (1 - Math.exp(-10 * dt));
    this.smooth = clamp(this.smooth * Math.exp(-12 * dt), -0.5, 0.5);
    if (dt) {
      v[0] = (x - x0) / dt;
      v[2] = (z - z0) / dt;
    }
    const eye = feet + this.height + this.smooth,
      ox = x - c.position[0],
      oy = eye - c.position[1],
      oz = z - c.position[2];
    c.position = [x, eye, z];
    c.target = [c.target[0] + ox, c.target[1] + oy, c.target[2] + oz];
    const after = [...c.position, ...c.target],
      moved = before.some((value, i) => Math.abs(value - after[i]) > 1e-9);
    if (moved) this.dispatchEvent({ type: 'change' });
    return moved;
  }

  private check(): void {
    const ok =
      this.eyeHeight > 0 &&
      this.crouchHeight > 0 &&
      this.crouchHeight <= this.eyeHeight &&
      this.radius > 0 &&
      this.stepHeight >= 0 &&
      this.maxSlope >= 0 &&
      this.maxSlope <= Math.PI / 2 &&
      this.speed >= 0 &&
      this.runMultiplier >= 0 &&
      this.acceleration > 0 &&
      this.gravity >= 0 &&
      this.jumpSpeed >= 0 &&
      Number.isFinite(this.lookSpeed) &&
      this.transitionTime >= 0 &&
      this.dollhouseElevation > 0 &&
      this.dollhouseElevation < Math.PI / 2 &&
      [
        this.eyeHeight,
        this.radius,
        this.stepHeight,
        this.speed,
        this.runMultiplier,
        this.acceleration,
        this.gravity,
        this.jumpSpeed,
        this.transitionTime,
      ].every(Number.isFinite);
    if (!ok)
      throw new RangeError(
        'Invalid WalkControls settings (heights, radius and speeds must be finite and >= 0, crouchHeight <= eyeHeight, maxSlope in [0, PI/2], dollhouseElevation in (0, PI/2))',
      );
  }
  private current(): Pose {
    const b = basis(this.camera),
      f = b.forward;
    return pose([...this.camera.position] as V3, Math.atan2(f[0], f[2]), Math.asin(clamp(f[1], -1, 1)), b.distance);
  }
  private animate(delta: number): boolean {
    const anim = this.anim!,
      c = this.camera;
    anim.t = this.transitionTime > 0 ? Math.min(1, anim.t + Math.max(0, delta) / this.transitionTime) : 1;
    const s = anim.t * anim.t * (3 - 2 * anim.t),
      { from, to } = anim;
    let turnBy = to.yaw - from.yaw;
    turnBy -= Math.round(turnBy / (2 * Math.PI)) * 2 * Math.PI;
    const p: V3 = [0, 1, 2].map((i) => from.p[i] + (to.p[i] - from.p[i]) * s) as V3;
    const yaw = from.yaw + turnBy * s,
      pitch = clamp(from.pitch + (to.pitch - from.pitch) * s, -MAX_PITCH, MAX_PITCH),
      distance = from.distance + (to.distance - from.distance) * s;
    c.position = p;
    c.target = sub3(p, direction(yaw, pitch), -distance);
    if (anim.t >= 1) {
      this.anim = null;
      if (this.modeValue === 'dollhouse') {
        this.orbit.enabled = true;
        if (this.projection) this.projection.mode = 'orthographic';
      } else this.velocity.fill(0);
      this.dispatchEvent({ type: 'mode', mode: this.modeValue });
    }
    this.dispatchEvent({ type: 'change' });
    return true;
  }

  /** Fills the candidate pool with colliders whose world box touches `box`; their union goes to WB. */
  private gather(box: Float64Array): void {
    this.count = 0;
    WB.fill(Infinity, 0, 3);
    WB.fill(-Infinity, 3);
    const runtime = engineRuntime(this.engine!),
      list = this.colliders;
    if (list) {
      for (const object of list)
        if (isModel(object)) this.addModel(object, box);
        else this.addMesh(object as unknown as RuntimeMesh, box);
    } else {
      for (const mesh of runtime.meshes.values()) this.addMesh(mesh as unknown as RuntimeMesh, box);
      for (const model of engineModels(this.engine!)) this.addModel(model, box);
    }
  }
  private addMesh(mesh: RuntimeMesh, box: Float64Array): void {
    const geometry = mesh.geometry;
    if (!geometry) return;
    const store = engineRuntime(this.engine!).store,
      local = localBounds(geometry, geometry.vertices, 6, 1);
    if (overlaps(store.matrices, mesh.id * 16, local, 0, box) && this.alive(mesh))
      this.accept(store.matrices, mesh.id * 16, geometry, null);
  }
  private addModel(model: ModelLike, box: Float64Array): void {
    if (model.disposed) return;
    const store = engineRuntime(this.engine!).store,
      M = store.matrices,
      primitives = model.primitives,
      locals = modelBounds(model);
    // ponytail: one box test per primitive and frame (well under a microsecond); a top-level tree over parts would pay off past ~10k parts.
    for (let i = 0; i < primitives.length; i++) {
      const primitive = primitives[i],
        node = primitive.node as unknown as RuntimeMesh,
        instances = primitive.instances;
      if (!instances) {
        if (overlaps(M, node.id * 16, locals, i * 6, box) && this.alive(node))
          this.accept(M, node.id * 16, null, primitive);
        continue;
      }
      if (!this.alive(node)) continue;
      for (let k = 0; k < instances.count; k++) {
        multiplyMatrices(
          M.subarray(node.id * 16, node.id * 16 + 16),
          instances.data.subarray(k * 24, k * 24 + 16),
          INSTANCE,
        );
        if (overlaps(INSTANCE, 0, locals, i * 6, box)) this.accept(INSTANCE, 0, null, primitive);
      }
    }
  }
  private alive(mesh: RuntimeMesh): boolean {
    const runtime = engineRuntime(this.engine!);
    return runtime.meshes.get(mesh.id) === (mesh as unknown) && !hidden(runtime.store, mesh.id);
  }
  /** Adds a candidate whose world box (left in OB by `overlaps`) touches the query, when its matrix inverts. */
  private accept(
    matrices: ArrayLike<number>,
    o: number,
    geometry: GeometryLike | null,
    primitive: ModelPrimitiveLike | null,
  ): void {
    const slot = (this.pool[this.count] ??= {
      bvh: null,
      geometry: null,
      primitive: null,
      m: new Float64Array(16),
      inv: new Float64Array(16),
    });
    for (let i = 0; i < 16; i++) slot.m[i] = matrices[o + i];
    if (!invertMatrix(slot.m, slot.inv)) return;
    for (let k = 0; k < 3; k++) {
      WB[k] = Math.min(WB[k], OB[k]);
      WB[k + 3] = Math.max(WB[k + 3], OB[k + 3]);
    }
    slot.geometry = geometry;
    slot.primitive = primitive;
    slot.bvh = null;
    this.count++;
  } /** World bounds of every collider, or null when there are none. */
  private bounds(): number[] | null {
    BOX.fill(-Infinity, 0, 3);
    BOX.fill(Infinity, 3);
    this.gather(BOX);
    return this.count ? [...WB] : null;
  }
  /** Calls `visit` for each candidate triangle (world space in T) whose box touches the world box. */
  private triangles(box: Float64Array, visit: () => void): void {
    for (let n = 0; n < this.count; n++) {
      const slot = this.pool[n],
        { m, inv } = slot,
        bvh = (slot.bvh ??= slot.primitive ? getPrimitiveBVH(slot.primitive) : getGeometryBVH(slot.geometry!)),
        f = bvh.nodeBounds,
        u = bvh.nodeData,
        index = bvh.index,
        P = bvh.positions,
        s = bvh.stride;
      localBox(inv, box);
      let sp = 0;
      STACK[sp++] = 0;
      while (sp) {
        const node = STACK[--sp],
          w = node * 8;
        if (
          f[w] > LB[3] ||
          f[w + 3] < LB[0] ||
          f[w + 1] > LB[4] ||
          f[w + 4] < LB[1] ||
          f[w + 2] > LB[5] ||
          f[w + 5] < LB[2]
        )
          continue;
        if (!bvh.isLeaf(node)) {
          STACK[sp++] = u[w + 6];
          STACK[sp++] = node + 1;
          continue;
        }
        for (let k = u[w + 6], end = k + u[w + 7]; k < end; k++) {
          for (let j = 0; j < 3; j++) {
            const o = index[k * 3 + j] * s,
              x = P[o],
              y = P[o + 1],
              z = P[o + 2];
            T[j * 3] = m[0] * x + m[4] * y + m[8] * z + m[12];
            T[j * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
            T[j * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
          }
          if (
            Math.min(T[0], T[3], T[6]) > box[3] ||
            Math.max(T[0], T[3], T[6]) < box[0] ||
            Math.min(T[1], T[4], T[7]) > box[4] ||
            Math.max(T[1], T[4], T[7]) < box[1] ||
            Math.min(T[2], T[5], T[8]) > box[5] ||
            Math.max(T[2], T[5], T[8]) < box[2]
          )
            continue;
          this.stats.triangles++;
          visit();
        }
      }
    }
  }

  /** Pushes the capsule at (x, z) horizontally out of every triangle; result in px, pz. */
  private collide(x: number, z: number, feet: number): void {
    const r = this.radius;
    this.px = x;
    this.pz = z;
    this.y0 = feet + this.stepHeight + r;
    this.y1 = Math.max(this.y0, feet + this.height + HEAD - r);
    for (let i = 0; i < 4; i++) {
      this.pushed = false;
      BOX[0] = this.px - 1.5 * r;
      BOX[1] = this.y0 - r;
      BOX[2] = this.pz - 1.5 * r;
      BOX[3] = this.px + 1.5 * r;
      BOX[4] = this.y1 + r;
      BOX[5] = this.pz + 1.5 * r;
      this.triangles(BOX, this.pushOut);
      if (!this.pushed) break;
    }
  }
  private readonly pushOut = (): void => {
    const r = this.radius,
      x = this.px,
      z = this.pz,
      y0 = this.y0,
      y1 = this.y1;
    const ax = T[0],
      ay = T[1],
      az = T[2],
      e1x = T[3] - ax,
      e1y = T[4] - ay,
      e1z = T[5] - az,
      e2x = T[6] - ax,
      e2y = T[7] - ay,
      e2z = T[8] - az;
    const nx = e1y * e2z - e1z * e2y,
      ny = e1z * e2x - e1x * e2z,
      nz = e1x * e2y - e1y * e2x,
      nh = Math.hypot(nx, nz);
    if (!(Math.hypot(nx, ny, nz) > 1e-12)) return;
    // The vertical segment pierces the triangle: push along the triangle's horizontal normal, against the motion.
    // ponytail: half a radius per iteration; only reachable after a teleport or with geometry thinner than a sub-step.
    if (Math.abs(ny) > 1e-12) {
      const y = planeHeight(x, z);
      if (y >= y0 && y <= y1) {
        if (nh < 1e-9) return;
        const sign =
          nx * this.mx + nz * this.mz > 0 ||
          (!this.mx && !this.mz && nx * (x - ax) + ny * ((y0 + y1) / 2 - ay) + nz * (z - az) < 0)
            ? -1
            : 1;
        this.px += ((sign * nx) / nh) * r * 0.5;
        this.pz += ((sign * nz) / nh) * r * 0.5;
        this.pushed = true;
        return;
      }
    }
    let best = closestPointTriangle(x, y0, z, Q, 3),
      qx = Q[3],
      qy = Q[4],
      qz = Q[5],
      py = y0;
    let d = closestPointTriangle(x, y1, z, Q, 3);
    if (d < best) {
      best = d;
      qx = Q[3];
      qy = Q[4];
      qz = Q[5];
      py = y1;
    }
    for (let e = 0; e < 3; e++) {
      d = segmentEdge(x, y0, y1, z, e);
      if (d < best) {
        best = d;
        py = Q[1];
        qx = Q[3];
        qy = Q[4];
        qz = Q[5];
      }
    }
    if (best >= r * r) return;
    const hx = x - qx,
      hz = z - qz,
      hl = Math.hypot(hx, hz),
      dy = py - qy;
    if (hl < 1e-9) return; // straight above or below: floors and ceilings belong to the vertical probes
    const move = Math.sqrt(Math.max(0, r * r - dy * dy)) - hl + SKIN;
    this.px += (hx / hl) * move;
    this.pz += (hz / hl) * move;
    this.pushed = true;
  };

  /** Snaps to the floor within a step, or falls; returns the new feet height. */
  private vertical(x: number, z: number, feet: number, h: number): number {
    const v = this.velocity,
      step = this.stepHeight + STEP_SLACK;
    if (this.grounded_) {
      const ground = this.probe(x, z, feet - step, feet + step, false);
      if (ground > -Infinity) {
        this.smooth += feet - ground;
        v[1] = 0;
        return ground;
      }
      this.grounded_ = false;
      v[1] = 0;
    }
    v[1] = Math.max(v[1] - this.gravity * h, -50);
    let next = feet + v[1] * h;
    if (v[1] > 0) {
      const head = feet + this.height + HEAD,
        ceiling = this.probe(x, z, head, next + this.height + HEAD, true);
      if (ceiling < Infinity) {
        next = Math.max(feet, ceiling - this.height - HEAD - SKIN);
        v[1] = 0;
      }
      return next;
    }
    // Land only on floors crossed during this sub-step (a fall beside a slab must not land on its underside), except on the
    // first update, which also lifts a camera placed up to a step too low onto the floor.
    const ground = this.probe(x, z, next - STEP_SLACK, feet + (this.fresh ? step : STEP_SLACK), false);
    if (ground >= next - STEP_SLACK && ground > -Infinity) {
      this.grounded_ = true;
      v[1] = 0;
      return ground;
    }
    return next;
  }
  /**
   * Nine vertical rays at the centre and on a ring of 0.9 x radius, in one BVH pass per collider: the highest walkable
   * hit in [lo, hi] (floor), or with `ceiling` the lowest hit of any slope (-Infinity / Infinity for none).
   */
  private probe(x: number, z: number, lo: number, hi: number, ceiling: boolean): number {
    const reach = this.radius * RING;
    this.px = x;
    this.pz = z;
    this.lo = lo;
    this.hi = hi;
    this.ceiling = ceiling;
    this.best = ceiling ? Infinity : -Infinity;
    this.cosSlope = Math.cos(this.maxSlope) - 1e-9;
    BOX[0] = x - reach;
    BOX[1] = lo;
    BOX[2] = z - reach;
    BOX[3] = x + reach;
    BOX[4] = hi;
    BOX[5] = z + reach;
    this.stats.rays += 9;
    if (hi >= lo) this.triangles(BOX, this.hitRays);
    return this.best;
  }
  private readonly hitRays = (): void => {
    const e1x = T[3] - T[0],
      e1y = T[4] - T[1],
      e1z = T[5] - T[2],
      e2x = T[6] - T[0],
      e2y = T[7] - T[1],
      e2z = T[8] - T[2];
    const nx = e1y * e2z - e1z * e2y,
      ny = e1z * e2x - e1x * e2z,
      nz = e1x * e2y - e1y * e2x;
    if (!this.ceiling && Math.abs(ny) < this.cosSlope * Math.hypot(nx, ny, nz)) return;
    const reach = this.radius * RING;
    for (let i = 0; i < 9; i++) {
      const y = planeHeight(this.px + RX[i] * reach, this.pz + RZ[i] * reach);
      if (y >= this.lo && y <= this.hi && (this.ceiling ? y < this.best : y > this.best)) this.best = y;
    }
  };

  /** Current stick vector in [-1, 1] (x right, y down), from the touch thumbstick. */
  private stick(): [number, number] {
    for (const p of this.pointers.values())
      if (p.stick) {
        const x = (p.x - p.x0) / STICK_PIXELS,
          y = (p.y - p.y0) / STICK_PIXELS,
          l = Math.max(1, Math.hypot(x, y));
        return [x / l, y / l];
      }
    return [0, 0];
  }
  /** Draws the floating thumbstick (a ring at the touch-down point and a knob) or hides it. */
  private showStick(p: { x: number; y: number; x0: number; y0: number } | null): void {
    const doc = this.element?.ownerDocument;
    if (!p) {
      if (this.stickView) this.stickView.style.display = 'none';
      return;
    }
    if (!doc?.createElement) return;
    if (!this.stickView) {
      const ring = (this.stickView = doc.createElement('div') as HTMLDivElement),
        knob = doc.createElement('div');
      ring.style.cssText =
        'position:fixed;width:96px;height:96px;margin:-50px;border:2px solid #fffa;border-radius:50%;background:#0003;pointer-events:none;z-index:10';
      knob.style.cssText =
        'position:absolute;left:30px;top:30px;width:36px;height:36px;border-radius:50%;background:#fffc';
      ring.append(knob);
      doc.body.append(ring);
    }
    const rect = this.element?.getBoundingClientRect?.() ?? { left: 0, top: 0 },
      [sx, sy] = this.stick(),
      view = this.stickView;
    view.style.display = '';
    view.style.left = `${rect.left + p.x0}px`;
    view.style.top = `${rect.top + p.y0}px`;
    (view.firstChild as HTMLDivElement).style.transform = `translate(${sx * 30}px,${sy * 30}px)`;
  }

  private readonly onDown = (event: PointerEvent): void => {
    if (!this.enabled || this.modeValue !== 'walk' || this.anim) return;
    const touch = event.pointerType === 'touch',
      p = this.local(event),
      element = this.element!;
    if (!touch && event.button !== 0) return;
    if (!touch && this.pointerLock && !this.isLocked) this.lock();
    const stick = touch && p.x < element.clientWidth / 2 && ![...this.pointers.values()].some((q) => q.stick);
    this.pointers.set(event.pointerId, { stick, x: p.x, y: p.y, x0: p.x, y0: p.y });
    this.capture(event.pointerId);
    if (stick) this.showStick(this.pointers.get(event.pointerId)!);
  };
  private readonly onMove = (event: PointerEvent): void => {
    if (!this.enabled || this.modeValue !== 'walk' || this.anim) return;
    const k = this.lookSpeed;
    if (this.isLocked && event.pointerType !== 'touch') {
      this.yaw -= (event.movementX || 0) * MOUSE * k;
      this.pitch -= (event.movementY || 0) * MOUSE * k;
      return;
    }
    const state = this.pointers.get(event.pointerId);
    if (!state) return;
    const p = this.local(event);
    if (!state.stick) {
      const f = (event.pointerType === 'touch' ? TOUCH : MOUSE) * k;
      this.yaw -= (p.x - state.x) * f;
      this.pitch -= (p.y - state.y) * f;
    }
    state.x = p.x;
    state.y = p.y;
    if (state.stick) this.showStick(state);
  };
  private readonly onUp = (event: PointerEvent): void => {
    const state = this.pointers.get(event.pointerId);
    if (!state) return;
    this.pointers.delete(event.pointerId);
    this.release(event.pointerId);
    if (state.stick) this.showStick(null);
  };
  private readonly onLockChange = (): void => {
    const locked = !!this.doc && this.doc.pointerLockElement === this.element;
    if (locked !== this.isLocked) {
      this.isLocked = locked;
      this.dispatchEvent({ type: locked ? 'lock' : 'unlock' });
    }
  };
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!this.enabled || (event.target as Element | null)?.closest?.('input,textarea,select,[contenteditable=true]'))
      return;
    this.pressed.add(event.code);
    if (this.modeValue === 'walk' && /^(Space|Arrow)/.test(event.code)) event.preventDefault?.();
  };
  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.pressed.delete(event.code);
  };
}

interface RuntimeMesh {
  id: number;
  geometry: { vertices: Float32Array; indices: Uint32Array; bounds: Float32Array } | null;
}

function hidden(store: { parents: ArrayLike<number>; hidden: ArrayLike<number> }, id: number): boolean {
  for (let node = id, depth = 0; node >= 0 && depth <= 64; node = store.parents[node], depth++)
    if (store.hidden[node]) return true;
  return false;
}
/** Local box of interleaved positions (stride 6 for core geometry, 20 for gltf-pro), cached per geometry. */
function localBounds(key: object, v: Float32Array, stride: number, cache: number): Float64Array {
  let box = cache ? localBoxes.get(key) : undefined;
  if (!box) {
    box = new Float64Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
    for (let i = 0; i < v.length; i += stride)
      for (let k = 0; k < 3; k++) {
        if (v[i + k] < box[k]) box[k] = v[i + k];
        if (v[i + k] > box[k + 3]) box[k + 3] = v[i + k];
      }
    if (cache) localBoxes.set(key, box);
  }
  return box;
}
/** Local boxes of a model's primitives, 6 numbers each, cached per primitives array (shared vertex arrays share one pass). */
function modelBounds(model: ModelLike): Float64Array {
  let boxes = modelBoxes.get(model.primitives);
  if (!boxes || boxes.length !== model.primitives.length * 6) {
    boxes = new Float64Array(model.primitives.length * 6);
    model.primitives.forEach((p, i) => {
      let box = localBoxes.get(p.indices);
      if (!box) localBoxes.set(p.indices, (box = localBounds(p, p.vertices, 20, 0)));
      boxes!.set(box, i * 6);
    });
    modelBoxes.set(model.primitives, boxes);
  }
  return boxes;
}
/** True when the local box `local[l..l+5]` under the matrix at `m[o]` (Arvo's method) touches `box`; the world box goes to OB. */
function overlaps(m: ArrayLike<number>, o: number, local: Float64Array, l: number, box: Float64Array): boolean {
  for (let k = 0; k < 3; k++) {
    let lo = m[o + 12 + k],
      hi = lo;
    for (let j = 0; j < 3; j++) {
      const s = m[o + j * 4 + k],
        a = s * local[l + j],
        b = s * local[l + j + 3];
      if (a < b) {
        lo += a;
        hi += b;
      } else {
        lo += b;
        hi += a;
      }
    }
    if (lo > box[k + 3] || hi < box[k] || !(lo <= hi)) return false;
    OB[k] = lo;
    OB[k + 3] = hi;
  }
  return true;
} /** World box through an inverse matrix into LB (Arvo's method). */
function localBox(m: Float64Array, box: Float64Array): void {
  const cx = (box[0] + box[3]) / 2,
    cy = (box[1] + box[4]) / 2,
    cz = (box[2] + box[5]) / 2,
    ex = (box[3] - box[0]) / 2,
    ey = (box[4] - box[1]) / 2,
    ez = (box[5] - box[2]) / 2;
  for (let r = 0; r < 3; r++) {
    const c = m[r] * cx + m[4 + r] * cy + m[8 + r] * cz + m[12 + r],
      e = Math.abs(m[r]) * ex + Math.abs(m[4 + r]) * ey + Math.abs(m[8 + r]) * ez;
    LB[r] = c - e;
    LB[3 + r] = c + e;
  }
}
/** Height of the triangle T's plane above (x, z) when (x, z) lies inside its ground projection, else NaN. */
function planeHeight(x: number, z: number): number {
  const ax = T[0],
    az = T[2],
    bx = T[3],
    bz = T[5],
    cx = T[6],
    cz = T[8],
    d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
  if (Math.abs(d) < 1e-12) return NaN;
  const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d,
    l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d,
    l3 = 1 - l1 - l2;
  return l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9 ? NaN : l1 * T[1] + l2 * T[4] + l3 * T[7];
}
/** Closest point of triangle T to p (Ericson 5.1.5) into out[o..o+2]; returns the squared distance. */
function closestPointTriangle(px: number, py: number, pz: number, out: Float64Array, o: number): number {
  const ax = T[0],
    ay = T[1],
    az = T[2],
    abx = T[3] - ax,
    aby = T[4] - ay,
    abz = T[5] - az,
    acx = T[6] - ax,
    acy = T[7] - ay,
    acz = T[8] - az;
  const apx = px - ax,
    apy = py - ay,
    apz = pz - az,
    d1 = abx * apx + aby * apy + abz * apz,
    d2 = acx * apx + acy * apy + acz * apz;
  let v = 0,
    w = 0;
  const d3 = d1 - (abx * abx + aby * aby + abz * abz),
    d4 = d2 - (abx * acx + aby * acy + abz * acz); // p - b
  const d5 = d1 - (abx * acx + aby * acy + abz * acz),
    d6 = d2 - (acx * acx + acy * acy + acz * acz); // p - c
  const vc = d1 * d4 - d3 * d2,
    vb = d5 * d2 - d1 * d6,
    va = d3 * d6 - d5 * d4;
  if (d1 <= 0 && d2 <= 0) {
    /* a */
  } else if (d3 >= 0 && d4 <= d3) v = 1;
  else if (vc <= 0 && d1 >= 0 && d3 <= 0) v = d1 / (d1 - d3);
  else if (d6 >= 0 && d5 <= d6) w = 1;
  else if (vb <= 0 && d2 >= 0 && d6 <= 0) w = d2 / (d2 - d6);
  else if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    v = 1 - w;
  } else {
    const denominator = 1 / (va + vb + vc);
    v = vb * denominator;
    w = vc * denominator;
  }
  const qx = ax + abx * v + acx * w,
    qy = ay + aby * v + acy * w,
    qz = az + abz * v + acz * w;
  out[o] = qx;
  out[o + 1] = qy;
  out[o + 2] = qz;
  return (px - qx) ** 2 + (py - qy) ** 2 + (pz - qz) ** 2;
}
/** Closest points between the vertical segment (x, y0..y1, z) and edge e of T (Ericson 5.1.9) into Q; squared distance. */
function segmentEdge(x: number, y0: number, y1: number, z: number, e: number): number {
  const i = e * 3,
    j = ((e + 1) % 3) * 3,
    p2x = T[i],
    p2y = T[i + 1],
    p2z = T[i + 2],
    d2x = T[j] - p2x,
    d2y = T[j + 1] - p2y,
    d2z = T[j + 2] - p2z;
  const d1 = y1 - y0,
    rx = x - p2x,
    ry = y0 - p2y,
    rz = z - p2z,
    a = d1 * d1,
    ee = d2x * d2x + d2y * d2y + d2z * d2z,
    f = d2x * rx + d2y * ry + d2z * rz;
  let s = 0,
    t = 0;
  if (ee <= 1e-18) s = a > 1e-18 ? clamp(-(d1 * ry) / a, 0, 1) : 0;
  else if (a <= 1e-18) t = clamp(f / ee, 0, 1);
  else {
    const c = d1 * ry,
      b = d1 * d2y,
      denominator = a * ee - b * b;
    s = denominator > 1e-18 ? clamp((b * f - c * ee) / denominator, 0, 1) : 0;
    t = (b * s + f) / ee;
    if (t < 0) {
      t = 0;
      s = clamp(-c / a, 0, 1);
    } else if (t > 1) {
      t = 1;
      s = clamp((b - c) / a, 0, 1);
    }
  }
  Q[0] = x;
  Q[1] = y0 + d1 * s;
  Q[2] = z;
  Q[3] = p2x + d2x * t;
  Q[4] = p2y + d2y * t;
  Q[5] = p2z + d2z * t;
  return (Q[0] - Q[3]) ** 2 + (Q[1] - Q[4]) ** 2 + (Q[2] - Q[5]) ** 2;
}
const direction = (yaw: number, pitch: number): V3 => [
  Math.sin(yaw) * Math.cos(pitch),
  Math.sin(pitch),
  Math.cos(yaw) * Math.cos(pitch),
];
const sub3 = (a: readonly number[], d: V3, s: number): V3 => [a[0] - d[0] * s, a[1] - d[1] * s, a[2] - d[2] * s];
