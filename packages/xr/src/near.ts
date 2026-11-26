/// <reference lib="esnext.disposable" preserve="true" />
// Near-interaction behaviours for hands and controllers: a hand-attached menu, a tag-along panel, surface magnetism,
// six-DoF drag with two-pointer scale, an app bar, a movable slate and a poke menu. Written from the W3C WebXR Hand
// Input Module (25 joints; each joint space has -Z toward the fingertips and +Y out of the back of the hand, so the
// palm faces -Y; joint 4 is the thumb tip and 9 the index tip), the WebXR Device API (viewer pose, targetRaySpace
// along -Z) and published near-interaction UX guidance (direct manipulation with two hands, a menu that follows the
// gaze only when it leaves the view, a poke target pressed by a fingertip). Smoothing is exponential,
// k = 1 - exp(-rate dt), which is frame-rate independent. Two points give a similarity transform: the scale is the
// ratio of their distances, the rotation takes the old line between them onto the new one (shortest arc), and the
// object keeps its offset from the midpoint, scaled and turned the same way.
import type { Mesh } from '@margoengine/core';
import { Quaternion } from '@margoengine/math/quaternion';
import { Vector3 } from '@margoengine/math/vector3';
import type { XRController } from './controller.js';
import type { PanelPointerEvent, RayPanel } from './interaction.js';
import type { XRFrameState } from './types.js';

/** What the behaviours need of an `XR`: its controllers and a per-frame hook. `XR` itself fits. */
export interface NearHost {
  readonly controllers: readonly XRController[];
  onFrame(callback: (state: XRFrameState) => void): () => void;
}
/** Something the behaviours move: a pose in the XR reference space (metres), optionally a scale. */
export interface NearTarget {
  readonly position: Vector3;
  readonly orientation: Quaternion;
  /** Present when the target can be scaled. */
  readonly scale?: Vector3;
  /** Set by {@link HandConstraint}: false while the hand hides the target. Default true. */
  visible?: boolean;
  /** Called after a behaviour moves it; {@link nearTarget} writes the mesh here. */
  apply?(): void;
}
/** A target a hand or controller can drag: it grabs within `radius` metres of the pointer, or along the ray. */
export interface NearDraggable extends NearTarget {
  radius: number;
  /** False ignores it. Default true. */
  enabled?: boolean;
  onDragStart?(event: NearDragEvent): void;
  onDragEnd?(event: NearDragEvent): void;
}
/** A drag starting or ending. */
export interface NearDragEvent {
  readonly controller: XRController;
  /** True when the object was reached by the ray rather than by the hand. */
  readonly ray: boolean;
  /** Pointers on the object after a start, or before an end. */
  readonly pointers: number;
}

/** A draggable that writes its pose and scale to `mesh` (a root mesh, so its position is in world units). */
export function nearTarget(
  mesh: Mesh,
  options: {
    radius?: number;
    position?: readonly number[];
    orientation?: readonly number[];
    scale?: readonly number[];
  } = {},
): NearDraggable & { readonly scale: Vector3; readonly mesh: Mesh } {
  const p = options.position ?? [mesh.position.x, mesh.position.y, mesh.position.z],
    q = options.orientation ?? [0, 0, 0, 1],
    s = options.scale ?? [1, 1, 1];
  const target = {
    mesh,
    position: new Vector3(p[0], p[1], p[2]),
    orientation: new Quaternion(q[0], q[1], q[2], q[3]),
    scale: new Vector3(s[0], s[1], s[2]),
    radius: options.radius ?? 0.1,
    apply() {
      mesh.setPosition([target.position.x, target.position.y, target.position.z]);
      mesh.setQuaternion([target.orientation.x, target.orientation.y, target.orientation.z, target.orientation.w]);
      mesh.setScale([target.scale.x, target.scale.y, target.scale.z]);
    },
  };
  target.apply();
  return target;
}

