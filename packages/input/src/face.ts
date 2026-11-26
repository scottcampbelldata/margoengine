import { MargoError } from '@margoengine/math/errors';
import { Quaternion } from '@margoengine/math/quaternion';
import {
  OneEuroFilter,
  type FaceTrack,
  type Landmark,
  type LandmarkFrame,
  type LandmarkSource,
  type OneEuroOptions,
} from './landmarks.js';

const HELP = '; see https://margoengine.com/errors#face-driver';

// Face landmarks or detector blendshape scores to ARKit-named morph target weights and a head rotation. Sources:
// docs/clean-room.md, "Webcam landmarks". ARKit is a trademark of Apple Inc.; only its published shape names are used.

/** The 52 ARKit face blendshape names (Apple, ARFaceAnchor.BlendShapeLocation), the names face rigs search for. */
export const ARKIT_BLENDSHAPES = [
  'browDownLeft',
  'browDownRight',
  'browInnerUp',
  'browOuterUpLeft',
  'browOuterUpRight',
  'cheekPuff',
  'cheekSquintLeft',
  'cheekSquintRight',
  'eyeBlinkLeft',
  'eyeBlinkRight',
  'eyeLookDownLeft',
  'eyeLookDownRight',
  'eyeLookInLeft',
  'eyeLookInRight',
  'eyeLookOutLeft',
  'eyeLookOutRight',
  'eyeLookUpLeft',
  'eyeLookUpRight',
  'eyeSquintLeft',
  'eyeSquintRight',
  'eyeWideLeft',
  'eyeWideRight',
  'jawForward',
  'jawLeft',
  'jawOpen',
  'jawRight',
  'mouthClose',
  'mouthDimpleLeft',
  'mouthDimpleRight',
  'mouthFrownLeft',
  'mouthFrownRight',
  'mouthFunnel',
  'mouthLeft',
  'mouthLowerDownLeft',
  'mouthLowerDownRight',
  'mouthPressLeft',
  'mouthPressRight',
  'mouthPucker',
  'mouthRight',
  'mouthRollLower',
  'mouthRollUpper',
  'mouthShrugLower',
  'mouthShrugUpper',
  'mouthSmileLeft',
  'mouthSmileRight',
  'mouthStretchLeft',
  'mouthStretchRight',
  'mouthUpperUpLeft',
  'mouthUpperUpRight',
  'noseSneerLeft',
  'noseSneerRight',
  'tongueOut',
] as const;
/** One ARKit blendshape name. */
export type ARKitBlendshape = (typeof ARKIT_BLENDSHAPES)[number];
/** The shapes {@link faceWeightsFromLandmarks} measures from points alone; a detector's scores give all 52. */
export const LANDMARK_BLENDSHAPES: readonly ARKitBlendshape[] = [
  'eyeBlinkLeft',
  'eyeBlinkRight',
  'eyeWideLeft',
  'eyeWideRight',
  'jawOpen',
  'mouthSmileLeft',
  'mouthSmileRight',
  'mouthFrownLeft',
  'mouthFrownRight',
  'mouthPucker',
  'browInnerUp',
  'browDownLeft',
  'browDownRight',
  'browOuterUpLeft',
  'browOuterUpRight',
];

/** A mesh primitive with named morph targets; a glTF model's primitives fit. */
export interface MorphPrimitive {
  readonly targetNames: readonly string[];
  readonly weights: { [index: number]: number; readonly length: number };
}
/** Something holding morph primitives; a `PBRModel` from `@margoengine/gltf` fits. */
export interface MorphHost {
  readonly primitives: readonly MorphPrimitive[];
}

// Face mesh indices (MediaPipe Face Landmarker topology, from its published landmark map). "Left" is the subject's.
const EYE_R = [33, 133, 159, 145, 158, 153],
  EYE_L = [263, 362, 386, 374, 385, 380],
  LIP_UP = 13,
  LIP_DOWN = 14,
  CORNER_R = 61,
  CORNER_L = 291,
  TOP = 10,
  CHIN = 152,
  BROW_IN_R = 107,
  BROW_IN_L = 336,
  BROW_OUT_R = 70,
  BROW_OUT_L = 300;
const LANDMARK_COUNT = 468;

