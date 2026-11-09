import { WorkerPool, jobTimeout, payload, requireWorkers, timeLimit, workerLimit } from './pool.js';
import { validatedDracoLimits } from './protocol.js';
import type { DecodedDracoGeometry, DecodedDracoPoints } from './protocol.js';
import type { DracoOptions, DracoDecodeOptions } from './draco.js';
import type { DracoPointsOptions, DracoPointsDecodeOptions } from './draco-points.js';

export type { DracoOptions, DracoDecodeOptions } from './draco.js';
export type { DracoPointsOptions, DracoPointsDecodeOptions } from './draco-points.js';
export type { DecodedDracoGeometry, DecodedDracoPoints } from './protocol.js';

class NativePool {
  readonly workerLimit: number;
  private readonly timeout?: number;
  private pool?: WorkerPool;
  constructor(private readonly options: DracoOptions) {
    this.workerLimit = workerLimit(options.workerLimit);
    this.timeout = timeLimit(options.timeout);
  }
  run<T>(data: ArrayBuffer | ArrayBufferView, options: DracoDecodeOptions, points: boolean): Promise<T> {
    try {
      requireWorkers('Clean-room Draco decoder');
      if (options.signal?.aborted) throw options.signal.reason ?? new DOMException('Aborted', 'AbortError');
      const limits = validatedDracoLimits(options.limits);
      const buffer = payload(data, options.transfer ?? false);
      const path = this.options.decoderPath;
      const wasmURL =
        path === undefined
          ? new URL('./draco-native.wasm', import.meta.url).href
          : new URL('draco-native.wasm', new URL(path.endsWith('/') ? path : path + '/', globalThis.location?.href))
              .href;
      this.pool ??= new WorkerPool(
        this.workerLimit,
        () =>
          new Worker(new URL('./draco-native.worker.js?no-inline', import.meta.url), {
            name: 'margoengine-draco-native',
          }),
      );
      return this.pool.run<T>(
        {
          type: points ? 'points' : 'mesh',
          buffer,
          wasmURL,
          request: { attributeIds: options.attributeIds, componentTypes: options.componentTypes, limits },
        },
        [buffer],
        options.signal,
        this.timeout ?? jobTimeout(buffer.byteLength),
        'Clean-room Draco decode',
      );
    } catch (error) {
      return Promise.reject(error);
    }
  }
  dispose(): void {
    this.pool?.dispose();
    this.pool = undefined;
  }
}

/**
 * Optional clean-room Rust/Wasm mesh decoder. Same decode contract as the default decoder; warm speed parity is open.
 * Construction is SSR-safe. One Wasm per worker loads on first decode. decoderPath overrides its asset folder.
 * @example
 * using decoder = new DracoDecoder();
 * const geometry = await decoder.decode(await (await fetch('/mesh.drc')).arrayBuffer());
 */
export class DracoDecoder {
  private readonly native: NativePool;
  /** Maximum workers, default hardware threads capped at four. */
  readonly workerLimit: number;
  constructor(options: DracoOptions = {}) {
    this.native = new NativePool(options);
    this.workerLimit = this.native.workerLimit;
  }
  /** Decode a mesh; limits, transfer and cancellation match the default decoder. */
  decode(data: ArrayBuffer | ArrayBufferView, options: DracoDecodeOptions = {}): Promise<DecodedDracoGeometry> {
    return this.native.run(data, options, false);
  }
  /** Terminate workers and reject pending jobs. A later decode starts fresh workers. */
  dispose(): void {
    this.native.dispose();
  }
  /** Dispose using explicit resource management. */
  [Symbol.dispose](): void {
    this.dispose();
  }
}

/** Optional full-flavor clean-room Rust/Wasm point decoder, with the default point decoder's result contract. */
export class DracoPointsDecoder {
  private readonly native: NativePool;
  /** Maximum workers, default hardware threads capped at four. */
  readonly workerLimit: number;
  constructor(options: DracoPointsOptions = {}) {
    this.native = new NativePool(options);
    this.workerLimit = this.native.workerLimit;
  }
  /** Decode every native point attribute and identity indices, with cancellation and bounded output. */
  decode(data: ArrayBuffer | ArrayBufferView, options: DracoPointsDecodeOptions = {}): Promise<DecodedDracoPoints> {
    return this.native.run(data, options, true);
  }
  /** Terminate workers and reject pending jobs. */
  dispose(): void {
    this.native.dispose();
  }
  /** Dispose using explicit resource management. */
  [Symbol.dispose](): void {
    this.dispose();
  }
}