/** Base of every behaviour: stops its frame hooks once, with `Symbol.dispose`. */
export class NearBehavior {
  protected readonly stops: (() => void)[] = [];
  private done = false;
  /** Stops following the session. Safe to call twice. */
  dispose(): void {
    if (this.done) return;
    this.done = true;
    for (const stop of this.stops.splice(0)) stop();
    this.release();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
  /** Lets go of anything held; runs once on dispose. */
  protected release(): void {}
}

const THUMB_TIP = 4,
  INDEX_TIP = 9,
  DEG = Math.PI / 180;
const damp = (rate: number, dt: number): number => (rate > 0 ? 1 - Math.exp(-rate * Math.max(0, dt)) : 1);
const positive = (name: string, value: number): void => {
  if (!(value > 0)) throw new RangeError(`${name} must be a positive number; got ${value}`);
};
/** Writes joint `j`'s position to `out`; false when the joint is not tracked. */
function jointPosition(c: XRController, j: number, out: Vector3): boolean {
  if (!c.handTracked[j]) return false;
  const o = j * 16 + 12;
  out.set(c.handMatrices[o], c.handMatrices[o + 1], c.handMatrices[o + 2]);
  return true;
}
const viewerOf = (state: XRFrameState) => state.viewer?.transform ?? null;

/** Options for {@link HandConstraint.attach}. */
export interface HandConstraintOptions {
  /** The thing the hand carries. */
  target: NearTarget;
  /** Which hand. Default 'either': the one whose palm faces you most. */
  hand?: 'left' | 'right' | 'either';
  /** Joint index in WebXR Hand Input order. Default 0, the wrist. */
  joint?: number;
  /** Where the target floats, in the joint's frame (-Z toward the fingers, +Y out of the back of the hand). Default [0, -0.1, 0], 10 cm off the palm. */
  offset?: readonly [number, number, number];
  /** The palm must face the viewer within this angle in degrees to show. Default 45. */
  showAngle?: number;
  /** A shown target hides once the palm turns past this angle in degrees. Default 60. */
  hideAngle?: number;
  /** 'viewer' needs the palm turned toward you; 'any' always shows while the hand is tracked. Default 'viewer'. */
  facing?: 'viewer' | 'any';
  /** 'hand' lays the target on the palm (+Z out of the palm, +Y toward the fingers); 'viewer' turns it about the vertical axis to face you. Default 'hand'. */
  orientation?: 'hand' | 'viewer';
  /** Follow smoothing in 1/seconds; 0 follows exactly. Default 14. */
  rate?: number;
  onShow?(controller: XRController): void;
  onHide?(): void;
}
/**
 * Carries a target on the palm: it shows while a tracked hand's palm faces you and hides when the hand turns away
 * (with hysteresis between `showAngle` and `hideAngle`), so a wrist menu or a watch does not flicker.
 */
export class HandConstraint extends NearBehavior {
  /** True while the target is shown. */
  visible = false;
  /** The hand that carries it, or null. */
  controller: XRController | null = null;
  private readonly t: Required<Omit<HandConstraintOptions, 'target' | 'onShow' | 'onHide'>>;
  private readonly p = new Vector3();
  private readonly n = new Vector3();
  private readonly w = new Vector3();
  private readonly goal = new Vector3();
  private readonly q = new Quaternion();
  // Rx(90 deg) * Rz(180 deg): +Z out of the palm (-Y of the joint), +Y toward the fingers (-Z).
  private readonly r = new Quaternion(Math.SQRT1_2, 0, 0, Math.SQRT1_2).multiply(new Quaternion(0, 0, 1, 0));
  private placed = false;
  static attach(xr: NearHost, options: HandConstraintOptions): HandConstraint {
    return new HandConstraint(xr, options);
  }
  private constructor(
    xr: NearHost,
    private readonly options: HandConstraintOptions,
  ) {
    super();
    this.t = {
      hand: options.hand ?? 'either',
      joint: options.joint ?? 0,
      offset: options.offset ?? [0, -0.1, 0],
      showAngle: options.showAngle ?? 45,
      hideAngle: options.hideAngle ?? 60,
      facing: options.facing ?? 'viewer',
      orientation: options.orientation ?? 'hand',
      rate: options.rate ?? 14,
    };
    if (!(this.t.joint >= 0 && this.t.joint < 25 && Number.isInteger(this.t.joint)))
      throw new RangeError('HandConstraint joint must be a WebXR hand joint index 0 to 24; pass { joint: 0 }');
    positive('HandConstraint showAngle', this.t.showAngle);
    if (!(this.t.hideAngle >= this.t.showAngle))
      throw new RangeError(
        'HandConstraint hideAngle must be at least showAngle; pass { showAngle: 45, hideAngle: 60 }',
      );
    options.target.visible = false;
    this.stops.push(xr.onFrame((state) => this.frame(xr.controllers, state)));
  }
  protected override release(): void {
    this.set(false, null);
  }
  private set(visible: boolean, controller: XRController | null): void {
    const was = this.visible;
    this.visible = visible;
    this.controller = visible ? controller : null;
    this.options.target.visible = visible;
    if (visible && !was && controller) this.options.onShow?.(controller);
    if (!visible && was) this.options.onHide?.();
  }
  private frame(controllers: readonly XRController[], state: XRFrameState): void {
    const head = viewerOf(state)?.position,
      { joint, hand, facing, showAngle, hideAngle } = this.t;
    let best: XRController | null = null,
      bestAngle = Infinity;
    for (const c of controllers) {
      if (hand !== 'either' && c.source?.handedness !== hand) continue;
      if (!jointPosition(c, joint, this.p)) continue;
      // The palm normal is -Y of the joint frame: minus matrix column 1.
      const m = c.handMatrices,
        o = joint * 16;
      this.n.set(-m[o + 4], -m[o + 5], -m[o + 6]).normalize();
      let angle = 0;
      if (facing === 'viewer') {
        if (!head) continue;
        this.w.set(head.x - this.p.x, head.y - this.p.y, head.z - this.p.z).normalize();
        angle = Math.acos(Math.max(-1, Math.min(1, this.n.dot(this.w)))) / DEG;
      }
      if (angle <= (c === this.controller ? hideAngle : showAngle) && angle < bestAngle) {
        best = c;
        bestAngle = angle;
      }
    }
    if (!best) return this.set(false, null);
    const c = best,
      m = c.handMatrices,
      o = this.t.joint * 16,
      target = this.options.target;
    jointPosition(c, this.t.joint, this.p);
    // Joint orientation from the rigid matrix, then the offset in that frame.
    this.q.setFromRotationMatrix({ elements: m.subarray(o, o + 16) });
    const [ox, oy, oz] = this.t.offset;
    this.goal.set(ox, oy, oz).applyQuaternion(this.q).add(this.p);
    if (this.t.orientation === 'hand') {
      this.q.multiply(this.r);
    } else if (head) {
      this.q.setFromAxisAngle({ x: 0, y: 1, z: 0 }, Math.atan2(head.x - this.goal.x, head.z - this.goal.z));
    }
    const k = this.placed && this.visible ? damp(this.t.rate, state.delta) : 1;
    this.placed = true;
    target.position.lerp(this.goal, k);
    target.orientation.slerp(this.q, k);
    this.set(true, c);
    target.apply?.();
  }
}

/** Options for {@link FollowInView.attach}. */
export interface FollowInViewOptions {
  /** The panel or menu that tags along. */
  target: NearTarget;
  /** Half-angle in degrees of the cone around the gaze the target may leave before it moves. Default 25. */
  maxViewDegrees?: number;
  /** Nearest distance from the head in metres. Default 0.4. */
  minDistance?: number;
  /** Farthest distance from the head in metres. Default 1.2. */
  maxDistance?: number;
  /** Distance used by `snap()` and on the first frame. Default 0.7. */
  distance?: number;
  /** Smoothing in 1/seconds. Default 5. */
  rate?: number;
  /** 'yaw' turns the target about the vertical axis to face you, 'full' to face you exactly, 'none' leaves it. Default 'yaw'. */
  billboard?: 'yaw' | 'full' | 'none';
  /** Place the target `distance` in front of you on the first frame. Default true. */
  snapOnStart?: boolean;
}
/**
 * Keeps a target in view lazily (tag-along): while it stays inside the cone around your gaze and between the
 * distance limits it does not move; once it leaves, it eases to the cone edge. Set `enabled` false to pin it.
 */
export class FollowInView extends NearBehavior {
  /** False pins the target where it is. Default true. */
  enabled = true;
  private readonly o: Required<Omit<FollowInViewOptions, 'target'>>;
  private snapNext: boolean;
  private readonly d = new Vector3();
  private readonly f = new Vector3();
  private readonly goal = new Vector3();
  private readonly q = new Quaternion();
  private readonly s = new Quaternion();
  static attach(xr: NearHost, options: FollowInViewOptions): FollowInView {
    return new FollowInView(xr, options);
  }
  private constructor(
    xr: NearHost,
    private readonly options: FollowInViewOptions,
  ) {
    super();
    this.o = {
      maxViewDegrees: options.maxViewDegrees ?? 25,
      minDistance: options.minDistance ?? 0.4,
      maxDistance: options.maxDistance ?? 1.2,
      distance: options.distance ?? 0.7,
      rate: options.rate ?? 5,
      billboard: options.billboard ?? 'yaw',
      snapOnStart: options.snapOnStart ?? true,
    };
    positive('FollowInView maxViewDegrees', this.o.maxViewDegrees);
    positive('FollowInView minDistance', this.o.minDistance);
    if (!(this.o.maxDistance >= this.o.minDistance))
      throw new RangeError(
        'FollowInView maxDistance must be at least minDistance; pass { minDistance: 0.4, maxDistance: 1.2 }',
      );
    this.snapNext = this.o.snapOnStart;
    this.stops.push(xr.onFrame((state) => this.frame(state)));
  }
  /** Places the target `distance` in front of the viewer on the next frame. */
  snap(): void {
    this.snapNext = true;
  }
  private frame(state: XRFrameState): void {
    const v = viewerOf(state);
    if (!v || !this.enabled) return;
    const target = this.options.target,
      { x: hx, y: hy, z: hz } = v.position;
    this.q.set(v.orientation.x, v.orientation.y, v.orientation.z, v.orientation.w);
    this.f.set(0, 0, -1).applyQuaternion(this.q);
    let k = damp(this.o.rate, state.delta);
    if (this.snapNext) {
      this.snapNext = false;
      this.goal.set(hx, hy, hz).addScaledVector(this.f, this.o.distance);
      k = 1;
    } else {
      this.d.set(target.position.x - hx, target.position.y - hy, target.position.z - hz);
      const dist = this.d.length();
      if (dist < 1e-6) this.d.copy(this.f);
      else this.d.divideScalar(dist);
      const angle = Math.acos(Math.max(-1, Math.min(1, this.d.dot(this.f)))),
        limit = this.o.maxViewDegrees * DEG;
      if (angle > limit) {
        // Turn the direction toward the gaze by the excess, so it rests on the cone's edge.
        this.s.set(0, 0, 0, 1).slerp(this.q.setFromUnitVectors(this.d, this.f), (angle - limit) / angle);
        this.d.applyQuaternion(this.s);
      }
      const clamped = Math.min(this.o.maxDistance, Math.max(this.o.minDistance, dist || this.o.distance));
      this.goal.set(hx, hy, hz).addScaledVector(this.d, clamped);
      if (angle <= limit && clamped === dist) {
        this.face(target, hx, hy, hz, k);
        return;
      }
    }
    target.position.lerp(this.goal, k);
    this.face(target, hx, hy, hz, k);
  }
  private face(target: NearTarget, hx: number, hy: number, hz: number, k: number): void {
    const dx = hx - target.position.x,
      dy = hy - target.position.y,
      dz = hz - target.position.z;
    if (this.o.billboard === 'yaw') this.q.setFromAxisAngle({ x: 0, y: 1, z: 0 }, Math.atan2(dx, dz));
    else if (this.o.billboard === 'full') {
      const len = Math.hypot(dx, dy, dz);
      if (len < 1e-6) return;
      this.q.setFromUnitVectors({ x: 0, y: 0, z: 1 }, { x: dx / len, y: dy / len, z: dz / len });
    } else return target.apply?.();
    target.orientation.slerp(this.q, k);
    target.apply?.();
  }
}

/** A plane a target can stick to. `normal` is unit length and points out of the surface. */
export interface Surface {
  readonly point: readonly [number, number, number];
  readonly normal: readonly [number, number, number];
}
/** A hit-test result (`HitTest` from `@margoengine/xr/hit-test`) as a surface: its pose's +Y is the normal. */
export function surfaceFromHit(hit: { readonly matrix: ArrayLike<number> }): Surface {
  const m = hit.matrix;
  return { point: [m[12], m[13], m[14]], normal: [m[4], m[5], m[6]] };
}
/** Options for {@link SurfaceMagnetism.attach} and {@link snapToSurface}. */
export interface SurfaceMagnetismOptions {
  target: NearTarget;
  /** The surfaces, or a function returning this frame's (for example from AR hit tests). */
  surfaces: readonly Surface[] | (() => readonly Surface[]);
  /** What aims: 'gaze' (default), a controller's index in `xr.controllers`, or the controller itself. */
  source?: 'gaze' | number | XRController;
  /** Farthest surface hit in metres. Default 3. */
  maxDistance?: number;
  /** Gap between the target and the surface in metres. Default 0.005. */
  offset?: number;
  /** Which target axis points out of the surface: 'y' stands it on the surface, 'z' hangs a panel. Default 'y'. */
  normalAxis?: 'y' | 'z';
  /** 'normal' aligns that axis to the surface; 'upright' keeps +Y vertical (a 'z' panel only turns about it); 'none' keeps the rotation. Default 'normal'. */
  alignment?: 'normal' | 'upright' | 'none';
  /** Smoothing in 1/seconds; 0 is exact. Default 18. */
  rate?: number;
}
const ndot = (a: readonly number[], b: Vector3) => a[0] * b.x + a[1] * b.y + a[2] * b.z;
const aligned = (
  axis: 'y' | 'z',
  alignment: 'normal' | 'upright' | 'none',
  normal: Vector3,
  out: Quaternion,
): boolean => {
  if (alignment === 'none') return false;
  if (alignment === 'upright') {
    if (axis === 'y') return false;
    const len = Math.hypot(normal.x, normal.z);
    if (len < 1e-6) return false;
    out.setFromAxisAngle({ x: 0, y: 1, z: 0 }, Math.atan2(normal.x, normal.z));
    return true;
  }
  out.setFromUnitVectors(axis === 'y' ? { x: 0, y: 1, z: 0 } : { x: 0, y: 0, z: 1 }, normal);
  return true;
};
/**
 * Moves `target` onto the nearest surface when it is within `snapDistance` metres of it (position projected onto
 * the plane, plus `offset`) and aligns it; returns that surface or null. Use it after anything else moves the target,
 * for example a drag.
 */
export function snapToSurface(
  options: Omit<SurfaceMagnetismOptions, 'source' | 'maxDistance' | 'rate'> & {
    snapDistance?: number;
  },
): Surface | null {
  const list = typeof options.surfaces === 'function' ? options.surfaces() : options.surfaces,
    limit = options.snapDistance ?? 0.1,
    p = options.target.position,
    n = new Vector3();
  let best: Surface | null = null,
    bestDistance = Infinity;
  for (const s of list) {
    const d = (p.x - s.point[0]) * s.normal[0] + (p.y - s.point[1]) * s.normal[1] + (p.z - s.point[2]) * s.normal[2];
    if (Math.abs(d) <= limit && Math.abs(d) < bestDistance) {
      best = s;
      bestDistance = Math.abs(d);
    }
  }
  if (!best) return null;
  const side =
      Math.sign(
        (p.x - best.point[0]) * best.normal[0] +
          (p.y - best.point[1]) * best.normal[1] +
          (p.z - best.point[2]) * best.normal[2],
      ) || 1,
    offset = options.offset ?? 0.005;
  n.set(best.normal[0] * side, best.normal[1] * side, best.normal[2] * side);
  const d = (p.x - best.point[0]) * n.x + (p.y - best.point[1]) * n.y + (p.z - best.point[2]) * n.z;
  p.addScaledVector(n, offset - d);
  const q = new Quaternion();
  if (aligned(options.normalAxis ?? 'y', options.alignment ?? 'normal', n, q)) options.target.orientation.copy(q);
  options.target.apply?.();
  return best;
}
/**
 * Sticks a target to the surface a ray points at: the gaze or a controller ray meets each plane (t = ((p - o) . n) /
 * (d . n), front faces only) and the target sits on the nearest hit, aligned to it. With no hit it stays where it
 * was. `surface` is the one it sits on, or null.
 */
export class SurfaceMagnetism extends NearBehavior {
  /** The surface the target sits on this frame, or null. */
  surface: Surface | null = null;
  /** False stops moving the target. Default true. */
  enabled = true;
  private readonly o: Required<
    Pick<SurfaceMagnetismOptions, 'maxDistance' | 'offset' | 'normalAxis' | 'alignment' | 'rate'>
  >;
  private readonly ro = new Vector3();
  private readonly rd = new Vector3();
  private readonly n = new Vector3();
  private readonly goal = new Vector3();
  private readonly q = new Quaternion();
  private placed = false;
  static attach(xr: NearHost, options: SurfaceMagnetismOptions): SurfaceMagnetism {
    return new SurfaceMagnetism(xr, options);
  }
  private constructor(
    private readonly xr: NearHost,
    private readonly options: SurfaceMagnetismOptions,
  ) {
    super();
    this.o = {
      maxDistance: options.maxDistance ?? 3,
      offset: options.offset ?? 0.005,
      normalAxis: options.normalAxis ?? 'y',
      alignment: options.alignment ?? 'normal',
      rate: options.rate ?? 18,
    };
    positive('SurfaceMagnetism maxDistance', this.o.maxDistance);
    this.stops.push(xr.onFrame((state) => this.frame(state)));
  }
  private aim(state: XRFrameState): boolean {
    const source = this.options.source ?? 'gaze';
    let pose:
      | {
          position: { x: number; y: number; z: number };
          orientation: { x: number; y: number; z: number; w: number };
        }
      | null
      | undefined;
    if (source === 'gaze') pose = viewerOf(state);
    else pose = (typeof source === 'number' ? this.xr.controllers[source] : source)?.targetRay?.transform;
    if (!pose) return false;
    this.ro.set(pose.position.x, pose.position.y, pose.position.z);
    this.q.set(pose.orientation.x, pose.orientation.y, pose.orientation.z, pose.orientation.w);
    this.rd.set(0, 0, -1).applyQuaternion(this.q);
    return true;
  }
  private frame(state: XRFrameState): void {
    if (!this.enabled || !this.aim(state)) return;
    const list = typeof this.options.surfaces === 'function' ? this.options.surfaces() : this.options.surfaces;
    let best: Surface | null = null,
      bestT = this.o.maxDistance;
    for (const s of list) {
      const denom = ndot(s.normal, this.rd);
      if (denom >= 0) continue;
      const t =
        ((s.point[0] - this.ro.x) * s.normal[0] +
          (s.point[1] - this.ro.y) * s.normal[1] +
          (s.point[2] - this.ro.z) * s.normal[2]) /
        denom;
      if (t > 0 && t <= bestT) {
        best = s;
        bestT = t;
      }
    }
    this.surface = best;
    if (!best) return;
    this.n.set(best.normal[0], best.normal[1], best.normal[2]);
    this.goal.copy(this.ro).addScaledVector(this.rd, bestT).addScaledVector(this.n, this.o.offset);
    const k = this.placed ? damp(this.o.rate, state.delta) : 1,
      target = this.options.target;
    this.placed = true;
    target.position.lerp(this.goal, k);
    if (aligned(this.o.normalAxis, this.o.alignment, this.n, this.q)) target.orientation.slerp(this.q, k);
    target.apply?.();
  }
}

/** How a dragged object turns. */
export type NearRotation = 'follow' | 'yaw' | 'none';
/** Options for {@link Manipulator.attach}. */
export interface ManipulatorOptions {
  /** Objects to drag. The array stays live. */
  draggables?: NearDraggable[];
  /** Thumb-tip to index-tip distance in metres that counts as a pinch. Default 0.02. */
  pinch?: number;
  /** Reach objects along the controller or hand ray. Default true. */
  ray?: boolean;
  /** Longest ray in metres. Default 5. */
  rayLength?: number;
  /** Move the object. Default true. */
  translate?: boolean;
  /** Axes that keep their value while dragging. Default none. */
  lock?: { x?: boolean; y?: boolean; z?: boolean };
  /** 'follow' turns the object with the pointer, 'yaw' only about the vertical axis, 'none' never. Default 'follow'. */
  rotate?: NearRotation;
  /** Let a second pointer on the same object scale it (and turn it by the line between them). Default true. */
  scale?: boolean;
  /** Limits of the object's x scale (uniform scale) in a two-pointer scale. Default [0.1, 10]. */
  scaleLimits?: readonly [number, number];
}
interface Frame {
  readonly p: Vector3;
  readonly q: Quaternion;
  readonly ro: Vector3;
  readonly rd: Vector3;
  active: boolean;
  was: boolean;
  ray: boolean;
}
interface Hold {
  controller: XRController;
  ray: boolean;
}
interface Session {
  object: NearDraggable;
  holds: Hold[];
  /** Object pose and pointer at the last rebase. */
  readonly p0: Vector3;
  readonly q0: Quaternion;
  readonly s0: Vector3;
  readonly f0: Vector3;
  readonly fq0: Quaternion;
  readonly rel0: Vector3;
  readonly axis0: Vector3;
  mid0: Vector3;
  dist0: number;
  readonly start: Vector3;
}
/**
 * Six-DoF drag and two-pointer scale. A pinch (hand) or squeeze (controller) on or near an object, or along the ray at
 * it, picks it up; it keeps its pose in the pointer's frame (position, and rotation per `rotate`), so turning your
 * wrist turns it. A second pointer on the same object switches to a two-point manipulation: the distance between
 * the pointers scales it and the line between them turns it. Lifting one pointer returns to the one-point drag
 * without a jump. For plain grab, throw and sockets use `Interaction`.
 */
export class Manipulator extends NearBehavior {
  readonly draggables: NearDraggable[];
  private readonly o: Required<Omit<ManipulatorOptions, 'draggables' | 'lock'>> & {
    lock: { x?: boolean; y?: boolean; z?: boolean };
  };
  private readonly frames = new Map<XRController, Frame>();
  private readonly sessions: Session[] = [];
  private readonly a = new Vector3();
  private readonly b = new Vector3();
  private readonly c = new Vector3();
  private readonly qa = new Quaternion();
  private readonly qb = new Quaternion();
  static attach(xr: NearHost, options: ManipulatorOptions = {}): Manipulator {
    return new Manipulator(xr, options);
  }
  private constructor(
    private readonly xr: NearHost,
    options: ManipulatorOptions,
  ) {
    super();
    this.draggables = options.draggables ?? [];
    this.o = {
      pinch: options.pinch ?? 0.02,
      ray: options.ray ?? true,
      rayLength: options.rayLength ?? 5,
      translate: options.translate ?? true,
      lock: options.lock ?? {},
      rotate: options.rotate ?? 'follow',
      scale: options.scale ?? true,
      scaleLimits: options.scaleLimits ?? [0.1, 10],
    };
    positive('Manipulator pinch', this.o.pinch);
    positive('Manipulator rayLength', this.o.rayLength);
    if (!(this.o.scaleLimits[0] > 0 && this.o.scaleLimits[1] >= this.o.scaleLimits[0]))
      throw new RangeError(
        'Manipulator scaleLimits must be [min, max] with 0 < min <= max; pass { scaleLimits: [0.1, 10] }',
      );
    this.stops.push(xr.onFrame(() => this.frame()));
  }
  /** The objects being dragged now. */
  get active(): readonly NearDraggable[] {
    return this.sessions.map((s) => s.object);
  }
  protected override release(): void {
    for (const s of this.sessions.splice(0)) this.end(s);
    this.frames.clear();
  }
  private read(c: XRController): Frame | null {
    const pose = c.grip ?? c.targetRay;
    if (!pose) return null;
    let f = this.frames.get(c);
    if (!f) {
      f = {
        p: new Vector3(),
        q: new Quaternion(),
        ro: new Vector3(),
        rd: new Vector3(),
        active: false,
        was: false,
        ray: false,
      };
      this.frames.set(c, f);
    }
    f.was = f.active;
    const o = pose.transform.orientation;
    f.q.set(o.x, o.y, o.z, o.w);
    const hand = c.handTracked[THUMB_TIP] && c.handTracked[INDEX_TIP];
    if (hand) {
      jointPosition(c, THUMB_TIP, this.a);
      jointPosition(c, INDEX_TIP, this.b);
      f.active = this.a.distanceTo(this.b) <= this.o.pinch;
      f.p.lerpVectors(this.a, this.b, 0.5);
    } else {
      const p = pose.transform.position;
      f.p.set(p.x, p.y, p.z);
      f.active = c.source?.gamepad?.mapping === 'xr-standard' && c.buttonCount > 1 && c.buttons[1 * 3 + 1] === 1;
    }
    f.ray = false;
    if (c.targetRay) {
      const r = c.targetRay.transform;
      f.ro.set(r.position.x, r.position.y, r.position.z);
      this.qa.set(r.orientation.x, r.orientation.y, r.orientation.z, r.orientation.w);
      f.rd.set(0, 0, -1).applyQuaternion(this.qa);
      f.ray = true;
    }
    return f;
  }
  private frame(): void {
    const controllers = this.xr.controllers;
    for (const c of this.frames.keys()) if (!controllers.includes(c)) this.frames.delete(c);
    for (const c of controllers) this.read(c);
    // Let go first, so a pointer that lifts and another that lands in one frame both count.
    for (const s of [...this.sessions])
      for (const hold of [...s.holds]) {
        const f = this.frames.get(hold.controller);
        if (!f || !f.active) this.drop(s, hold);
      }
    for (const c of controllers) {
      const f = this.frames.get(c);
      if (f?.active && !f.was && !this.sessions.some((s) => s.holds.some((h) => h.controller === c))) this.pick(c, f);
    }
    for (const s of this.sessions) this.update(s);
  }
  private pick(c: XRController, f: Frame): void {
    let best: NearDraggable | null = null,
      bestDistance = Infinity,
      ray = false;
    const open = (d: NearDraggable): boolean => {
      if (d.enabled === false) return false;
      const s = this.sessions.find((x) => x.object === d);
      return !s || (this.o.scale && s.holds.length < 2);
    };
    for (const d of this.draggables) {
      if (!open(d)) continue;
      const dist = d.position.distanceTo(f.p);
      if (dist <= d.radius && dist < bestDistance) {
        best = d;
        bestDistance = dist;
      }
    }
    if (!best && this.o.ray && f.ray)
      for (const d of this.draggables) {
        if (!open(d)) continue;
        const t = raySphere(f.ro, f.rd, d.position, d.radius);
        if (t !== null && t <= this.o.rayLength && t < bestDistance) {
          best = d;
          bestDistance = t;
          ray = true;
        }
      }
    if (!best) return;
    let s = this.sessions.find((x) => x.object === best);
    const fresh = !s;
    if (!s) {
      s = {
        object: best,
        holds: [],
        p0: new Vector3(),
        q0: new Quaternion(),
        s0: new Vector3(1, 1, 1),
        f0: new Vector3(),
        fq0: new Quaternion(),
        rel0: new Vector3(),
        axis0: new Vector3(),
        mid0: new Vector3(),
        dist0: 1,
        start: best.position.clone(),
      };
      this.sessions.push(s);
    }
    s.holds.push({ controller: c, ray });
    this.rebase(s);
    if (fresh || s.holds.length === 2) best.onDragStart?.({ controller: c, ray, pointers: s.holds.length });
  }
  private drop(s: Session, hold: Hold): void {
    s.holds.splice(s.holds.indexOf(hold), 1);
    if (s.holds.length) return this.rebase(s);
    this.sessions.splice(this.sessions.indexOf(s), 1);
    this.end(s, hold);
  }
  private end(s: Session, hold: Hold = s.holds[0]): void {
    if (hold)
      s.object.onDragEnd?.({
        controller: hold.controller,
        ray: hold.ray,
        pointers: Math.max(1, s.holds.length),
      });
  }
  /** Records the object and pointers now, so the next update continues from here with no jump. */
  private rebase(s: Session): void {
    const o = s.object;
    s.p0.copy(o.position);
    s.q0.copy(o.orientation);
    if (o.scale) s.s0.copy(o.scale);
    const f = this.frames.get(s.holds[0].controller)!;
    s.f0.copy(f.p);
    s.fq0.copy(f.q);
    s.rel0.copy(o.position).sub(f.p);
    if (s.holds.length > 1) {
      const g = this.frames.get(s.holds[1].controller)!;
      s.mid0.lerpVectors(f.p, g.p, 0.5);
      s.axis0.copy(g.p).sub(f.p);
      s.dist0 = s.axis0.length();
      if (s.dist0 > 1e-6) s.axis0.divideScalar(s.dist0);
      s.rel0.copy(o.position).sub(s.mid0);
    }
  }
  private update(s: Session): void {
    const o = s.object,
      f = this.frames.get(s.holds[0].controller)!,
      pos = this.a,
      rot = this.qa;
    let ratio = 1;
    if (s.holds.length === 1) {
      // rot = pointer rotation since the rebase, restricted by `rotate`.
      rot.copy(s.fq0).invert().premultiply(f.q);
      this.restrict(rot);
      pos.copy(s.rel0).applyQuaternion(rot).add(f.p);
    } else {
      const g = this.frames.get(s.holds[1].controller)!;
      this.b.copy(g.p).sub(f.p);
      const dist = this.b.length();
      if (!(dist > 1e-6) || !(s.dist0 > 1e-6)) return;
      this.b.divideScalar(dist);
      this.c.copy(s.axis0);
      if (this.o.rotate === 'none') rot.identity();
      else if (this.o.rotate === 'yaw') {
        const a = Math.atan2(this.c.x, this.c.z),
          b = Math.atan2(this.b.x, this.b.z);
        rot.setFromAxisAngle({ x: 0, y: 1, z: 0 }, b - a);
      } else rot.setFromUnitVectors(this.c, this.b);
      if (o.scale) {
        const [min, max] = this.o.scaleLimits;
        ratio = Math.min(max / s.s0.x, Math.max(min / s.s0.x, dist / s.dist0));
        o.scale.copy(s.s0).multiplyScalar(ratio);
      }
      pos
        .copy(s.rel0)
        .multiplyScalar(ratio)
        .applyQuaternion(rot)
        .add(this.c.lerpVectors(f.p, g.p, 0.5));
    }
    if (this.o.translate) {
      const { x, y, z } = this.o.lock;
      o.position.set(x ? s.start.x : pos.x, y ? s.start.y : pos.y, z ? s.start.z : pos.z);
    }
    if (this.o.rotate !== 'none') o.orientation.copy(rot).multiply(s.q0);
    o.apply?.();
  }
  /** 'yaw' keeps only the twist about the vertical axis of a rotation. */
  private restrict(q: Quaternion): void {
    if (this.o.rotate === 'follow') return;
    if (this.o.rotate === 'none') q.identity();
    else {
      const len = Math.hypot(q.y, q.w);
      if (len < 1e-9) q.identity();
      else q.set(0, q.y / len, 0, q.w / len);
    }
  }
}
/** Distance along unit `d` from `o` to the sphere's surface (0 when inside), or null for a miss. */
function raySphere(o: Vector3, d: Vector3, c: Vector3, r: number): number | null {
  const lx = c.x - o.x,
    ly = c.y - o.y,
    lz = c.z - o.z,
    along = lx * d.x + ly * d.y + lz * d.z,
    square = lx * lx + ly * ly + lz * lz - along * along;
  if (lx * lx + ly * ly + lz * lz <= r * r) return 0;
  if (along < 0 || square > r * r) return null;
  return along - Math.sqrt(r * r - square);
}

/** One button of an {@link AppBar} or {@link NearMenu}. */
export interface NearButton {
  id: string;
  label: string;
  /** False greys it out and ignores presses. Default true. */
  enabled?: boolean;
}
/** A laid-out button for drawing: centre in metres from the panel centre (+y up), size, and its state. */
export interface ButtonRect {
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly hovered: boolean;
  readonly pressed: boolean;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
/** Poking with a fingertip: the hover and touch distances in metres in front of the panel. */
export interface PokeOptions {
  /** A tip this close in front of a button hovers it. Default 0.06. */
  hover?: number;
  /** A tip this close presses it; it releases 1 cm farther out. Default 0.012. */
  touch?: number;
  /** A tip that pushes this far through the panel cancels. Default 0.03. */
  through?: number;
}
/** Options shared by the button panels. */
export interface ButtonPanelOptions {
  buttons?: readonly NearButton[];
  /** Buttons per row. Default all in one row (an app bar) or 3 (a menu). */
  columns?: number;
  /** Button width and height in metres. Default 0.05. */
  buttonSize?: number;
  /** Gap between buttons in metres. Default 0.008. */
  spacing?: number;
  /** Margin around the buttons in metres. Default 0.01. */
  padding?: number;
  /** Fingertip pressing, or false for rays only. Default on. */
  poke?: PokeOptions | false;
  /** Called with the button's id when it is pressed and released on itself. */
  onSelect?(id: string): void;
}
interface Poking {
  inside: boolean;
  touching: boolean;
}
/** A flat row or grid of buttons that works as a `RayPanel` (for `Interaction.panels`) and as a fingertip poke target. */
export class ButtonPanel extends NearBehavior implements RayPanel {
  readonly position = new Vector3();
  readonly orientation = new Quaternion();
  size: readonly [number, number] = [0, 0];
  enabled = true;
  /** The button list. Replace entries or push; the layout follows. */
  buttons: NearButton[];
  /** Index of the hovered button, or -1. */
  hovered = -1;
  /** Index of the pressed button, or -1. */
  pressed = -1;
  protected onSelect?: (id: string) => void;
  private readonly cfg: {
    columns: number;
    button: number;
    spacing: number;
    padding: number;
  };
  private readonly poke_: Required<PokeOptions> | null;
  private readonly poking = new Map<XRController, Poking>();
  private readonly tip = new Vector3();
  private readonly inv = new Quaternion();
  constructor(options: ButtonPanelOptions, defaultColumns: number) {
    super();
    this.buttons = [...(options.buttons ?? [])];
    this.onSelect = options.onSelect;
    this.cfg = {
      columns: Math.max(1, Math.floor(options.columns ?? defaultColumns)),
      button: options.buttonSize ?? 0.05,
      spacing: options.spacing ?? 0.008,
      padding: options.padding ?? 0.01,
    };
    positive('buttonSize', this.cfg.button);
    this.poke_ =
      options.poke === false
        ? null
        : {
            hover: options.poke?.hover ?? 0.06,
            touch: options.poke?.touch ?? 0.012,
            through: options.poke?.through ?? 0.03,
          };
    this.relayout();
  }
  private relayout(): void {
    const { columns, button, spacing, padding } = this.cfg,
      n = Math.max(1, this.buttons.length),
      cols = Math.min(columns, n),
      rows = Math.ceil(n / cols);
    this.size = [
      cols * button + (cols - 1) * spacing + 2 * padding,
      rows * button + (rows - 1) * spacing + 2 * padding,
    ];
  }
  /** Every button's rectangle and state, for drawing. */
  layout(): ButtonRect[] {
    this.relayout();
    const { columns, button, spacing } = this.cfg,
      cols = Math.min(columns, Math.max(1, this.buttons.length)),
      [w, h] = this.size;
    return this.buttons.map((b, i) => ({
      id: b.id,
      label: b.label,
      enabled: b.enabled !== false,
      hovered: i === this.hovered,
      pressed: i === this.pressed,
      x: -w / 2 + this.cfg.padding + button / 2 + (i % cols) * (button + spacing),
      y: h / 2 - this.cfg.padding - button / 2 - Math.floor(i / cols) * (button + spacing),
      width: button,
      height: button,
    }));
  }
  private at(u: number, v: number): number {
    const [w, h] = this.size,
      x = (u - 0.5) * w,
      y = (0.5 - v) * h;
    const rects = this.layout();
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i];
      if (Math.abs(x - r.x) <= r.width / 2 && Math.abs(y - r.y) <= r.height / 2) return i;
    }
    return -1;
  }
  /** Ray or poke events from `Interaction` (add the panel to `Interaction.panels`) or from a fingertip. */
  onPointer(event: PanelPointerEvent): void {
    this.relayout();
    if (event.type === 'leave') {
      this.hovered = this.pressed = -1;
      return;
    }
    const index = this.at(event.u, event.v),
      live = index >= 0 && this.buttons[index].enabled !== false ? index : -1;
    this.hovered = live;
    if (event.type === 'down') this.pressed = live;
    if (event.type === 'up') {
      const was = this.pressed;
      this.pressed = -1;
      if (was >= 0 && was === live) this.select(was);
    }
  }
  /** Presses button `index` as a click would. */
  protected select(index: number): void {
    this.onSelect?.(this.buttons[index].id);
  }
  /** Drives hover and press from the index fingertips of tracked hands. */
  protected pokeAll(controllers: readonly XRController[]): void {
    const cfg = this.poke_;
    if (!cfg || !this.enabled) return;
    this.relayout();
    this.inv.copy(this.orientation).invert();
    const [w, h] = this.size;
    for (const c of controllers) {
      let s = this.poking.get(c);
      if (!s) this.poking.set(c, (s = { inside: false, touching: false }));
      const have = jointPosition(c, INDEX_TIP, this.tip);
      let u = 0,
        v = 0,
        z = Infinity,
        inside = false;
      if (have) {
        this.tip.sub(this.position).applyQuaternion(this.inv);
        z = this.tip.z;
        u = this.tip.x / w + 0.5;
        v = 0.5 - this.tip.y / h;
        inside = u >= 0 && u <= 1 && v >= 0 && v <= 1 && z <= cfg.hover && z >= -cfg.through;
      }
      const send = (type: PanelPointerEvent['type']) => this.onPointer({ type, u, v, distance: z, controller: c });
      if (inside && !s.inside) send('enter');
      else if (inside) send('move');
      if (inside && !s.touching && z <= cfg.touch) {
        s.touching = true;
        send('down');
      } else if (s.touching && (!inside || z > cfg.touch + 0.01)) {
        s.touching = false;
        if (inside) send('up');
        else this.pressed = -1;
      }
      if (!inside && s.inside) send('leave');
      s.inside = inside;
    }
    for (const c of this.poking.keys()) if (!controllers.includes(c)) this.poking.delete(c);
  }
}

