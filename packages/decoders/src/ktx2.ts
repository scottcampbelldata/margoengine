/// <reference lib="esnext.disposable" preserve="true" />
import { transcodeFormats } from './formats.js';
import { WorkerPool, jobTimeout, payload, requireWorkers, timeLimit, workerLimit } from './pool.js';
import type { TranscodeTarget, TranscodedKTX2Result } from './protocol.js';
import { createKTX2Texture, getSupportedTranscodeFormat, type KTX2TextureOptions } from './texture.js';

export interface KTX2Options {
  /** Device whose enabled features choose the transcode target. */
  device?: GPUDevice;
  /** Override the negotiated target, e.g. 'rgba8' for CPU readback. */
  target?: TranscodeTarget;
  /** Folder holding basis_transcoder.js and basis_transcoder.wasm. Defaults to the copy bundled with this package. */
  transcoderPath?: string;
  /** Maximum workers. Default: hardware threads capped at 4. */
  workerLimit?: number;
  /**
   * Most milliseconds one transcode may take before its worker is restarted and the transcode rejects. Default: 10 s plus
   * 4 s per MiB of input; Infinity disables the limit.
   */
  timeout?: number;
}

export interface KTX2DecodeOptions {
  signal?: AbortSignal;
  /** Transfer a whole input ArrayBuffer to the worker instead of copying it. The caller's buffer is detached. */
  transfer?: boolean;
}

/** Worker-pooled Basis Universal KTX2 transcoder. Construction is free and SSR-safe. */
export class KTX2Decoder {
  readonly workerLimit: number;
  readonly target: TranscodeTarget;
  readonly device?: GPUDevice;
  private readonly transcoderPath?: string;
  private readonly timeout?: number;
  private pool?: WorkerPool;

  constructor(options: KTX2Options = {}) {
    this.workerLimit = workerLimit(options.workerLimit);
    this.device = options.device;
    this.target = options.target ?? getSupportedTranscodeFormat(options.device);
    if (!transcodeFormats[this.target]) throw new TypeError(`Unknown transcode target ${this.target}`);
    this.transcoderPath = options.transcoderPath;
    this.timeout = timeLimit(options.timeout);
  }

  /** Transcode every mip level in a worker. Mip data arrives as views of one transferred buffer. */
  transcode(data: ArrayBuffer | ArrayBufferView, options: KTX2DecodeOptions = {}): Promise<TranscodedKTX2Result> {
    try {
      requireWorkers('KTX2Decoder');
      if (options.signal?.aborted) throw options.signal.reason ?? new DOMException('Aborted', 'AbortError');
      const buffer = payload(data, options.transfer ?? false);
      this.pool ??= new WorkerPool(this.workerLimit);
      return this.pool.run<TranscodedKTX2Result>(
        { type: 'ktx2', buffer, target: this.target, ...this.urls() },
        [buffer],
        options.signal,
        this.timeout ?? jobTimeout(buffer.byteLength),
        'KTX2 transcode',
      );
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /** Transcode and upload to a GPUTexture on the decoder's device. */
  async createTexture(
    data: ArrayBuffer | ArrayBufferView,
    options: KTX2DecodeOptions & KTX2TextureOptions = {},
  ): Promise<GPUTexture> {
    if (!this.device) throw new Error('KTX2Decoder.createTexture needs a device');
    const result = await this.transcode(data, options);
    options.signal?.throwIfAborted();
    return createKTX2Texture(this.device, result, options);
  }

  /** Terminate the workers. Pending transcodes reject. */
  dispose(): void {
    this.pool?.dispose();
    this.pool = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }

  private urls(): { transcoderURL: string; wasmURL: string } {
    if (this.transcoderPath !== undefined) {
      const base = new URL(
        this.transcoderPath.endsWith('/') ? this.transcoderPath : this.transcoderPath + '/',
        globalThis.location?.href,
      );
      return {
        transcoderURL: new URL('basis_transcoder.js', base).href,
        wasmURL: new URL('basis_transcoder.wasm', base).href,
      };
    }
    return {
      transcoderURL: new URL('./basis/basis_transcoder.js', import.meta.url).href,
      wasmURL: new URL('./basis/basis_transcoder.wasm', import.meta.url).href,
    };
  }
}
