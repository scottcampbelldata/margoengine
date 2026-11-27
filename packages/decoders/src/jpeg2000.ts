// `@margoengine/decoders/jpeg2000`: JPEG 2000 Part 1 (Rec. ITU-T T.800 | ISO/IEC 15444-1), JP2 files and raw
// codestreams, to RGBA. The decoder is Margo's own Rust crate (jpeg2000-kernel), written from the standard and from
// Taubman and Marcellin, "JPEG2000: Image Compression Fundamentals, Standards and Practice" (Kluwer, 2002), and shipped
// as jpeg2000.wasm, which loads on the first decode.
/// <reference lib="esnext.disposable" preserve="true" />
import { wasmError } from '../../shared/errors.js';
import { checkInput, decodeJPEG2000Module, jpeg2000Settings, type JPEG2000Module } from './jpeg2000-codec.js';
import { ModulePool, wasmBytes } from './module-pool.js';
import { jobTimeout, payload, timeLimit, workerLimit } from './pool.js';

/**
 * Top-row-first straight alpha RGBA, `width * height * 4` samples: a Uint8Array at depth 8, a Uint16Array spanning
 * 0..65535 at depth 16. Grey images repeat the grey in R, G and B; sYCC is converted to RGB.
 */
export interface JPEG2000Image {
  width: number;
  height: number;
  depth: 8 | 16;
  data: Uint8Array | Uint16Array;
  /** True when the file stops early: the picture holds what its packets give, at lower quality. */
  truncated: boolean;
}

/** Worker and asset configuration of a {@link JPEG2000Decoder}. */
export interface JPEG2000Options {
  /** Default hardware thread count capped at four; range 1..16. */
  workerLimit?: number;
  /** Milliseconds per job. Default 10 seconds plus 4 seconds/MiB; Infinity disables the watchdog. */
  timeout?: number;
  /** Folder containing jpeg2000.wasm. Default the package asset, resolved on first decode. */
  decoderPath?: string;
}

/** What to decode from one image, its limits and its cancellation. */
export interface JPEG2000DecodeOptions {
  /** Resolution levels to drop: each halves the width and height (rounding up). Default 0, full size. */
  reduce?: number;
  /** Quality layers to decode, from the first. Default 0, every layer. */
  layers?: number;
  /** Bits per output sample, 8 or 16. Default 8. */
  depth?: 8 | 16;
  /** Largest output `width * height` accepted. Default 2^26, maximum 2^28. */
  maxPixels?: number;
  signal?: AbortSignal;
  /** Transfer a complete input ArrayBuffer to the worker. Default false. */
  transfer?: boolean;
}

/** Decodes on the calling thread; made by {@link loadJPEG2000}. */
export type JPEG2000Reader = (
  data: ArrayBuffer | ArrayBufferView,
  options?: Omit<JPEG2000DecodeOptions, 'signal' | 'transfer'>,
) => JPEG2000Image;

const wasmAsset = (decoderPath: string | undefined): string =>
  decoderPath === undefined
    ? new URL('./jpeg2000.wasm', import.meta.url).href
    : new URL(
        'jpeg2000.wasm',
        new URL(decoderPath.endsWith('/') ? decoderPath : decoderPath + '/', globalThis.location?.href),
      ).href;

/** JPEG 2000 decoding in module workers (browser or Node), off the calling thread. */
export class JPEG2000Decoder {
  readonly workerLimit: number;
  private readonly pool: ModulePool;
  private readonly timeout?: number;
  private readonly decoderPath?: string;
  constructor(options: JPEG2000Options = {}) {
    this.workerLimit = workerLimit(options.workerLimit);
    this.timeout = timeLimit(options.timeout);
    this.decoderPath = options.decoderPath;
    this.pool = new ModulePool(
      this.workerLimit,
      new URL('./jpeg2000.worker.js?no-inline', import.meta.url),
      'Margo JPEG 2000 decode',
    );
  }
  async decode(data: ArrayBuffer | ArrayBufferView, options: JPEG2000DecodeOptions = {}): Promise<JPEG2000Image> {
    options.signal?.throwIfAborted();
    const settings = jpeg2000Settings(options);
    checkInput(data.byteLength);
    const wasmURL = wasmAsset(this.decoderPath);
    const buffer = payload(data, options.transfer ?? false);
    return this.pool.run<JPEG2000Image>(
      { buffer, wasmURL, settings },
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

/** Decode one image in a worker and release the worker, including on cancellation or failure. */
export async function decodeJPEG2000(
  data: ArrayBuffer | ArrayBufferView,
  options: JPEG2000DecodeOptions = {},
): Promise<JPEG2000Image> {
  const decoder = new JPEG2000Decoder({ workerLimit: 1 });
  try {
    return await decoder.decode(data, options);
  } finally {
    decoder.dispose();
  }
}

const compiled = new Map<string, Promise<WebAssembly.Module>>();

/**
 * Loads the decoder and returns a synchronous reader for the calling thread, for code that is already off the main
 * thread or reads small images. A large image blocks its thread while it decodes; use {@link JPEG2000Decoder} then.
 * The compiled module is shared by later calls; each image gets its own instance, so its memory is released with it.
 */
export async function loadJPEG2000(
  options: { decoderPath?: string; signal?: AbortSignal } = {},
): Promise<JPEG2000Reader> {
  const { signal } = options;
  signal?.throwIfAborted();
  const url = wasmAsset(options.decoderPath);
  let loading = compiled.get(url);
  if (!loading) {
    loading = wasmBytes(url)
      .then((bytes) => WebAssembly.compile(bytes))
      .catch((error: unknown) => {
        // A failed load is not kept: the next call fetches again.
        compiled.delete(url);
        throw wasmError(error);
      });
    compiled.set(url, loading);
  }
  const module = await abortable(loading, signal);
  return (data, decodeOptions = {}) => {
    const bytes = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data);
    const { exports } = new WebAssembly.Instance(module);
    return decodeJPEG2000Module(exports as unknown as JPEG2000Module, bytes, jpeg2000Settings(decodeOptions));
  };
}

/** `promise`, rejecting with the signal's reason as soon as it aborts. The shared load carries on for other callers. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason);
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
