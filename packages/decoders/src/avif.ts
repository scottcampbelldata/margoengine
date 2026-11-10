/// <reference lib="esnext.disposable" preserve="true" />
import { ModulePool } from './module-pool.js';
import { jobTimeout, payload, timeLimit, workerLimit } from './pool.js';

/** CICP describes the encoded RGB values; ICC is retained without applying a display transform. */
export interface AVIFColor {
  primaries: number;
  transfer: number;
  matrix: number;
  fullRange: boolean;
  monochrome: boolean;
  subsamplingX: boolean;
  subsamplingY: boolean;
  chromaPosition: number;
  icc: Uint8Array;
}
/** Top-row-first straight alpha RGBA. rgba16 spans 0..65535 and retains 10/12-bit source precision. */
export interface AVIFImage {
  width: number;
  height: number;
  data: Uint8Array | Uint16Array;
  bitDepth: 8 | 10 | 12;
  color: AVIFColor;
}
/** Worker and asset configuration, loaded lazily by {@link AVIFDecoder}. */
export interface AVIFOptions {
  /** Default hardware thread count capped at four; range 1..16. */
  workerLimit?: number;
  /** Milliseconds per job. Default 10 seconds plus 4 seconds/MiB; Infinity disables the watchdog. */
  timeout?: number;
  /** Folder containing avif.wasm. Default the package asset, resolved on first decode. */
  decoderPath?: string;
}
/** Per-image output, cancellation and allocation limits. */
export interface AVIFDecodeOptions {
  signal?: AbortSignal;
  /** Transfer a complete input ArrayBuffer. Default false. */
  transfer?: boolean;
  /** Default rgba8; rgba16 preserves source precision as normalized unsigned integers. */
  format?: 'rgba8' | 'rgba16';
  /** Maximum width times height per image item, default 2^26. */
  maxPixels?: number;
  /** Input, item composition and conservative padded codec workspace budget. Default 512 MiB, maximum 1 GiB. */
  maxMemory?: number;
}

/** Margo-authored AV1 still-image decoder. One lazy SIMD Wasm module per browser or Node worker. */
export class AVIFDecoder {
  readonly workerLimit: number;
  private readonly pool: ModulePool;
  private readonly timeout?: number;
  private readonly decoderPath?: string;
  constructor(options: AVIFOptions = {}) {
    this.workerLimit = workerLimit(options.workerLimit);
    this.timeout = timeLimit(options.timeout);
    this.decoderPath = options.decoderPath;
    this.pool = new ModulePool(
      this.workerLimit,
      new URL('./avif.worker.js?no-inline', import.meta.url),
      'Margo AVIF decode',
    );
  }
  async decode(data: ArrayBuffer | ArrayBufferView, options: AVIFDecodeOptions = {}): Promise<AVIFImage> {
    options.signal?.throwIfAborted();
    const format = options.format ?? 'rgba8';
    if (format !== 'rgba8' && format !== 'rgba16') throw new TypeError('AVIF format must be rgba8 or rgba16');
    const maxPixels = options.maxPixels ?? 2 ** 26,
      maxMemory = options.maxMemory ?? 512 * 2 ** 20;
    if (!Number.isSafeInteger(maxPixels) || maxPixels < 1 || maxPixels > 0xffffffff)
      throw new RangeError('AVIF maxPixels must be 1..4294967295');
    if (!Number.isSafeInteger(maxMemory) || maxMemory < 1 || maxMemory > 2 ** 30)
      throw new RangeError('AVIF maxMemory must be 1..1073741824 bytes');
    const length = data.byteLength;
    if (length > maxMemory / 2)
      throw new RangeError('AVIF input exceeds maxMemory; increase the budget or reduce the image');
    const wasmURL =
      this.decoderPath === undefined
        ? new URL('./avif.wasm', import.meta.url).href
        : new URL(
            'avif.wasm',
            new URL(
              this.decoderPath.endsWith('/') ? this.decoderPath : this.decoderPath + '/',
              globalThis.location?.href,
            ),
          ).href;
    const buffer = payload(data, options.transfer ?? false);
    return this.pool.run<AVIFImage>(
      { buffer, wasmURL, format, maxPixels, maxMemory },
      [buffer],
      options.signal,
      this.timeout ?? jobTimeout(buffer.byteLength),
    );
  }
  /** Terminate active and queued jobs. Subsequent calls create fresh workers. */
  dispose(): void {
    this.pool.dispose();
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}

/** Decode one image and release its worker, including on cancellation or failure. */
export async function decodeAVIF(
  data: ArrayBuffer | ArrayBufferView,
  options: AVIFDecodeOptions = {},
): Promise<AVIFImage> {
  const decoder = new AVIFDecoder({ workerLimit: 1 });
  try {
    return await decoder.decode(data, options);
  } finally {
    decoder.dispose();
  }
}