/** Options for {@link AppBar.attach}. */
export interface AppBarOptions extends ButtonPanelOptions {
  /** The object the bar belongs to. */
  target: NearTarget;
  /** The object's size in metres at scale 1. Default [0.3, 0.3]. Only the height places the bar. */
  extent?: readonly [number, number];
  /** Gap between the object's lower edge and the bar in metres. Default 0.03. */
  gap?: number;
  /** The bar shows while a hand or controller is within this distance of the object's centre. Default 0.6. */
  showDistance?: number;
  /** Always show it. Default false. */
  alwaysVisible?: boolean;
  /** Turn the bar about the vertical axis to face you. Default true. */
  billboard?: boolean;
}
/** The standard bar: remove and adjust. */
const APP_BAR_BUTTONS: readonly NearButton[] = [
  { id: 'remove', label: 'Remove' },
  { id: 'adjust', label: 'Adjust' },
];
/**
 * A row of buttons that sits under an object, shows when a hand comes near it and can be pressed by a ray or a
 * fingertip. Add it to `Interaction.panels` for ray presses. Default buttons are `remove` and `adjust`; pass
 * your own to add more.
 */
export class AppBar extends ButtonPanel {
  /** True while the bar is shown. */
  visible = false;
  private readonly a: AppBarOptions;
  private readonly p = new Vector3();
  static attach(xr: NearHost, options: AppBarOptions): AppBar {
    return new AppBar(xr, options);
  }
  private constructor(xr: NearHost, options: AppBarOptions) {
    super({ ...options, buttons: options.buttons ?? APP_BAR_BUTTONS }, 99);
    this.a = options;
    positive('AppBar showDistance', options.showDistance ?? 0.6);
    this.enabled = false;
    this.stops.push(xr.onFrame((state) => this.frame(xr.controllers, state)));
  }
  private frame(controllers: readonly XRController[], state: XRFrameState): void {
    const target = this.a.target,
      limit = (this.a.showDistance ?? 0.6) + (this.visible ? 0.1 : 0);
    let near = this.a.alwaysVisible === true;
    for (const c of controllers) {
      if (near) break;
      const g = c.grip?.transform.position;
      if (g && target.position.distanceTo(g) <= limit) near = true;
      else if (jointPosition(c, INDEX_TIP, this.p) && target.position.distanceTo(this.p) <= limit) near = true;
    }
    this.visible = near;
    this.enabled = near;
    if (!near) {
      this.hovered = this.pressed = -1;
      return;
    }
    const half = ((this.a.extent?.[1] ?? 0.3) * (target.scale?.y ?? 1)) / 2;
    this.p.set(0, -(half + (this.a.gap ?? 0.03) + this.size[1] / 2), 0);
    const head = viewerOf(state)?.position;
    if (this.a.billboard !== false && head)
      this.orientation.setFromAxisAngle(
        { x: 0, y: 1, z: 0 },
        Math.atan2(head.x - target.position.x, head.z - target.position.z),
      );
    else this.orientation.copy(target.orientation);
    this.position.copy(this.p).add(target.position);
    this.pokeAll(controllers);
  }
}

