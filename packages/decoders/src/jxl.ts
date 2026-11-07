// JPEG XL (`@margoengine/decoders/jxl`). The browser decodes when it can; elsewhere a module worker loads the vendored
// jxl-oxide Wasm on the first decode, so importing this entry costs its own few kilobytes. The output is RGBA8 either way.
import { readJXLHeader } from './jxl-file.js';
import type { DecodedJXL } from './jxl-render.js';
import { WorkerPool, jobTimeout, payload, requireWorkers, timeLimit, workerLimit } from './pool.js';
import type { TextureFile } from './texture-file.js';

export { readJXLHeader, type JXLHeader } from './jxl-file.js';
export type { DecodedJXL } from './jxl-render.js';
export { uploadTexture } from './texture-file.js';

/** Options of a {@link JXLDecoder}. */
export interface JXLDecoderOptions {
  /** Folder holding jxl_oxide_wasm_bg.wasm. Defaults to the copy bundled with this package. */
  decoderPath?: string;
  /** Try the browser's own decoder first. Default true; false always uses the Wasm module. */
  browser?: boolean;
  /** Maximum workers. Default: hardware threads capped at 4. */
  workerLimit?: number;
  /** Most milliseconds one decode may take before its worker is restarted. Default: 10 s plus 4 s per MiB of input. */
  timeout?: number;
}

/** Per-call options of {@link JXLDecoder.decode}. */
export interface JXLDecodeOptions {
  signal?: AbortSignal;
  /** Largest `width * height` accepted. Default 2^26 (an 8192 x 8192 image), 256 MiB of RGBA8. */
  maxPixels?: number;
  /** Transfer a whole input ArrayBuffer to the worker instead of copying it. The caller's buffer is detached. */
  transfer?: boolean;
}

/**
 * A decoded JPEG XL image: RGBA8 rows, top row first, straight alpha, `width * height * 4` bytes. sRGB, unless the Wasm path
 * read a file with an ICC profile not stored in XYB: those samples come out as stored (docs/known-bugs.md).
 */
export interface JXLImage extends DecodedJXL {
  hasAlpha: boolean;
  /** True for an animation, of which `data` is the first frame. */
  animated: boolean;
  /** Which decoder ran. */
  decoder: 'browser' | 'wasm';
}

// False once the browser refused a file the Wasm module then read, so later files skip the attempt.
let browserReads = true;

async function decodeInBrowser(bytes: Uint8Array): Promise<DecodedJXL | undefined> {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') return undefined;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/jxl' }), {
      premultiplyAlpha: 'none',
    });
  } catch {
    // Not an error yet: this browser may not read JPEG XL. The Wasm module decides, and reports a bad file.
    return undefined;
  }
  const { width, height } = bitmap,
    context = new OffscreenCanvas(width, height).getContext('2d', { colorSpace: 'srgb', willReadFrequently: true })!;
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  return { width, height, data: new Uint8Array(context.getImageData(0, 0, width, height).data.buffer) };
}

/**
 * JPEG XL decoder. Construction is free and SSR-safe; the worker and the Wasm start on the first decode that needs them.
 *
 * @example
 * using decoder = new JXLDecoder();
 * const image = await decoder.decode(await (await fetch('/rock.jxl')).arrayBuffer());
 * const texture = uploadTexture(device, jxlTextureFile(image));
 */
export class JXLDecoder {
  readonly workerLimit: number;
  private readonly decoderPath?: string;
  private readonly browser: boolean;
  private readonly timeout?: number;
  private pool?: WorkerPool;

  constructor(options: JXLDecoderOptions = {}) {
    this.workerLimit = workerLimit(options.workerLimit);
    this.decoderPath = options.decoderPath;
    this.browser = options.browser ?? true;
    this.timeout = timeLimit(options.timeout);
  }

  /**
   * Decodes the first frame of a JPEG XL file to RGBA8.
   *
   * @throws RangeError when the image is larger than `maxPixels`.
   * @throws MargoError `failed` when the file is cut short or corrupt or has no RGB rendering; `unsupported` without Web
   * Workers when the browser cannot read it.
   */
  async decode(data: ArrayBuffer | ArrayBufferView, options: JXLDecodeOptions = {}): Promise<JXLImage> {
    if (options.signal?.aborted) throw options.signal.reason ?? new DOMException('Aborted', 'AbortError');
    const bytes = ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data),
      { hasAlpha, animated, width, height } = readJXLHeader(bytes),
      maxPixels = options.maxPixels ?? 2 ** 26;
    if (width * height > maxPixels)
      throw new RangeError(`JPEG XL is ${width} x ${height}, over maxPixels ${maxPixels}; raise maxPixels to decode it`);
    if (this.browser && browserReads) {
      const decoded = await decodeInBrowser(bytes);
      if (decoded) return { ...decoded, hasAlpha, animated, decoder: 'browser' };
    }
    requireWorkers('JXLDecoder');
    const buffer = payload(data, options.transfer ?? false);
    this.pool ??= new WorkerPool(
      this.workerLimit,
      () => new Worker(new URL('./jxl.worker.js', import.meta.url), { type: 'module', name: 'margoengine-jxl' }),
    );
    const decoded = await this.pool.run<DecodedJXL>(
      { buffer, wasmURL: this.wasmURL(), maxPixels },
      [buffer],
      options.signal,
      this.timeout ?? jobTimeout(buffer.byteLength),
      'JPEG XL decode',
    );
    if (this.browser) browserReads = false;
    return { ...decoded, hasAlpha, animated, decoder: 'wasm' };
  }

  /** Terminate the workers. Pending decodes reject. */
  dispose(): void {
    this.pool?.dispose();
    this.pool = undefined;
  }

  [Symbol.dispose](): void {
    this.dispose();
  }

  private wasmURL(): string {
    if (this.decoderPath === undefined) return new URL('./jxl/jxl_oxide_wasm_bg.wasm', import.meta.url).href;
    const base = new URL(
      this.decoderPath.endsWith('/') ? this.decoderPath : this.decoderPath + '/',
      globalThis.location?.href,
    );
    return new URL('jxl_oxide_wasm_bg.wasm', base).href;
  }
}

/**
 * A decoded image as a {@link TextureFile} in `rgba8unorm-srgb`, for `uploadTexture` or `new Texture(file)`.
 *
 * @example
 * const texture = uploadTexture(device, jxlTextureFile(await decoder.decode(file)));
 */
export function jxlTextureFile(image: DecodedJXL & { hasAlpha?: boolean }): TextureFile {
  const { width, height, data } = image;
  return {
    width,
    height,
    layers: 1,
    dimension: '2d',
    mipmaps: [{ data, width, height, byteLength: data.length }],
    format: 'rgba8unorm-srgb',
    target: 'jxl',
    srgb: true,
    hasAlpha: image.hasAlpha ?? true,
  };
}
