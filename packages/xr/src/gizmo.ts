/// <reference lib="esnext.disposable" preserve="true" />
// Drives a transform gizmo from XR controller rays. Written from the W3C WebXR Device API (an input source's
// targetRaySpace points along its -Z axis; the session fires selectstart/selectend and squeezestart/squeezeend with the
// input source), Mine, Brooks and Sequin 1997 (two-handed scaling by the ratio of the hands' separation) and Bowman and
// Hodges 1997 (ray-casting to pick at a distance, then manipulating about the object rather than the hand). The handle
// shapes, constraints and snapping are the gizmo's own: this entry only feeds it rays, through the gizmo's `aim` hook.
import { add, cross, dot, normalize, scale, sub } from '@margoengine/math/vec3';
import { rangeError } from '../../shared/errors.js';
import type { XRController } from './controller.js';
import type { XRFrameState, XRInputSource, XRNativeSession } from './types.js';

/** What `XRGizmo` needs of an `XR`: its session, controllers and a per-frame hook. `XR` itself fits. */
export interface XRGizmoHost {
  readonly session: XRNativeSession | null;
  readonly controllers: readonly XRController[];
  onFrame(callback: (state: XRFrameState) => void): () => void;
}
type V3 = [number, number, number];
/** The world ray a driver hands the gizmo in place of a pointer: `TransformAim` of `@margoengine/controls/transform`. */
export interface XRGizmoAim {
  ray: { origin: V3; direction: V3 };
  /** The frame of the ray when it grabbed, a stand-in screen `screen` pixels square. */
  b: { position: V3; forward: V3; right: V3; up: V3; distance: number; tanHalf: number };
  screen: number;
  /** Kept by the gizmo: the ray's nearest point along a dragged axis and what steadies it near parallel. */
  along: number;
  from: V3;
  bias: number;
  parallel: boolean;
  /** The size factor of a two-point scale, or null for a ray drag. */
  factor: number | null;
}
/**
 * The gizmo a ray drives, by its pointer methods and its ray hook `aim`. `TransformControls` of
 * `@margoengine/controls/transform` fits.
 */
export interface XRGizmoTarget {
  /** True while a handle is dragged. */
  readonly dragging: boolean;
  readonly enabled: boolean;
  /** The lit or dragged handle. */
  readonly axis: string | null;
  /** While set, the gizmo picks and drags by this ray; the end of a drag clears it. */
  aim: XRGizmoAim | null;
  /** Where the gizmo is and the unit vector from it to the eye, or null with nothing attached. */
  frame(): { origin: readonly number[]; eye: readonly number[] } | null;
  pick(x: number, y: number): string | null;
  setAxis(axis: string | null): void;
  pointerDown(x: number, y: number): void;
  pointerMove(x: number, y: number): void;
  begin(action: { op: 'scale'; axis: 'XYZ' }, x: number, y: number): void;
  endDrag(): void;
}
/** A hover, grab or release of the gizmo by a controller. */
export interface XRGizmoEvent {
  readonly controller: XRController;
  /** The handle's name (`X`, `XY`, `RZ`...), `scale` for a two-hand scale, or null when a hover ends. */
  readonly handle: string | null;
}
/** Options of `XRGizmo`, copied at attachment; every field is optional. */
export interface XRGizmoOptions {
  /** The action that grabs: the primary `select` (trigger or pinch) or `squeeze` (grip). Default `select`. */
  button?: 'select' | 'squeeze';
  /** Which hands drive the gizmo. Default all three: `left`, `right` and `none`. */
  hands?: readonly XRInputSource['handedness'][];
  /** A second hand's press during a grab turns it into a two-hand scale. Default true. */
  twoHandScale?: boolean;
  /** Hands closer than this at the second press, in metres, do not start a two-hand scale. Default 0.02. */
  minSeparation?: number;
  /** Called when the handle under a ray changes. */
  onHover?(event: XRGizmoEvent): void;
  /** Called when a hand grabs a handle, or the second hand starts a two-hand scale. */
  onGrab?(event: XRGizmoEvent): void;
  /** Called when a grab or a two-hand scale ends. */
  onRelease?(event: XRGizmoEvent): void;
  /** Aborting disposes the driver. */
  signal?: AbortSignal;
}