/** Options for {@link NearMenu.attach}. */
export interface NearMenuOptions extends ButtonPanelOptions {
  /** Add a pin button that stops the menu following you. Default true. */
  pinButton?: boolean;
  /** Start pinned in place. Default false. */
  pinned?: boolean;
  /** How it follows you while not pinned; see {@link FollowInViewOptions}. */
  follow?: Omit<FollowInViewOptions, 'target'>;
}
/**
 * A grid of buttons that floats in front of you and tags along while it is not pinned, pressed by fingertip poke or
 * ray. Its pin button (id `pin`) toggles `pinned`; every other button reports its id to `onSelect`.
 */
export class NearMenu extends ButtonPanel {
  private readonly following: FollowInView;
  private custom: NearButton[];
  private readonly pin: boolean;
  private pinnedNow: boolean;
  static attach(xr: NearHost, options: NearMenuOptions = {}): NearMenu {
    return new NearMenu(xr, options);
  }
  private constructor(xr: NearHost, options: NearMenuOptions) {
    super(options, 3);
    this.custom = [...(options.buttons ?? [])];
    this.pin = options.pinButton ?? true;
    this.pinnedNow = options.pinned ?? false;
    this.sync();
    this.following = FollowInView.attach(xr, {
      ...options.follow,
      target: this,
    });
    this.following.enabled = !this.pinnedNow;
    this.stops.push(
      () => this.following.dispose(),
      xr.onFrame(() => this.pokeAll(xr.controllers)),
    );
  }
  /** True when the menu stays where it is. Setting it pins or unpins. */
  get pinned(): boolean {
    return this.pinnedNow;
  }
  set pinned(value: boolean) {
    this.pinnedNow = value;
    this.following.enabled = !value;
    this.sync();
  }
  /** Replaces the buttons (the pin button stays last). */
  setButtons(buttons: readonly NearButton[]): void {
    this.custom = [...buttons];
    this.sync();
  }
  /** Places the menu in front of you on the next frame. */
  recenter(): void {
    this.following.snap();
  }
  protected override select(index: number): void {
    const b = this.buttons[index];
    if (b.id === 'pin') this.pinned = !this.pinnedNow;
    else super.select(index);
  }
  private sync(): void {
    this.buttons = this.pin
      ? [...this.custom, { id: 'pin', label: this.pinnedNow ? 'Unpin' : 'Pin' }]
      : [...this.custom];
  }
}

