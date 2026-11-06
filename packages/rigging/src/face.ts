// Face tracking onto a character. Trackers such as Apple's ARKit, Google's MediaPipe Face Landmarker and Live Link Face
// report the same 52 coefficients from 0 to 1, one per facial movement. This entry reads a frame in any of their
// shapes, smooths it, and drives what a character has: morph targets found by their names, or a VRM avatar's expressions.
// The 52 names are Apple's published ARFaceAnchor.BlendShapeLocation identifiers.
import { MargoError } from '@margoengine/math/errors';
import type { Animator } from '@margoengine/animator';
import type { VRMHandle } from './vrm.js';

/** The 52 face shapes, in the order of Apple's documentation. Left and right are the face's own. */
export const FACE_SHAPES = [
  'eyeBlinkLeft',
  'eyeLookDownLeft',
  'eyeLookInLeft',
  'eyeLookOutLeft',
  'eyeLookUpLeft',
  'eyeSquintLeft',
  'eyeWideLeft',
  'eyeBlinkRight',
  'eyeLookDownRight',
  'eyeLookInRight',
  'eyeLookOutRight',
  'eyeLookUpRight',
  'eyeSquintRight',
  'eyeWideRight',
  'jawForward',
  'jawLeft',
  'jawRight',
  'jawOpen',
  'mouthClose',
  'mouthFunnel',
  'mouthPucker',
  'mouthLeft',
  'mouthRight',
  'mouthSmileLeft',
  'mouthSmileRight',
  'mouthFrownLeft',
  'mouthFrownRight',
  'mouthDimpleLeft',
  'mouthDimpleRight',
  'mouthStretchLeft',
  'mouthStretchRight',
  'mouthRollLower',
  'mouthRollUpper',
  'mouthShrugLower',
  'mouthShrugUpper',
  'mouthPressLeft',
  'mouthPressRight',
  'mouthLowerDownLeft',
  'mouthLowerDownRight',
  'mouthUpperUpLeft',
  'mouthUpperUpRight',
  'browDownLeft',
  'browDownRight',
  'browInnerUp',
  'browOuterUpLeft',
  'browOuterUpRight',
  'cheekPuff',
  'cheekSquintLeft',
  'cheekSquintRight',
  'noseSneerLeft',
  'noseSneerRight',
  'tongueOut',
] as const;

/** One of the {@link FACE_SHAPES}. */
export type FaceShape = (typeof FACE_SHAPES)[number];

/**
 * One tracker frame: a record of shape names to values, or a list of `{ categoryName, score }` as MediaPipe's
 * `faceBlendshapes[0].categories` gives. Names need not match exactly (see {@link faceShapeOf}); others are ignored.
 */
export type FaceFrame = Readonly<Record<string, number>> | readonly { categoryName: string; score: number }[];

/** Options of {@link FaceMapper}. */
export interface FaceMapperOptions {
  /** Time constant of the smoothing, seconds; 0 follows the tracker exactly (default 0.05). */
  smoothing?: number;
  /** Multiplies values before they clamp to 0 to 1: one number for all, or per shape, the rest at 1 (default 1). */
  gain?: number | Partial<Record<FaceShape, number>>;
  /** Swaps left and right, for a tracker fed by a mirrored camera (default false). */
  mirror?: boolean;
}

const INDEX = new Map<string, number>(FACE_SHAPES.map((shape, i) => [shape, i]));
const fold = (name: string): string => name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
/** Folded spellings, longest first: `eyeblinkleft`, and `eyeblinkl` for names such as `eyeBlink_L`. */
const SPELLINGS: readonly (readonly [string, FaceShape])[] = FACE_SHAPES.flatMap((shape) => {
  const folded = fold(shape),
    short = folded.replace(/left$/, 'l').replace(/right$/, 'r');
  return short === folded
    ? [[folded, shape] as const]
    : [[folded, shape] as const, [short, shape] as const];
}).sort((a, b) => b[0].length - a[0].length);

/**
 * The face shape a name stands for, or null. Ignores case, separators and anything before the shape, so
 * `EyeBlinkLeft`, `eye_blink_left`, `eyeBlink_L` and `blendShape1.ARKit_eyeBlinkLeft` all read as `eyeBlinkLeft`.
 */
export function faceShapeOf(name: string): FaceShape | null {
  if (INDEX.has(name)) return name as FaceShape;
  const folded = fold(name);
  for (const [spelling, shape] of SPELLINGS) if (folded.endsWith(spelling)) return shape;
  return null;
}

/** The shape on the other side of the face; a shape with no side is itself. */
function across(shape: FaceShape): FaceShape {
  const other = shape.endsWith('Left')
    ? `${shape.slice(0, -4)}Right`
    : shape.endsWith('Right')
      ? `${shape.slice(0, -5)}Left`
      : shape;
  return other as FaceShape;
}

const MIRRORED = FACE_SHAPES.map((shape) => INDEX.get(across(shape))!);

