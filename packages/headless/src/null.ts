// Logic-only renderer injection through the existing optional fallback contract.
// The real engine still owns scenes, transforms, animation callbacks and plugins.
import { Engine, type CameraOptions } from '@margoengine/core';
import { engineRuntime, type Renderer, type RenderView } from '@margoengine/core/extension';
import { HeadlessStage } from './stage.js';
import { createHeadlessCanvas } from './index.js';
import { fault, rangeError, typeError } from '../../shared/errors.js';

/** Options for a GPU-free scene simulation. */
export interface NullStageOptions {
  /** Logical viewport width. Default 1. */
  width?: number;
  /** Logical viewport height. Default 1. */
  height?: number;
  /** Initial transform capacity. Default 1024; grows automatically. */
  capacity?: number;
  /** Initial camera configuration. Default core camera defaults. */
  camera?: CameraOptions;
  /** Cancels creation. Default none. */
  signal?: AbortSignal;
  /** Engine error callback. Default core error reporting. */
  onError?: (error: unknown) => void;
}

/**
 * Real scenes and transforms with no graphics context, binding or render passes.
 * step runs ticks, frame callbacks and every live scene's plugin updates once.
 * CPU animation samplers and property animation work unchanged; GPU deformation
 * and readback are unsupported. Nothing runs until step is called.
 */
export class NullStage extends HeadlessStage {
  /** Identifies this stage independently of the engine fallback dispatch label. */
  readonly isNull = true;
  #stepping = false;
  #time = 0;
  /** Accumulated successful steps in seconds. */
  get time(): number {
    return this.#time;
  }

  /** Advance all live scenes by delta seconds, 0..1. Default 0. Reentrant steps reject. */
  override step(delta = 0): void {
    const engine = engineRuntime(this.engine);
    if (engine.disposed) throw fault('disposed', 'Null stage disposed; create another stage', 'headless');
    if (!Number.isFinite(delta) || delta < 0 || delta > 1)
      throw rangeError('Null stage delta must be in 0..1 seconds', 'headless');
    if (this.#stepping) throw fault('state', 'Null stage step is already running', 'headless');
    this.#stepping = true;
    try {
      super.step(delta);
      this.#time += delta;
    } finally {
      this.#stepping = false;
    }
  }
}

/**
 * Creates a GPU-free stage using core's existing renderer injection. It never
 * requests an adapter or graphics context, modifies no globals and needs no DOM.
 * engine.backend is the existing 'webgl2' fallback dispatch label; gpu and
 * renderTarget are null. Render passes are registered but never executed.
 */
export async function createNullStage({
  width = 1,
  height = 1,
  onError,
  ...options
}: NullStageOptions = {}): Promise<NullStage> {
  options.signal?.throwIfAborted();
  if (onError !== undefined && typeof onError !== 'function')
    throw typeError('Null stage onError must be a function or undefined; pass a callback or omit it', 'arguments');
  const renderer: Renderer = {
    backend: 'webgl2',
    add() {},
    remove() {},
    render() {},
    dispose() {},
  };
  const engine = await Engine.create(createHeadlessCanvas({ width, height }), {
    ...options,
    backend: 'webgl2',
    exactSize: true,
    fallback: () => renderer,
  });
  if (onError) engine.onError = onError;
  const runtime = engineRuntime(engine),
    render = engine.render.bind(engine);
  // Keep all scene lifecycle/activation rules in the real engine. Multiple views
  // share a camera, advanced once, and update each scene's plugins once.
  engine.render = (options = {}) => {
    const views: RenderView[] = [...runtime.scenes].map((scene) => ({
      scene,
      camera: options.camera ?? runtime.camera,
      viewport: [0, 0, 1, 1],
    }));
    render({ ...options, culling: false, views: options.views ?? views });
  };
  return new NullStage(engine);
}
