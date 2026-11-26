import { MargoError } from '@margoengine/math/errors';

const HELP = '; see https://margoengine.com/errors#webcam-landmarks';

// Face, hand and pose landmark frames from any detector, a webcam helper and the one-euro filter. Margo ships no
// trained weights and no detector: the app loads its own (MediaPipe Tasks, or anything that gives points) and passes its
// results in. Sources: docs/clean-room.md, "Webcam landmarks".

/** One tracked point. Image landmarks are normalised to the frame (x right, y down, 0..1); world ones are metres. */
export interface Landmark {
  x: number;
  y: number;
  z: number;
  /** Likelihood the point is visible, 0..1, when the detector reports it. */
  visibility?: number;
  /** Likelihood the point is in the frame, 0..1, when the detector reports it. */
  presence?: number;
}
/** One detected face. */
export interface FaceTrack {
  /** Face mesh points in the MediaPipe Face Landmarker order (468 or 478). */
  landmarks: Landmark[];
  /** Detector blendshape scores by ARKit name (`jawOpen`, `eyeBlinkLeft`, ...), when it gives them. */
  blendshapes?: Record<string, number>;
  /** Column-major 4x4 face transform, when the detector gives one. */
  transform?: ArrayLike<number>;
  /** Detection confidence 0..1. Default 1. */
  score?: number;
}
/** One detected hand, in the MediaPipe Hand Landmarker order (21 points, 0 the wrist). */
export interface HandTrack {
  landmarks: Landmark[];
  /** Metric points about the hand's centre, when the detector gives them. */
  worldLandmarks?: Landmark[];
  /** The subject's hand, as the detector labels it. */
  handedness: 'left' | 'right';
  /** Default 1. */
  score?: number;
}
/** One detected body, in the MediaPipe Pose Landmarker order (33 points, 0 the nose, 23 and 24 the hips). */
export interface PoseTrack {
  landmarks: Landmark[];
  /** Metric points about the hips' centre, when the detector gives them. */
  worldLandmarks?: Landmark[];
  /** Default 1. */
  score?: number;
}
/** Everything one detector pass saw. `time` is milliseconds on one clock (the video frame time). */
export interface LandmarkFrame {
  time: number;
  faces: FaceTrack[];
  hands: HandTrack[];
  poses: PoseTrack[];
}
/** An async iterator of frames that the consumer ends with `break`, the signal or `dispose`. */
export interface LandmarkSource extends AsyncIterable<LandmarkFrame>, Disposable {
  /** End the source; a waiting `next()` resolves done. */
  dispose(): void;
}

const check = (frame: LandmarkFrame): LandmarkFrame => {
  if (!frame || typeof frame !== 'object' || !Number.isFinite(frame.time))
    throw new TypeError('A landmark frame needs a finite time in ms and faces, hands and poses arrays' + HELP);
  for (const key of ['faces', 'hands', 'poses'] as const)
    if (!Array.isArray(frame[key]))
      throw new TypeError(`A landmark frame needs a ${key} array; pass [] for none` + HELP);
  return frame;
};

/** A pushable {@link LandmarkSource}. */
export interface LandmarkStream extends LandmarkSource {
  /** Queue a frame; frames past `buffer` drop the oldest. @throws MargoError `disposed` after the stream ended. */
  push(frame: LandmarkFrame): void;
  /** End the stream after the queued frames are read. */
  close(): void;
}
/** {@link landmarkStream} options. */
export interface LandmarkStreamOptions {
  /** Frames held for a slow reader; older ones are dropped, so a reader always sees the newest. Default 1. */
  buffer?: number;
  /** Ends the stream. */
  signal?: AbortSignal;
}
/**
 * A source the app pushes frames into, from a detector callback or a recording; `for await` reads them.
 * @throws RangeError unless `buffer` is a whole number of 1 or more.
 */
