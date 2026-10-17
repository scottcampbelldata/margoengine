import { WorkerPool, jobTimeout, payload, requireWorkers, timeLimit, workerLimit } from './pool.js';
import type { DecodedDracoGeometry, DracoRequest } from './protocol.js';
import { validatedDracoLimits } from './protocol.js';

export interface DracoOptions {
  /** Folder holding draco_wasm_wrapper.js and draco_decoder.wasm, e.g. 'https://www.gstatic.com/draco/versioned/decoders/1.5.7/'. Defaults to the copy bundled with this package. */
  decoderPath?: string;
  /** Maximum workers. Default: hardware threads capped at 4. */
  workerLimit?: number;
  /**
   * Most milliseconds one decode may take before its worker is restarted and the decode rejects. Default: 10 s plus
   * 4 s per MiB of input; Infinity disables the limit.
   */
  timeout?: number;
}

export interface DracoDecodeOptions extends DracoRequest {
  signal?: AbortSignal;
  /** Transfer a whole input ArrayBuffer to the worker instead of copying it. The caller's buffer is detached. */
  transfer?: boolean;
}

/** Worker-pooled Google Draco decoder. Construction is free and SSR-safe; workers and Wasm start on the first decode. */
export class DracoDecoder {
  readonly workerLimit: number;
  private readonly decoderPath?: string;
  private readonly timeout?: number;
  private pool?: WorkerPool;

  constructor(options: DracoOptions = {}) {
    this.workerLimit = workerLimit(options.workerLimit);
    this.decoderPath = options.decoderPath;
    this.timeout = timeLimit(options.timeout);
  }

  /** Decode a Draco buffer, such as a KHR_draco_mesh_compression bufferView, into transferable typed arrays. */
  decode(data: ArrayBuffer | ArrayBufferView, options: DracoDecodeOptions = {}): Promise<DecodedDracoGeometry> {
    try {
      requireWorkers('DracoDecoder');
      if (options.signal?.aborted) throw options.signal.reason ?? new DOMException('Aborted', 'AbortError');
      const limits = validatedDracoLimits(options.limits);
      const buffer = payload(data, options.transfer ?? false),
        { attributeIds, componentTypes } = options;
      this.pool ??= new WorkerPool(this.workerLimit);
      return this.pool.run<DecodedDracoGeometry>(
        { type: 'draco', buffer, request: { attributeIds, componentTypes, limits }, ...this.urls() },
        [buffer],
        options.signal,
        this.timeout ?? jobTimeout(buffer.byteLength),
        'Draco decode',
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
    if (this.decoderPath !== undefined) {
      const base = new URL(
        this.decoderPath.endsWith('/') ? this.decoderPath : this.decoderPath + '/',
        globalThis.location?.href,
      );
      return {
        wrapperURL: new URL('draco_wasm_wrapper.js', base).href,
        wasmURL: new URL('draco_decoder.wasm', base).href,
      };
    }
    return {
      wrapperURL: new URL('./draco/draco_wasm_wrapper.js', import.meta.url).href,
      wasmURL: new URL('./draco/draco_decoder.wasm', import.meta.url).href,
    };
  }
}
