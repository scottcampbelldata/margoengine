import type { EngineKernel, Mesh } from '@margoengine/core';
import { engineRuntime, meshRuntime } from '@margoengine/core/extension';
import { Raycaster, isModel, type ModelLike } from '@margoengine/bvh';
import { Controls, type ControlElement, type EventTargetLike, type InputEventListener } from './controls.js';
import { EPS, IDENTITY, madd, transformPoint, type V3 } from './math.js';
import { cross, normalize, sub } from '@margoengine/math/vec3';
import { moved } from './steer.js';
export { Controls };

/** What the camera follows: a core mesh, a gltf-pro model (by its `root`), or a function returning a world position. */
export type FollowSubject = Mesh | ModelLike | (() => readonly number[]);
/** Something the arm collides with: a core mesh or a gltf-pro model. */
export type ArmCollider = Mesh | ModelLike;

/** Options of `ThirdPersonControls`; every field is optional, and all but `element` and `raycaster` can change later as properties. */
export interface ThirdPersonControlsOptions {
  /** Arm length the camera returns to, in world units. Default 4. */
  distance?: number;
  /** World offset from the subject to the point the arm turns about. Default [0, 1.5, 0]: about head height. */
  pivotOffset?: readonly [number, number, number];
  /** Sideways shift of the camera, positive to the right: over-the-shoulder views. Default 0. */
  shoulder?: number;
  /** Seconds the pivot takes to settle behind a moving subject. 0 is rigid. Default 0.12. */
  lag?: number;
  /** Time constant in seconds of the arm lengthening after an obstacle clears. 0 is at once. Default 0.25. */
  returnTime?: number;
  /** Clearance kept from what the camera hits, and the radius of the swept rays. Default 0.2. */
  probeRadius?: number;
  /** Sweep the arm against the scene. Default true. */
  collide?: boolean;
  /** What stops the arm. Default null: every visible mesh and model except the subject. */
  colliders?: readonly ArmCollider[] | null;
  /** Meshes and models the arm passes through, on top of the subject. Default none. */
  ignore?: readonly ArmCollider[];
  /** Raycaster for the arm (layers, side, filter). Default: a new one. */
  raycaster?: Raycaster;
  /** Element to listen on. Defaults to the engine canvas. */
  element?: ControlElement | null;
}

/** Radians per CSS pixel of drag at `rotateSpeed` 1. */
const DRAG = 0.005;
/** Pixels of wheel that double the distance at `zoomSpeed` 1, as in OrbitControls. */
const PIXELS_PER_DOUBLING = 500;
const LINE_PIXELS = 100 / 3;
const PAGE_PIXELS = 800;
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/**
 * A follow camera on a spring arm. The camera sits `distance` behind a pivot above the subject, at `yaw` and `pitch`.
 * The pivot trails the subject on a critically damped spring (`lag`), so starts and stops are soft. Every update the
 * arm is swept from the pivot to the camera with the bvh Raycaster: a centre ray and four rays `probeRadius` around
 * it. When something is in the way the arm shortens at once, so no wall ever comes between camera and subject, and
 * it lengthens again over `returnTime`. Drag (mouse or one finger) turns the view, the wheel or a pinch changes
 * `distance`, and `rotate(yaw, pitch)` takes any other input. Events: `start`, `change`, `end`.
 */
