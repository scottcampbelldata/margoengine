// Film sequences from a path tracer: one traced image per frame of a fixed frame rate, with motion blur from the
// previous frame's camera and instance poses, per-frame or fixed noise, and the tracer's own display mapping.
// Distributed ray tracing over the shutter interval: Cook, Porter and Carpenter, "Distributed Ray Tracing", SIGGRAPH
// 1984, https://doi.org/10.1145/800031.808590. The per-frame seed decorrelates noise between frames (white noise in
// time), so a sequence does not show a fixed noise pattern sliding under moving content; 'fixed' keeps one pattern for
// comparisons and stills.
import { MargoError } from '@margoengine/math/errors';
import { displayRows, type DisplaySettings } from './display.js';
import type {
  TracePreviousCamera,
  TraceVec3,
  VoxelTraceImage,
  VoxelTraceRenderOptions,
  VoxelTraceScene,
} from './types.js';

/** The fields of a triangle scene's mesh instance that the sequence fills in (see `@margoengine/voxel-pathtracer/mesh`). */
interface MeshPlacement {
  readonly id: string;
  readonly transform?: readonly number[] | Float32Array;
  readonly previousTransform?: readonly number[] | Float32Array;
}
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** The tracer calls a sequence makes; `VoxelPathTracer` and `MeshPathTracer` both fit. */
export interface SequenceTracer<Scene extends VoxelTraceScene = VoxelTraceScene> {
  readonly options: Readonly<DisplaySettings & { shutter: number; previousCamera?: TracePreviousCamera }>;
  setScene(scene: Scene): unknown;
  setOptions(options: { shutter?: number; previousCamera?: TracePreviousCamera | null }): void;
  whenIdle(): Promise<void>;
  renderImage(options: VoxelTraceRenderOptions): Promise<VoxelTraceImage>;
}

/** The pose a sequence reads from the camera after each update; the engine camera fits. */
export interface SequenceCamera {
  position: TraceVec3;
  target: TraceVec3;
  up?: TraceVec3;
  fov?: number;
}

/** What `update` is called with, once per frame before it is traced. */
export interface SequenceTiming {
  /** Frame number: 0 for the first traced frame, negative for pre-roll frames. */
  index: number;
  /** Seconds: `index / fps`. */
  time: number;
  /** Seconds since the previous update: 0 for the first, then `1 / fps`. */
  delta: number;
  /** `index / frames` (negative during pre-roll). */
  progress: number;
  /** True for a pre-roll frame, which is updated but not traced. */
  preRoll: boolean;
}

/** Options of {@link traceFrames}. */
export interface TraceFramesOptions<Scene extends VoxelTraceScene = VoxelTraceScene> {
  /** Frames to trace, integer 0 to 1,000,000. */
  frames: number;
  /** Frames per second, above 0 and at most 1000. Default 30. */
  fps?: number;
  /** Image width in pixels, 1 to 16384. */
  width: number;
  /** Image height in pixels, 1 to 16384. */
  height: number;
  /** Samples per pixel per frame, 1 to 1048576. */
  samples: number;
  /**
   * Motion blur as a share of the frame interval, 0 to 1: the shutter opens at `shutter` of the way from the previous
   * frame's poses to this frame's and closes at this frame's (the tracer's own `shutter` rule). Default 0.
   */
  shutter?: number;
  /**
   * The camera the tracer renders through (the engine camera). Its pose after each update becomes the next frame's
   * `previousCamera`, so camera moves blur. Default none (no camera blur).
   */
  camera?: SequenceCamera;
  /**
   * Called before each frame with its {@link SequenceTiming}; may move the camera and return the frame's scene (or a
   * promise of it). A returned scene is set on the tracer; instances without `previousMatrix` that were in the last
   * frame's scene (by id) get last frame's `matrix` as `previousMatrix` when `shutter` is above 0, and mesh instances
   * (`meshInstances` of a triangle scene) without `previousTransform` get last frame's `transform` the same way.
   * Returning nothing keeps the scene, still.
   */
  update?: (timing: SequenceTiming) => Scene | void | Promise<Scene | void>;
  /** Base seed, integer 0 to 4294967295. Default 0. */
  seed?: number;
  /** 'per-frame' (default) draws a new seed for each frame from `seed` and the frame index; 'fixed' uses `seed`. */
  noise?: 'per-frame' | 'fixed';
  /** Frames updated before frame 0 but not traced (simulations settle, motion has a previous pose), integer 0 to 100000. Default 0. */
  preRoll?: number;
  /** Denoise each frame. Default: the tracer's `denoise` option. */
  denoise?: boolean;
  /** Also return albedo, normal, depth and id buffers per frame. Default false. */
  aovs?: boolean;
  /** Transparent background (see `renderImage`). Default false. */
  transparent?: boolean;
  /** Cancels the sequence; the generator then rejects with the signal's reason. */
  signal?: AbortSignal;
}

