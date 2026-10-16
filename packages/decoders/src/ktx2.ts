/// <reference lib="esnext.disposable" preserve="true" />
import { transcodeFormats } from './formats.js';
import { WorkerPool, payload, requireWorkers, workerLimit } from './pool.js';
import type { TranscodeTarget, TranscodedKTX2Result } from './protocol.js';

declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number };

/** Pick the best compressed format the device has enabled: BC7 on desktop, ASTC on mobile and Apple, ETC2 on Android, else RGBA8. */
export function getSupportedTranscodeFormat(device?: { features: ReadonlySetLike<string> }): TranscodeTarget {
  const features = device?.features;
  if (features?.has('texture-compression-bc')) return 'bc7';
  if (features?.has('texture-compression-astc')) return 'astc-4x4';
  if (features?.has('texture-compression-etc2')) return 'etc2';
  return 'rgba8';
}

type ReadonlySetLike<T> = { has(value: T): boolean };

/** Bytes per row of one mip level for `writeTexture`. Block formats count 4-pixel blocks. */
export function getBytesPerRow(format: GPUTextureFormat, width: number): number {
  const base = format.replace(/-srgb$/, ''),
    entry = Object.values(transcodeFormats).find((f) => f.gpu === base);
  if (!entry) throw new TypeError(`Unsupported KTX2 texture format ${format}`);
  return Math.ceil(width / entry.block) * entry.blockBytes;
}

export interface KTX2TextureOptions {
  label?: string;
  /** Default: TEXTURE_BINDING | COPY_DST. */
  usage?: number;
}

/** Allocate the texture in its compressed format and write every mip level directly from the transferred buffer. */
export function createKTX2Texture(
  device: GPUDevice,
  result: TranscodedKTX2Result,
  options: KTX2TextureOptions = {},
): GPUTexture {
  const block = transcodeFormats[result.target]?.block ?? 1;
  const texture = device.createTexture({
    label: options.label,
    size: [result.width, result.height, 1],
    mipLevelCount: result.mipmaps.length,
    format: result.format,
    usage: options.usage ?? GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  try {
    result.mipmaps.forEach((mip, level) => {
      // Small block-compressed mips are copied at their physical (block-rounded) size.
      const width = Math.ceil(mip.width / block) * block,
        height = Math.ceil(mip.height / block) * block;
      device.queue.writeTexture(
        { texture, mipLevel: level },
        mip.data as Uint8Array<ArrayBuffer>,
        { bytesPerRow: getBytesPerRow(result.format, mip.width), rowsPerImage: height },
        [width, height, 1],
      );
    });
  } catch (error) {
    texture.destroy();
    throw error;
  }
  return texture;
}

export interface KTX2Options {
  /** Device whose enabled features choose the transcode target. */
  device?: GPUDevice;
  /** Override the negotiated target, e.g. 'rgba8' for CPU readback. */
  target?: TranscodeTarget;
  /** Folder holding basis_transcoder.js and basis_transcoder.wasm. Defaults to the copy bundled with this package. */
  transcoderPath?: string;
  /** Maximum workers. Default: hardware threads capped at 4. */
  workerLimit?: number;
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
  private pool?: WorkerPool;

  constructor(options: KTX2Options = {}) {
    this.workerLimit = workerLimit(options.workerLimit);
    this.device = options.device;
    this.target = options.target ?? getSupportedTranscodeFormat(options.device);
    if (!transcodeFormats[this.target]) throw new TypeError(`Unknown transcode target ${this.target}`);
    this.transcoderPath = options.transcoderPath;
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
