// The stage facade with no page: createStage needs an element, so this builds the same Stage on a stand-in canvas. The
// stage's feature entries (addGLTF, addSky and the rest) take a Stage, so they work here unchanged.
import { Engine, Stage, type EngineOptions, type Mesh } from '@margoengine/stage';
import {
  createHeadlessCanvas,
  installGPU,
  readPixels,
  toPNG,
  type GPUBinding,
  type HeadlessPixels,
  type HeadlessReadOptions,
  type InstalledGPU,
} from './index.js';
import { fault, typeError } from '../../shared/errors.js';

/** Options of {@link createHeadlessStage}: engine options, less `backend`, which is always WebGPU, plus these. */
export interface HeadlessStageOptions extends Omit<EngineOptions, 'backend'> {
  /** Width of the image in pixels, a whole number from 1. Required. */
  width: number;
  /** Height of the image in pixels, a whole number from 1. Required. */
  height: number;
  /** The WebGPU implementation: `create([])` from a Node binding. Default `navigator.gpu`. */
  gpu?: GPUBinding;
  /** Globals the binding exports, as in `installGPU`. Default none. */
  globals?: Readonly<Record<string, unknown>>;
  /** Receives engine errors (set as `engine.onError`). */
  onError?: (error: unknown) => void;
}

// installGPU changes globals, so stages alive at once share one installation: a stage disposed first must not take
// `GPUBufferUsage` away from another that is still drawing.
let shared: { gpu: GPUBinding; installed: InstalledGPU; users: number } | undefined;

function acquire(gpu: GPUBinding, globals: HeadlessStageOptions['globals']): () => void {
  if (shared && shared.gpu !== gpu) throw fault('state', 'Headless stages alive at once share one gpu', 'headless');
  shared ??= { gpu, installed: installGPU({ gpu, globals }), users: 0 };
  shared.users++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (shared && --shared.users === 0) {
      shared.installed.dispose();
      shared = undefined;
    }
  };
}

/**
 * A {@link Stage} with no page. Nothing runs by itself: `engine.start()` needs `requestAnimationFrame`, so call
 * {@link HeadlessStage.step} to advance time, or just read an image. Create one with {@link createHeadlessStage}.
 */
export class HeadlessStage extends Stage {
  readonly #ticks = new Set<(delta: number) => void>();

  /** Runs on each {@link HeadlessStage.step}. Returns a function that removes it. */
  override onTick(callback: (delta: number) => void): () => void {
    this.#ticks.add(callback);
    return () => void this.#ticks.delete(callback);
  }

  /** Runs `onTick` callbacks, then draws a frame that advances plugins and animation by `delta` seconds. Default 0. */
  step(delta = 0): void {
    for (const tick of this.#ticks) tick(delta);
    this.engine.render({ delta });
  }

  /** Sets the image size. The next frame uses it. */
  resize(width: number, height: number): void {
    const { canvas } = this;
    canvas.width = width;
    canvas.height = height;
  }

  // Stage.fit takes its aspect from the canvas's CSS size. The stand-in has none, which is how core keeps width and
  // height as the image size, so it gets one only while fit runs.
  override fit(meshes?: Iterable<Mesh>): void {
    const canvas = this.canvas as unknown as Record<'width' | 'height' | 'clientWidth' | 'clientHeight', number>;
    canvas.clientWidth = canvas.width;
    canvas.clientHeight = canvas.height;
    try {
      super.fit(meshes);
    } finally {
      canvas.clientWidth = canvas.clientHeight = 0;
    }
  }

  /** Draws a frame and reads it as RGBA pixels. See `readPixels`. */
  readPixels(options?: HeadlessReadOptions): Promise<HeadlessPixels> {
    this.engine.render();
    return readPixels(this.engine, options);
  }

  /** Draws a frame and gives it as PNG file bytes. */
  toPNG(options?: HeadlessReadOptions): Promise<Uint8Array> {
    this.engine.render();
    return toPNG(this.engine, options);
  }

  /** `dispose()`, for `using`. */
  [Symbol.dispose](): void {
    this.dispose();
  }
}

/**
 * The server version of `createStage`: installs the GPU, creates an engine on a stand-in canvas and wraps it. There
 * are no camera controls and no frame loop. Disposing the stage (or its engine) restores what `installGPU` changed once
 * no other headless stage is alive.
 */
export async function createHeadlessStage({
  width,
  height,
  gpu = globalThis.navigator?.gpu,
  globals,
  onError,
  ...options
}: HeadlessStageOptions): Promise<HeadlessStage> {
  if (onError !== undefined && typeof onError !== 'function') throw typeError('Invalid stage options', 'arguments');
  const canvas = createHeadlessCanvas({ width, height }),
    release = acquire(gpu, globals);
  try {
    const engine = await Engine.create(canvas, { ...options, backend: 'webgpu' });
    if (onError) engine.onError = onError;
    engine.use({ name: 'margoengine-headless', setup() {}, dispose: release });
    return new HeadlessStage(engine);
  } catch (error) {
    release();
    throw error;
  }
}
