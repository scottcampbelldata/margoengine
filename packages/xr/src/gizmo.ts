/// <reference lib="esnext.disposable" preserve="true" />
// Drives a transform gizmo from XR controller rays. Written from the W3C WebXR Device API (an input source's
// targetRaySpace points along its -Z axis; the session fires selectstart/selectend and squeezestart/squeezeend with the
// input source), Mine, Brooks and Sequin 1997 (two-handed scaling by the ratio of the hands' separation) and Bowman and
// Hodges 1997 (ray-casting to pick at a distance, then manipulating about the object rather than the hand). The handle
// shapes, constraints and snapping are the gizmo's own: this entry only feeds it rays.
import { rangeError } from '../../shared/errors.js';
import type { XRController } from './controller.js';
import type { XRFrameState, XRInputSource, XRNativeSession } from './types.js';

/** What `XRGizmo` needs of an `XR`: its session, controllers and a per-frame hook. `XR` itself fits. */
export interface XRGizmoHost {
  readonly session: XRNativeSession | null;
  readonly controllers: readonly XRController[];
  onFrame(callback: (state: XRFrameState) => void): () => void;
}
/**
 * The gizmo a ray drives. `TransformControls` of `@margoengine/controls/transform` fits. Rays are an origin and a
 * direction in world space.
 */
export interface XRGizmoTarget {
  /** True while a handle is dragged. */
  readonly dragging: boolean;
  /** Lights the handle the ray points at and returns its name, or null. */
  rayHover(origin: readonly number[], direction: readonly number[]): string | null;
  /** Grabs the handle the ray points at; false when it points at none. */
  rayDown(origin: readonly number[], direction: readonly number[]): boolean;
  /** Continues the grab. */
  rayMove(origin: readonly number[], direction: readonly number[]): void;
  /** Ends a grab or a two-point scale; with neither, puts out the hover light. */
  rayUp(): void;
  /** Starts a two-point scale; false when it cannot. */
  scaleDown(): boolean;
  /** Sizes the two-point scale: `factor` times the size at `scaleDown`. */
  scaleTo(factor: number): void;
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

const METHODS = ['rayHover', 'rayDown', 'rayMove', 'rayUp', 'scaleDown', 'scaleTo'] as const;
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

  /** Attaches the driver; `dispose()` or `using` detaches it. */
  static attach(xr: XRGizmoHost, gizmo: XRGizmoTarget, options: XRGizmoOptions = {}): XRGizmo {
    options.signal?.throwIfAborted();
    return new XRGizmo(xr, gizmo, options);
  }
  private constructor(
    private readonly xr: XRGizmoHost,
    private readonly gizmo: XRGizmoTarget,
    private readonly options: XRGizmoOptions,
  ) {
    const button = options.button ?? 'select';
    this.hands = [...(options.hands ?? HANDS)];
    this.twoHandScale = options.twoHandScale ?? true;
    this.minSeparation = options.minSeparation ?? 0.02;
    if (typeof xr?.onFrame !== 'function' || !Array.isArray(xr.controllers))
      throw rangeError('XRGizmo needs an XR host with controllers and onFrame; pass the XR manager', 'arguments');
    if (!gizmo || METHODS.some((name) => typeof gizmo[name] !== 'function'))
      throw rangeError(
        'XRGizmo needs a gizmo with rayHover, rayDown, rayMove, rayUp, scaleDown and scaleTo; pass a TransformControls',
        'arguments',
      );
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
