import type { EngineKernel, Mesh } from '@margoengine/core';
import { engineRuntime, meshRuntime } from '@margoengine/core/extension';
import { Raycaster, isModel, type ModelLike } from '@margoengine/bvh';
import { Controls, type ControlElement, type EventTargetLike, type InputEventListener } from './controls.js';
import { EPS, IDENTITY, finiteInput, madd, transformPoint, type V3 } from './math.js';
import { cross, normalize, sub } from '@margoengine/math/vec3';
import { moved } from './steer.js';
import type { FollowTarget } from '@margoengine/math/fields';
import { rangeError, typeError } from '../../shared/errors.js';
export { Controls };
export type { FollowTarget };

/**
 * What the camera follows: a core mesh, a gltf/pbr model (by its `root`), a function returning a world position, a
 * {@link FollowTarget} of the physics framework's follow-targets contract (docs/physics-framework.md, section 4: pose,
 * velocity and acceleration at the frame's time, in a large-world origin cell), or a function returning one each frame.
 * Meshes, models and position functions get their velocity and acceleration from their motion.
 */
export type FollowSubject = Mesh | ModelLike | (() => readonly number[]) | FollowTarget | (() => FollowTarget);
/**
 * How the camera follows. `orbit`: you turn the arm, the pivot follows (the default). `chase`: behind the direction of
 * travel and above, turning after it with `turnLag`. `side`: tracking alongside, on the right of the travel. `lock`:
 * chase with lead room, aiming ahead so the subject sits back from the centre toward where it came from. `flyby`: the
 * camera holds a point ahead of and beside the path while the subject passes, then moves on to the next.
 */
export type FollowStyle = 'orbit' | 'chase' | 'side' | 'lock' | 'flyby';
/** A floating origin the camera writes through (`FloatingOrigin` from `@margoengine/cameras/origin`). */
export interface FollowOrigin {
  toLocal(world: ArrayLike<number>): ArrayLike<number>;
  toWorld(local: ArrayLike<number>): ArrayLike<number>;
}
/** Something the arm collides with: a core mesh or a gltf/pbr model. */
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
  /** How the camera follows; see {@link FollowStyle}. Default `'orbit'`. */
  style?: FollowStyle;
  /** Seconds the arm takes to swing behind (or beside) a turning subject in chase, side and lock. Default 0.6. */
  turnLag?: number;
  /** Seconds of travel the aim leads by, from velocity and acceleration. Default 0 in orbit, 0.4 otherwise. */
  lookAhead?: number;
  /** Lead room in lock, as a share of the arm length the aim moves ahead along the travel. Default 0.35. */
  lead?: number;
  /** Share of the subject's roll the camera banks with (birds: 1; ships and cars stay level: 0). Default 0. */
  bank?: number;
  /** Largest bank, radians. Default 0.5. */
  maxBank?: number;
  /** Seconds of travel ahead a flyby places its next point. Default 3. */
  flybyAhead?: number;
  /** Metres per origin cell of `FollowTarget`s (a power of two; the physics world's default). Default 4096. */
  cellSize?: number;
  /** A floating origin: the follow works in float64 world metres and writes the camera in its local coordinates. */
  origin?: FollowOrigin | null;
  /** World ground height at world x, z (a terrain query, a biomes world's `heightAt`): the camera keeps `clearance` above it. */
  ground?: ((x: number, z: number) => number | undefined) | null;
  /** Height kept above `ground`, world units. Default 1. */
  clearance?: number;
}

/** The followed subjects at one update: centroid, mean velocity and acceleration, bank angle and spread. */
interface Sample {
  position: V3;
  velocity: V3;
  acceleration: V3;
  roll: number;
  radius: number;
}
const STYLES: readonly FollowStyle[] = ['orbit', 'chase', 'side', 'lock', 'flyby'];
/** Seconds of smoothing on velocities and accelerations measured from motion. */
const MEASURE = 0.1;
const isTarget = (x: unknown): x is FollowTarget =>
  !!x &&
  typeof x === 'object' &&
  Array.isArray((x as FollowTarget).cell) &&
  Array.isArray((x as FollowTarget).position);
