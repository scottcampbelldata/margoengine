// A real-device run: one XR session measured from its first frame to its last, in the shape docs/xr-device-runs keeps.
// Its fields come from the W3C WebXR Device API (XRSession.enabledFeatures, XRViewerPose.views and emulatedPosition,
// XRInputSource) and the WebXR Hand Input Module (XRInputSource.hand).
import { margoError } from '../../shared/errors.js';
import { checkXRRun, xrRunGaps, XR_RUN_MIN_FRAMES, XR_RUN_TARGETS } from '../../shared/xr-run.js';
import type { XRRun, XRRunObserved, XRRunTarget } from '../../shared/xr-run.js';
import type { XRFrameState, XRInputSource, XRMode, XRNativeSession } from './types.js';
export { checkXRRun, xrRunGaps, XR_RUN_MIN_FRAMES, XR_RUN_TARGETS };
export type { XRRun, XRRunObserved, XRRunTarget };

/** What `runDeviceCheck` needs of an `XR`. */
export interface DeviceCheckHost {
  requestSession(
    mode: XRMode,
    options: {
      optionalFeatures?: string[];
      requiredFeatures?: string[];
      signal?: AbortSignal;
      onFrame?: (state: XRFrameState) => void;
    },
  ): Promise<XRNativeSession>;
  end(): Promise<void>;
}
/** Options for {@link runDeviceCheck}. */
export interface DeviceCheckOptions {
  /** Session to run. Default 'immersive-vr'. */
  mode?: XRMode;
  /** How long the session runs in seconds, from its first frame. Default 20, about 1,400 frames on a 72 Hz headset. */
  seconds?: number;
  /** Features the session must have. Default none. */
  requiredFeatures?: string[];
  /** Features to ask for and record when granted. Default hand tracking, hit testing, anchors, planes, depth and light. */
  optionalFeatures?: string[];
  /** Asks the tester what they saw once the session is over. Default none: the run then proves no route. */
  observe?: (run: XRRun) => Promise<XRRunObserved>;
  /** Ends the session early; the promise rejects with the reason. */
  signal?: AbortSignal;
  /** Called every frame, for the page's own scene updates. */
  onFrame?: (state: XRFrameState) => void;
}
const FEATURES = ['hand-tracking', 'hit-test', 'anchors', 'plane-detection', 'depth-sensing', 'light-estimation'];

/** True when `navigator.xr.requestSession` is the browser's own code. */
function native(): boolean {
  const request = (globalThis.navigator as (Navigator & { xr?: { requestSession?: unknown } }) | undefined)?.xr
    ?.requestSession;
  return (
    typeof request === 'function' && /\{\s*\[native code\]\s*\}\s*$/.test(Function.prototype.toString.call(request))
  );
}
function route(mode: XRMode): XRRun['route'] {
  if (mode === 'inline') return 'none';
  return (globalThis as { XRGPUBinding?: { webgl?: boolean } }).XRGPUBinding?.webgl ? 'webgl2' : 'webgpu';
}
const percentile = (sorted: readonly number[], at: number): number =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * at))] : 0;
/** What one input source is, as the run records it. */
const describe = (source: XRInputSource): XRRun['inputs'][number] => ({
  handedness: source.handedness,
  targetRayMode: source.targetRayMode,
  profiles: [...source.profiles],
  hand: !!source.hand,
  buttons: source.gamepad?.buttons.length ?? 0,
  axes: source.gamepad?.axes.length ?? 0,
});

/**
 * Runs one session for `seconds` and resolves with what happened. Call it from a user gesture. A failure in `onFrame`
 * is recorded in `errors`, since finding those is what the run is for; one that stops the session starting rejects.
 * A run with `native` false is a stand-in and proves no route (`xrRunGaps`).
 * @throws RangeError when `seconds` is not above 0.
 */
export async function runDeviceCheck(xr: DeviceCheckHost, options: DeviceCheckOptions = {}): Promise<XRRun> {
  const {
    mode = 'immersive-vr',
    seconds = 20,
    requiredFeatures,
    optionalFeatures = FEATURES,
    observe,
    signal,
    onFrame,
  } = options;
  if (!(seconds > 0) || !Number.isFinite(seconds))
    throw new RangeError('runDeviceCheck seconds must be above 0; pass the session length, such as 20');
  const gaps: number[] = [],
    inputs = new Map<XRInputSource, XRRun['inputs'][number]>(),
    errors: string[] = [],
    run: XRRun = {
      schema: 1,
      date: new Date().toISOString(),
      userAgent: globalThis.navigator?.userAgent ?? 'unknown',
      native: native(),
      mode,
      route: route(mode),
      features: [],
      views: 0,
      frames: 0,
      tracked: 0,
      emulated: 0,
      frameMs: { median: 0, p95: 0, max: 0 },
      inputs: [],
      endedEarly: false,
      errors,
    };
  let first: number | null = null,
    last: number | null = null,
    finish: () => void = () => {},
    timedOut = false;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const session = await xr.requestSession(mode, {
    ...(requiredFeatures && { requiredFeatures }),
    optionalFeatures,
    ...(signal && { signal }),
    onFrame(state) {
      run.frames++;
      if (last !== null) gaps.push(state.time - last);
      last = state.time;
      first ??= state.time;
      if (state.viewer) {
        run.tracked++;
        if (state.viewer.emulatedPosition) run.emulated++;
        run.views = Math.max(run.views, state.viewer.views.length);
      }
      for (const input of state.inputs) if (!inputs.has(input.source)) inputs.set(input.source, describe(input.source));
      try {
        onFrame?.(state);
      } catch (error) {
        errors.push(String(error));
      }
      if (state.time - first >= seconds * 1000) {
        timedOut = true;
        finish();
      }
    },
  });
  run.features = [...(session.enabledFeatures ?? [])];
  session.addEventListener('end', () => finish(), { once: true });
  const abort = (): void => finish();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) finish();
  await done;
  signal?.removeEventListener('abort', abort);
  run.endedEarly = !timedOut;
  await xr.end().catch((error: unknown) => errors.push(String(error)));
  signal?.throwIfAborted();
  const sorted = gaps.sort((a, b) => a - b);
  run.frameMs = { median: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), max: sorted.at(-1) ?? 0 };
  run.inputs = [...inputs.values()];
  if (observe) run.observed = await observe(run);
  const problems = checkXRRun(run);
  if (problems.length)
    throw margoError('failed', `The device run is not well formed (${problems.join('; ')}); report this as a bug`);
  return run;
}