/** One traced frame of a sequence. */
export interface TracedFrame extends SequenceTiming {
  /** The linear float image (and AOVs) `renderImage` returned. */
  readonly image: VoxelTraceImage;
  /** Seed the frame was traced with. */
  readonly seed: number;
  /**
   * 8-bit RGBA display pixels, rows from the top: the tracer's exposure, vignette, tone mapping and gamma as they were
   * when the frame was traced (the same mapping as `capture`). Alpha is 255 unless `transparent`.
   */
  pixels(): Uint8ClampedArray;
}

const MAX_SIDE = 16384;

function integer(name: string, value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)
    throw new RangeError(`traceFrames ${name} must be an integer from ${min} to ${max}`);
  return value;
}

/** A 32-bit seed for frame `index` of a sequence seeded `seed` (murmur3 finaliser over the pair). */
export function frameSeed(seed: number, index: number): number {
  let h = (seed ^ Math.imul(index | 0, 0x9e3779b9)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

const poseOf = (camera: SequenceCamera): TracePreviousCamera => ({
  position: [camera.position[0], camera.position[1], camera.position[2]],
  target: [camera.target[0], camera.target[1], camera.target[2]],
  ...(camera.up ? { up: [camera.up[0], camera.up[1], camera.up[2]] as TraceVec3 } : {}),
  ...(typeof camera.fov === 'number' ? { fov: camera.fov } : {}),
});

/**
 * Traces `frames` frames of a moving scene, one `renderImage` per frame, and yields each as it finishes. The tracer's
 * `shutter` and `previousCamera` are set per frame and restored when the generator ends, returns early or throws.
 *
 * ```ts
 * for await (const frame of traceFrames(tracer, { frames: 48, fps: 24, width: 1280, height: 720, samples: 256,
 *   shutter: 0.5, camera: engine.camera, update: ({ time }) => { engine.camera.position = [10 * Math.cos(time), 4, 10 * Math.sin(time)]; } })) {
 *   encoder.add(frame.pixels());
 * }
 * ```
 * @throws TypeError / RangeError for invalid options (on the first `next()`); the signal's reason when aborted;
 * whatever the tracer's `setScene` or `renderImage` rejects with.
 */
export async function* traceFrames<Scene extends VoxelTraceScene>(
  tracer: SequenceTracer<Scene>,
  options: TraceFramesOptions<Scene>,
): AsyncGenerator<TracedFrame, void, undefined> {
  if (!tracer || typeof tracer.renderImage !== 'function' || typeof tracer.setOptions !== 'function')
    throw new TypeError('traceFrames expects a VoxelPathTracer or MeshPathTracer');
  if (!options || typeof options !== 'object') throw new TypeError('traceFrames expects options');
  const frames = integer('frames', options.frames, 0, 1_000_000),
    fps = options.fps ?? 30,
    width = integer('width', options.width, 1, MAX_SIDE),
    height = integer('height', options.height, 1, MAX_SIDE),
    samples = integer('samples', options.samples, 1, 1 << 20),
    shutter = options.shutter ?? 0,
    seed = integer('seed', options.seed ?? 0, 0, 0xffffffff),
    noise = options.noise ?? 'per-frame',
    preRoll = integer('preRoll', options.preRoll ?? 0, 0, 100_000),
    { camera, update, signal } = options;
  if (typeof fps !== 'number' || !(fps > 0 && fps <= 1000))
    throw new RangeError('traceFrames fps must be above 0 and at most 1000');
  if (typeof shutter !== 'number' || !(shutter >= 0 && shutter <= 1))
    throw new RangeError('traceFrames shutter must be from 0 to 1');
  if (noise !== 'per-frame' && noise !== 'fixed')
    throw new TypeError("traceFrames noise must be 'per-frame' or 'fixed'");
  if (update !== undefined && typeof update !== 'function')
    throw new TypeError('traceFrames update must be a function');
  if (camera !== undefined && (!camera || !Array.isArray(camera.position) || !Array.isArray(camera.target)))
    throw new TypeError('traceFrames camera needs position and target arrays');
  if (signal !== undefined && !(signal instanceof AbortSignal))
    throw new TypeError('traceFrames signal must be an AbortSignal');
  const abort = () => {
    if (signal?.aborted) throw signal.reason ?? new DOMException('The sequence was aborted', 'AbortError');
  };
  abort();
  const saved = tracer.options,
    savedShutter = saved.shutter,
    savedCamera = saved.previousCamera ?? null;
  // Instance matrices at the end of the last update: this frame's shutter opens from them.
  let matrices = new Map<string, readonly number[]>(),
    transforms = new Map<string, MeshPlacement['transform']>(),
    current: Scene | undefined,
    moved = false;
  const setScene = async (scene: Scene) => {
    await tracer.setScene(scene);
  };
  try {
    await tracer.whenIdle();
    for (let index = preRoll ? -preRoll : 0; index < frames; index++) {
      abort();
      const first = index === (preRoll ? -preRoll : 0),
        timing: SequenceTiming = {
          index,
          time: index / fps,
          delta: first ? 0 : 1 / fps,
          progress: frames ? index / frames : 0,
          preRoll: index < 0,
        };
      const pose = camera ? poseOf(camera) : null,
        returned = update ? await update(timing) : undefined;
      abort();
      // The shutter opens from the pose before this update; the first update has none before it, so it is still.
      const opening = first ? null : pose;
      if (returned && typeof returned === 'object') {
        current = returned as Scene;
        const instances = current.instances ?? [];
        let filled = false;
        const withMotion =
          shutter > 0
            ? instances.map((instance) => {
                const before = matrices.get(instance.id);
                if (instance.previousMatrix || !before) return instance;
                filled = true;
                return { ...instance, previousMatrix: before };
              })
            : instances;
        const placements = (current as { meshInstances?: readonly MeshPlacement[] }).meshInstances;
        let placed = false;
        const meshMotion =
          shutter > 0 && Array.isArray(placements)
            ? placements.map((instance) => {
                const before = transforms.get(instance.id);
                if (instance.previousTransform || !transforms.has(instance.id)) return instance;
                placed = true;
                return { ...instance, previousTransform: before ?? IDENTITY };
              })
            : placements;
        await setScene(
          filled || placed
            ? ({
                ...current,
                ...(filled ? { instances: withMotion } : {}),
                ...(placed ? { meshInstances: meshMotion } : {}),
              } as Scene)
            : current,
        );
        moved = filled || placed;
        matrices = new Map(instances.map((instance) => [instance.id, instance.matrix]));
        transforms = new Map(
          Array.isArray(placements) ? placements.map((instance) => [instance.id, instance.transform]) : [],
        );
      } else if (moved && current) {
        // Nothing changed since the last frame: its filled-in motion no longer applies.
        await setScene(current);
        moved = false;
      }
      if (index < 0) continue;
      tracer.setOptions({
        shutter,
        previousCamera: shutter > 0 && opening ? opening : null,
      });
      const frameSeedValue = noise === 'fixed' ? seed : frameSeed(seed, index),
        display: DisplaySettings = { ...tracer.options },
        image = await tracer.renderImage({
          width,
          height,
          samples,
          seed: frameSeedValue,
          ...(options.denoise === undefined ? {} : { denoise: options.denoise }),
          ...(options.aovs ? { aovs: true } : {}),
          ...(options.transparent ? { transparent: true } : {}),
          ...(signal ? { signal } : {}),
        });
      let pixels: Uint8ClampedArray | undefined;
      yield {
        ...timing,
        image,
        seed: frameSeedValue,
        pixels() {
          if (!pixels) {
            pixels = new Uint8ClampedArray(width * height * 4);
            displayRows(display, width, height, 0, height, image.color, image.alpha, 4, pixels);
          }
          return pixels.slice();
        },
      };
    }
  } finally {
    try {
      tracer.setOptions({ shutter: savedShutter, previousCamera: savedCamera });
    } catch (error) {
      // A disposed tracer has nothing to restore; any other failure is real.
      if (!(error instanceof MargoError && error.code === 'disposed')) throw error;
    }
  }
}