const smooth = (t: number) => t * t * (3 - 2 * t);

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
  /** What the camera follows (the first of `subjects`); assigning one follows it alone. */
  get subject(): FollowSubject {
    return this.subjects[0]!;
  }
  set subject(subject: FollowSubject) {
    this.subjects = [subject];
  }
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
  /** How the camera follows; see {@link FollowStyle}. */
  style: FollowStyle;
  /** Seconds the arm takes to swing behind a turning subject (chase, side, lock). */
  turnLag: number;
  /** Seconds of travel the aim leads by. */
  lookAhead: number;
  /** Lead room in lock, share of the arm length. */
  lead: number;
  /** Share of the subject's roll the camera banks with. */
  bank: number;
  /** Largest bank, radians. */
  maxBank: number;
  /** Seconds of travel ahead a flyby places its next point. */
  flybyAhead: number;
  /** Metres per origin cell of `FollowTarget`s. */
  cellSize: number;
  /** The floating origin the camera writes through, or null. */
  origin: FollowOrigin | null;
  /** World ground height under the camera, or null. */
  ground: ((x: number, z: number) => number | undefined) | null;
  /** Height kept above `ground`. */
  clearance: number;
  /** The subjects followed now (one, or a flock or convoy to frame together). */
  subjects: readonly FollowSubject[];

  private pivot: V3;
  private last: readonly number[] = [0, 0, 0];
  private readonly speed: V3 = [0, 0, 0];
  private yawSpeed = 0;
  private station: V3 | null = null;
  private readonly motion = new Map<unknown, { p: V3; v: V3; a: V3 }>();
  private blend: { from: V3; aim: V3; time: number; elapsed: number } | null = null;
  private sampled: Sample = { position: [0, 0, 0], velocity: [0, 0, 0], acceleration: [0, 0, 0], roll: 0, radius: 0 };
  private settled = false;
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private spread = 0;
  private savedTouchAction: string | null = null;

  constructor(
    engine: EngineKernel,
    subject: FollowSubject | readonly FollowSubject[],
    options: ThirdPersonControlsOptions = {},
  ) {
    super(engine, options.element);
    const list = Array.isArray(subject) ? (subject as readonly FollowSubject[]) : [subject as FollowSubject];
    if (!list.length || list.some((s) => !s))
      throw typeError(
        'ThirdPersonControls needs a subject; pass a mesh, a model, a function, a FollowTarget or a list of them',
        'controls-arguments',
      );
    this.subjects = list;
    const style = options.style ?? 'orbit';
    if (!STYLES.includes(style))
      throw rangeError(`Follow style is one of ${STYLES.join(', ')}; got ${String(style)}`, 'controls-arguments');
    this.style = style;
    this.turnLag = options.turnLag ?? 0.6;
    this.lookAhead = options.lookAhead ?? (style === 'orbit' ? 0 : 0.4);
    this.lead = options.lead ?? 0.35;
    this.bank = options.bank ?? 0;
    this.maxBank = options.maxBank ?? 0.5;
    this.flybyAhead = options.flybyAhead ?? 3;
    this.cellSize = options.cellSize ?? 4096;
    this.origin = options.origin ?? null;
    this.ground = options.ground ?? null;
    this.clearance = options.clearance ?? 1;
    if (
      ![this.turnLag, this.lookAhead, this.lead, this.bank, this.maxBank, this.flybyAhead, this.clearance].every(
        (x) => x >= 0 && Number.isFinite(x),
      ) ||
      !(this.cellSize > 0 && Number.isFinite(this.cellSize))
    )
      throw rangeError(
        'Follow turnLag, lookAhead, lead, bank, maxBank, flybyAhead and clearance are finite and 0 or more, cellSize above 0; pass seconds, shares and metres',
        'controls-arguments',
      );
    this.pivotOffset = options.pivotOffset ?? [0, 1.5, 0];
    this.shoulder = options.shoulder ?? 0;
    this.lag = options.lag ?? 0.12;
    this.returnTime = options.returnTime ?? 0.25;
    this.probeRadius = options.probeRadius ?? 0.2;
    this.collide = options.collide ?? true;
    this.colliders = options.colliders ?? null;
    this.ignore = options.ignore ?? [];
    this.raycaster = options.raycaster ?? new Raycaster();
    this.sampled = this.sample(0);
    this.pivot = this.goal();
    // Start from where the camera is, so attaching does not swing the view.
    const camera = this.camera,
      back = sub(this.toWorld3(camera.position), this.pivot),
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

  /** Turns the arm by finite `yaw` and `pitch` radians, within the pitch limits: for gamepads, pointer lock or `@margoengine/input`. */
  rotate(yaw: number, pitch: number): void {
    finiteInput('Third-person turn', yaw, pitch);
    this.yaw += yaw;
    this.pitch = clamp(this.pitch + pitch, this.minPitch, this.maxPitch);
  }
  /** Moves the pivot straight to the subject with no spring, for a teleport or a cut. */
  snap(): void {
    this.sampled = this.sample(0);
    this.pivot = this.goal();
    this.speed.fill(0);
    this.yawSpeed = 0;
    this.station = null;
    this.settled = false;
  }
  /**
   * Follow something else (one subject or a flock), easing over from the view the camera has now in `seconds`: a
   * hand-off from any other camera or controls, or the end of a flight. 0 cuts.
   */
  follow(subject: FollowSubject | readonly FollowSubject[], seconds = 0.8): void {
    const list = Array.isArray(subject) ? (subject as readonly FollowSubject[]) : [subject as FollowSubject];
    if (!list.length || list.some((s) => !s))
      throw typeError(
        'follow needs a subject or a list of them; pass a mesh, a model, a function or a FollowTarget',
        'controls-arguments',
      );
    this.subjects = list;
    this.motion.clear();
    this.sampled = this.sample(0);
    this.snap();
    this.takeOver(seconds);
  }
  /**
   * Ease from the camera's current position and aim to the follow view over `seconds` (smoothstep), so taking over
   * from another camera, a cut or a flight does not jump. 0 takes over at once.
   */
  takeOver(seconds = 0.8): void {
    finiteInput('Follow takeOver', seconds);
    if (seconds < 0)
      throw rangeError('Follow takeOver needs seconds of 0 or more; pass 0 to cut', 'controls-arguments');
    const c = this.camera;
    this.blend =
      seconds > 0 ? { from: this.toWorld3(c.position), aim: this.toWorld3(c.target), time: seconds, elapsed: 0 } : null;
  }
  /** The followed subjects' centroid, velocity, acceleration, bank and spread at the last update, world units. */
  get target(): Readonly<Sample> {
    return this.sampled;
  }
  /** Unit direction on the ground the camera faces: "forward" for moving the subject with the stick. */
  get heading(): V3 {
    return [-Math.sin(this.yaw), 0, -Math.cos(this.yaw)];
  }

  /** Moves the pivot, sweeps the arm and places the camera for `delta` seconds (default 1/60; finite and 0 or more, else a RangeError). Returns true when the camera moved. */
  update(delta = 1 / 60): boolean {
    finiteInput('Third-person update step', delta);
    if (delta < 0)
      throw rangeError(
        `Third-person update step must be 0 or more; pass a finite number of seconds, not ${delta}`,
        'controls-arguments',
      );
    const camera = this.camera,
      before = [...camera.position, ...camera.target],
      upBefore = [...camera.up],
      dt = delta,
      s = (this.sampled = this.sample(dt));
    this.spring(this.goal(), dt);
    const ground = Math.hypot(s.velocity[0], s.velocity[2]),
      u: V3 = ground > 0.5 ? [s.velocity[0] / ground, 0, s.velocity[2] / ground] : this.heading;
    // Chase, side and lock swing the arm after the travel on a critically damped spring of the angle.
    if (this.style !== 'orbit' && this.style !== 'flyby' && ground > 0.5) {
      const want = this.style === 'side' ? Math.atan2(-u[2], u[0]) : Math.atan2(-u[0], -u[2]);
      this.yaw = this.turn(want, dt);
    }
    // A flock or convoy: the arm long enough that the whole spread fits the view.
    const half = ((this.camera.fov ?? 60) * Math.PI) / 180 / 2,
      reach = Math.max(this.distance, s.radius > 0 ? (s.radius * 1.15) / Math.sin(half) : 0),
      pitch = clamp(this.pitch, this.minPitch, this.maxPitch),
      across = Math.cos(pitch),
      back: V3 = [Math.sin(this.yaw) * across, Math.sin(pitch), Math.cos(this.yaw) * across];
    let position: V3;
    if (this.style === 'flyby') position = this.flyby(u, ground, reach);
    else {
      const right: V3 = [Math.cos(this.yaw), 0, -Math.sin(this.yaw)],
        wanted = madd(madd(this.pivot, back, reach), right, this.shoulder),
        line = sub(wanted, this.pivot),
        full = Math.hypot(...line),
        along = full > EPS ? (normalize(line) as V3) : back,
        free = this.collide ? this.sweep(along, full) : full;
      // In at once, so the wall never comes between; out on a curve, so the camera does not jump when it clears.
      if (free < this.armLength || !this.settled || !this.returnTime) this.armLength = free;
      else this.armLength += (free - this.armLength) * (1 - Math.exp(-dt / this.returnTime));
      if (this.armLength > full) this.armLength = full;
      position = madd(this.pivot, along, this.armLength);
    }
    this.settled = true;
    // Ground: never below `clearance` over the ground query (terrain, biomes, a tiles height).
    const g = this.ground?.(position[0], position[2]);
    if (typeof g === 'number' && Number.isFinite(g) && position[1] < g + this.clearance)
      position[1] = g + this.clearance;
    // Aim: the arm's own line in orbit; elsewhere the pivot led by the travel (and the lead room in lock).
    const t = this.lookAhead,
      ahead = [0, 1, 2].map((i) => s.velocity[i]! * t + 0.5 * s.acceleration[i]! * t * t) as V3,
      speed3 = Math.hypot(...s.velocity),
      aim =
        this.style === 'orbit' && !t
          ? madd(position, back, -Math.max(this.distance, 1))
          : madd(
              madd(this.pivot, ahead, 1),
              speed3 > 0.5 ? (s.velocity.map((v) => v / speed3) as V3) : u,
              this.style === 'lock' ? this.lead * reach : 0,
            );
    let eye = position,
      look = aim;
    if (this.blend) {
      const b = this.blend;
      b.elapsed += dt;
      const k = smooth(Math.min(1, b.elapsed / b.time));
      eye = [0, 1, 2].map((i) => b.from[i]! + (position[i]! - b.from[i]!) * k) as V3;
      look = [0, 1, 2].map((i) => b.aim[i]! + (aim[i]! - b.aim[i]!) * k) as V3;
      if (k >= 1) this.blend = null;
    }
    camera.position = this.toLocal3(eye);
    camera.target = this.toLocal3(look);
    camera.up = this.upFor(sub(look, eye) as V3, s.roll);
    const changed = moved(before, camera) || camera.up.some((v, i) => Math.abs(v - upBefore[i]!) > EPS);
    if (changed) this.dispatchEvent({ type: 'change' });
    return changed;
  }

  /** The pivot's goal: the subjects' centroid plus `pivotOffset`. */
  private goal(): V3 {
    return madd(this.sampled.position, this.pivotOffset, 1);
  }
  /** World float64 of a camera (core local) position. */
  private toWorld3(p: readonly number[]): V3 {
    const w = this.origin ? this.origin.toWorld(p) : p;
    return [w[0]!, w[1]!, w[2]!];
  }
  /** Core local of a world position. */
  private toLocal3(p: readonly number[]): V3 {
    const l = this.origin ? this.origin.toLocal(p) : p;
    return [l[0]!, l[1]!, l[2]!];
  }
  /**
   * Every subject's world position, velocity and acceleration (from the FollowTarget, else measured from its motion
   * and smoothed over 0.1 s), averaged; the bank of the first; the spread around the centroid.
   */
  private sample(dt: number): Sample {
    const all = this.subjects.map((subject) => this.one(subject, dt)),
      n = all.length,
      mean = (k: 'p' | 'v' | 'a') => [0, 1, 2].map((i) => all.reduce((sum, x) => sum + x[k][i]!, 0) / n) as V3,
      position = mean('p');
    return {
      position,
      velocity: mean('v'),
      acceleration: mean('a'),
      roll: all[0]!.roll,
      radius: n > 1 ? Math.max(...all.map((x) => Math.hypot(...sub(x.p, position)))) : 0,
    };
  }
  /** One subject now, world float64. */
  private one(subject: FollowSubject, dt: number): { p: V3; v: V3; a: V3; roll: number } {
    const value = typeof subject === 'function' ? subject() : subject;
    if (isTarget(value)) {
      const c = this.cellSize,
        p = [0, 1, 2].map((i) => value.cell[i]! * c + value.position[i]!) as V3,
        q = value.rotation,
        // The target's right axis (q applied to +X); its height is the sine of the roll (right wing down is positive).
        ry = 2 * (q[0] * q[1] + q[3] * q[2]);
      return { p, v: [...value.velocity] as V3, a: [...value.acceleration] as V3, roll: -Math.asin(clamp(ry, -1, 1)) };
    }
    // A position function gives world metres; a mesh or model is read from core (local under a floating origin).
    const at = Array.isArray(value)
        ? (value as readonly number[])
        : this.toWorld3(this.meshPosition(value as Mesh | ModelLike)),
      p = [at[0]!, at[1]!, at[2]!] as V3,
      m = this.motion.get(subject);
    if (!m || !(dt > 0)) {
      if (!m) this.motion.set(subject, { p, v: [0, 0, 0], a: [0, 0, 0] });
      return { p, v: m?.v ?? [0, 0, 0], a: m?.a ?? [0, 0, 0], roll: 0 };
    }
    const k = 1 - Math.exp(-dt / MEASURE),
      v = [0, 1, 2].map((i) => m.v[i]! + ((p[i]! - m.p[i]!) / dt - m.v[i]!) * k) as V3,
      a = [0, 1, 2].map((i) => m.a[i]! + ((v[i]! - m.v[i]!) / dt - m.a[i]!) * k) as V3;
    this.motion.set(subject, { p, v, a });
    return { p, v, a, roll: 0 };
  }
  /** The flyby station: held while the subject comes and passes, then placed `flybyAhead` seconds on. */
  private flyby(u: V3, speed: number, reach: number): V3 {
    const pivot = this.pivot,
      s = this.station,
      passed = s && (s[0] - pivot[0]) * u[0] + (s[2] - pivot[2]) * u[2] < -1.5 * reach,
      far = s && Math.hypot(...sub(s, pivot)) > 8 * reach + speed * this.flybyAhead * 2;
    if (!s || passed || far) {
      const right: V3 = [-u[2], 0, u[0]],
        on = Math.max(reach * 2, speed * this.flybyAhead);
      this.station = madd(madd(madd(pivot, u, on), right, reach), [0, 1, 0], reach * 0.3);
    }
    return [...this.station!] as V3;
  }
  /** Screen up: world up, turned about the view by the subject's roll times `bank`, within `maxBank`. */
  private upFor(forward: V3, roll: number): V3 {
    const b = clamp(roll * this.bank, -this.maxBank, this.maxBank);
    if (!b) return [0, 1, 0];
    const f = normalize(forward) as V3,
      right = normalize(cross(f, [0, 1, 0])) as V3,
      up = cross(right, f) as V3;
    return [0, 1, 2].map((i) => up[i]! * Math.cos(b) + right[i]! * Math.sin(b)) as V3;
  }
  /** Critically damped spring of the arm's heading toward `want` (wrapped), exact like the pivot's. */
  private turn(want: number, dt: number): number {
    const gap0 = Math.atan2(Math.sin(this.yaw - want), Math.cos(this.yaw - want));
    if (!(this.turnLag > 0)) {
      this.yawSpeed = 0;
      return want;
    }
    const rate = 4 / this.turnLag,
      fade = Math.exp(-rate * dt),
      carry = (this.yawSpeed + rate * gap0) * dt;
    this.yawSpeed = (this.yawSpeed - rate * carry) * fade;
    return want + (gap0 + carry) * fade;
  }
  private meshPosition(subject: Mesh | ModelLike): readonly number[] {
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
  private spring(goal: V3, dt: number): void {
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
    ray.set(this.toLocal3(origin), direction);
    ray.near = 0;
    ray.far = far;
    ray.firstHitOnly = true;
    ray.filter = (mesh, model) => !this.skips(mesh, model) && (!filter || filter(mesh, model));
    try {
      const options = { refresh },
        [hit] = this.colliders
          ? ray.intersectObjects(engine, this.colliders, options)
          : ray.intersectEngine(engine, options);
      return hit ? hit.distance : far;
    } finally {
      ray.filter = filter;
    }
  }
  /** True for the subject, its children and anything in `ignore`. */
  private skips(mesh: Mesh, model?: ModelLike): boolean {
    const subjects = this.subjects;
    if (model && (subjects.includes(model) || this.ignore.includes(model))) return true;
    const store = engineRuntime(this.engine!).store,
      stops = new Set<number>();
    for (const subject of subjects)
      if (typeof subject !== 'function' && !isTarget(subject))
        stops.add(meshRuntime(isModel(subject) ? subject.root : (subject as Mesh)).id);
    for (let id = meshRuntime(mesh).id; id >= 0; id = store.parents[id]) if (stops.has(id)) return true;
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