/** Options for {@link Slate}. */
export interface SlateOptions {
  /** Centre in the reference space. Default [0, 1.4, -0.8]. */
  position?: readonly [number, number, number];
  /** Rotation [x, y, z, w]. Default identity (faces +Z). */
  orientation?: readonly [number, number, number, number];
  /** Width and height in metres. Default [0.4, 0.3]. */
  size?: readonly [number, number];
  /** Smallest size when resizing. Default [0.15, 0.1]. */
  minSize?: readonly [number, number];
  /** Largest size when resizing. Default [1.6, 1.2]. */
  maxSize?: readonly [number, number];
  /** Height of the title bar in metres. Default 0.04. */
  titleHeight?: number;
  /** Side of the corner resize handle in metres, or 0 for none. Default 0.03. */
  handle?: number;
  /** Drag the content with a ray or finger to pan it. Default true. */
  panContent?: boolean;
  title?: string;
  /** Called with the new position after the title bar moved the slate. */
  onMove?(slate: Slate): void;
  /** Called after a corner drag resized it. */
  onResize?(slate: Slate): void;
  /** The close button was pressed (a button in the title bar's right end). */
  onClose?(slate: Slate): void;
  /** A tap on the content (panning on) or its raw down, move and up (panning off), in content metres from the content's top left. */
  onContent?(event: { type: 'tap' | 'down' | 'move' | 'up'; x: number; y: number }): void;
}
/** Where a slate press landed. */
export type SlateRegion = 'title' | 'close' | 'handle' | 'content';
/**
 * A holographic slate: a 2D panel with a title bar you drag to move it, a close button, a corner you drag to resize
 * and content you drag to pan (`contentOffset`, `contentZoom`). It is a `RayPanel`: add it to `Interaction.panels`
 * and rays and pinches drive it; draw its `size`, `title`, `contentOffset` and `contentZoom` yourself.
 */