export function landmarkStream({ buffer = 1, signal }: LandmarkStreamOptions = {}): LandmarkStream {
  if (!Number.isInteger(buffer) || buffer < 1)
    throw new RangeError('landmarkStream buffer must be a whole number >= 1' + HELP);
  const queue: LandmarkFrame[] = [];
  let waiting: ((r: IteratorResult<LandmarkFrame>) => void) | undefined,
    closed = false,
    ended = false;
  const end = () => {
    ended = closed = true;
    queue.length = 0;
    signal?.removeEventListener('abort', end);
    waiting?.({ done: true, value: undefined });
    waiting = undefined;
  };
  if (signal?.aborted) ended = closed = true;
  else signal?.addEventListener('abort', end, { once: true });
  const stream: LandmarkStream = {
    push(frame) {
      if (closed) throw new MargoError('disposed', 'The landmark stream has ended; create a new landmarkStream' + HELP);
      check(frame);
      if (waiting) {
        waiting({ done: false, value: frame });
        waiting = undefined;
      } else {
        queue.push(frame);
        if (queue.length > buffer) queue.shift();
      }
    },
    close() {
      closed = true;
      if (!queue.length) end();
    },
    dispose: end,
    [Symbol.dispose]: end,
    [Symbol.asyncIterator]() {
      return {
        next: () => {
          if (queue.length) {
            const value = queue.shift()!;
            if (closed && !queue.length) end();
            return Promise.resolve({ done: false, value });
          }
          if (ended || closed) return Promise.resolve({ done: true, value: undefined });
          if (waiting)
            throw new MargoError('state', 'A landmark stream has one reader; await each next() in turn' + HELP);
          return new Promise((resolve) => (waiting = resolve));
        },
        return: () => {
          end();
          return Promise.resolve({ done: true, value: undefined });
        },
      };
    },
  };
  return stream;
}

// ---------------------------------------------------------------- MediaPipe Tasks adapter

interface MPCategory {
  categoryName?: string;
  score?: number;
}
/** The fields `fromMediaPipe` reads from MediaPipe Tasks Vision results (FaceLandmarker, HandLandmarker, PoseLandmarker). */
export interface MediaPipeResults {
  face?: {
    faceLandmarks: Landmark[][];
    faceBlendshapes?: { categories: MPCategory[] }[];
    facialTransformationMatrixes?: { data: ArrayLike<number> }[];
  };
  hands?: {
    landmarks: Landmark[][];
    worldLandmarks?: Landmark[][];
    /** Newer releases name it `handedness`, older ones `handednesses`. */
    handedness?: MPCategory[][];
    handednesses?: MPCategory[][];
  };
  pose?: { landmarks: Landmark[][]; worldLandmarks?: Landmark[][] };
}
/** {@link fromMediaPipe} options. */
export interface FromMediaPipeOptions {
  /**
   * Swap the hand labels. MediaPipe labels handedness as if the image were mirrored (a selfie view), so the default
   * true turns its `Left` into the subject's right for an unmirrored webcam frame. Default true.
   */
  mirroredHandedness?: boolean;
}
/**
 * One {@link LandmarkFrame} from MediaPipe Tasks results, so `detectForVideo` output plugs straight in.
 * @param time The same ms timestamp passed to `detectForVideo`.
 * @throws TypeError for a non-finite time or a result without its landmark arrays.
 */
export function fromMediaPipe(
  results: MediaPipeResults,
  time: number,
  { mirroredHandedness = true }: FromMediaPipeOptions = {},
): LandmarkFrame {
  const { face, hands, pose } = results ?? {};
  const list = <T>(value: T[] | undefined, name: string): T[] => {
    if (!Array.isArray(value))
      throw new TypeError(
        `MediaPipe ${name} result has no landmark arrays; pass the object the ${name} landmarker returned` + HELP,
      );
    return value;
  };
  const frame: LandmarkFrame = { time, faces: [], hands: [], poses: [] };
  if (face)
    list(face.faceLandmarks, 'face').forEach((landmarks, i) => {
      const categories = face.faceBlendshapes?.[i]?.categories;
      const track: FaceTrack = { landmarks };
      if (categories) {
        const blendshapes: Record<string, number> = {};
        for (const c of categories)
          if (c.categoryName && c.categoryName !== '_neutral') blendshapes[c.categoryName] = c.score ?? 0;
        track.blendshapes = blendshapes;
      }
      const matrix = face.facialTransformationMatrixes?.[i]?.data;
      if (matrix) track.transform = matrix;
      frame.faces.push(track);
    });
  if (hands) {
    const labels = hands.handedness ?? hands.handednesses ?? [];
    list(hands.landmarks, 'hand').forEach((landmarks, i) => {
      const best = labels[i]?.[0],
        left = /left/i.test(best?.categoryName ?? '') !== mirroredHandedness;
      const track: HandTrack = {
        landmarks,
        handedness: left ? 'left' : 'right',
        score: best?.score ?? 1,
      };
      if (hands.worldLandmarks?.[i]) track.worldLandmarks = hands.worldLandmarks[i];
      frame.hands.push(track);
    });
  }
  if (pose)
    list(pose.landmarks, 'pose').forEach((landmarks, i) => {
      const track: PoseTrack = { landmarks };
      if (pose.worldLandmarks?.[i]) track.worldLandmarks = pose.worldLandmarks[i];
      frame.poses.push(track);
    });
  return check(frame);
}

