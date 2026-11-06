// Draco point clouds (`@margoengine/decoders/draco-points`). The glTF Draco build shipped for meshes has no point cloud decoder, so
// this entry uses Google's full build, in a worker pool of its own: nothing loads it unless a point cloud is decoded.
import { WorkerPool, jobTimeout, payload, requireWorkers, timeLimit, workerLimit } from './pool.js';
import type { DecodedDracoPoints, DracoPointsRequest } from './protocol.js';
import { validatedDracoLimits } from './protocol.js';

export type { DecodedDracoPoints, DracoPointsAttribute, DracoPointsRequest } from './protocol.js';

/** Options of a {@link DracoPointsDecoder}. */
export interface DracoPointsOptions {
  /** Folder holding Draco's full draco_wasm_wrapper.js and draco_decoder.wasm. Defaults to the copy bundled with this package. */
  decoderPath?: string;
  /** Maximum workers. Default: hardware threads capped at 4. */
  workerLimit?: number;
  /** Most milliseconds one decode may take before its worker is restarted. Default: 10 s plus 4 s per MiB of input. */
  timeout?: number;
}

/** Per-call options of {@link DracoPointsDecoder.decode}. */
export interface DracoPointsDecodeOptions extends DracoPointsRequest {
  signal?: AbortSignal;
  /** Transfer a whole input ArrayBuffer to the worker instead of copying it. The caller's buffer is detached. */
  transfer?: boolean;
}

/**
 * Worker-pooled decoder of Draco point clouds, with every attribute, generic ones included, and indices. Construction is free
 * and SSR-safe; workers and Wasm start on the first decode.
 *
 * @example
 * using decoder = new DracoPointsDecoder();
 * const { pointCount, attributes } = await decoder.decode(await (await fetch('/scan.drc')).arrayBuffer());
 * const intensity = attributes.find((attribute) => attribute.name === 'intensity');
 */
export class DracoPointsDecoder {
  readonly workerLimit: number;
  private readonly decoderPath?: string;
  private readonly timeout?: number;
  private pool?: WorkerPool;

  constructor(options: DracoPointsOptions = {}) {
    this.workerLimit = workerLimit(options.workerLimit);
    this.decoderPath = options.decoderPath;
    this.timeout = timeLimit(options.timeout);
  }

  /**
   * Decodes a `.drc` point cloud into transferable typed arrays.
   *
   * @throws RangeError when the cloud is over `limits`.
   * @throws MargoError `failed` for a mesh or a damaged file, `unsupported` without Web Workers.
   */
  decode(data: ArrayBuffer | ArrayBufferView, options: DracoPointsDecodeOptions = {}): Promise<DecodedDracoPoints> {
    try {
      requireWorkers('DracoPointsDecoder');
      if (options.signal?.aborted) throw options.signal.reason ?? new DOMException('Aborted', 'AbortError');
      const limits = validatedDracoLimits(options.limits),
        buffer = payload(data, options.transfer ?? false);
      this.pool ??= new WorkerPool(this.workerLimit);
      return this.pool.run<DecodedDracoPoints>(
        { type: 'draco-points', buffer, request: { limits }, ...this.urls() },
        [buffer],
        options.signal,
        this.timeout ?? jobTimeout(buffer.byteLength),
        'Draco points decode',
      );
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /** Terminate the workers. Pending decodes reject. */
  dispose(): void {
    this.pool?.dispose();
    this.pool = undefined;
  }

  [Symbol.dispose](): void {
    this.dispose();
  }

  private urls(): { wrapperURL: string; wasmURL: string } {
    if (this.decoderPath === undefined)
      return {
        wrapperURL: new URL('./draco-full/draco_wasm_wrapper.js', import.meta.url).href,
        wasmURL: new URL('./draco-full/draco_decoder.wasm', import.meta.url).href,
      };
    const base = new URL(
      this.decoderPath.endsWith('/') ? this.decoderPath : this.decoderPath + '/',
      globalThis.location?.href,
    );
    return {
      wrapperURL: new URL('draco_wasm_wrapper.js', base).href,
      wasmURL: new URL('draco_decoder.wasm', base).href,
    };
  }
}
