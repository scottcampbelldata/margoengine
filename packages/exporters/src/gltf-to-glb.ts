// One GLB from a .gltf and the files beside it (GAP-FILM-GLTFPACK): every buffer, data URI and image becomes part of
// the GLB's one BIN chunk, so a model downloaded as a folder travels as one file.
//
// Written from the glTF 2.0 specification (Khronos, 2021): 3.6.1 (buffers and their `uri`), 3.6.2 (buffer views),
// 3.9 (images by `uri` or by `bufferView` with a `mimeType`), 4.4 (the GLB container: buffer 0 without a `uri` is the
// BIN chunk, chunks 4-byte aligned, JSON padded with spaces, BIN with zeros) and 3.3 (URI references, RFC 3986, read
// relative to the .gltf file); data URIs from RFC 2397; image types from their signatures (PNG, ISO/IEC 15948 5.2;
// JPEG, ITU-T T.81 B.1.1.3; WebP, RFC 9649 2.5; KTX2, Khronos KTX File Format Specification 2.0, 3.1; AVIF, AV1 Image
// File Format 1.1 (AOM) by its `ftyp` brand). EXT_meshopt_compression (Khronos glTF extension registry) and its
// KHR_meshopt_compression successor, which has the same layout, point bufferViews at buffers too, and their fallback
// buffers carry no data, so those references are rewritten and fallbacks kept as they are.

const MESHOPT = ['EXT_meshopt_compression', 'KHR_meshopt_compression'];

import { joinGLB } from './glb.js';
import { rangeError, typeError } from '../../shared/errors.js';

/** Options of {@link gltfToGLB}. */
export interface GLTFToGLBOptions {
  /**
   * Returns the bytes a buffer or image `uri` names, as written in the file (a URI reference, percent-encoded), for
   * example `(uri) => readFile(new URL(uri, pathToFileURL(file)))` in Node or `fetch(new URL(uri, base))` in a page.
   * Not called for `data:` URIs, which are decoded here. Needed when the file names any other uri.
   */
  read?: (uri: string) => Uint8Array | ArrayBuffer | Promise<Uint8Array | ArrayBuffer>;
  /**
   * Allow a uri with a scheme (`https:`, `file:`), an absolute path or a `..` segment, which names a file outside the
   * .gltf's folder. Default false: such a uri is refused before `read` is asked, so a file cannot pull in an arbitrary
   * path.
   */
  outside?: boolean;
  /** Stops between reads. */
  signal?: AbortSignal;
}

type Data = Record<string, unknown>;
const isObject = (value: unknown): value is Data =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const align = (n: number) => (n + 3) & ~3;

/** An image's MIME type from its first bytes, as glTF 2.0 3.9 requires on an image in a buffer view. */
export function imageMimeType(bytes: Uint8Array): string | undefined {
  const at = (i: number, text: string) => [...text].every((c, j) => bytes[i + j] === c.charCodeAt(0));
  if (bytes.length >= 8 && bytes[0] === 0x89 && at(1, 'PNG\r\n\x1a\n')) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && at(0, 'RIFF') && at(8, 'WEBP')) return 'image/webp';
  if (bytes.length >= 12 && bytes[0] === 0xab && at(1, 'KTX 20') && bytes[7] === 0xbb) return 'image/ktx2';
  if (bytes.length >= 12 && at(4, 'ftyp') && (at(8, 'avif') || at(8, 'avis'))) return 'image/avif';
  return undefined;
}

/** The bytes of an RFC 2397 data URI; only base64 and percent-encoded payloads exist. */
function dataURI(uri: string): Uint8Array {
  const comma = uri.indexOf(',');
  if (comma < 0) throw typeError('Invalid data URI in the glTF; it has no comma before its data', 'gltf-to-glb');
  const head = uri.slice(5, comma),
    body = uri.slice(comma + 1);
  if (/;base64$/i.test(head)) {
    const text = atob(body.replace(/\s/g, ''));
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
    return out;
  }
  return new TextEncoder().encode(decodeURIComponent(body));
}

