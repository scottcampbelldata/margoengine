import {WorkerPool, payload, requireWorkers, workerLimit} from './pool.js';
import type {DecodedDracoGeometry, DracoRequest} from './protocol.js';

export interface DracoOptions {
  /** Folder holding draco_wasm_wrapper.js and draco_decoder.wasm, e.g. 'https://www.gstatic.com/draco/versioned/decoders/1.5.7/'. Defaults to the copy bundled with this package. */
  decoderPath?: string;
  /** Maximum workers. Default: hardware threads capped at 4. */
  workerLimit?: number;
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
  private pool?: WorkerPool;

  constructor(options: DracoOptions = {}) {
    this.workerLimit = workerLimit(options.workerLimit);
    this.decoderPath = options.decoderPath;
  }

  /** Decode a Draco buffer, such as a KHR_draco_mesh_compression bufferView, into transferable typed arrays. */
  decode(data: ArrayBuffer | ArrayBufferView, options: DracoDecodeOptions = {}): Promise<DecodedDracoGeometry> {
    try {
      requireWorkers('DracoDecoder');
      const buffer = payload(data, options.transfer ?? false), {attributeIds, componentTypes} = options;
      this.pool ??= new WorkerPool(this.workerLimit);
      return this.pool.run<DecodedDracoGeometry>({type: 'draco', buffer, request: {attributeIds, componentTypes}, ...this.urls()}, [buffer], options.signal);
    } catch (error) {return Promise.reject(error);}
  }

  /** Terminate the workers. Pending decodes reject. */
  dispose(): void {this.pool?.dispose(); this.pool = undefined;}

  private urls(): {wrapperURL: string; wasmURL: string} {
    if (this.decoderPath !== undefined) {
      const base = new URL(this.decoderPath.endsWith('/') ? this.decoderPath : this.decoderPath + '/', globalThis.location?.href);
      return {wrapperURL: new URL('draco_wasm_wrapper.js', base).href, wasmURL: new URL('draco_decoder.wasm', base).href};
    }
    return {wrapperURL: new URL('./draco/draco_wasm_wrapper.js', import.meta.url).href, wasmURL: new URL('./draco/draco_decoder.wasm', import.meta.url).href};
  }
}