// ---------------------------------------------------------------- webcam

/** The parts of a video element the webcam helper uses; an HTMLVideoElement fits. */
export interface WebcamVideo {
  srcObject: unknown;
  muted: boolean;
  playsInline: boolean;
  readonly currentTime: number;
  play(): Promise<void>;
  pause(): void;
  requestVideoFrameCallback?(callback: (now: number, metadata: { mediaTime: number }) => void): number;
  cancelVideoFrameCallback?(handle: number): void;
}
/** A running webcam. */
export interface Webcam extends Disposable {
  readonly video: WebcamVideo;
  readonly stream: MediaStream;
  /** Stop the frame loop and every track; idempotent. */
  stop(): void;
}
/** {@link startWebcam} options. */
export interface WebcamOptions {
  /** Called once per new video frame with its time in ms (`requestVideoFrameCallback`, else animation frames). */
  onFrame?: (video: WebcamVideo, time: number) => void;
  /** Video element to play into. Default a new detached `<video>`. */
  video?: WebcamVideo;
  /** Video constraints. Default `{ facingMode: 'user', width: 640, height: 480 }`. */
  constraints?: MediaTrackConstraints;
  /** Cancels the start and, later, stops the webcam. */
  signal?: AbortSignal;
  /** Media devices to ask. Default `navigator.mediaDevices`. */
  mediaDevices?: Pick<MediaDevices, 'getUserMedia'>;
}
/**
 * Open the camera, play it into a video element and call `onFrame` once per new frame until stopped.
 * @throws MargoError `unsupported` without getUserMedia; DOMException from the browser (NotAllowedError) or AbortError.
 */
export async function startWebcam({
  onFrame,
  video,
  constraints = { facingMode: 'user', width: 640, height: 480 },
  signal,
  mediaDevices = globalThis.navigator?.mediaDevices,
}: WebcamOptions = {}): Promise<Webcam> {
  signal?.throwIfAborted();
  if (typeof mediaDevices?.getUserMedia !== 'function')
    throw new MargoError('unsupported', 'This page has no camera access (getUserMedia); serve it over https' + HELP);
  const stream = await mediaDevices.getUserMedia({
    video: constraints,
    audio: false,
  });
  const halt = () => stream.getTracks().forEach((track) => track.stop());
  if (signal?.aborted) {
    halt();
    throw signal.reason;
  }
  const element = video ?? (document.createElement('video') as WebcamVideo);
  element.muted = true;
  element.playsInline = true;
  element.srcObject = stream;
  try {
    await element.play();
    signal?.throwIfAborted();
  } catch (error) {
    halt();
    element.srcObject = null;
    throw error;
  }
  let stopped = false,
    handle = 0,
    last = -1;
  const byFrame = typeof element.requestVideoFrameCallback === 'function';
  const tick = (now: number) => {
    if (stopped) return;
    schedule();
    // Animation frames come faster than a camera; only a new picture counts as a frame.
    if (element.currentTime === last) return;
    last = element.currentTime;
    onFrame?.(element, now);
  };
  const schedule = () => {
    handle = byFrame ? element.requestVideoFrameCallback!(tick) : requestAnimationFrame(tick);
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    signal?.removeEventListener('abort', stop);
    if (byFrame) element.cancelVideoFrameCallback?.(handle);
    else cancelAnimationFrame(handle);
    halt();
    element.pause();
    element.srcObject = null;
  };
  signal?.addEventListener('abort', stop, { once: true });
  if (onFrame) schedule();
  return { video: element, stream, stop, [Symbol.dispose]: stop };
}