const clamp = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * A tracker's frames as smoothed shape values, plain data with no engine: {@link addFace} runs one on a model. Settings
 * can be changed between frames.
 */
export class FaceMapper {
  /** The 52 current values, in {@link FACE_SHAPES} order. */
  readonly values = new Float32Array(FACE_SHAPES.length);
  /** Seconds; see {@link FaceMapperOptions.smoothing}. */
  smoothing: number;
  /** See {@link FaceMapperOptions.gain}. */
  gain: number | Partial<Record<FaceShape, number>>;
  /** See {@link FaceMapperOptions.mirror}. */
  mirror: boolean;
  private readonly target = new Float32Array(FACE_SHAPES.length);

  constructor(options: FaceMapperOptions = {}) {
    this.smoothing = options.smoothing ?? 0.05;
    this.gain = options.gain ?? 1;
    this.mirror = options.mirror ?? false;
    this.check();
  }

  private check(): void {
    const { smoothing, gain } = this;
    if (!(smoothing >= 0 && smoothing < Infinity)) throw new RangeError('Face smoothing must be 0 or more seconds');
    if (typeof gain === 'number') {
      if (!(gain >= 0 && gain < Infinity)) throw new RangeError('Face gain must be finite and 0 or more');
    } else if (gain === null || typeof gain !== 'object') throw new TypeError('Face gain must be a number or a record');
    else
      for (const [shape, value] of Object.entries(gain)) {
        if (!INDEX.has(shape)) throw new RangeError(`Face gain names ${shape}; use a name from FACE_SHAPES`);
        if (!(value >= 0 && value < Infinity)) throw new RangeError(`Face gain of ${shape} must be finite and 0 or more`);
      }
  }

  private take(name: string, value: number): void {
    const shape = faceShapeOf(name);
    if (shape === null) return;
    if (!Number.isFinite(value)) throw new RangeError(`Face value of ${name} must be finite`);
    const gain = typeof this.gain === 'number' ? this.gain : (this.gain[shape] ?? 1),
      i = INDEX.get(shape)!;
    this.target[this.mirror ? MIRRORED[i] : i] = clamp(value * gain);
  }

  /** Takes a tracker's latest frame; shapes it leaves out hold their value. Pass null when tracking is lost: all go to 0. */
  push(frame: FaceFrame | null): this {
    this.check();
    if (frame === null) this.target.fill(0);
    else if (Array.isArray(frame))
      for (const entry of frame as readonly { categoryName: string; score: number }[])
        this.take(entry.categoryName, entry.score);
    else if (typeof frame === 'object')
      for (const [name, value] of Object.entries(frame as Readonly<Record<string, number>>)) this.take(name, value);
    else throw new TypeError('A face frame must be a record, a list of {categoryName, score}, or null');
    return this;
  }

  /** Moves `values` toward the last frame by `delta` seconds, the same at any frame rate. */
  update(delta: number): this {
    if (!(delta >= 0 && delta < Infinity)) throw new RangeError('Face update delta must be 0 or more seconds');
    this.check();
    const share = this.smoothing === 0 ? 1 : 1 - Math.exp(-delta / this.smoothing);
    for (let i = 0; i < this.values.length; i++) this.values[i] += (this.target[i] - this.values[i]) * share;
    return this;
  }

  /** The current value of `shape`. */
  get(shape: FaceShape): number {
    const i = INDEX.get(shape);
    if (i === undefined) throw new RangeError(`Unknown face shape ${shape}; use a name from FACE_SHAPES`);
    return this.values[i];
  }

  /** Back to neutral at once. */
  reset(): this {
    this.values.fill(0);
    this.target.fill(0);
    return this;
  }
}

/**
 * VRM 1.0 preset expressions from the 52 values. Blinks are split so `blink` holds what both eyes share and
 * `blinkLeft`, `blinkRight` the rest; the look presets are the two eyes' mean. The tracker has no reading for `relaxed`,
 * so it stays out. `get` is a {@link FaceMapper}'s `get`, bound.
 */
export function vrmFaceExpressions(get: (shape: FaceShape) => number): Record<string, number> {
  const mean = (a: FaceShape, b: FaceShape): number => (get(a) + get(b)) / 2,
    left = get('eyeBlinkLeft'),
    right = get('eyeBlinkRight'),
    blink = Math.min(left, right);
  return {
    blink,
    blinkLeft: left - blink,
    blinkRight: right - blink,
    lookUp: mean('eyeLookUpLeft', 'eyeLookUpRight'),
    lookDown: mean('eyeLookDownLeft', 'eyeLookDownRight'),
    // Toward the face's own left: the left eye turns out, the right eye in.
    lookLeft: mean('eyeLookOutLeft', 'eyeLookInRight'),
    lookRight: mean('eyeLookInLeft', 'eyeLookOutRight'),
    aa: get('jawOpen'),
    ih: mean('mouthLowerDownLeft', 'mouthLowerDownRight'),
    ou: get('mouthPucker'),
    ee: mean('mouthStretchLeft', 'mouthStretchRight'),
    oh: get('mouthFunnel'),
    happy: mean('mouthSmileLeft', 'mouthSmileRight'),
    sad: mean('mouthFrownLeft', 'mouthFrownRight'),
    angry: mean('browDownLeft', 'browDownRight'),
    surprised: mean('eyeWideLeft', 'eyeWideRight'),
  };
}