/** True for a URI reference that stays inside the .gltf's folder: no scheme, no leading slash, no `..` segment. */
function inside(uri: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:/i.test(uri) || uri.startsWith('/') || uri.startsWith('\\')) return false;
  const path = uri.replace(/[?#].*$/, '');
  let segments: string[];
  try {
    segments = decodeURIComponent(path).split(/[\\/]/);
  } catch {
    return false;
  }
  return !segments.some((s) => s === '..');
}

/**
 * Packs a glTF document (a parsed object, its JSON text or bytes) and the files its `uri`s name into one GLB: all
 * buffers become buffer 0, the BIN chunk, with every buffer view (and EXT_ or KHR_meshopt_compression view) moved to its new
 * offset; each image with a `uri` moves into a buffer view with its `mimeType`. Everything else, extensions and extras
 * included, is kept as written. The input object is not changed.
 *
 * @example
 * import {gltfToGLB} from 'margoengine/exporters/gltf-to-glb';
 * const gltf = {asset: {version: '2.0'}, buffers: [{byteLength: 4, uri: 'data:application/octet-stream;base64,AAAAAA=='}]};
 * const glb = await gltfToGLB(gltf);
 * console.log(glb.byteLength); // 88: the 12-byte header, a 64-byte JSON chunk and a 12-byte BIN chunk
 * @throws TypeError when the document is not glTF 2.0, a uri is refused or unreadable, or an image type is unknown;
 * RangeError when a buffer holds fewer bytes than its `byteLength` or the GLB would pass 4 GiB.
 */
export async function gltfToGLB(
  gltf: Data | string | Uint8Array,
  { read, outside = false, signal }: GLTFToGLBOptions = {},
): Promise<Uint8Array> {
  let json: Data;
  try {
    json =
      gltf instanceof Uint8Array
        ? JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(gltf))
        : typeof gltf === 'string'
          ? JSON.parse(gltf)
          : structuredClone(gltf);
  } catch {
    throw typeError(
      'gltfToGLB needs a glTF JSON document; pass the .gltf file, its text or the parsed object',
      'gltf-to-glb',
    );
  }
  if (!isObject(json) || !isObject(json.asset) || json.asset.version !== '2.0')
    throw typeError('gltfToGLB needs a glTF 2.0 document (asset.version "2.0")', 'gltf-to-glb');
  const fetchURI = async (uri: string, what: string): Promise<Uint8Array> => {
    signal?.throwIfAborted();
    if (/^data:/i.test(uri)) return dataURI(uri);
    if (!outside && !inside(uri))
      throw typeError(
        `${what} uri ${JSON.stringify(uri.slice(0, 80))} names a file outside the glTF's folder; pass outside: true to allow it`,
        'gltf-to-glb',
      );
    if (!read)
      throw typeError(
        `${what} names ${JSON.stringify(uri.slice(0, 80))}; pass read to load the files beside the glTF`,
        'gltf-to-glb',
      );
    const bytes = await read(uri);
    signal?.throwIfAborted();
    if (bytes instanceof Uint8Array) return bytes;
    if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
    throw typeError(
      `read gave no bytes for ${JSON.stringify(uri.slice(0, 80))}; return a Uint8Array or ArrayBuffer`,
      'gltf-to-glb',
    );
  };
  const buffers = (json.buffers ?? []) as unknown[],
    views = (json.bufferViews ?? []) as unknown[],
    images = (json.images ?? []) as unknown[];
  if (![buffers, views, images].every((list) => Array.isArray(list) && list.every(isObject)))
    throw typeError('glTF buffers, bufferViews and images must be arrays of objects', 'gltf-to-glb');
  // Parts of the new buffer 0, each 4-byte aligned, and where each old buffer starts in it.
  const parts: { at: number; bytes: Uint8Array }[] = [];
  let length = 0;
  const add = (bytes: Uint8Array) => {
    const at = length;
    parts.push({ at, bytes });
    length = align(at + bytes.length);
    return at;
  };
  // Old buffer index -> new index and offset. Buffers with data join buffer 0; a meshopt fallback keeps its place.
  const moved: { buffer: number; offset: number }[] = [],
    kept: Data[] = [];
  for (const [index, buffer] of (buffers as Data[]).entries()) {
    const byteLength = buffer.byteLength;
    if (!Number.isSafeInteger(byteLength) || (byteLength as number) < 1)
      throw typeError(`glTF buffer ${index} needs a positive integer byteLength`, 'gltf-to-glb');
    if (typeof buffer.uri !== 'string') {
      const extensions = buffer.extensions,
        fallback = isObject(extensions) && MESHOPT.some((name) => isObject(extensions[name]));
      if (!fallback)
        throw typeError(`glTF buffer ${index} has no uri; a .gltf buffer must name its data`, 'gltf-to-glb');
      moved.push({ buffer: -1 - kept.length, offset: 0 });
      kept.push(buffer);
      continue;
    }
    const bytes = await fetchURI(buffer.uri, `buffer ${index}`);
    if (bytes.length < (byteLength as number))
      throw rangeError(
        `glTF buffer ${index} holds ${bytes.length} bytes, fewer than its byteLength ${byteLength}; the file beside the glTF is cut short`,
        'gltf-to-glb',
      );
    moved.push({ buffer: 0, offset: add(bytes.subarray(0, byteLength as number)) });
  }
  const target = (old: unknown, what: string) => {
    const place = Number.isInteger(old) ? moved[old as number] : undefined;
    if (!place) throw typeError(`${what} names buffer ${String(old)}, which does not exist`, 'gltf-to-glb');
    return place;
  };
  // A kept fallback buffer must not become buffer 0, which in a GLB without a uri means the BIN chunk (4.4).
  if (kept.length && !parts.length) add(new Uint8Array(4));
  const hasBin = parts.length > 0 || images.some((image) => typeof (image as Data).uri === 'string');
  const index = (place: { buffer: number }) => (place.buffer >= 0 ? 0 : (hasBin ? 1 : 0) + (-1 - place.buffer));
  for (const [i, view] of (views as Data[]).entries()) {
    const place = target(view.buffer, `bufferView ${i}`);
    view.buffer = index(place);
    if (place.buffer >= 0) view.byteOffset = ((view.byteOffset as number | undefined) ?? 0) + place.offset;
    for (const name of MESHOPT) {
      const meshopt = isObject(view.extensions) ? view.extensions[name] : undefined;
      if (!isObject(meshopt)) continue;
      const from = target(meshopt.buffer, `bufferView ${i} ${name}`);
      meshopt.buffer = index(from);
      if (from.buffer >= 0) meshopt.byteOffset = ((meshopt.byteOffset as number | undefined) ?? 0) + from.offset;
    }
  }
  for (const [i, image] of (images as Data[]).entries()) {
    if (typeof image.uri !== 'string') continue;
    const bytes = await fetchURI(image.uri, `image ${i}`),
      mimeType = imageMimeType(bytes) ?? (typeof image.mimeType === 'string' ? image.mimeType : undefined);
    if (!mimeType || !bytes.length)
      throw typeError(`glTF image ${i} is not a PNG, JPEG, WebP, KTX2 or AVIF file; give it a mimeType`, 'gltf-to-glb');
    views.push({ buffer: 0, byteOffset: add(bytes), byteLength: bytes.length });
    image.bufferView = views.length - 1;
    image.mimeType = mimeType;
    delete image.uri;
  }
  if (length > 0xffffffff - 64)
    throw rangeError('The packed GLB would pass 4 GiB, the most a GLB can hold; keep the glTF as files', 'gltf-to-glb');
  json.buffers = hasBin ? [{ byteLength: length }, ...kept] : kept;
  if (!(json.buffers as unknown[]).length) delete json.buffers;
  if (views.length) json.bufferViews = views;
  const bin = new Uint8Array(length);
  for (const { at, bytes } of parts) bin.set(bytes, at);
  return joinGLB({ json, bin: hasBin ? bin : null, chunks: [] });
}
