// Session facts and controls the WebXR Device API gives next to rendering: the display's blend mode, the frame rate the
// session may ask for (WebXR Device API, `supportedFrameRates` and `updateTargetFrameRate`), the visibility state and
// its `visibilitychange` event, and the play area of a 'bounded-floor' space (`boundsGeometry`) with its `reset` event.
import { margoError } from '../../shared/errors.js';
import type { XRNativeSession, XRSpace } from './types.js';

/** What {@link XRSessionState.attach} needs of an `XR`. */
export interface XRSessionStateHost {
  readonly session: XRNativeSession | null;
  readonly referenceSpace: XRSpace | undefined;
}
/** The browser's session fields this class reads. */
type NativeSession = XRNativeSession & {
  readonly environmentBlendMode?: 'opaque' | 'additive' | 'alpha-blend';
  readonly interactionMode?: 'screen-space' | 'world-space';
  readonly visibilityState?: 'visible' | 'visible-blurred' | 'hidden';
  readonly frameRate?: number | null;
  readonly supportedFrameRates?: ArrayLike<number> | null;
  updateTargetFrameRate?(rate: number): Promise<void>;
  addEventListener?(type: string, listener: (event: Event & { transform?: unknown }) => void): void;
  removeEventListener?(type: string, listener: (event: Event & { transform?: unknown }) => void): void;
};
type Bounded = XRSpace & {
  readonly boundsGeometry?: ArrayLike<{ x: number; z: number }>;
  addEventListener?(type: string, listener: (event: Event & { transform?: unknown }) => void): void;
  removeEventListener?(type: string, listener: (event: Event & { transform?: unknown }) => void): void;
};
/** The session's visibility (WebXR Device API, XRVisibilityState). */
export type XRVisibility = 'visible' | 'visible-blurred' | 'hidden';
/** Options for {@link XRSessionState.attach}. */
export interface XRSessionStateOptions {
  /** Stops following the session when aborted. */
  signal?: AbortSignal;
}

/**
 * Reads and follows an XR session's display and tracking facts: `environmentBlendMode`, `visibility` (a `hidden`
 * session should stop drawing), `frameRate` with `setFrameRate`, and the play-area `bounds` of a 'bounded-floor'
 * reference space.
 * @throws MargoError 'state' without a session.
 */
export class XRSessionState {
  private readonly visible = new Set<(visibility: XRVisibility) => void>();
  private readonly resets = new Set<(transform: unknown) => void>();
  private readonly stops: Array<() => void> = [];
  private disposed = false;
  private constructor(
    private readonly host: XRSessionStateHost,
    private readonly session: NativeSession,
  ) {}
  static attach(xr: XRSessionStateHost, options: XRSessionStateOptions = {}): XRSessionState {
    const session = xr?.session as NativeSession | null;
    if (!session) throw margoError('state', 'XRSessionState needs an active XR session; await xr.requestSession first');
    const state = new XRSessionState(xr, session),
      changed = () => {
        for (const callback of state.visible) callback(state.visibility);
      };
    session.addEventListener?.('visibilitychange', changed);
    state.stops.push(() => session.removeEventListener?.('visibilitychange', changed));
    const space = xr.referenceSpace as Bounded | undefined,
      reset = (event: { transform?: unknown }) => {
        for (const callback of state.resets) callback(event.transform ?? null);
      };
    space?.addEventListener?.('reset', reset);
    state.stops.push(() => space?.removeEventListener?.('reset', reset));
    options.signal?.addEventListener('abort', () => state.dispose(), { once: true });
    return state;
  }
  /** How the display mixes the real world with the scene; undefined where the browser does not say. */
  get environmentBlendMode(): 'opaque' | 'additive' | 'alpha-blend' | undefined {
    return this.session.environmentBlendMode;
  }
  /** Whether the session's input is a screen or the world; undefined where the browser does not say. */
  get interactionMode(): 'screen-space' | 'world-space' | undefined {
    return this.session.interactionMode;
  }
  /** 'visible', 'visible-blurred' (a system menu is up) or 'hidden'. Default 'visible' where the browser does not say. */
  get visibility(): XRVisibility {
    return this.session.visibilityState ?? 'visible';
  }
  /** The frame rate the device runs at now, or null where it does not say. */
  get frameRate(): number | null {
    return this.session.frameRate ?? null;
  }
  /** The frame rates the device accepts; empty where it offers a choice of none. */
  get supportedFrameRates(): readonly number[] {
    return Array.from(this.session.supportedFrameRates ?? []).sort((a, b) => a - b);
  }
  /**
   * Asks the device for `rate` frames per second (WebXR `updateTargetFrameRate`).
   * @throws RangeError when `rate` is not one of `supportedFrameRates`; MargoError 'unsupported' where the browser has no
   * frame rate control.
   */
  async setFrameRate(rate: number): Promise<void> {
    if (!this.session.updateTargetFrameRate)
      throw margoError('unsupported', 'This browser has no XR frame rate control (updateTargetFrameRate)');
    const supported = this.supportedFrameRates;
    if (!supported.includes(rate))
      throw new RangeError(
        `XR frame rate ${String(rate)} is not supported; pass one of ${supported.join(', ') || '(the device lists none)'}`,
      );
    await this.session.updateTargetFrameRate(rate);
  }
  /**
   * The play area of a 'bounded-floor' space as x and z metres per corner in the space's own frame (a polygon, wound as
   * the browser gives it), or null where the space has no bounds (ask for `referenceSpace: 'bounded-floor'`).
   */
  get bounds(): Float32Array | null {
    const geometry = (this.host.referenceSpace as Bounded | undefined)?.boundsGeometry;
    if (!geometry || geometry.length === 0) return null;
    const out = new Float32Array(geometry.length * 2);
    for (let i = 0; i < geometry.length; i++) {
      out[i * 2] = geometry[i].x;
      out[i * 2 + 1] = geometry[i].z;
    }
    return out;
  }
  /** Runs `callback` when the visibility changes; returns a function that stops it. */
  onVisibilityChange(callback: (visibility: XRVisibility) => void): () => void {
    this.visible.add(callback);
    return () => this.visible.delete(callback);
  }
  /**
   * Runs `callback` when the reference space resets (the user recentred, or the play area changed), with the event's
   * `transform` (an XRRigidTransform) or null; read `bounds` again here.
   */
  onReset(callback: (transform: unknown) => void): () => void {
    this.resets.add(callback);
    return () => this.resets.delete(callback);
  }
  /** Stops following the session. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const stop of this.stops) stop();
    this.visible.clear();
    this.resets.clear();
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}
