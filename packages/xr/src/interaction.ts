// Grab, ray UI and sockets for XR controllers and hands. Written from the W3C WebXR Device API (targetRaySpace points
// down its -Z axis; gripSpace is where the hand holds), the WebXR Gamepads Module ("xr-standard": button 0 trigger, 1
// squeeze) and the WebXR Hand Input Module (joint 4 thumb-tip, 9 index-finger-tip: a pinch is the two tips touching).
// The grab keeps the object's pose fixed in the grip's frame: object = grip * offset, offset = grip^-1 * object at the
// moment of the grab. A ray meets a panel plane at t = ((p - o) . n) / (d . n), front faces only.
import type { Mesh } from '@margoengine/core';
import { Quaternion } from '@margoengine/math/quaternion';
import { Vector3 } from '@margoengine/math/vector3';
import type { XRController } from './controller.js';
import type { XRFrameState } from './types.js';

/** What the toolkit needs of an `XR`: its controllers and a per-frame hook. `XR` itself fits. */
export interface InteractionHost {
  readonly controllers: readonly XRController[];
  onFrame(callback: (state: XRFrameState) => void): () => void;
}
/** Something a controller or hand can pick up. Its pose is in the XR reference space (world units). */
export interface Grabbable {
  readonly position: Vector3;
  readonly orientation: Quaternion;
  /** Reach in metres: a grip this close grabs it, and a ray grab aims at a sphere this big. */
  radius: number;
  /** False ignores it. Default true. */
  enabled?: boolean;
  /** Called after the toolkit moves it; `grabbable(mesh)` writes the mesh here. */
  apply?(): void;
  onGrab?(event: GrabEvent): void;
  onRelease?(event: ReleaseEvent): void;
}
/** A grab: which controller holds the object and whether it was reached by the ray. */
export interface GrabEvent {
  readonly controller: XRController;
  readonly ray: boolean;
}
/** A release: the object's speed at release in metres per second, and the socket that took it, if any. */
export interface ReleaseEvent {
  readonly controller: XRController;
  readonly velocity: readonly [number, number, number];
  readonly socket: Socket | null;
}
/** A place an object snaps to when released close by: a holster, a slot, a key in a lock. */
export interface Socket {
  readonly position: Vector3;
  readonly orientation: Quaternion;
  /** Snap distance in metres. */
  radius: number;
  /** Which objects fit. Default every one. */
  accepts?(object: Grabbable): boolean;
  /** The object in the socket, or null. */
  held: Grabbable | null;
  /** True while a held object that fits is within reach. */
  hovered?: boolean;
  onSnap?(object: Grabbable): void;
  onLeave?(object: Grabbable): void;
}
/** A flat rectangle a ray can point at and press: a menu, a keypad, a layer panel. Faces +Z. */
export interface RayPanel {
  readonly position: Vector3;
  readonly orientation: Quaternion;
  /** Width and height in metres. */
  size: readonly [number, number];
  enabled?: boolean;
  onPointer(event: PanelPointerEvent): void;
}
/** A ray's event on a panel: u from the left edge, v from the top edge, each 0 to 1. */
export interface PanelPointerEvent {
  readonly type: 'enter' | 'move' | 'down' | 'up' | 'leave';
  readonly u: number;
  readonly v: number;
  readonly distance: number;
  readonly controller: XRController;
}
/** Options for {@link Interaction.attach}. */
export interface InteractionOptions {
  grabbables?: Grabbable[];
  sockets?: Socket[];
  panels?: RayPanel[];
  /** Longest ray in metres for ray grabs and panels. Default 5. */
  rayLength?: number;
  /** Grab objects at a distance along the ray. Default true. */
  rayGrab?: boolean;
  /** Thumb-tip to index-tip distance in metres that counts as a pinch. Default 0.02. */
  pinch?: number;
}
/** Where one controller's ray points this frame, for drawing a pointer. */
export interface RayState {
  readonly controller: XRController;
  /** The panel under the ray, or null. */
  panel: RayPanel | null;
  /** Distance to the panel, or the ray length. */
  distance: number;
  /** The object held, or null. */
  holding: Grabbable | null;
}