export class ThirdPersonControls extends Controls {
  /** What the camera follows. */
  subject: FollowSubject;
  /** Arm length the camera returns to, in world units. Default 4. */
  distance: number;
  /** Shortest `distance` the wheel and pinch reach. Default 1. */
  minDistance = 1;
  /** Longest `distance` the wheel and pinch reach. Default 12. */
  maxDistance = 12;
  /** World offset from the subject to the pivot. Default [0, 1.5, 0]. */
  pivotOffset: readonly [number, number, number];
  /** Sideways shift of the camera, positive to the right. Default 0. */
  shoulder: number;
  /** Heading of the arm in radians: 0 puts the camera on the +Z side of the subject, looking toward -Z. */
  yaw = 0;
  /** Elevation of the arm in radians: positive is above the subject, looking down. Default from the camera. */
  pitch = 0;
  /** Lowest `pitch`. Default -0.6. */
  minPitch = -0.6;
  /** Highest `pitch`. Default 1.4. */
  maxPitch = 1.4;
  /** Drag rate multiplier. Default 1. */
  rotateSpeed = 1;
  /** Wheel and pinch rate multiplier. Default 1. */
  zoomSpeed = 1;
  /** Time in seconds the pivot takes to settle behind a moving subject. 0 is rigid. Default 0.12. */
  lag: number;
  /** Time constant in seconds of the arm lengthening after an obstacle clears. 0 is at once. Default 0.25. */
  returnTime: number;
  /** Clearance kept between the camera and what it hits, and the radius of the swept rays. Default 0.2. */
  probeRadius: number;
  /** Sweep the arm against the scene. Default true. */
  collide: boolean;
  /** What stops the arm. Default null: every visible mesh and model except the subject. */
  colliders: readonly ArmCollider[] | null;
  /** Meshes and models the arm passes through, on top of the subject. */
  ignore: readonly ArmCollider[];
  /** The arm's length now, shorter than the wanted one while something is in the way. */
  armLength: number;
  readonly raycaster: Raycaster;

  private pivot: V3;
  private last: readonly number[] = [0, 0, 0];
  private readonly speed: V3 = [0, 0, 0];
  private settled = false;
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private spread = 0;
  private savedTouchAction: string | null = null;

  constructor(engine: EngineKernel, subject: FollowSubject, options: ThirdPersonControlsOptions = {}) {
    super(engine, options.element);
    if (!subject) throw new TypeError('ThirdPersonControls needs a subject: a mesh, a model or a function');
    this.subject = subject;
    this.pivotOffset = options.pivotOffset ?? [0, 1.5, 0];
    this.shoulder = options.shoulder ?? 0;
    this.lag = options.lag ?? 0.12;
    this.returnTime = options.returnTime ?? 0.25;
    this.probeRadius = options.probeRadius ?? 0.2;
    this.collide = options.collide ?? true;
    this.colliders = options.colliders ?? null;
    this.ignore = options.ignore ?? [];
    this.raycaster = options.raycaster ?? new Raycaster();
    this.pivot = this.goal();
    // Start from where the camera is, so attaching does not swing the view.
    const camera = this.camera,
      back = sub(camera.position, this.pivot),
      length = Math.hypot(...back);
    this.distance = options.distance ?? 4;
    this.armLength = this.distance;
    if (length > EPS) {
      this.yaw = Math.atan2(back[0], back[2]);
      this.pitch = clamp(Math.asin(clamp(back[1] / length, -1, 1)), this.minPitch, this.maxPitch);
    }
    this.init();
  }
  protected override get kind(): string {
    return 'third-person';
  }
  protected override bind(
    element: ControlElement,
  ): Array<[EventTargetLike, string, InputEventListener, AddEventListenerOptions?]> {
    if (element.style) {
      this.savedTouchAction = element.style.touchAction;
      element.style.touchAction = 'none';
    }
    return [
      [element, 'pointerdown', this.onDown as InputEventListener],
      [element, 'pointermove', this.onMove as InputEventListener],
      [element, 'pointerup', this.onUp as InputEventListener],
      [element, 'pointercancel', this.onUp as InputEventListener],
      [element, 'wheel', this.onWheel as InputEventListener, { passive: false }],
      [element, 'contextmenu', this.onMenu],
    ];
  }
  protected override onDisconnect(): void {
    for (const id of this.pointers.keys()) this.release(id);
    this.pointers.clear();
    const element = this.element;
    if (element?.style && this.savedTouchAction !== null) element.style.touchAction = this.savedTouchAction;
    this.savedTouchAction = null;
  }

