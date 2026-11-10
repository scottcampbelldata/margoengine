// Any stored texture as RGBA8 pixels (`@margoengine/decoders/image`), for tools that need the picture itself: an exporter
// writing PNG, a converter. The file's own signature picks the reader, and each reader loads only when a file needs it.
import { decodeFailed, deviceUnsupported } from './errors.js';
import { readKTX2Index } from './ktx2-file.js';
import { decodePNG } from './png.js';
import type { TranscodedKTX2Result } from './protocol.js';
import { textureFileToRGBA } from './texture-rgba.js';
export { textureFileToRGBA } from './texture-rgba.js';

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


/** Basis Universal KTX2: a worker in a browser; in Node, which has no Web Worker, the same Wasm in this thread. */
async function transcodeBasis(bytes: Uint8Array, signal?: AbortSignal): Promise<DecodedImage> {
  if (typeof Worker !== 'undefined') {
    const { KTX2Decoder } = await import('./image-ktx2.js'),
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
  if (!(bytes instanceof Uint8Array)) throw new TypeError("bytes must be a Uint8Array; pass the image file's bytes");
  const format = imageFormat(bytes);
  switch (format) {
    case 'png':
      return decodePNG(bytes);
    case 'webp':
      return (await import('./webp.js')).parseWebP(bytes);
    case 'dds':
      return textureFileToRGBA((await import('./dds.js')).parseDDS(bytes));
    case 'ktx':
      return textureFileToRGBA((await import('./ktx.js')).parseKTX(bytes));
    case 'ktx2':
      if (!readKTX2Index(bytes).vkFormat) return transcodeBasis(bytes, options.signal);
      return textureFileToRGBA(await (await import('./image-ktx2.js')).parseKTX2(bytes, options));
    case 'jpeg':
    case 'avif':
      throw deviceUnsupported(`decodeImage does not read ${format} files; use the browser's image decoder`);
    default:
      throw decodeFailed('This file is not an image decodeImage reads; pass a PNG, WebP, DDS, KTX or KTX2 file');
  }
}
