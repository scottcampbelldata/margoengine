/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import type { Engine, EnginePlugin } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import type { Stats } from './index.js';

/** One `createShaderModule` or pipeline create call. */
export interface CompileRecord {
  kind: 'shader' | 'render' | 'compute';
  /** The descriptor's label, else its shader module's label, else `''`. */
  label: string;
  /** True for a call that held the caller until it returned; false for the `...Async` pipeline calls. */
  blocking: boolean;
  /** `performance.now()` when the call started. */
  startedAt: number;
  /** How many frames had ended when it started. */
  frame: number;
  /** Time until the call returned or its promise settled; null while an async call runs. */
  milliseconds: number | null;
  /** True when the call threw or its promise rejected. */
  failed: boolean;
  /** Where the call came from, with the `stacks` option. */
  stack?: string;
}
/** A slow frame and the compiles that ran during it or the frame before. */
export interface CompileHitch {
  /** Frame number, counted from attach. */
  frame: number;
  /** `performance.now()` when the frame ended. */
  at: number;
  milliseconds: number;
  /** Blocking calls first, then longest first. */
  compiles: CompileRecord[];
}
/** What {@link PipelineCompiles.toJSON} returns; safe for `JSON.stringify`. */
export interface PipelineCompilesReport {
  frames: number;
  /** Every compile seen since attach, the dropped ones included. */
  count: number;
  /** Time spent inside blocking calls since attach. */
  blockingMilliseconds: number;
  /** The newest records, oldest first. */
  compiles: CompileRecord[];
  /** The newest hitches, oldest first. */
  hitches: CompileHitch[];
}
/** Options for {@link PipelineCompiles}. */
export interface PipelineCompilesOptions {
  /** A frame longer than this, in milliseconds, is a hitch when compiles ran near it. Default 33.4. */
  hitchMilliseconds?: number;
  /** Records and hitches kept, 1..65536 of each; the oldest go first. Default 256. */
  capacity?: number;
  /** Keep a stack trace on each record, to find unlabelled compiles. Default false. */
  stacks?: boolean;
}

const METHODS = [
  'createShaderModule',
  'createRenderPipeline',
  'createComputePipeline',
  'createRenderPipelineAsync',
  'createComputePipelineAsync',
] as const;
type Method = (typeof METHODS)[number];
type Descriptor = {
  label?: string;
  vertex?: { module?: { label?: string } };
  compute?: { module?: { label?: string } };
};
const kinds: Record<Method, CompileRecord['kind']> = {
  createShaderModule: 'shader',
  createRenderPipeline: 'render',
  createComputePipeline: 'compute',
  createRenderPipelineAsync: 'render',
  createComputePipelineAsync: 'compute',
};
const running = (record: CompileRecord, at: number) => record.milliseconds ?? at - record.startedAt;

/**
 * Records every shader and pipeline compile on a device and links them to slow frames. `PipelineCompiles.attach(engine)`
 * follows the engine's device and frames; a custom loop calls `track(device)` and `frame(milliseconds)`. Compiles made
 * before attach are not seen. A hitch says a compile ran near a slow frame; that is evidence, not proof of the cause.
 */
export class PipelineCompiles implements EnginePlugin {
  readonly name = 'pipeline-compiles';
  /** Frames seen since attach. */
  frames = 0;
  /** Compiles seen since attach, the dropped ones included. */
  count = 0;
  /** Time spent inside blocking calls since attach. */
  blockingMilliseconds = 0;
  private readonly records: CompileRecord[] = [];
  private readonly hitches: CompileHitch[] = [];
  private readonly listeners = new Set<(hitch: CompileHitch) => void>();
  private readonly hitchMilliseconds: number;
  private readonly capacity: number;
  private readonly stacks: boolean;
  private restore?: () => void;
  private engine?: Engine;
  private removeFrameListener?: () => void;
  private tracked?: GPUDevice;
  private untrackNext?: () => void;
  private last = 0;
  private previous = 0;
  private timer?: ReturnType<typeof setInterval>;
  private row?: HTMLElement;
  private disposed = false;