  /** Turns the arm by `yaw` and `pitch` radians, within the pitch limits: for gamepads, pointer lock or `@margoengine/input`. */
  rotate(yaw: number, pitch: number): void {
    this.yaw += yaw;
    this.pitch = clamp(this.pitch + pitch, this.minPitch, this.maxPitch);
  }
  /** Moves the pivot straight to the subject with no spring, for a teleport or a cut. */
  snap(): void {
    this.pivot = this.goal();
    this.speed.fill(0);
    this.settled = false;
  }
  /** Unit direction on the ground the camera faces: "forward" for moving the subject with the stick. */
  get heading(): V3 {
    return [-Math.sin(this.yaw), 0, -Math.cos(this.yaw)];
  }

  /** Moves the pivot, sweeps the arm and places the camera for `delta` seconds (default 1/60). Returns true when the camera moved. */
  update(delta = 1 / 60): boolean {
    const camera = this.camera,
      before = [...camera.position, ...camera.target],
      dt = Math.max(0, delta);
    this.follow(this.goal(), dt);
    const pitch = clamp(this.pitch, this.minPitch, this.maxPitch),
      across = Math.cos(pitch),
      back: V3 = [Math.sin(this.yaw) * across, Math.sin(pitch), Math.cos(this.yaw) * across],
      right: V3 = [Math.cos(this.yaw), 0, -Math.sin(this.yaw)],
      wanted = madd(madd(this.pivot, back, this.distance), right, this.shoulder),
      line = sub(wanted, this.pivot),
      full = Math.hypot(...line),
      along = full > EPS ? (normalize(line) as V3) : back,
      free = this.collide ? this.sweep(along, full) : full;
    // In at once, so the wall never comes between; out on a curve, so the camera does not jump when it clears.
    if (free < this.armLength || !this.settled || !this.returnTime) this.armLength = free;
    else this.armLength += (free - this.armLength) * (1 - Math.exp(-dt / this.returnTime));
    if (this.armLength > full) this.armLength = full;
    this.settled = true;
    const position = madd(this.pivot, along, this.armLength);
    camera.position = position;
    camera.target = madd(position, back, -Math.max(this.distance, 1));
    const changed = moved(before, camera);
    if (changed) this.dispatchEvent({ type: 'change' });
    return changed;
  }