const METHODS = ['frame', 'pick', 'setAxis', 'pointerDown', 'pointerMove', 'begin', 'endDrag'] as const;
/** Side in pixels of the stand-in screen of a ray, and tan of half its field: the 8 pixel pick radius spans 1.5 degrees. */
const SCREEN = 300;
const CENTRE = SCREEN / 2;
const TAN = 0.5;
/** A ray's aim with how far along the ray the gizmo was at the grab. */
type Aim = XRGizmoAim & { reach: number };

/**
 * Drives a transform gizmo with world rays: an origin and a direction in world space (the direction need not be unit).
 * `XRGizmo` feeds it controller rays; any other ray source (a tracked stylus, a second camera) can call it directly.
 */
export class GizmoRayDriver {
  constructor(readonly gizmo: XRGizmoTarget) {
    if (!gizmo || METHODS.some((name) => typeof gizmo[name] !== 'function'))
      throw rangeError(
        'GizmoRayDriver needs a gizmo with frame, pick, setAxis, pointerDown, pointerMove, begin and endDrag; pass a TransformControls',
        'arguments',
      );
  }
  /** True while a handle is dragged. */
  get dragging(): boolean {
    return this.gizmo.dragging;
  }
  private take(origin: readonly number[], direction: readonly number[]): Aim | null {
    const length = Math.hypot(direction[0], direction[1], direction[2]);
    if (!(length > 0 && Number.isFinite(length) && Number.isFinite(origin[0] + origin[1] + origin[2])))
      throw rangeError(
        'GizmoRayDriver ray must be a finite origin and a non-zero direction; pass [x, y, z] and [x, y, z]',
        'arguments',
      );
    const f = this.gizmo.enabled ? this.gizmo.frame() : null;
    if (!f) return null;
    const from: V3 = [origin[0], origin[1], origin[2]],
      forward: V3 = [direction[0] / length, direction[1] / length, direction[2] / length],
      right = normalize(cross(forward, Math.abs(forward[1]) < 0.99 ? [0, 1, 0] : [1, 0, 0])) as V3;
    return {
      ray: { origin: from, direction: forward },
      b: { position: from, forward, right, up: cross(right, forward) as V3, distance: 1, tanHalf: TAN },
      screen: SCREEN,
      reach: Math.max(1e-3, Math.hypot(...sub(f.origin, from))),
      along: 0,
      from,
      bias: 0,
      parallel: false,
      factor: null,
    };
  }
  /**
   * Lights the handle a world ray points at, as a hovering pointer does, and returns its name or null. During a drag it
   * returns the dragged handle and changes nothing.
   */
  rayHover(origin: readonly number[], direction: readonly number[]): string | null {
    const g = this.gizmo,
      aim = this.take(origin, direction);
    if (g.dragging) return g.axis;
    g.aim = aim;
    const axis = aim && g.pick(CENTRE, CENTRE);
    g.aim = null;
    g.setAxis(axis);
    return axis;
  }
  /**
   * Grabs the handle a world ray points at and starts a drag, as a pointer press does. Returns false when the ray points
   * at no handle or a drag is under way. Follow with `rayMove` and end with `rayUp`.
   */
  rayDown(origin: readonly number[], direction: readonly number[]): boolean {
    const g = this.gizmo;
    if (g.dragging || !this.rayHover(origin, direction)) return false;
    g.aim = this.take(origin, direction);
    g.pointerDown(CENTRE, CENTRE);
    if (!g.dragging) g.aim = null;
    return g.dragging;
  }
  /** Continues a `rayDown` drag with the ray's new place. */
  rayMove(origin: readonly number[], direction: readonly number[]): void {
    const g = this.gizmo,
      aim = g.aim as Aim | null,
      next = aim && aim.factor === null && g.dragging ? this.take(origin, direction) : null;
    if (!aim || !next) return;
    aim.ray = next.ray;
    // The handles dragged across the view follow the ray's point at the grab distance over the grab's stand-in screen.
    const b = aim.b,
      d = sub(add(next.ray.origin, scale(next.ray.direction, aim.reach)), b.position),
      depth = dot(d, b.forward),
      half = depth * b.tanHalf;
    if (depth > 0) g.pointerMove((dot(d, b.right) / half + 1) * CENTRE, (1 - dot(d, b.up) / half) * CENTRE);
  }
  /**
   * Starts a two-point scale in any mode: `scaleTo(factor)` then sizes everything attached about the gizmo, with the
   * scale snap, until `rayUp`. Returns false when nothing is attached or a drag is under way.
   */
  scaleDown(): boolean {
    const g = this.gizmo,
      f = g.dragging ? null : g.frame(),
      aim = f && this.take(add(f.origin, f.eye), scale(f.eye, -1));
    if (!aim) return false;
    aim.factor = 1;
    g.aim = aim;
    g.begin({ op: 'scale', axis: 'XYZ' }, CENTRE, CENTRE);
    if (!g.dragging) g.aim = null;
    return g.dragging;
  }
  /** Sets the size of a `scaleDown` drag to `factor` times the size it began with (1 leaves it as it was). */
  scaleTo(factor: number): void {
    if (!(Number.isFinite(factor) && factor > 0))
      throw rangeError(
        'GizmoRayDriver scaleTo factor must be a finite number above 0; pass a ratio such as 1.5',
        'arguments',
      );
    const g = this.gizmo,
      aim = g.aim;
    if (!aim || aim.factor === null || !g.dragging) return;
    aim.factor = factor;
    g.pointerMove(CENTRE, CENTRE);
  }
  /** Ends a `rayDown` or `scaleDown` drag, as a pointer release does; with no drag, the highlight of `rayHover` goes out. */
  rayUp(): void {
    const g = this.gizmo;
    if (!g.dragging) g.setAxis(null);
    else if (g.aim) g.endDrag();
  }
}
const HANDS = ['left', 'right', 'none'];