/** A grabbable that moves `mesh` (a root mesh, so its position is in world units). */
export function grabbable(
  mesh: Mesh,
  options: { radius?: number; position?: readonly number[]; orientation?: readonly number[] } = {},
): Grabbable & { readonly mesh: Mesh } {
  const p = options.position ?? [mesh.position.x, mesh.position.y, mesh.position.z],
    q = options.orientation ?? [0, 0, 0, 1];
  const target = {
    mesh,
    position: new Vector3(p[0], p[1], p[2]),
    orientation: new Quaternion(q[0], q[1], q[2], q[3]),
    radius: options.radius ?? 0.1,
    apply() {
      mesh.setPosition([target.position.x, target.position.y, target.position.z]);
      mesh.setQuaternion([target.orientation.x, target.orientation.y, target.orientation.z, target.orientation.w]);
    },
  };
  target.apply();
  return target;
}

interface Hand {
  readonly ray: RayState;
  grabbed: Grabbable | null;
  readonly offsetPosition: Vector3;
  readonly offsetOrientation: Quaternion;
  grab: boolean;
  press: boolean;
  pressed: RayPanel | null;
  readonly history: number[];
}
const TRIGGER = 0,
  SQUEEZE = 1,
  THUMB_TIP = 4,
  INDEX_TIP = 9,
  HISTORY = 4;

/**
 * Grab, ray UI and sockets for every controller and hand of an XR session: squeeze (or pinch) to pick up an object
 * near the grip or along the ray, release over a socket to snap it in, and point the ray at a panel and press the
 * trigger (or pinch) to click. Arrays passed in options stay live: push and remove objects at any time.
 */
export class Interaction {
  readonly grabbables: Grabbable[];
  readonly sockets: Socket[];
  readonly panels: RayPanel[];
  /** One entry per controller, in `xr.controllers` order. */
  readonly rays: RayState[] = [];
  private readonly hands = new Map<XRController, Hand>();
  private readonly stop: () => void;
  private readonly rayLength: number;
  private readonly rayGrab: boolean;
  private readonly pinch: number;
  private readonly gp = new Vector3();
  private readonly gq = new Quaternion();
  private readonly ro = new Vector3();
  private readonly rd = new Vector3();
  private readonly v = new Vector3();
  private readonly q = new Quaternion();

  static attach(xr: InteractionHost, options: InteractionOptions = {}): Interaction {
    return new Interaction(xr, options);
  }
  private constructor(
    private readonly xr: InteractionHost,
    options: InteractionOptions,
  ) {
    this.grabbables = options.grabbables ?? [];
    this.sockets = options.sockets ?? [];
    this.panels = options.panels ?? [];
    this.rayLength = options.rayLength ?? 5;
    this.rayGrab = options.rayGrab ?? true;
    this.pinch = options.pinch ?? 0.02;
    if (!(this.rayLength > 0) || !(this.pinch > 0))
      throw new RangeError(
        'Interaction rayLength and pinch must be positive metres; pass { rayLength: 5, pinch: 0.02 }',
      );
    this.stop = xr.onFrame((state) => this.frame(state.delta));
  }
  /** Lets go of everything and stops following the controllers. */
  dispose(): void {
    this.stop();
    for (const hand of this.hands.values()) if (hand.grabbed) this.release(hand, [0, 0, 0]);
    this.hands.clear();
    this.rays.length = 0;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }

  private frame(delta: number): void {
    const controllers = this.xr.controllers;
    for (const [controller, hand] of this.hands)
      if (!controllers.includes(controller)) {
        if (hand.grabbed) this.release(hand, [0, 0, 0]);
        if (hand.pressed) hand.pressed = null;
        this.hands.delete(controller);
      }
    this.rays.length = 0;
    for (const controller of controllers) {
      let hand = this.hands.get(controller);
      if (!hand) {
        hand = {
          ray: { controller, panel: null, distance: this.rayLength, holding: null },
          grabbed: null,
          offsetPosition: new Vector3(),
          offsetOrientation: new Quaternion(),
          grab: false,
          press: false,
          pressed: null,
          history: [],
        };
        this.hands.set(controller, hand);
      }
      this.rays.push(hand.ray);
      this.update(controller, hand, delta);
    }
  }
  private update(controller: XRController, hand: Hand, delta: number): void {
    const held = controller.grip ?? controller.targetRay;
    if (!held) return;
    // Buttons mean squeeze and trigger only under the xr-standard mapping; any other input (a hand) pinches.
    const pinched = this.pinched(controller),
      standard = controller.source?.gamepad?.mapping === 'xr-standard',
      grab = standard && controller.buttonCount > SQUEEZE ? controller.buttons[SQUEEZE * 3 + 1] === 1 : pinched,
      press = standard && controller.buttonCount > TRIGGER ? controller.buttons[TRIGGER * 3 + 1] === 1 : pinched;
    const { position: p, orientation: o } = held.transform;
    this.gp.set(p.x, p.y, p.z);
    this.gq.set(o.x, o.y, o.z, o.w);
    this.ray(controller);
    if (grab && !hand.grab && !hand.grabbed) this.pick(controller, hand);
    if (hand.grabbed) {
      const object = hand.grabbed;
      // object = grip * offset
      object.position.copy(hand.offsetPosition).applyQuaternion(this.gq).add(this.gp);
      object.orientation.copy(this.gq).multiply(hand.offsetOrientation);
      object.apply?.();
      hand.history.push(object.position.x, object.position.y, object.position.z, delta);
      if (hand.history.length > HISTORY * 4) hand.history.splice(0, 4);
      for (const socket of this.sockets) socket.hovered = this.fits(socket, object);
      if (!grab) this.release(hand, velocity(hand.history));
    }
    hand.grab = grab;
    hand.ray.holding = hand.grabbed;
    this.point(controller, hand, press && !hand.grabbed);
    hand.press = press;
  }
  private pinched(controller: XRController): boolean {
    const m = controller.handMatrices;
    if (!controller.handTracked[THUMB_TIP] || !controller.handTracked[INDEX_TIP]) return false;
    const a = THUMB_TIP * 16 + 12,
      b = INDEX_TIP * 16 + 12;
    return Math.hypot(m[a] - m[b], m[a + 1] - m[b + 1], m[a + 2] - m[b + 2]) <= this.pinch;
  }
  /** Sets ro and rd to the target ray's origin and -Z direction; false when untracked. */
  private ray(controller: XRController): boolean {
    const ray = controller.targetRay;
    if (!ray) return false;
    const { position: p, orientation: o } = ray.transform;
    this.ro.set(p.x, p.y, p.z);
    this.q.set(o.x, o.y, o.z, o.w);
    this.rd.set(0, 0, -1).applyQuaternion(this.q);
    return true;
  }
  private pick(controller: XRController, hand: Hand): void {
    let best: Grabbable | null = null,
      bestDistance = Infinity,
      ray = false;
    const taken = new Set<Grabbable>();
    for (const other of this.hands.values()) if (other.grabbed) taken.add(other.grabbed);
    for (const object of this.grabbables) {
      if (object.enabled === false || taken.has(object)) continue;
      const d = object.position.distanceTo(this.gp);
      if (d <= object.radius && d < bestDistance) {
        best = object;
        bestDistance = d;
      }
    }
    if (!best && this.rayGrab && controller.targetRay) {
      for (const object of this.grabbables) {
        if (object.enabled === false || taken.has(object)) continue;
        const t = raySphere(this.ro, this.rd, object.position, object.radius);
        if (t !== null && t <= this.rayLength && t < bestDistance) {
          best = object;
          bestDistance = t;
          ray = true;
        }
      }
    }
    if (!best) return;
    // offset = grip^-1 * object
    this.q.copy(this.gq).invert();
    hand.offsetPosition.copy(best.position).sub(this.gp).applyQuaternion(this.q);
    hand.offsetOrientation.copy(this.q).multiply(best.orientation);
    hand.grabbed = best;
    hand.history.length = 0;
    for (const socket of this.sockets)
      if (socket.held === best) {
        socket.held = null;
        socket.onLeave?.(best);
      }
    best.onGrab?.({ controller, ray });
  }
  private fits(socket: Socket, object: Grabbable): boolean {
    return (
      (socket.held === null || socket.held === object) &&
      (socket.accepts?.(object) ?? true) &&
      socket.position.distanceTo(object.position) <= socket.radius
    );
  }
  private release(hand: Hand, speed: readonly [number, number, number]): void {
    const object = hand.grabbed!;
    hand.grabbed = null;
    hand.ray.holding = null;
    let socket: Socket | null = null,
      nearest = Infinity;
    for (const s of this.sockets) {
      s.hovered = false;
      const d = s.position.distanceTo(object.position);
      if (this.fits(s, object) && d < nearest) {
        socket = s;
        nearest = d;
      }
    }
    if (socket) {
      object.position.copy(socket.position);
      object.orientation.copy(socket.orientation);
      object.apply?.();
      socket.held = object;
      socket.onSnap?.(object);
    }
    object.onRelease?.({ controller: hand.ray.controller, velocity: socket ? [0, 0, 0] : speed, socket });
  }
  private point(controller: XRController, hand: Hand, press: boolean): void {
    let panel: RayPanel | null = null,
      distance = this.rayLength,
      u = 0,
      v = 0;
    if (!hand.grabbed && this.ray(controller))
      for (const candidate of this.panels) {
        if (candidate.enabled === false) continue;
        const hit = this.panelHit(candidate, distance);
        if (hit) {
          panel = candidate;
          [distance, u, v] = hit;
        }
      }
    const ray = hand.ray,
      send = (target: RayPanel, type: PanelPointerEvent['type']) =>
        target.onPointer({ type, u, v, distance, controller });
    if (ray.panel && ray.panel !== panel) send(ray.panel, 'leave');
    if (panel && ray.panel !== panel) send(panel, 'enter');
    else if (panel) send(panel, 'move');
    ray.panel = panel;
    ray.distance = distance;
    if (press && !hand.press && panel) {
      hand.pressed = panel;
      send(panel, 'down');
    }
    if (!press && hand.pressed) {
      send(hand.pressed, 'up');
      hand.pressed = null;
    }
  }
  /** [distance, u, v] where the ray meets the panel's front within `limit`, or null. */
  private panelHit(panel: RayPanel, limit: number): [number, number, number] | null {
    const n = this.v.set(0, 0, 1).applyQuaternion(panel.orientation),
      denom = this.rd.dot(n);
    if (denom >= 0) return null;
    const t =
      (n.x * (panel.position.x - this.ro.x) +
        n.y * (panel.position.y - this.ro.y) +
        n.z * (panel.position.z - this.ro.z)) /
      denom;
    if (t <= 0 || t > limit) return null;
    const local = this.v
      .copy(this.rd)
      .multiplyScalar(t)
      .add(this.ro)
      .sub(panel.position)
      .applyQuaternion(this.q.copy(panel.orientation).invert());
    const u = local.x / panel.size[0] + 0.5,
      v = 0.5 - local.y / panel.size[1];
    if (u < 0 || u > 1 || v < 0 || v > 1) return null;
    return [t, u, v];
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
/** Mean velocity over the recorded [x, y, z, dt] samples. */
function velocity(history: readonly number[]): [number, number, number] {
  const n = history.length / 4;
  if (n < 2) return [0, 0, 0];
  let time = 0;
  for (let i = 1; i < n; i++) time += history[i * 4 + 3];
  if (!(time > 0)) return [0, 0, 0];
  const a = 0,
    b = (n - 1) * 4;
  return [
    (history[b] - history[a]) / time,
    (history[b + 1] - history[a + 1]) / time,
    (history[b + 2] - history[a + 2]) / time,
  ];
}
