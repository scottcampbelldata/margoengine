// Any stored texture as RGBA8 pixels (`@margoengine/decoders/image`), for tools that need the picture itself: an exporter
// writing PNG, a converter. The file's own signature picks the reader, and each reader loads only when a file needs it.
import { decodeFailed, deviceUnsupported } from './errors.js';
import type { TranscodedKTX2Result } from './protocol.js';
import type { TextureFile } from './texture-file.js';

/** A decoded image: RGBA8 rows, top row first, `width * height * 4` bytes, alpha not premultiplied. */
export interface DecodedImage {
  width: number;
  height: number;
  data: Uint8Array;
}

/** Options for {@link decodeImage}. */
export interface DecodeImageOptions {
  /** Aborts decoding of a KTX2 file; the promise rejects with the signal's reason. */
  signal?: AbortSignal;
}

/** The name of a file's image format from its first bytes, or undefined when it is not one {@link decodeImage} knows. */
export function imageFormat(bytes: Uint8Array): 'png' | 'jpeg' | 'webp' | 'dds' | 'ktx' | 'ktx2' | 'avif' | undefined {
  const text = (at: number, length: number): string => String.fromCharCode(...bytes.subarray(at, at + length));
  if (bytes[0] === 0x89 && text(1, 3) === 'PNG') return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (text(0, 4) === 'RIFF' && text(8, 4) === 'WEBP') return 'webp';
  if (text(0, 4) === 'DDS ') return 'dds';
  if (bytes[0] === 0xab && text(1, 6) === 'KTX 11') return 'ktx';
  if (bytes[0] === 0xab && text(1, 6) === 'KTX 20') return 'ktx2';
  if (text(4, 4) === 'ftyp' && /^avi[fs]$/.test(text(8, 4))) return 'avif';
  return undefined;
}


/**
 * The first layer of level 0 of a texture file as RGBA8: a missing green or blue is 0, a missing alpha is 255. Signed
 * formats map -1..1 to 0..255, as a normal map stored in an unsigned image does, so a missing channel is 128. Float
 * formats hold linear light, so they clamp to 0..1 and are sRGB encoded.
 *
 * @example
 * import {textureFileToRGBA} from 'margoengine/decoders/image';
 * import {parseDDS} from 'margoengine/decoders/dds';
 * const file = new Uint8Array([]); // the bytes of a .dds file
 * if (file.length) console.log(textureFileToRGBA(parseDDS(file)).width);
 *
 * @throws MargoError `unsupported` for ETC, EAC and ASTC blocks, which are not decoded on the CPU.
 */