/** The raw face measures, all scale-free. */
export interface FaceMeasures {
  /** Eye aspect ratio (Soukupova and Cech 2016) per eye. */
  eyeLeft: number;
  eyeRight: number;
  /** Inner lip gap over face height. */
  mouthOpen: number;
  /** Mouth corner distance over outer-eye distance. */
  mouthWidth: number;
  /** Corner height above the upper lip's middle over face height, per side (the jaw does not move it). */
  cornerLeft: number;
  cornerRight: number;
  /** Brow height above the eye top over face height. */
  browInnerLeft: number;
  browInnerRight: number;
  browOuterLeft: number;
  browOuterRight: number;
}
/** Typical neutral measures, used until {@link FaceDriver.calibrate}. */
export const NEUTRAL_FACE: Readonly<FaceMeasures> = Object.freeze({
  eyeLeft: 0.28,
  eyeRight: 0.28,
  mouthOpen: 0.005,
  mouthWidth: 0.6,
  cornerLeft: 0,
  cornerRight: 0,
  browInnerLeft: 0.07,
  browInnerRight: 0.07,
  browOuterLeft: 0.07,
  browOuterRight: 0.07,
});

const points = (landmarks: readonly Landmark[]): readonly Landmark[] => {
  if (!Array.isArray(landmarks) || landmarks.length < LANDMARK_COUNT)
    throw new RangeError(
      `Face landmarks need the ${LANDMARK_COUNT} or 478 points of the Face Landmarker topology` + HELP,
    );
  return landmarks;
};
/**
 * Scale-free measures of a face mesh. `aspect` is the frame's width over height (normalised x and y have different
 * units unless it is given). @throws RangeError for fewer than 468 points.
 */
export function measureFace(landmarks: readonly Landmark[], aspect = 1): FaceMeasures {
  const p = points(landmarks);
  const d = (a: number, b: number) =>
    Math.hypot((p[a].x - p[b].x) * aspect, p[a].y - p[b].y, (p[a].z - p[b].z) * aspect);
  const ear = ([o, i, u1, l1, u2, l2]: number[]) => (d(u1, l1) + d(u2, l2)) / (2 * d(o, i) || 1);
  const h = d(TOP, CHIN) || 1,
    upper = p[LIP_UP].y,
    eyeTopL = p[EYE_L[2]].y,
    eyeTopR = p[EYE_R[2]].y;
  return {
    eyeLeft: ear(EYE_L),
    eyeRight: ear(EYE_R),
    mouthOpen: d(LIP_UP, LIP_DOWN) / h,
    mouthWidth: d(CORNER_L, CORNER_R) / (d(EYE_L[0], EYE_R[0]) || 1),
    cornerLeft: (upper - p[CORNER_L].y) / h,
    cornerRight: (upper - p[CORNER_R].y) / h,
    browInnerLeft: (eyeTopL - p[BROW_IN_L].y) / h,
    browInnerRight: (eyeTopR - p[BROW_IN_R].y) / h,
    browOuterLeft: (eyeTopL - p[BROW_OUT_L].y) / h,
    browOuterRight: (eyeTopR - p[BROW_OUT_R].y) / h,
  };
}

// NaN stays NaN, so a bad input is seen (and held over) rather than read as 0.
const clamp01 = (v: number) => (v > 0 ? (v < 1 ? v : 1) : v <= 0 ? 0 : Number.NaN);
/**
 * ARKit weights 0..1 for {@link LANDMARK_BLENDSHAPES} from a face mesh, against a neutral face (default
 * {@link NEUTRAL_FACE}; pass a calibrated one for a real person). Each weight is the change of one measure from neutral
 * over a typical full range (the eye closes at 35% of its open aspect ratio, the jaw opens 15% of the face height).
 */
export function faceWeightsFromLandmarks(
  landmarks: readonly Landmark[],
  neutral: Readonly<FaceMeasures> = NEUTRAL_FACE,
  aspect = 1,
): Record<string, number> {
  const m = measureFace(landmarks, aspect),
    n = neutral;
  const blink = (e: number, o: number) => clamp01((o - e) / (o * 0.65)),
    wide = (e: number, o: number) => clamp01((e - o) / (o * 0.4)),
    widthTerm = (m.mouthWidth - n.mouthWidth) / 0.15,
    smile = (lift: number) => clamp01(0.5 * widthTerm + 0.5 * (lift / 0.03)),
    brow = (h: number, o: number) => (h - o) / 0.03;
  const liftL = m.cornerLeft - n.cornerLeft,
    liftR = m.cornerRight - n.cornerRight,
    inner = (brow(m.browInnerLeft, n.browInnerLeft) + brow(m.browInnerRight, n.browInnerRight)) / 2;
  return {
    eyeBlinkLeft: blink(m.eyeLeft, n.eyeLeft),
    eyeBlinkRight: blink(m.eyeRight, n.eyeRight),
    eyeWideLeft: wide(m.eyeLeft, n.eyeLeft),
    eyeWideRight: wide(m.eyeRight, n.eyeRight),
    jawOpen: clamp01((m.mouthOpen - n.mouthOpen) / 0.15),
    mouthSmileLeft: smile(liftL),
    mouthSmileRight: smile(liftR),
    mouthFrownLeft: clamp01(-liftL / 0.02),
    mouthFrownRight: clamp01(-liftR / 0.02),
    mouthPucker: clamp01(-widthTerm * 0.75),
    browInnerUp: clamp01(inner),
    browDownLeft: clamp01(-brow(m.browInnerLeft, n.browInnerLeft) * 1.5),
    browDownRight: clamp01(-brow(m.browInnerRight, n.browInnerRight) * 1.5),
    browOuterUpLeft: clamp01(brow(m.browOuterLeft, n.browOuterLeft)),
    browOuterUpRight: clamp01(brow(m.browOuterRight, n.browOuterRight)),
  };
}

