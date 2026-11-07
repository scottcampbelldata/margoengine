/** One browser and device route a real run must cover before XR counts as run on hardware. */
export interface XRRunTarget {
  /** Stable name of the route. */
  readonly id: string;
  readonly mode: 'immersive-vr' | 'immersive-ar';
  readonly route: 'webgpu' | 'webgl2';
  /** What the run needs, in words. */
  readonly needs: string;
}
/** What the tester saw, answered by a person after the session. */
export interface XRRunObserved {
  /** The scene stood still in the room while the head moved, in the right place for each eye. */
  scene: boolean;
  /** Moving the head moved the view at once, with no jumps. */
  tracking: boolean;
  /** A controller, hand or tap was seen and reacted. */
  input: boolean;
  /** Leaving the session gave the page back. */
  exit: boolean;
}
/** What `runDeviceCheck` writes: one session on one device. */
export interface XRRun {
  schema: 1;
  /** ISO date of the run. */
  date: string;
  userAgent: string;
  /** True when `navigator.xr.requestSession` is the browser's own code. A stand-in written in JavaScript cannot set it. */
  native: boolean;
  mode: 'inline' | 'immersive-vr' | 'immersive-ar';
  route: 'webgpu' | 'webgl2' | 'none';
  /** The session's `enabledFeatures`, or empty where the browser does not list them. */
  features: string[];
  /** Largest number of views in one frame: 2 on a headset, 1 on a phone. */
  views: number;
  frames: number;
  /** Frames with a viewer pose. */
  tracked: number;
  /** Frames whose viewer pose was estimated, as on a headset with no position tracking. */
  emulated: number;
  /** Time between frames in milliseconds: the median, the 95th percentile and the longest. */
  frameMs: { median: number; p95: number; max: number };
  /** Every input source seen in the session. */
  inputs: {
    handedness: string;
    targetRayMode: string;
    profiles: string[];
    hand: boolean;
    buttons: number;
    axes: number;
  }[];
  /** True when the session ended before the check's time was up: the headset came off, or the browser stopped it. */
  endedEarly: boolean;
  /** Messages of everything that went wrong. */
  errors: string[];
  observed?: XRRunObserved;
}
/** The routes a real run must cover. */
export const XR_RUN_TARGETS: readonly XRRunTarget[];
/** Shortest run that counts: frames of a session with a viewer pose. */
export const XR_RUN_MIN_FRAMES: number;
/** What is wrong with `run`'s shape: an empty list for a well-formed run. */
export function checkXRRun(run: unknown): string[];
/** Why `run` does not prove `target`: an empty list when it does. */
export function xrRunGaps(run: XRRun, target: XRRunTarget): string[];