/**
 * Drives a transform gizmo from XR controller rays: a ray lights the handle it points at, the grab button takes it, the
 * handle then follows the ray under the gizmo's own constraints and snapping, and a second hand's press scales by the
 * ratio of the hands' separation. Poses are read in the XR reference space, taken as world space.
 */
export class XRGizmo {
  private readonly stop: () => void;
  private session: XRNativeSession | null = null;
  private holder: XRController | null = null;
  private second: XRController | null = null;
  private separation = 0;
  private hover: string | null = null;
  private pointer: XRController | null = null;
  private handle: string | null = null;
  private disposed = false;
  private readonly start: string;
  private readonly end: string;
  private readonly hands: readonly string[];
  private readonly twoHandScale: boolean;
  private readonly minSeparation: number;
  private readonly gizmo: GizmoRayDriver;

  /** Attaches the driver; `dispose()` or `using` detaches it. */
  static attach(xr: XRGizmoHost, gizmo: XRGizmoTarget, options: XRGizmoOptions = {}): XRGizmo {
    options.signal?.throwIfAborted();
    return new XRGizmo(xr, gizmo, options);
  }
  private constructor(
    private readonly xr: XRGizmoHost,
    gizmo: XRGizmoTarget,
    private readonly options: XRGizmoOptions,
  ) {
    const button = options.button ?? 'select';
    this.hands = [...(options.hands ?? HANDS)];
    this.twoHandScale = options.twoHandScale ?? true;
    this.minSeparation = options.minSeparation ?? 0.02;
    if (typeof xr?.onFrame !== 'function' || !Array.isArray(xr.controllers))
      throw rangeError('XRGizmo needs an XR host with controllers and onFrame; pass the XR manager', 'arguments');
    this.gizmo = new GizmoRayDriver(gizmo);
    if (
      (button !== 'select' && button !== 'squeeze') ||
      !this.hands.length ||
      this.hands.some((hand) => !HANDS.includes(hand)) ||
      !(Number.isFinite(this.minSeparation) && this.minSeparation > 0)
    )
      throw rangeError(
        "XRGizmo needs button 'select' or 'squeeze', hands from 'left', 'right' and 'none', and minSeparation above 0; pass valid options",
        'arguments',
      );
    this.start = button + 'start';
    this.end = button + 'end';
    this.bind();
    this.stop = xr.onFrame(this.frame);
    options.signal?.addEventListener('abort', this.abort, { once: true });
  }

  /** The controller holding a handle (the first hand of a two-hand scale), or null. */
  get grabbing(): XRController | null {
    return this.holder;
  }
  /** True while two hands scale. */
  get scaling(): boolean {
    return !!this.second;
  }