type Quat = [number, number, number, number];
/**
 * Head rotation [x, y, z, w] of a face mesh, in a y-up frame where an unturned face looks along +z (toward the camera)
 * with its left at +x: x from the right to the left outer eye corner, y from the chin to the forehead.
 */
export function headRotation(landmarks: readonly Landmark[], aspect = 1): Quat {
  const p = points(landmarks);
  const v = (i: number) => [p[i].x * aspect, -p[i].y, -p[i].z * aspect];
  const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const unit = (a: number[]) => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  };
  const x = unit(sub(v(EYE_L[0]), v(EYE_R[0]))),
    up = sub(v(TOP), v(CHIN)),
    k = up[0] * x[0] + up[1] * x[1] + up[2] * x[2],
    y = unit([up[0] - k * x[0], up[1] - k * x[1], up[2] - k * x[2]]),
    z = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
  return matrixRotation([...x, 0, ...y, 0, ...z, 0, 0, 0, 0, 1]);
}
const matrixRotation = (m: ArrayLike<number>): Quat => {
  const q = new Quaternion().setFromRotationMatrix({ elements: m } as never);
  return [q.x, q.y, q.z, q.w];
};
const multiply = (a: Quat, b: Quat): Quat => {
  const q = new Quaternion(...a).multiply({
    x: b[0],
    y: b[1],
    z: b[2],
    w: b[3],
  });
  return [q.x, q.y, q.z, q.w];
};

/** {@link FaceDriver} options; every one is optional. */
export interface FaceDriverOptions {
  /** ARKit name to the model's morph target name, for rigs that name shapes their own way. Default the ARKit names. */
  names?: Partial<Record<ARKitBlendshape, string>>;
  /** Where weights come from: detector scores, landmark measures, or scores when present else landmarks. Default 'auto'. */
  source?: 'auto' | 'blendshapes' | 'landmarks';
  /** Faces below this detection score are not trusted and the last good value is held. Default 0.5. */
  minScore?: number;
  /** Seconds the last good value is held through lost tracking before easing back to neutral. Default 0.5. */
  hold?: number;
  /** One-euro filter on weights and head rotation, or false for raw values. Default `{ minCutoff: 1.5, beta: 0.5 }`. */
  smoothing?: OneEuroOptions | false;
  /** Swap left and right, for a mirrored (selfie) picture. Default false. */
  mirror?: boolean;
  /** Frame width over height, for landmark measures. Default 1. */
  aspect?: number;
}
/** The driver's latest result. */
export interface FaceState {
  /** ARKit name to weight 0..1 (detector scores give all 52, landmarks {@link LANDMARK_BLENDSHAPES}). */
  readonly weights: Readonly<Record<string, number>>;
  /** Head rotation [x, y, z, w] relative to the calibrated face (identity looks at the camera). */
  readonly rotation: Readonly<Quat>;
  /** False once tracking has been lost for longer than `hold`. */
  readonly tracked: boolean;
  /** Frame time in ms. */
  readonly time: number;
}
const swap = (name: string) => (/Left$/.test(name) ? name.replace(/Left$/, 'Right') : name.replace(/Right$/, 'Left'));

/**
 * Drives ARKit-named morph targets from face frames: detector blendshape scores, or landmark measures (eye aspect
 * ratio, jaw opening, mouth width and corners, brow height), smoothed by the one-euro filter, gated on the detection
 * score and calibrated on a neutral face; also gives the head rotation.
 */