export class Slate extends NearBehavior implements RayPanel {
  readonly position: Vector3;
  readonly orientation: Quaternion;
  size: readonly [number, number];
  enabled = true;
  title: string;
  /** Pan of the content in panel metres (positive x right, positive y up). */
  readonly contentOffset: [number, number] = [0, 0];
  /** Zoom of the content, 1 is natural size. */
  contentZoom = 1;
  /** The region being dragged, or null. */
  dragging: SlateRegion | null = null;
  private readonly o: SlateOptions;
  private readonly d = new Vector3();
  private owner: XRController | null = null;
  private grab = { u: 0, v: 0, w: 0, h: 0, x: 0, y: 0, moved: 0 };
  constructor(options: SlateOptions = {}) {
    super();
    this.o = options;
    const p = options.position ?? [0, 1.4, -0.8],
      q = options.orientation ?? [0, 0, 0, 1];
    this.position = new Vector3(p[0], p[1], p[2]);
    this.orientation = new Quaternion(q[0], q[1], q[2], q[3]);
    this.size = options.size ?? [0.4, 0.3];
    this.title = options.title ?? '';
    const [mw, mh] = options.minSize ?? [0.15, 0.1],
      [xw, xh] = options.maxSize ?? [1.6, 1.2];
    if (!(mw > 0 && mh > 0 && xw >= mw && xh >= mh))
      throw new RangeError(
        'Slate minSize must be positive and not above maxSize; pass { minSize: [0.15, 0.1], maxSize: [1.6, 1.2] }',
      );
  }
  /** The region at panel coordinates u (from the left) and v (from the top), or null outside. */
  regionAt(u: number, v: number): SlateRegion | null {
    const [w, h] = this.size,
      title = this.o.titleHeight ?? 0.04,
      handle = this.o.handle ?? 0.03;
    if (u < 0 || u > 1 || v < 0 || v > 1) return null;
    const x = u * w,
      y = v * h;
    if (y <= title) return this.o.onClose && x >= w - title ? 'close' : 'title';
    if (handle > 0 && x >= w - handle && y >= h - handle) return 'handle';
    return 'content';
  }
  /** Zooms the content by `factor`, clamped to [min, max] (default 0.25 to 4). */
  zoomBy(factor: number, min = 0.25, max = 4): void {
    this.contentZoom = Math.min(max, Math.max(min, this.contentZoom * factor));
  }
  onPointer(e: PanelPointerEvent): void {
    if (this.owner && e.controller !== this.owner) return;
    const [w, h] = this.size,
      g = this.grab;
    if (e.type === 'down') {
      const region = this.regionAt(e.u, e.v);
      if (!region) return;
      this.owner = e.controller;
      this.dragging = region;
      this.grab = {
        u: e.u,
        v: e.v,
        w,
        h,
        x: this.contentOffset[0],
        y: this.contentOffset[1],
        moved: 0,
      };
      if (region === 'content' && this.o.panContent === false) this.content('down', e);
      return;
    }
    if (!this.dragging) return;
    const dx = (e.u - g.u) * w,
      dy = -(e.v - g.v) * h;
    if (e.type === 'move') {
      g.moved = Math.max(g.moved, Math.hypot(dx, dy));
      if (this.dragging === 'title') {
        // The grab point stays under the ray: shift by the local delta.
        this.position.add(this.d.set(dx, dy, 0).applyQuaternion(this.orientation));
        this.o.onMove?.(this);
      } else if (this.dragging === 'handle') this.resize(e.u * w + (g.w - g.u * g.w), e.v * h + (g.h - g.v * g.h));
      else if (this.dragging === 'content') {
        if (this.o.panContent === false) this.content('move', e);
        else {
          // The content under the ray follows it: the start offset plus the whole drag so far.
          this.contentOffset[0] = g.x + dx;
          this.contentOffset[1] = g.y + dy;
        }
      }
      return;
    }
    if (e.type === 'up' || e.type === 'leave') {
      const region = this.dragging;
      this.dragging = null;
      this.owner = null;
      if (region === 'close' && e.type === 'up' && this.regionAt(e.u, e.v) === 'close') this.o.onClose?.(this);
      if (region === 'content' && e.type === 'up') {
        if (this.o.panContent === false) this.content('up', e);
        else if (g.moved < 0.01) this.content('tap', e);
      }
    }
  }
  private content(type: 'tap' | 'down' | 'move' | 'up', e: PanelPointerEvent): void {
    const [w, h] = this.size,
      title = this.o.titleHeight ?? 0.04;
    this.o.onContent?.({
      type,
      x: (e.u * w - this.contentOffset[0]) / this.contentZoom,
      y: (e.v * h - title + this.contentOffset[1]) / this.contentZoom,
    });
  }
  /** Sets the size with the top-left corner fixed, within the limits. */
  private resize(width: number, height: number): void {
    const [mw, mh] = this.o.minSize ?? [0.15, 0.1],
      [xw, xh] = this.o.maxSize ?? [1.6, 1.2],
      w = Math.min(xw, Math.max(mw, width)),
      h = Math.min(xh, Math.max(mh, height));
    this.position.add(this.d.set((w - this.size[0]) / 2, -(h - this.size[1]) / 2, 0).applyQuaternion(this.orientation));
    this.size = [w, h];
    this.o.onResize?.(this);
  }
}
