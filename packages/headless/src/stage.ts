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
import { fault, rangeError, typeError } from '../../shared/errors.js';

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
  /**
   * No background: pixels nothing draws read back with alpha 0, for graphics laid over other pictures. Attaches
   * `TransparentCanvas` from `@margoengine/environment`, which must be installed. Default false.
   */
  transparent?: boolean;
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
  readonly #frames = new Set<Parameters<Stage['engine']['onFrame']>[0]>();
  #stepping = false;

  constructor(engine: Stage['engine']) {
    super(engine);
    // Core runs these callbacks only from its requestAnimationFrame loop, and a package that drives itself from them
    // would stand still here. They stay registered with core too, for an `engine.start()` on a page.
    const register = engine.onFrame.bind(engine);
    engine.onFrame = (callback) => {
      const remove = register(callback);
      this.#frames.add(callback);
      return () => {
        remove();
        this.#frames.delete(callback);
      };
    };
  }

  /** Runs on each {@link HeadlessStage.step}. Returns a function that removes it. */
  override onTick(callback: (delta: number) => void): () => void {
    this.#ticks.add(callback);
    return () => void this.#ticks.delete(callback);
  }

  /**
   * Runs `onTick` and `engine.onFrame` callbacks, then draws a frame that advances plugins and animation by `delta`
   * seconds, 0 to 1 as `engine.render` takes it. Default 0. A delta outside that range, or a step from inside a step,
   * throws before any callback runs.
   */
  step(delta = 0): void {
    // engine.render checks the delta too, but only after the callbacks have already acted on it.
    if (typeof delta !== 'number' || !(delta >= 0 && delta <= 1))
      throw rangeError('Stage step delta must be 0 to 1 seconds', 'headless');
    if (this.#stepping) throw fault('state', 'Stage step is already running', 'headless');
    this.#stepping = true;
    try {
      for (const tick of this.#ticks) tick(delta);
      for (const frame of this.#frames) frame(this.engine, delta);
      this.engine.render({ delta });
    } finally {
      this.#stepping = false;
    }
  }

  /** Sets the image size, whole numbers from 1 as in {@link createHeadlessStage}. The next frame uses it. */
  resize(width: number, height: number): void {
    for (const size of [width, height])
      if (!Number.isInteger(size) || size < 1) throw rangeError('Stage size must be whole numbers from 1', 'headless');
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

/** `@margoengine/environment`, an optional peer loaded on first use. */
async function transparentCanvas(): Promise<typeof import('@margoengine/environment')> {
  try {
    return await import('@margoengine/environment');
  } catch (error) {
    if ((error as { code?: string }).code === 'ERR_MODULE_NOT_FOUND')
      throw Object.assign(fault('state', 'Install @margoengine/environment', 'install'), { cause: error });
    throw error;
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
  transparent = false,
  ...options
}: HeadlessStageOptions): Promise<HeadlessStage> {
  if (onError !== undefined && typeof onError !== 'function')
    throw typeError(
      'Invalid stage onError: expected a function or undefined; pass an error callback or omit onError',
      'arguments',
    );
  if (typeof transparent !== 'boolean')
    throw typeError(
      'Invalid stage transparent: expected a boolean; pass true for a transparent background or omit transparent',
      'arguments',
    );
  const environment = transparent ? await transparentCanvas() : undefined;
  const canvas = createHeadlessCanvas({ width, height }),
    release = acquire(gpu, globals);
  try {
    const engine = await Engine.create(canvas, { ...options, backend: 'webgpu' });
    if (onError) engine.onError = onError;
    engine.use({ name: 'margoengine-headless', setup() {}, dispose: release });
    if (environment) engine.use(new environment.TransparentCanvas());
    return new HeadlessStage(engine);
  } catch (error) {
    release();
    throw error;
  }
}