  /** The pivot's goal: the subject's world position plus `pivotOffset`. */
  private goal(): V3 {
    return madd(this.subjectPosition(), this.pivotOffset, 1);
  }
  private subjectPosition(): readonly number[] {
    const subject = this.subject;
    if (typeof subject === 'function') return subject();
    const mesh = isModel(subject) ? subject.root : subject,
      store = engineRuntime(this.engine!).store,
      t = store.transforms,
      id = meshRuntime(mesh).id;
    // A disposed subject leaves the camera where it last followed to.
    if (engineRuntime(this.engine!).meshes.get(id) !== (mesh as unknown)) return this.last;
    const parent = store.parents[id],
      local = [t.x[id], t.y[id], t.z[id]];
    // The local position is current; a parent's matrix is the one from the last frame.
    this.last = transformPoint(parent < 0 ? IDENTITY : store.matrices.subarray(parent * 16, parent * 16 + 16), local);
    return this.last;
  }
  /** Critically damped spring toward `goal`, integrated exactly, so 30 and 60 fps settle alike. */
  private follow(goal: V3, dt: number): void {
    if (!(this.lag > 0)) {
      this.pivot = goal;
      this.speed.fill(0);
      return;
    }
    const rate = 4 / this.lag,
      fade = Math.exp(-rate * dt);
    for (let i = 0; i < 3; i++) {
      const gap = this.pivot[i] - goal[i],
        carry = (this.speed[i] + rate * gap) * dt;
      this.speed[i] = (this.speed[i] - rate * carry) * fade;
      this.pivot[i] = goal[i] + (gap + carry) * fade;
    }
  }
  /** Length the arm can reach along the unit `along`, at most `full`, keeping `probeRadius` from whatever it hits. */
  private sweep(along: V3, full: number): number {
    if (full <= EPS) return full;
    const radius = Math.max(0, this.probeRadius),
      side = normalize(Math.abs(along[1]) < 0.99 ? cross(along, [0, 1, 0]) : cross(along, [1, 0, 0])) as V3,
      lift = cross(side, along) as V3;
    let free = this.cast(this.pivot, along, full + radius, true) - radius;
    if (radius > 0)
      for (const offset of [side, lift, madd([0, 0, 0], side, -1), madd([0, 0, 0], lift, -1)]) {
        // Keep the side ray's start on the near side of a wall right beside the pivot.
        const room = this.cast(this.pivot, offset, radius, false),
          start = madd(this.pivot, offset, Math.max(0, room - EPS));
        free = Math.min(free, this.cast(start, along, full + radius, false) - radius);
      }
    return Math.max(0, Math.min(free, full));
  }
  /** Distance to the first thing along the ray, or `far` when it is clear. */
  private cast(origin: V3, direction: V3, far: number, refresh: boolean): number {
    const ray = this.raycaster,
      engine = this.engine!,
      filter = ray.filter;
    ray.set(origin, direction);
    ray.near = 0;
    ray.far = far;
    ray.firstHitOnly = true;
    ray.filter = (mesh, model) => !this.skips(mesh, model) && (!filter || filter(mesh, model));
    try {
      const options = { refresh },
        [hit] = this.colliders ? ray.intersectObjects(engine, this.colliders, options) : ray.intersectEngine(engine, options);
      return hit ? hit.distance : far;
    } finally {
      ray.filter = filter;
    }
  }
  /** True for the subject, its children and anything in `ignore`. */
  private skips(mesh: Mesh, model?: ModelLike): boolean {
    const subject = this.subject;
    if (model && (model === subject || this.ignore.includes(model))) return true;
    const store = engineRuntime(this.engine!).store,
      root = typeof subject === 'function' ? null : isModel(subject) ? subject.root : subject,
      stop = root ? meshRuntime(root).id : -1;
    for (let id = meshRuntime(mesh).id; id >= 0; id = store.parents[id]) if (id === stop) return true;
    return this.ignore.includes(mesh);
  }

  // ---- input ----
  private readonly onDown = (event: PointerEvent): void => {
    if (!this.enabled) return;
    this.capture(event.pointerId);
    if (!this.pointers.size) this.dispatchEvent({ type: 'start' });
    this.pointers.set(event.pointerId, this.local(event));
    this.spread = this.pinch();
  };
  private readonly onMove = (event: PointerEvent): void => {
    const p = this.pointers.get(event.pointerId);
    if (!p || !this.enabled) return;
    const at = this.local(event),
      dx = at.x - p.x,
      dy = at.y - p.y;
    p.x = at.x;
    p.y = at.y;
    if (this.pointers.size === 1) this.rotate(-dx * DRAG * this.rotateSpeed, dy * DRAG * this.rotateSpeed);
    else {
      const spread = this.pinch();
      if (spread > 0 && this.spread > 0) this.zoom(this.spread / spread);
      this.spread = spread;
    }
  };
  private readonly onUp = (event: PointerEvent): void => {
    if (!this.pointers.delete(event.pointerId)) return;
    this.release(event.pointerId);
    this.spread = this.pinch();
    if (!this.pointers.size) this.dispatchEvent({ type: 'end' });
  };
  private readonly onWheel = (event: WheelEvent): void => {
    if (!this.enabled) return;
    event.preventDefault();
    const pixels = event.deltaY * (event.deltaMode === 2 ? PAGE_PIXELS : event.deltaMode === 1 ? LINE_PIXELS : 1);
    this.zoom(2 ** ((pixels / PIXELS_PER_DOUBLING) * this.zoomSpeed));
  };
  private readonly onMenu = (event: Event): void => {
    if (this.enabled) event.preventDefault();
  };
  private zoom(factor: number): void {
    this.distance = clamp(this.distance * factor, this.minDistance, this.maxDistance);
  }
  /** Distance between the first two pointers, or 0 with fewer. */
  private pinch(): number {
    const [a, b] = this.pointers.values();
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  }
}