export async function textureFileToRGBA(file: TextureFile): Promise<DecodedImage> {
  const { width, height, data: all } = file.mipmaps[0],
    format = file.format as string,
    count = width * height,
    out = new Uint8Array(count * 4);
  if (format.startsWith('bc')) {
    const { decodeBC } = await import('./bc.js');
    return decodeBC(format, all, width, height);
  }
  const { halfToFloat, linearToByte, signedByte } = await import('./bc.js'),
    view = new DataView(all.buffer, all.byteOffset, all.byteLength),
    unpacked = (width: number, read: (i: number, c: number) => number): void => {
      for (let i = 0; i < count; i++) {
        for (let c = 0; c < 3; c++) out[i * 4 + c] = c < width ? linearToByte(read(i, c)) : 0;
        out[i * 4 + 3] = width === 4 ? Math.round(Math.min(1, Math.max(0, read(i, 3))) * 255) : 255;
      }
    },
    bytes = (channels: number, signed: boolean): void => {
      for (let i = 0; i < count; i++)
        for (let c = 0; c < 4; c++) {
          const v = c < channels ? all[i * channels + c] : c === 3 ? 255 : signed ? 128 : 0;
          out[i * 4 + c] = signed && c < channels ? signedByte((v << 24) >> 24) : v;
        }
    };
  switch (format) {
    case 'rgba8unorm':
    case 'rgba8unorm-srgb':
      out.set(all.subarray(0, count * 4));
      break;
    case 'bgra8unorm':
    case 'bgra8unorm-srgb':
      for (let i = 0; i < count; i++) {
        out[i * 4] = all[i * 4 + 2];
        out[i * 4 + 1] = all[i * 4 + 1];
        out[i * 4 + 2] = all[i * 4];
        out[i * 4 + 3] = all[i * 4 + 3];
      }
      break;
    case 'r8unorm':
      bytes(1, false);
      break;
    case 'rg8unorm':
      bytes(2, false);
      break;
    case 'rgba8snorm':
      bytes(4, true);
      break;
    case 'rg8snorm':
      bytes(2, true);
      break;
    case 'r8snorm':
      bytes(1, true);
      break;
    case 'r16float':
      unpacked(1, (i) => halfToFloat(view.getUint16(i * 2, true)));
      break;
    case 'rg16float':
      unpacked(2, (i, c) => halfToFloat(view.getUint16((i * 2 + c) * 2, true)));
      break;
    case 'rgba16float':
      unpacked(4, (i, c) => halfToFloat(view.getUint16((i * 4 + c) * 2, true)));
      break;
    case 'r32float':
      unpacked(1, (i) => view.getFloat32(i * 4, true));
      break;
    case 'rg32float':
      unpacked(2, (i, c) => view.getFloat32((i * 2 + c) * 4, true));
      break;
    case 'rgba32float':
      unpacked(4, (i, c) => view.getFloat32((i * 4 + c) * 4, true));
      break;
    case 'rgb10a2unorm':
      for (let i = 0; i < count; i++) {
        const p = view.getUint32(i * 4, true);
        out[i * 4] = Math.round(((p & 1023) / 1023) * 255);
        out[i * 4 + 1] = Math.round((((p >>> 10) & 1023) / 1023) * 255);
        out[i * 4 + 2] = Math.round((((p >>> 20) & 1023) / 1023) * 255);
        out[i * 4 + 3] = Math.round(((p >>> 30) / 3) * 255);
      }
      break;
    case 'rgb9e5ufloat':
      unpacked(3, (i, c) => {
        const p = view.getUint32(i * 4, true);
        return (((p >>> (c * 9)) & 511) / 512) * 2 ** ((p >>> 27) - 15);
      });
      break;
    case 'rg11b10ufloat':
      unpacked(3, (i, c) => {
        const p = view.getUint32(i * 4, true),
          [shift, mantissa] = c === 0 ? [0, 6] : c === 1 ? [11, 6] : [22, 5],
          m = (p >>> shift) & ((1 << mantissa) - 1),
          e = (p >>> (shift + mantissa)) & 31;
        return e === 0 ? (m / 2 ** mantissa) * 2 ** -14 : (1 + m / 2 ** mantissa) * 2 ** (e - 15);
      });
      break;
    default:
      throw deviceUnsupported(`${format} blocks are not decoded on the CPU; export the texture as PNG, WebP, BC or Basis`);
  }
  return { width, height, data: out };
}

/** Basis Universal KTX2: a worker in a browser; in Node, which has no Web Worker, the same Wasm in this thread. */
async function transcodeBasis(bytes: Uint8Array, signal?: AbortSignal): Promise<DecodedImage> {
  if (typeof Worker !== 'undefined') {
    const { KTX2Decoder } = await import('./ktx2.js'),
      decoder = new KTX2Decoder({ target: 'rgba8', workerLimit: 1 });
    try {
      const { width, height, mipmaps } = await decoder.transcode(bytes, { signal });
      return { width, height, data: mipmaps[0].data };
    } finally {
      decoder.dispose();
    }
  }
  const { width, height, mipmaps } = await nodeKTX2.transcode(bytes, { signal });
  return { width, height, data: mipmaps[0].data };
}