export class FaceDriver implements Disposable {
  private readonly options: Required<Omit<FaceDriverOptions, 'smoothing' | 'names'>> & {
    smoothing: OneEuroOptions | false;
  };
  private readonly lookup = new Map<string, string>();
  private readonly maps = new WeakMap<MorphPrimitive, (string | undefined)[]>();
  private readonly filters = new Map<string, OneEuroFilter>();
  private neutral: Readonly<FaceMeasures> = NEUTRAL_FACE;
  private neutralScores: Record<string, number> = {};
  private neutralRotation: Quat = [0, 0, 0, 1];
  private lastGood = -Infinity;
  private current: FaceState = {
    weights: {},
    rotation: [0, 0, 0, 1],
    tracked: false,
    time: 0,
  };
  private disposed = false;
  /** @throws RangeError for an unknown source, a negative hold, a minScore outside 0..1 or an aspect not above 0. */
  constructor(options: FaceDriverOptions = {}) {
    const {
      source = 'auto',
      minScore = 0.5,
      hold = 0.5,
      smoothing = { minCutoff: 1.5, beta: 0.5 },
      mirror = false,
      aspect = 1,
      names = {},
    } = options;
    if (!['auto', 'blendshapes', 'landmarks'].includes(source))
      throw new RangeError(`Face source ${String(source)} must be auto, blendshapes or landmarks` + HELP);
    if (!(minScore >= 0 && minScore <= 1)) throw new RangeError('Face minScore must be in 0..1' + HELP);
    if (!(hold >= 0)) throw new RangeError('Face hold must be seconds >= 0' + HELP);
    if (!(aspect > 0) || !Number.isFinite(aspect))
      throw new RangeError('Face aspect must be a finite width / height above 0' + HELP);
    if (smoothing) new OneEuroFilter(smoothing);
    this.options = { source, minScore, hold, smoothing, mirror, aspect };
    for (const name of ARKIT_BLENDSHAPES)
      this.lookup.set(((names as Record<string, string>)[name] ?? name).toLowerCase(), name);
  }
  /** The latest result. */
  get state(): FaceState {
    return this.current;
  }
  private track(input: LandmarkFrame | FaceTrack | null | undefined): FaceTrack | undefined {
    if (this.disposed) throw new MargoError('disposed', 'The face driver is disposed; create a new FaceDriver' + HELP);
    return input && 'faces' in input ? input.faces[0] : (input ?? undefined);
  }
  private raw(face: FaceTrack): {
    weights: Record<string, number>;
    rotation: Quat;
  } {
    const { source, aspect } = this.options;
    const scores = face.blendshapes && source !== 'landmarks';
    if (source === 'blendshapes' && !face.blendshapes)
      throw new MargoError(
        'state',
        'The face has no detector blendshape scores; enable them in the detector or use source landmarks' + HELP,
      );
    let weights: Record<string, number>;
    if (scores) {
      weights = {};
      for (const name of ARKIT_BLENDSHAPES) {
        const v = face.blendshapes![name];
        if (v === undefined) continue;
        const n = this.neutralScores[name] ?? 0;
        // NaN passes through so update() can hold the last good weight.
        weights[name] = Number.isFinite(v) ? clamp01(n < 1 ? (v - n) / (1 - n) : 0) : Number.NaN;
      }
    } else weights = faceWeightsFromLandmarks(face.landmarks, this.neutral, aspect);
    let rotation: Quat;
    if (face.transform) {
      const m = face.transform,
        col = (c: number) => {
          const l = Math.hypot(m[c * 4], m[c * 4 + 1], m[c * 4 + 2]) || 1;
          return [m[c * 4] / l, m[c * 4 + 1] / l, m[c * 4 + 2] / l, 0];
        };
      rotation = matrixRotation([...col(0), ...col(1), ...col(2), 0, 0, 0, 1]);
    } else rotation = headRotation(face.landmarks, aspect);
    return { weights, rotation };
  }
  /**
   * Take this face (or the frame's first face) as the neutral pose: relaxed, eyes open, looking at the camera.
   * @throws MargoError `state` without a face.
   */
  calibrate(input: LandmarkFrame | FaceTrack): this {
    const face = this.track(input);
    if (!face)
      throw new MargoError(
        'state',
        'Calibrate on a frame with a face in it; pass a frame the detector found a face in' + HELP,
      );
    if (face.landmarks?.length >= LANDMARK_COUNT) this.neutral = measureFace(face.landmarks, this.options.aspect);
    this.neutralScores = { ...(face.blendshapes ?? {}) };
    const r = this.raw(face).rotation;
    this.neutralRotation = [-r[0], -r[1], -r[2], r[3]];
    for (const f of this.filters.values()) f.reset();
    return this;
  }
  /**
   * Read one frame (its first face) or one face. `time` (ms) defaults to the frame's. No face, or a score under
   * `minScore`, holds the last good result for `hold` seconds and then eases to neutral.
   * @throws MargoError `disposed` after dispose.
   */
  update(
    input: LandmarkFrame | FaceTrack | null | undefined,
    time = input && 'time' in input ? input.time : this.current.time,
  ): FaceState {
    const face = this.track(input),
      { minScore, hold, smoothing, mirror } = this.options,
      t = time / 1000;
    if (!face || (face.score ?? 1) < minScore) {
      if (t - this.lastGood <= hold) return (this.current = { ...this.current, time });
      const relaxed = smoothing
        ? this.smooth({}, [0, 0, 0, 1], t, true)
        : { weights: {}, rotation: [0, 0, 0, 1] as Quat };
      return (this.current = { ...relaxed, tracked: false, time });
    }
    let { weights, rotation } = this.raw(face);
    rotation = multiply(rotation, this.neutralRotation);
    if (mirror) {
      weights = Object.fromEntries(Object.entries(weights).map(([k, v]) => [swap(k), v]));
      rotation = [rotation[0], -rotation[1], -rotation[2], rotation[3]];
    }
    // A non-finite score or point keeps the last good value instead of reaching the filters and the morph targets.
    for (const [name, v] of Object.entries(weights))
      if (!Number.isFinite(v)) {
        const last = this.current.weights[name];
        if (last === undefined) delete weights[name];
        else weights[name] = last;
      }
    if (!rotation.every(Number.isFinite)) rotation = [...this.current.rotation] as Quat;
    if (smoothing) ({ weights, rotation } = this.smooth(weights, rotation, t, false));
    this.lastGood = t;
    return (this.current = { weights, rotation, tracked: true, time });
  }
  private smooth(weights: Record<string, number>, rotation: Quat, t: number, relax: boolean) {
    const out: Record<string, number> = {},
      filter = (key: string, v: number) => {
        let f = this.filters.get(key);
        if (!f) this.filters.set(key, (f = new OneEuroFilter(this.options.smoothing as OneEuroOptions)));
        return f.filter(v, t);
      };
    const names = relax ? Object.keys(this.current.weights) : Object.keys(weights);
    for (const name of names) out[name] = clamp01(filter(name, weights[name] ?? 0));
    const prev = this.current.rotation;
    // q and -q are one rotation; filter the one nearer the last so the components stay continuous.
    if (prev[0] * rotation[0] + prev[1] * rotation[1] + prev[2] * rotation[2] + prev[3] * rotation[3] < 0)
      rotation = [-rotation[0], -rotation[1], -rotation[2], -rotation[3]];
    const q = rotation.map((v, i) => filter('q' + i, v)) as Quat,
      l = Math.hypot(...q) || 1;
    return { weights: out, rotation: q.map((v) => v / l) as Quat };
  }
  /**
   * Write the latest weights to every morph target whose name (case-insensitive, through `names`) is an ARKit shape;
   * targets of shapes this frame did not measure are left as they are.
   */
  apply(target: MorphHost | readonly MorphHost[]): this {
    if (this.disposed) throw new MargoError('disposed', 'The face driver is disposed; create a new FaceDriver' + HELP);
    const weights = this.current.weights;
    const hosts: readonly MorphHost[] =
      'primitives' in target ? [target as MorphHost] : (target as readonly MorphHost[]);
    for (const host of hosts)
      for (const primitive of host.primitives) {
        let map: (string | undefined)[] | undefined = this.maps.get(primitive);
        if (!map) {
          map = primitive.targetNames.map((n) => this.lookup.get(String(n).toLowerCase()));
          this.maps.set(primitive, map);
        }
        for (let i = 0; i < map.length && i < primitive.weights.length; i++) {
          const name = map[i];
          if (name !== undefined && weights[name] !== undefined) primitive.weights[i] = weights[name];
        }
      }
    return this;
  }
  /**
   * Update from every frame of `source` and apply to `target` until the source ends or `signal` aborts.
   * @param onUpdate Called after each frame is applied, for the head bone or a UI.
   */
  async drive(
    source: LandmarkSource,
    target: MorphHost | readonly MorphHost[],
    { signal, onUpdate }: { signal?: AbortSignal; onUpdate?: (state: FaceState) => void } = {},
  ): Promise<void> {
    signal?.throwIfAborted();
    const stop = () => source.dispose();
    signal?.addEventListener('abort', stop, { once: true });
    try {
      for await (const frame of source) {
        if (this.disposed) break;
        this.update(frame);
        this.apply(target);
        onUpdate?.(this.current);
      }
    } finally {
      signal?.removeEventListener('abort', stop);
    }
    signal?.throwIfAborted();
  }
  /** Release the driver; later calls throw. */
  dispose(): void {
    this.disposed = true;
    this.filters.clear();
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}
