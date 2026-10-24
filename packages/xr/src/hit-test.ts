// AR hit testing (W3C WebXR Hit Test Module): rays from the viewer, from an input source's target ray, or from transient
// inputs such as screen taps, tested against the real world the device understands; results are poses in the XR
// session's reference space, ready to place content or to anchor it (WebXR Anchors Module, where supported).
import { margoError } from '../../shared/errors.js';
import type {
  XRAnchor,
  XRHitTestResult,
  XRHitTestSource,
  XRHitTestTrackableType,
  XRInputSource,
  XRNativeFrame,
  XRNativeSession,
  XRRayLike,
  XRSpace,
  XRTransientInputHitTestSource,
} from './types.js';

/** What `HitTest.create` needs of an `XR`: its session and reference space (the frame callback's space). */
export interface HitTestHost {
  readonly session: XRNativeSession | null;
  readonly referenceSpace: XRSpace | undefined;
}
/** Options for {@link HitTest.create}. */
export interface HitTestOptions {
  /**
   * Where the ray starts: `'viewer'` (the centre of the view, for a placement reticle; default), an input source (its
   * target ray: a controller or gaze), or `{profile}` for transient inputs of that profile, such as screen taps
   * (`'generic-touchscreen'`).
   */
  from?: 'viewer' | XRInputSource | { profile: string };
  /** Real-world features the ray hits. Default `['plane']`. */
  entityTypes?: readonly XRHitTestTrackableType[];
  /** The ray in the source's space: origin (default [0, 0, 0]) and direction (default [0, 0, -1]). */
  offsetRay?: { origin?: readonly [number, number, number]; direction?: readonly [number, number, number] };
}
/** One hit: its pose in the session's reference space, and the input source for a transient-input hit. */
export interface Hit {
  /** Column-major 4x4 pose: y is the surface normal for a plane hit. */
  readonly matrix: Float32Array;
  readonly position: [number, number, number];
  /** Unit quaternion [x, y, z, w]. */
  readonly orientation: [number, number, number, number];
  /** The tap or controller that produced it (transient-input sources only). */
  readonly inputSource?: XRInputSource;
  /** The browser's result, for `createAnchor()` and other module features. */
  readonly result: XRHitTestResult;
}
const types: readonly XRHitTestTrackableType[] = ['point', 'plane', 'mesh'];

/**
 * Hit tests in an `immersive-ar` session: `await HitTest.create(xr, {from: 'viewer'})` after `xr.requestSession(
 * 'immersive-ar', {requiredFeatures: ['hit-test']})`, then `hits.results(state.frame)` in the frame callback, nearest
 * first. The source is cancelled with `cancel()` or when the session ends. Throws MargoError 'unsupported' when the
 * session was started without the 'hit-test' feature or the browser lacks the module, 'state' without a session.
 */