/** {@link webcamLandmarks} options. */
export interface WebcamLandmarksOptions extends Omit<WebcamOptions, 'onFrame'> {
  /**
   * The app's detector, run on each new frame: return a frame (for MediaPipe, `fromMediaPipe({ face:
   * landmarker.detectForVideo(video, time) }, time)`), or null to skip it.
   */
  detect: (video: WebcamVideo, time: number) => LandmarkFrame | null | undefined;
  /** See {@link LandmarkStreamOptions.buffer}. Default 1. */
  buffer?: number;
}
/**
 * The webcam as a {@link LandmarkSource}: each new video frame goes through the app's detector. Ending the source stops
 * the camera. A detector that throws ends the source and the error comes out of the next read.
 */
export async function webcamLandmarks({
  detect,
  buffer,
  ...options
}: WebcamLandmarksOptions): Promise<LandmarkSource & { readonly webcam: Webcam }> {
  if (typeof detect !== 'function') throw new TypeError('webcamLandmarks needs a detect(video, time) function' + HELP);
  const stream = landmarkStream({ buffer, signal: options.signal });
  let failure: unknown, webcam: Webcam | undefined;
  function stop() {
    webcam?.stop();
    stream.dispose();
  }
  webcam = await startWebcam({
    ...options,
    onFrame(video, time) {
      try {
        const frame = detect(video, time);
        if (frame) stream.push(frame);
      } catch (error) {
        failure = error;
        stop();
      }
    },
  });
  return {
    webcam,
    dispose: stop,
    [Symbol.dispose]: stop,
    [Symbol.asyncIterator]() {
      const inner = stream[Symbol.asyncIterator]();
      return {
        next: async () => {
          const result = await inner.next();
          if (result.done && failure !== undefined) {
            const error = failure;
            failure = undefined;
            throw error;
          }
          return result;
        },
        return: () => {
          stop();
          return Promise.resolve({ done: true, value: undefined });
        },
      };
    },
  };
}

// ---------------------------------------------------------------- one-euro filter

/** {@link OneEuroFilter} settings. */
export interface OneEuroOptions {
  /** Cutoff in Hz at rest: lower removes more jitter when still. Default 1. */
  minCutoff?: number;
  /** How fast the cutoff rises with speed: higher removes more lag when moving. Default 0.007. */
  beta?: number;
  /** Cutoff in Hz for the speed estimate. Default 1. */
  dCutoff?: number;
}
const alpha = (cutoff: number, dt: number) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));
/**
 * The one-euro filter (Casiez, Roussel and Vogel, CHI 2012): a low-pass filter whose cutoff rises with the signal's
 * speed, so it removes jitter when still and lag when moving. One instance filters one scalar.
 * @throws RangeError for a cutoff that is not above 0 or a negative beta.
 */
export class OneEuroFilter {
  readonly minCutoff: number;
  readonly beta: number;
  readonly dCutoff: number;
  private x = NaN;
  private dx = 0;
  private t = NaN;
  constructor({ minCutoff = 1, beta = 0.007, dCutoff = 1 }: OneEuroOptions = {}) {
    if (!(minCutoff > 0) || !(dCutoff > 0) || !Number.isFinite(minCutoff + dCutoff))
      throw new RangeError('OneEuroFilter cutoffs must be finite and above 0 Hz' + HELP);
    if (!(beta >= 0) || !Number.isFinite(beta))
      throw new RangeError('OneEuroFilter beta must be finite and >= 0' + HELP);
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
  }
  /**
   * Filter `value` sampled at `time` seconds; the first sample (or one at or before the last time) passes through.
   * @throws RangeError for a non-finite value or time.
   */
  filter(value: number, time: number): number {
    if (!Number.isFinite(value) || !Number.isFinite(time))
      throw new RangeError('OneEuroFilter needs a finite value and time' + HELP);
    const dt = time - this.t;
    if (!(dt > 0)) {
      if (Number.isNaN(this.x)) this.x = value;
      this.t = Number.isNaN(this.t) ? time : this.t;
      return this.x;
    }
    this.dx += alpha(this.dCutoff, dt) * ((value - this.x) / dt - this.dx);
    this.x += alpha(this.minCutoff + this.beta * Math.abs(this.dx), dt) * (value - this.x);
    this.t = time;
    return this.x;
  }
  /** Forget the history; the next sample passes through. */
  reset(): void {
    this.x = this.t = NaN;
    this.dx = 0;
  }
}