  private bind(): void {
    if (this.session === this.xr.session) return;
    this.unbind();
    this.session = this.xr.session;
    this.session?.addEventListener(this.start, this.press);
    this.session?.addEventListener(this.end, this.lift);
    this.session?.addEventListener('end', this.ended);
  }
  private unbind(): void {
    this.release();
    this.session?.removeEventListener(this.start, this.press);
    this.session?.removeEventListener(this.end, this.lift);
    this.session?.removeEventListener('end', this.ended);
    this.session = null;
  }
  /** The controller's target ray as a world origin and direction (its -Z axis), or null when untracked or not a driving hand. */
  private ray(controller: XRController | undefined): [number[], number[]] | null {
    if (!controller?.targetRay || !this.hands.includes(controller.source.handedness)) return null;
    const m = controller.targetRayMatrix;
    return [
      [m[12], m[13], m[14]],
      [-m[8], -m[9], -m[10]],
    ];
  }
  private of(event: Event): XRController | undefined {
    const source = (event as Event & { inputSource?: XRInputSource }).inputSource;
    return this.xr.controllers.find((controller) => controller.source === source);
  }
  private readonly press = (event: Event): void => {
    const controller = this.of(event),
      ray = this.ray(controller);
    if (!controller || !ray || this.second || controller === this.holder) return;
    if (!this.holder) {
      if (this.gizmo.dragging || !this.gizmo.rayDown(ray[0], ray[1])) return;
      this.holder = controller;
      // During a drag the gizmo answers a hover with the handle it holds.
      this.handle = this.gizmo.rayHover(ray[0], ray[1]);
      this.options.onGrab?.({ controller, handle: this.handle });
      return;
    }
    const first = this.ray(this.holder),
      separation = first ? Math.hypot(...ray[0].map((value, i) => value - first[0][i])) : 0;
    if (!this.twoHandScale || !(separation >= this.minSeparation)) return;
    // The one-hand drag ends where it is; the two hands then size the object from there.
    this.gizmo.rayUp();
    if (!this.gizmo.scaleDown()) {
      this.release();
      return;
    }
    this.second = controller;
    this.separation = separation;
    this.options.onGrab?.({ controller, handle: 'scale' });
  };
  private readonly lift = (event: Event): void => {
    const controller = this.of(event);
    if (controller && (controller === this.holder || controller === this.second)) this.release();
  };
  /** Ends whatever is held. A hand still pressing after a two-hand scale presses again to grab. */
  private release(): void {
    const controller = this.second ?? this.holder;
    if (!controller) return;
    const handle = this.second ? 'scale' : this.handle;
    this.holder = this.second = null;
    if (this.gizmo.dragging) this.gizmo.rayUp();
    this.options.onRelease?.({ controller, handle });
  }
  private readonly frame = (): void => {
    this.bind();
    const controllers = this.xr.controllers;
    if (this.holder) {
      const first = this.ray(this.holder),
        second = this.second && this.ray(this.second);
      // A held controller that left the session, or a drag the gizmo ended itself, lets go.
      if (
        !controllers.includes(this.holder) ||
        (this.second && !controllers.includes(this.second)) ||
        !this.gizmo.dragging
      )
        this.release();
      else if (this.second) {
        if (first && second)
          this.gizmo.scaleTo(
            Math.max(1e-6, Math.hypot(...second[0].map((value, i) => value - first[0][i])) / this.separation),
          );
      } else if (first) this.gizmo.rayMove(first[0], first[1]);
      return;
    }
    if (this.gizmo.dragging) return;
    // The first ray on a handle lights it; with none, the last ray's miss puts the light out.
    let handle: string | null = null,
      by: XRController | null = null;
    for (const controller of controllers) {
      const ray = this.ray(controller);
      if (!ray) continue;
      by = controller;
      handle = this.gizmo.rayHover(ray[0], ray[1]);
      if (handle) break;
    }
    if (!by && this.hover) this.gizmo.rayUp();
    by ??= this.pointer;
    if (handle !== this.hover && by) {
      this.hover = handle;
      this.pointer = by;
      this.options.onHover?.({ controller: by, handle });
    }
  };
  private readonly ended = (): void => this.unbind();
  private readonly abort = (): void => this.dispose();

  /** Lets go of the gizmo and removes the session, frame and signal listeners. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    this.unbind();
    if (this.hover && !this.gizmo.dragging) this.gizmo.rayUp();
    this.hover = null;
    this.options.signal?.removeEventListener('abort', this.abort);
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}