export class HitTest {
  private cancelled = false;
  private constructor(
    private readonly host: HitTestHost,
    private readonly session: XRNativeSession,
    private readonly source: XRHitTestSource | undefined,
    private readonly transient: XRTransientInputHitTestSource | undefined,
  ) {
    session.addEventListener('end', this.ended, { once: true });
  }
  /** Subscribes to hit tests from `options.from` in `xr`'s current session. */
  static async create(xr: HitTestHost, options: HitTestOptions = {}): Promise<HitTest> {
    const session = xr?.session;
    if (!session) throw margoError('state', 'HitTest needs an active XR session; await xr.requestSession first');
    if (session.enabledFeatures && !session.enabledFeatures.includes('hit-test'))
      throw margoError(
        'unsupported',
        "The XR session has no 'hit-test' feature; request it in requiredFeatures or optionalFeatures",
      );
    if (!session.requestHitTestSource || !session.requestHitTestSourceForTransientInput)
      throw margoError('unsupported', 'This browser has no WebXR hit testing; use an AR-capable browser and device');
    const entityTypes = [...(options.entityTypes ?? ['plane'])];
    if (!entityTypes.length || entityTypes.some((type) => !types.includes(type)))
      throw new TypeError("HitTest entityTypes must list 'point', 'plane' or 'mesh'");
    const offsetRay = options.offsetRay === undefined ? undefined : ray(options.offsetRay),
      from = options.from ?? 'viewer';
    if (from !== 'viewer' && (typeof from !== 'object' || from === null))
      throw new TypeError("HitTest from must be 'viewer', an XRInputSource or {profile}");
    if (from !== 'viewer' && 'profile' in from) {
      if (typeof from.profile !== 'string' || !from.profile)
        throw new TypeError("HitTest profile must be a non-empty string such as 'generic-touchscreen'");
      const transient = await session.requestHitTestSourceForTransientInput({
        profile: from.profile,
        entityTypes,
        ...(offsetRay && { offsetRay }),
      });
      return new HitTest(xr, session, undefined, transient);
    }
    const space =
      from === 'viewer' ? await session.requestReferenceSpace('viewer') : (from as XRInputSource).targetRaySpace;
    if (!space) throw new TypeError('HitTest input source has no targetRaySpace; pass an XRInputSource');
    const source = await session.requestHitTestSource({ space, entityTypes, ...(offsetRay && { offsetRay }) });
    return new HitTest(xr, session, source, undefined);
  }
  /** Whether the source has been cancelled (by `cancel()` or the session ending). */
  get active(): boolean {
    return !this.cancelled;
  }
  /**
   * This frame's hits, nearest first, as poses in the XR reference space. Empty once cancelled, for another session's
   * frame, or while the device has not found a surface.
   */
  results(frame: XRNativeFrame): Hit[] {
    const space = this.host.referenceSpace;
    if (this.cancelled || !space || frame?.session !== this.session) return [];
    const out: Hit[] = [];
    if (this.source)
      for (const result of frame.getHitTestResults?.(this.source) ?? []) {
        const hit = toHit(result, space);
        if (hit) out.push(hit);
      }
    if (this.transient)
      for (const entry of frame.getHitTestResultsForTransientInput?.(this.transient) ?? [])
        for (const result of entry.results) {
          const hit = toHit(result, space, entry.inputSource);
          if (hit) out.push(hit);
        }
    return out;
  }
  /** The nearest hit of this frame, or null. */
  first(frame: XRNativeFrame): Hit | null {
    return this.results(frame)[0] ?? null;
  }
  /**
   * Anchors `hit` where the device keeps tracking it (WebXR Anchors Module, session feature 'anchors'); read the
   * anchor's pose with `frame.getPose(anchor.anchorSpace, space)` each frame.
   */
  anchor(hit: Hit): Promise<XRAnchor> {
    if (!hit?.result?.createAnchor)
      return Promise.reject(
        margoError('unsupported', "This hit cannot be anchored; request the 'anchors' feature on a supporting browser"),
      );
    return hit.result.createAnchor();
  }
  /** Ends the subscription. */
  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.session.removeEventListener('end', this.ended);
    this.source?.cancel();
    this.transient?.cancel();
  }
  private readonly ended = (): void => this.cancel();
}

function toHit(result: XRHitTestResult, space: XRSpace, inputSource?: XRInputSource): Hit | null {
  const pose = result.getPose(space);
  if (!pose) return null;
  const { matrix, position: p, orientation: q } = pose.transform;
  return {
    matrix: Float32Array.from(matrix),
    position: [p.x, p.y, p.z],
    orientation: [q.x, q.y, q.z, q.w],
    result,
    ...(inputSource && { inputSource }),
  };
}

/** The browser's XRRay for an offset ray; its constructor normalises the direction. */
function ray(o: NonNullable<HitTestOptions['offsetRay']>): XRRayLike {
  const origin = o.origin ?? [0, 0, 0],
    direction = o.direction ?? [0, 0, -1];
  if (![...origin, ...direction].every((v) => typeof v === 'number' && Number.isFinite(v)) || origin.length !== 3)
    throw new TypeError('HitTest offsetRay needs finite [x, y, z] origin and direction');
  if (direction.length !== 3 || !Math.hypot(direction[0], direction[1], direction[2]))
    throw new RangeError('HitTest offsetRay direction must be non-zero; pass a direction such as [0, 0, -1]');
  const XRRay = (
    globalThis as typeof globalThis & {
      XRRay?: new (origin: DOMPointInit, direction: DOMPointInit) => XRRayLike;
    }
  ).XRRay;
  if (!XRRay) throw margoError('unsupported', 'This browser has no XRRay; omit offsetRay');
  return new XRRay(
    { x: origin[0], y: origin[1], z: origin[2], w: 1 },
    { x: direction[0], y: direction[1], z: direction[2], w: 0 },
  );
}