/**
 * A KTX2 decoder for Node, which has no Web Worker for `KTX2Decoder`: it transcodes to RGBA8 in this thread. Pass it as
 * the `ktx2` option of `loadGLTF` to load a Basis Universal model there, for example to export it.
 *
 * @example
 * import {nodeKTX2} from 'margoengine/decoders/image';
 * const file = new Uint8Array([]); // the bytes of a .ktx2 file
 * if (file.length) console.log((await nodeKTX2.transcode(file)).mipmaps.length);
 */
export const nodeKTX2 = {
  async transcode(bytes: Uint8Array, options: DecodeImageOptions = {}): Promise<TranscodedKTX2Result> {
    options.signal?.throwIfAborted();
    const { module } = await nodeBasis(),
      { transcodeKTX2 } = await import('./codec.js');
    return transcodeKTX2(module, bytes, 'rgba8');
  },
};

let basis: ReturnType<typeof import('./codec.js').startBasis> | undefined;

// A name, not a literal: bundlers for the browser must not try to resolve Node's modules from this file.
const nodeImport = <T>(name: string): Promise<T> => import(/* @vite-ignore */ /* webpackIgnore: true */ name);

/** The vendored transcoder, loaded once from the package's own files. The folder's package.json marks it CommonJS. */
function nodeBasis(): ReturnType<typeof import('./codec.js').startBasis> {
  basis ??= (async () => {
    const [{ startBasis }, { createRequire }, { readFile }, { fileURLToPath }] = await Promise.all([
        import('./codec.js'),
        nodeImport<{ createRequire(from: string): (id: string) => import('./codec.js').BasisFactory }>('node:module'),
        nodeImport<{ readFile(file: URL): Promise<Uint8Array> }>('node:fs/promises'),
        nodeImport<{ fileURLToPath(file: URL): string }>('node:url'),
      ]),
      factory = createRequire(import.meta.url)(fileURLToPath(new URL('./basis/basis_transcoder.js', import.meta.url))),
      wasm = await readFile(new URL('./basis/basis_transcoder.wasm', import.meta.url));
    return startBasis(factory, wasm.slice().buffer as ArrayBuffer);
  })();
  return basis;
}

/**
 * Decodes a stored texture to RGBA8 pixels, top row first, whatever holds it: PNG, WebP, DDS, KTX or KTX2. Compressed
 * blocks are decoded on the CPU, Basis Universal through the transcoder this package ships.
 *
 * @example
 * import {decodeImage} from 'margoengine/decoders/image';
 * const file = new Uint8Array([]); // the bytes of a .webp, .dds or .ktx2 file
 * if (file.length) console.log((await decodeImage(file)).width);
 *
 * @throws TypeError when `bytes` is not a Uint8Array.
 * @throws MargoError `unsupported` for a JPEG, which needs no decoding to be written out, and for AVIF.
 * @throws MargoError `failed` when the bytes are not a known image, or are damaged.
 */
export async function decodeImage(bytes: Uint8Array, options: DecodeImageOptions = {}): Promise<DecodedImage> {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('decodeImage takes a Uint8Array of an image file');
  const format = imageFormat(bytes);
  switch (format) {
    case 'png':
      return (await import('./png.js')).decodePNG(bytes);
    case 'webp':
      return (await import('./webp.js')).parseWebP(bytes);
    case 'dds':
      return textureFileToRGBA((await import('./dds.js')).parseDDS(bytes));
    case 'ktx':
      return textureFileToRGBA((await import('./ktx.js')).parseKTX(bytes));
    case 'ktx2': {
      const { readKTX2Index } = await import('./ktx2-file.js');
      if (!readKTX2Index(bytes).vkFormat) return transcodeBasis(bytes, options.signal);
      return textureFileToRGBA(await (await import('./ktx2-layers.js')).parseKTX2(bytes, options));
    }
    case 'jpeg':
    case 'avif':
      throw deviceUnsupported(`decodeImage does not read ${format} files; use the browser's image decoder`);
    default:
      throw decodeFailed('This file is not an image decodeImage reads; pass a PNG, WebP, DDS, KTX or KTX2 file');
  }
}