/** Options of {@link addFace}. */
export interface AddFaceOptions extends FaceMapperOptions {
  /** Run inside this `Animator`, after its pose; with none, run as an engine plugin. */
  animator?: Animator;
  /** Drive this avatar's expressions rather than morph targets by name. */
  vrm?: VRMHandle;
  /** Morph target names for shapes the names alone do not find: `{ jawOpen: 'Mouth_Open', eyeBlinkLeft: ['A', 'B'] }`. */
  map?: Partial<Record<FaceShape, string | readonly string[]>>;
}

/** A running {@link addFace}. */
export interface FaceHandle {
  readonly mapper: FaceMapper;
  /** Shapes that drive something on this model. Empty with `vrm`, which goes through expressions. */
  readonly matched: readonly FaceShape[];
  /** Shapes with nothing to drive. */
  readonly missing: readonly FaceShape[];
  /** Takes the tracker's latest frame; see {@link FaceMapper.push}. */
  push(frame: FaceFrame | null): void;
  /** Runs one frame by hand; the Animator or the engine does this each frame by itself. */
  update(delta: number): void;
  /** Puts the face back to neutral and stops. */
  dispose(): void;
  [Symbol.dispose](): void;
}

/**
 * Drives a character's face from a tracker: call `push` with each tracker frame, at the tracker's own rate. Morph
 * targets are found on every mesh of the model by the names in `extras.targetNames`, so head, teeth and lashes move
 * together; pass `map` for other names, or `vrm` for an avatar. A driven morph target belongs to this: a clip's track
 * on it is overwritten.
 * @throws MargoError when nothing on the model matches, RangeError for bad settings.
 */
export function addFace(animation: Animator['animation'], options: AddFaceOptions = {}): FaceHandle {
  const mapper = new FaceMapper(options),
    model = animation.model,
    engine = model.root.engine,
    { animator, vrm, map = {} } = options;
  for (const shape of Object.keys(map))
    if (!INDEX.has(shape)) throw new RangeError(`Face map names ${shape}; use a name from FACE_SHAPES`);
  const named = new Map<string, FaceShape>();
  for (const [shape, names] of Object.entries(map) as [FaceShape, string | readonly string[]][])
    for (const name of typeof names === 'string' ? [names] : names) named.set(name, shape);
  // Each morph target a shape drives: glTF node and target index, once each.
  const targets: { node: number; target: number; shape: number }[] = [],
    seen = new Set<string>();
  if (!vrm)
    for (const { nodeIndex, targetNames } of model.primitives)
      (targetNames as readonly string[]).forEach((name, target) => {
        const shape = named.get(name) ?? faceShapeOf(name),
          key = `${nodeIndex}:${target}`;
        if (shape === null || seen.has(key)) return;
        seen.add(key);
        targets.push({ node: nodeIndex, target, shape: INDEX.get(shape)! });
      });
  if (!vrm && !targets.length)
    throw new MargoError('state', 'This model has no morph target named like a face shape; pass map, or vrm for an avatar');
  const driven = new Set(targets.map((t) => t.shape)),
    matched = vrm ? [] : FACE_SHAPES.filter((_, i) => driven.has(i)),
    missing = vrm ? [] : FACE_SHAPES.filter((_, i) => !driven.has(i)),
    get = (shape: FaceShape): number => mapper.get(shape);
  const apply = (): void => {
    if (vrm) for (const [name, value] of Object.entries(vrmFaceExpressions(get))) vrm.expressions.set(name, value);
    else for (const { node, target, shape } of targets) animation.setMorph(node, target, mapper.values[shape]);
  };
  const update = (delta: number): void => {
    mapper.update(delta);
    apply();
  };
  const name = `face:${model.root.id}`;
  let remove: (() => void) | null;
  if (animator) remove = animator.addSolver(update);
  else {
    engine.use({ name, setup() {}, onPreUpdate: update });
    remove = () => engine.removePlugin(name);
  }
  const stop = (): void => {
    remove?.();
    remove = null;
    unsubscribe?.();
    unsubscribe = null;
  };
  // A model disposed first takes the face with it: nothing is left to put back.
  let unsubscribe: (() => void) | null = model.onDispose(stop);
  const dispose = (): void => {
    if (!remove) return;
    stop();
    mapper.reset();
    apply();
  };
  return {
    mapper,
    matched,
    missing,
    push: (frame) => {
      mapper.push(frame);
    },
    update,
    dispose,
    [Symbol.dispose]: dispose,
  };
}