  /** Adds it to an engine: compiles on `engine.gpu` and the engine's frames are followed until `dispose()`. */
  static attach(engine: EngineKernel, options: PipelineCompilesOptions = {}): PipelineCompiles {
    const compiles = new PipelineCompiles(options);
    engine.use(compiles);
    return compiles;
  }
  constructor({ hitchMilliseconds = 33.4, capacity = 256, stacks = false }: PipelineCompilesOptions = {}) {
    if (!Number.isFinite(hitchMilliseconds) || hitchMilliseconds <= 0)
      throw new RangeError('hitchMilliseconds must be above 0');
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 65536)
      throw new RangeError('capacity must be 1..65536');
    if (typeof stacks !== 'boolean') throw new TypeError('stacks must be boolean');
    this.hitchMilliseconds = hitchMilliseconds;
    this.capacity = capacity;
    this.stacks = stacks;
  }

  /**
   * Catches the next device made on this page, so the engine's startup pipelines are seen too. Call it before
   * `Engine.create`, then add this tracker with `engine.use(compiles)`. Only `GPUAdapter.prototype.requestDevice` is
   * wrapped, and only until that device arrives or `dispose()`.
   * @throws MargoError `unsupported` where the page has no `GPUAdapter`.
   */
  trackNext(): this {
    if (this.disposed)
      throw new MargoError('disposed', 'PipelineCompiles is disposed; create a new one to track a device.');
    const adapter = (globalThis as { GPUAdapter?: { prototype: GPUAdapter } }).GPUAdapter?.prototype;
    if (!adapter) throw new MargoError('unsupported', 'trackNext needs WebGPU; this page has no GPUAdapter');
    const request = adapter.requestDevice,
      tracker = this,
      restore = () => {
        if (adapter.requestDevice === wrapped) adapter.requestDevice = request;
      };
    const wrapped: GPUAdapter['requestDevice'] = async function (this: GPUAdapter, descriptor) {
      restore();
      const device = await request.call(this, descriptor);
      if (!tracker.disposed) tracker.track(device);
      return device;
    };
    adapter.requestDevice = wrapped;
    this.untrackNext = restore;
    return this;
  }

  /** Wraps a device's compile calls until `dispose()`, or until another `track`. */
  track(device: GPUDevice): void {
    if (this.disposed)
      throw new MargoError('disposed', 'PipelineCompiles is disposed; create a new one to track a device.');
    this.restore?.();
    this.tracked = device;
    const target = device as unknown as Record<Method, (descriptor: Descriptor) => unknown>,
      originals = METHODS.map((method) => target[method]),
      wrappers = METHODS.map((method, i) => {
        const create = originals[i],
          blocking = !method.endsWith('Async');
        return (descriptor: Descriptor) => this.timed(device, create, descriptor, kinds[method], blocking);
      });
    METHODS.forEach((method, i) => {
      target[method] = wrappers[i];
    });
    this.restore = () => {
      // Something that wrapped these after us owns them now; writing the originals back would remove it.
      METHODS.forEach((method, i) => {
        if (target[method] === wrappers[i]) target[method] = originals[i];
      });
      this.restore = undefined;
    };
  }
  private timed(
    device: GPUDevice,
    create: (descriptor: Descriptor) => unknown,
    descriptor: Descriptor,
    kind: CompileRecord['kind'],
    blocking: boolean,
  ): unknown {
    const record: CompileRecord = {
      kind,
      label: descriptor.label || descriptor.vertex?.module?.label || descriptor.compute?.module?.label || '',
      blocking,
      startedAt: performance.now(),
      frame: this.frames,
      milliseconds: null,
      failed: false,
      ...(this.stacks && { stack: new Error().stack?.split('\n').slice(3).join('\n') }),
    };
    this.count++;
    this.records.push(record);
    if (this.records.length > this.capacity) this.records.shift();
    const finish = (failed: boolean) => {
      record.milliseconds = performance.now() - record.startedAt;
      record.failed = failed;
      if (blocking) this.blockingMilliseconds += record.milliseconds;
    };
    let result: unknown;
    try {
      result = create.call(device, descriptor);
    } catch (error) {
      finish(true);
      throw error;
    }
    if (blocking) {
      finish(false);
      return result;
    }
    return (result as Promise<unknown>).then(
      (value) => {
        finish(false);
        return value;
      },
      (error) => {
        finish(true);
        throw error;
      },
    );
  }

  /**
   * Ends a frame of this length, ending at `at`, and returns the hitch it makes, or null. Records are searched only
   * for a slow frame, so a normal frame allocates nothing.
   */
  frame(milliseconds: number, at: number = performance.now()): CompileHitch | null {
    if (this.disposed)
      throw new MargoError('disposed', 'PipelineCompiles is disposed; create a new one to sample frames.');
    if (!Number.isFinite(milliseconds) || milliseconds <= 0 || !Number.isFinite(at))
      throw new RangeError('Invalid frame; pass milliseconds above 0 and a finite time.');
    // The frame before counts: a call made in it can stall the GPU process until the frame after.
    const from = at - milliseconds - this.previous,
      number = ++this.frames;
    this.previous = milliseconds;
    if (milliseconds <= this.hitchMilliseconds) return null;
    const compiles = this.records.filter(
      (record) => record.startedAt <= at && record.startedAt + running(record, at) >= from,
    );
    if (!compiles.length) return null;
    compiles.sort((a, b) => +b.blocking - +a.blocking || running(b, at) - running(a, at));
    const hitch = { frame: number, at, milliseconds, compiles };
    this.hitches.push(hitch);
    if (this.hitches.length > this.capacity) this.hitches.shift();
    this.listeners.forEach((listener) => listener(hitch));
    return hitch;
  }
  /** Calls `listener` for each hitch; returns its remover. */
  onHitch(listener: (hitch: CompileHitch) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  /** A copy of what was seen. */
  toJSON(): PipelineCompilesReport {
    return {
      frames: this.frames,
      count: this.count,
      blockingMilliseconds: this.blockingMilliseconds,
      compiles: this.records.map((record) => ({ ...record })),
      hitches: this.hitches.map((hitch) => ({
        ...hitch,
        compiles: hitch.compiles.map((record) => ({ ...record })),
      })),
    };
  }
  /** Shows the totals and the newest hitch in a row of the Stats panel, refreshed twice a second until `dispose()`. */
  view(stats: Stats): this {
    if (this.row) return this;
    const row = (this.row = stats.element.ownerDocument.createElement('div')),
      show = () => {
        const hitch = this.hitches.at(-1),
          worst = hitch?.compiles[0];
        row.textContent =
          `Compiles ${this.count}, ${this.hitches.length} hitches` +
          (hitch ? `\nLast ${hitch.milliseconds.toFixed(1)} ms: ${worst!.label || worst!.kind}` : '');
      };
    row.style.whiteSpace = 'pre-line';
    stats.element.append(row);
    show();
    this.timer = setInterval(show, 500);
    return this;
  }

  setup(engine: Engine): void {
    if (this.disposed)
      throw new MargoError('disposed', 'PipelineCompiles is disposed; create a new one and add it to the engine.');
    if (this.engine)
      throw new MargoError('attached', 'PipelineCompiles is already attached to an engine; create one per engine.');
    this.engine = engine;
    if (engine.gpu && engine.gpu !== this.tracked) this.track(engine.gpu);
    this.removeFrameListener = engine.onFrame((_engine, delta) => {
      const now = performance.now();
      // Delta 0 is a restart: the time since the last frame was a pause, not a slow frame.
      if (delta === 0) this.previous = 0;
      else if (this.last) this.frame(now - this.last, now);
      this.last = now;
    });
  }
  onDeviceRestored(engine: Engine): void {
    this.restore?.();
    this.last = this.previous = 0;
    if (engine.gpu) this.track(engine.gpu);
  }
  /** Stops watching and removes the view; the device goes back to its own calls. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.removeFrameListener?.();
    this.removeFrameListener = undefined;
    this.engine?.sceneOf(this)?.removePlugin(this.name);
    this.engine = undefined;
    this.untrackNext?.();
    this.restore?.();
    clearInterval(this.timer);
    this.row?.remove();
    this.row = undefined;
    this.listeners.clear();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
