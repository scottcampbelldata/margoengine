/// <reference lib="esnext.disposable" preserve="true" />
import { deviceUnsupported } from './errors.js';
import { ModulePool } from './module-pool.js';
import { jobTimeout, payload, timeLimit, workerLimit } from './pool.js';
import { uploadTexture, type TextureFile, type UploadTextureOptions } from './texture-file.js';

export { uploadTexture } from './texture-file.js';
export type { TextureFile, TextureFileLevel, UploadTextureOptions } from './texture-file.js';

/** Output of the clean-room HDR6 decoder. Half float uploads on every WebGPU device. */
export type HDR6Target = 'rgba16float' | 'rgb9e5' | 'astc-hdr-6x6';
/** Options of {@link KTX2HDR6Decoder}; all decoder assets load on first use. */
export interface KTX2HDR6Options {
  /** Device used by createTexture. Default none. */
  device?: GPUDevice;
  /** Default rgba16float. ASTC HDR blocks are for offline tools; WebGPU has no HDR ASTC format. */
  target?: HDR6Target;
  /** Folder containing hdr6.wasm. Default the package asset. */
  decoderPath?: string;
  /** Hardware threads capped at four by default. Range 1 to 16. */
  workerLimit?: number;
  /** Milliseconds per job, default 10 seconds plus 4 seconds per MiB. Infinity disables the watchdog. */
  timeout?: number;
}
/** Options for one complete KTX2 texture. */
export interface HDR6DecodeOptions {
  signal?: AbortSignal;
  /** Transfer a whole input ArrayBuffer. Default false. */
  transfer?: boolean;
  /** Largest base-level width times height times image count. Default 2^26. */
  maxPixels?: number;
}

/** Clean-room Rust/Wasm UASTC HDR 6x6i and ASTC HDR 6x6, in browser or Node workers. */
export class KTX2HDR6Decoder {
  readonly workerLimit: number;
  readonly target: HDR6Target;
  readonly device?: GPUDevice;
  private readonly timeout?: number;
  private readonly decoderPath?: string;
  private readonly pool: ModulePool;

  constructor(options: KTX2HDR6Options = {}) {
    this.workerLimit = workerLimit(options.workerLimit);
    this.target = options.target ?? 'rgba16float';
    if (!['rgba16float', 'rgb9e5', 'astc-hdr-6x6'].includes(this.target))
      throw new TypeError(`Unknown HDR6 target ${this.target}; use rgba16float, rgb9e5 or astc-hdr-6x6`);
    this.device = options.device;
    this.decoderPath = options.decoderPath;
    this.timeout = timeLimit(options.timeout);
    this.pool = new ModulePool(
      this.workerLimit,
      new URL('./hdr6.worker.js?no-inline', import.meta.url),
      'Margo HDR6 decode',
    );
  }
  /** Decode every mip, array layer and cube face to a TextureFile; errors reject the promise. */
  async decode(data: ArrayBuffer | ArrayBufferView, options: HDR6DecodeOptions = {}): Promise<TextureFile> {
    options.signal?.throwIfAborted();
    const buffer = payload(data, options.transfer ?? false);
    const wasmURL =
      this.decoderPath === undefined
        ? new URL('./hdr6.wasm', import.meta.url).href
        : new URL(
            'hdr6.wasm',
            new URL(
              this.decoderPath.endsWith('/') ? this.decoderPath : this.decoderPath + '/',
              globalThis.location?.href,
            ),
          ).href;
    return this.pool.run<TextureFile>(
      { buffer, wasmURL, target: this.target, maxPixels: options.maxPixels },
      [buffer],
      options.signal,
      this.timeout ?? jobTimeout(buffer.byteLength),
    );
  }
  /** Decode and upload all levels to the device passed to the constructor. */
  async createTexture(
    data: ArrayBuffer | ArrayBufferView,
    options: HDR6DecodeOptions & UploadTextureOptions = {},
  ): Promise<GPUTexture> {
    if (!this.device) throw new TypeError('KTX2HDR6Decoder.createTexture needs options.device');
    if (this.target === 'astc-hdr-6x6')
      throw deviceUnsupported('WebGPU has no ASTC HDR texture format; use rgba16float or rgb9e5');
    const file = await this.decode(data, options);
    options.signal?.throwIfAborted();
    return uploadTexture(this.device, file, options);
  }
  /** Terminate pending jobs. A later decode starts fresh workers. */
  dispose(): void {
    this.pool.dispose();
  }
  /** Explicit resource management. */
  [Symbol.dispose](): void {
    this.dispose();
  }
}
