// @margoengine/compute/frame: compute kernels inside an engine's frame. Jobs are encoded into the frame's own command
// encoder before the scene draws (one submit, no CPU wait), on the engine's device, so their output buffers can feed
// the same frame's draws: particle simulation, GPU culling into indirect draw arguments, skinning, physics steps.
import type { Engine, EnginePlugin, FrameGraph, PassContext } from '@margoengine/core/extension';
import type { EngineKernel } from '@margoengine/core';
import { fault, rangeError, typeError } from '../../shared/errors.js';
import { ComputeContext } from './context.js';
import { BoundKernel, type RunOptions } from './kernel.js';

let serial = 0;

/** A per-frame job: a bound kernel, its dispatch (or a function giving it each frame), and its order among jobs. */
export interface FrameJob {
  readonly kernel: BoundKernel;
  readonly run: RunOptions | ((delta: number) => RunOptions | null);
  readonly order: number;
}

/** Options for {@link ComputeFrame.attach}. */
export interface ComputeFrameOptions {
  /**
   * Frame-graph order of the compute pass. Default -1000: before the main scene pass (order 0) and before effects that
   * run ahead of it.
   */
  readonly order?: number;
  /** Called after the GPU device is restored (a lost device's buffers are gone): rebuild arrays and jobs on `frame.gpu`. */
  readonly onRestored?: (frame: ComputeFrame) => void;
}

/**
 * Runs compute kernels every frame inside an engine's frame graph. `frame.gpu` is a compute context on the engine's
 * device; bind kernels there and `add` them as jobs. A job's `run` may be a function of the frame delta (return null
 * to skip that frame), so uniforms can change every frame with `bound.set(...)` inside it.
 * @example
 * const frame = ComputeFrame.attach(engine);
 * const step = frame.gpu.kernel(simulateWGSL).bind({ particles, params: { dt: 0 } });
 * frame.add(step, (dt) => (step.set('params', { dt }), { count: particles.size / 4 }));
 */
export class ComputeFrame implements EnginePlugin {
  /** Plugin name, unique per frame instance. */
  readonly name = `compute-frame:${serial++}`;
  readonly #order: number;
  readonly #onRestored?: (frame: ComputeFrame) => void;
  readonly #jobs: FrameJob[] = [];
  #gpu: ComputeContext | undefined;
  #engine: Engine | undefined;
  #delta = 0;
  #disposed = false;

  /** Creates the frame and attaches it to `engine` (WebGPU backend). */
  static attach(engine: EngineKernel, options: ComputeFrameOptions = {}): ComputeFrame {
    const frame = new ComputeFrame(options);
    (engine as unknown as Engine).use(frame);
    return frame;
  }

  /** @param options Pass order and the device-restore callback. Attach with `engine.use(frame)`, or use {@link ComputeFrame.attach}. */
  constructor(options: ComputeFrameOptions = {}) {
    const order = options.order ?? -1000;
    if (!Number.isFinite(order))
      throw rangeError(`ComputeFrame order must be a finite number, got ${order}`, 'compute');
    this.#order = order;
    this.#onRestored = options.onRestored;
  }

  /** The compute context on the engine's device. */
  get gpu(): ComputeContext {
    if (this.#disposed) throw fault('disposed', 'ComputeFrame disposed; attach a new one', 'compute');
    if (!this.#gpu) throw fault('state', 'ComputeFrame is not attached; call ComputeFrame.attach(engine)', 'compute');
    return this.#gpu;
  }

  /** The jobs, in run order. */
  get jobs(): readonly FrameJob[] {
    return this.#jobs;
  }

  /** @internal EnginePlugin hook. */
  setup(engine: Engine): void {
    const device = engine.gpu;
    if (!device) throw fault('unsupported', 'ComputeFrame needs the WebGPU backend; the engine runs WebGL2', 'compute');
    this.#engine = engine;
    this.#gpu = new ComputeContext(device, false);
  }

  /** @internal EnginePlugin hook. */
  onPreUpdate(delta: number): void {
    this.#delta = delta;
  }

  /** @internal EnginePlugin hook. */
  registerPasses(graph: FrameGraph): void {
    graph.add({ name: `${this.name}:jobs`, order: this.#order, execute: (context) => this.#execute(context) });
  }

  #execute(context: PassContext): void {
    // Once per frame: the first view (or the whole canvas) runs the jobs; later views of the same frame skip them.
    if (context.backend !== 'webgpu' || (context.view && context.view.index > 0) || !this.#jobs.length) return;
    for (const job of this.#jobs) {
      const run = typeof job.run === 'function' ? job.run(this.#delta) : job.run;
      if (run) job.kernel.encode(context.encoder, run);
    }
  }

  /** @internal EnginePlugin hook: the old device's buffers are gone, so jobs are dropped and a new context made. */
  onDeviceRestored(engine: Engine): void {
    this.#jobs.length = 0;
    this.#gpu?.dispose();
    this.#gpu = engine.gpu ? new ComputeContext(engine.gpu, false) : undefined;
    this.#onRestored?.(this);
  }

  /**
   * Adds a job run every frame, in ascending `order` (default: after the jobs already added). Returns a function that
   * removes it.
   */
  add(kernel: BoundKernel, run: FrameJob['run'], options: { readonly order?: number } = {}): () => void {
    if (this.#disposed) throw fault('disposed', 'ComputeFrame disposed; attach a new one', 'compute');
    if (!(kernel instanceof BoundKernel))
      throw typeError('ComputeFrame.add takes a bound kernel: gpu.kernel(code).bind(resources)', 'compute');
    if (typeof run !== 'function' && (typeof run !== 'object' || run === null))
      throw typeError(
        'ComputeFrame.add needs run options ({ count }, { workgroups } or { indirect }) or a function returning them',
        'compute',
      );
    const order = options.order ?? (this.#jobs.at(-1)?.order ?? 0) + 1;
    const job: FrameJob = { kernel, run, order };
    this.#jobs.push(job);
    this.#jobs.sort((a, b) => a.order - b.order);
    return () => {
      const at = this.#jobs.indexOf(job);
      if (at >= 0) this.#jobs.splice(at, 1);
    };
  }

  /** Removes the plugin from the engine and frees the context's arrays (the engine's device stays). */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#jobs.length = 0;
    this.#gpu?.dispose();
    this.#gpu = undefined;
    const engine = this.#engine;
    this.#engine = undefined;
    engine?.sceneOf(this)?.removePlugin(this.name);
  }

  /** Same as `dispose()`, for `using`. */
  [Symbol.dispose](): void {
    this.dispose();
  }
}
