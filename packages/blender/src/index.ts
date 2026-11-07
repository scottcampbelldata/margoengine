import { parseJSON } from '../../shared/json.js';
import { checkCount, countLimit } from '../../shared/limits.js';
import type { EngineKernel } from '@margoengine/core';
import { parsePreparedPBR, type GLTFDocument, type PBRModel, type PreparedGeometry } from '@margoengine/gltf-pro/model';
import { validatePreparedGeometry } from '../../shared/prepared-geometry.js';
import { readResponse } from '../../shared/loading.js';

const maxBytes = 256 * 1024 * 1024;
const littleEndian = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
// The prepared glTF subset inspected below; scene and material fields remain
// unknown here because parsePreparedPBR owns their validation.
interface MargoPrimitive {
  vertices?: unknown;
  indices?: unknown;
  attributes?: unknown;
  targets?: unknown;
  extensions?: unknown;
}
interface MargoMesh {
  primitives?: MargoPrimitive[];
}
interface MargoImage {
  mimeType?: unknown;
  uri?: unknown;
  section?: unknown;
}
interface MargoDocument extends Record<string, unknown> {
  asset?: { version?: unknown };
  meshes?: MargoMesh[];
  nodes?: unknown[];
  images?: MargoImage[];
}
/** A decoded `.margo` file before any GPU work: the validated scene document, geometry views and embedded PNG bytes. */
export interface MargoAsset {
  /** The glTF-shaped scene and material document. */
  readonly document: GLTFDocument;
  /** Prepared geometry per mesh, then per primitive; shared primitives share one entry. */
  readonly geometry: readonly (readonly PreparedGeometry[])[];
  /** Embedded RGBA8 PNG files, in the order the document's `images` list them. */
  readonly images: readonly Uint8Array<ArrayBuffer>[];
}
/** Resource limits shared by the .margo decoding and loading entrypoints. */
export interface MargoOptions {
  /** Maximum scene nodes (default 100,000). */
  maxNodes?: number;
}

/**
 * Validates and decodes `.margo` bytes without a GPU. Compact vertices and uint16 indices expand once; other geometry
 * retains the input buffer, so keep the bytes alive and unmodified while the result is used.
 *
 * @example
 * const asset = decodeMargo(await (await fetch('/scene.margo')).arrayBuffer());
 * console.log(asset.document.nodes?.length);
 */
export function decodeMargo(
  input: ArrayBuffer | ArrayBufferView,
  { maxNodes = 100_000 }: MargoOptions = {},
): MargoAsset {
  countLimit('maxNodes', maxNodes);
  if (!(input instanceof ArrayBuffer) && !ArrayBuffer.isView(input))
    throw new TypeError('Expected .margo bytes; pass an ArrayBuffer or a typed array holding the file');
  const buffer = input instanceof ArrayBuffer ? input : input.buffer,
    base = input instanceof ArrayBuffer ? 0 : input.byteOffset,
    length = input.byteLength;
  if (!(buffer instanceof ArrayBuffer) || base % 4 || !littleEndian)
    throw new TypeError(
      '.margo requires aligned, little-endian ArrayBuffer storage; pass an ArrayBuffer (not a SharedArrayBuffer) whose byte offset is a multiple of 4',
    );
  if (length < 64 || length > maxBytes || length % 4)
    throw new RangeError(
      'Invalid .margo size; the file must be 64 bytes to 256 MiB and a multiple of 4, so re-export it from Blender',
    );
  const view = new DataView(buffer, base, length);
  if (
    view.getUint32(0, true) !== 0x4f47524d ||
    view.getUint32(4, true) !== 1 ||
    view.getUint32(8, true) !== length ||
    view.getUint32(16, true) !== 64 ||
    view.getUint32(24, true) !== 80
  )
    throw new TypeError(
      'Invalid .margo header/version/stride; the input is not a version 1 .margo file, so export it again with the Margo Blender add-on',
    );
  for (let at = 20; at < 64; at += 4)
    if (at !== 24 && view.getUint32(at, true) !== 0)
      throw new TypeError(
        'Unsupported .margo flags; the file was written by a newer exporter, so update @margoengine/blender or re-export it',
      );
  const count = view.getUint32(12, true);
  if (count < 3 || count > 4096 || 64 + count * 16 > length)
    throw new RangeError(
      'Invalid .margo section count; the file is truncated or corrupt, so download or export it again',
    );
  const sections: { type: number; stride: number; bytes: Uint8Array<ArrayBuffer> }[] = [];
  let end = 64 + count * 16;
  for (let i = 0; i < count; i++) {
    const at = 64 + i * 16,
      type = view.getUint32(at, true),
      offset = view.getUint32(at + 4, true),
      size = view.getUint32(at + 8, true),
      flags = view.getUint32(at + 12, true),
      stride = type === 2 ? (flags === 1 ? 24 : 80) : flags === 1 ? 2 : 4;
    if (
      ![1, 2, 3, 4].includes(type) ||
      flags > (type === 2 ? 1 : type === 3 ? 2 : 0) ||
      !size ||
      offset !== end ||
      offset + size > length
    )
      throw new RangeError(
        'Invalid .margo section bounds/type/alignment; the file is truncated or corrupt, so download or export it again',
      );
    if (
      (i === 0) !== (type === 1) ||
      (type === 1 && size > 1024 * 1024) ||
      (type === 2 && size % stride) ||
      (type === 3 && size % (stride * 3))
    )
      throw new RangeError('Invalid .margo section layout; the file is corrupt, so re-export it from Blender');
    sections.push({ type, stride, bytes: new Uint8Array(buffer, base + offset, size) });
    end = (offset + size + 3) & ~3;
  }
  if (end !== length)
    throw new RangeError(
      'Trailing/truncated .margo data; the file has missing or extra bytes, so download or export it again',
    );
  let doc: MargoDocument | null;
  try {
    doc = parseJSON(new TextDecoder('utf-8', { fatal: true }).decode(sections[0].bytes));
  } catch {
    // Malformed UTF-8 or JSON: a named error, not TextDecoder's TypeError or JSON.parse's SyntaxError.
    throw new TypeError(
      'Invalid .margo scene JSON; the scene section is not UTF-8 JSON, so re-export the file from Blender',
    );
  }
  if (
    !doc ||
    doc.asset?.version !== '2.0' ||
    !Array.isArray(doc.meshes) ||
    !doc.meshes.length ||
    !Array.isArray(doc.nodes) ||
    !doc.nodes.length
  )
    throw new TypeError(
      'Invalid .margo scene; it needs glTF asset version 2.0 plus at least one mesh and one node, so re-export it from Blender',
    );
  checkCount('Too many .margo nodes', doc.nodes.length, maxNodes, 'maxNodes');
  for (const key of ['buffers', 'bufferViews', 'accessors', 'skins', 'animations', 'extensionsRequired'])
    if (doc[key] !== undefined)
      throw new TypeError(
        `Unsupported .margo ${key}; remove it from the scene (.margo carries geometry in sections, not glTF ${key})`,
      );
  for (const key of ['materials', 'images', 'textures', 'samplers', 'scenes'])
    if (doc[key] !== undefined && !Array.isArray(doc[key]))
      throw new TypeError(`Invalid .margo ${key}; it must be an array, so re-export the file from Blender`);
  const section = (id: unknown, type: number) => {
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1 || sections[id]?.type !== type)
      throw new TypeError(
        'Invalid .margo section reference; a mesh or image points at a missing section of the wrong type, so re-export the file',
      );
    return sections[id];
  };
  const shared = new Map<string, PreparedGeometry>();
  let geometryBytes = 0;
  const geometry = doc.meshes.map((mesh) => {
    if (!mesh || !Array.isArray(mesh.primitives) || !mesh.primitives.length)
      throw new TypeError(
        'Invalid .margo primitives; every mesh needs at least one primitive, so re-export the file from Blender',
      );
    return mesh.primitives.map((p) => {
      if (!p || p.attributes || p.targets || p.extensions)
        throw new TypeError(
          'Unsupported .margo primitive; remove attributes, morph targets and extensions (.margo primitives use packed sections)',
        );
      const { bytes: vertices, stride } = section(p.vertices, 2),
        { bytes: indices, stride: indexStride } = section(p.indices, 3);
      const key = `${p.vertices}:${p.indices}`;
      let geometry = shared.get(key);
      if (!geometry) {
        const count = vertices.byteLength / stride;
        geometryBytes += count * 80 + (indices.byteLength / indexStride) * 4;
        if (count < 3 || count > 1_000_000 || geometryBytes > maxBytes)
          throw new RangeError(
            '.margo geometry exceeds decoded size limit; split the scene into smaller files (3 to 1,000,000 vertices per mesh)',
          );
        let packed = new Float32Array(buffer, vertices.byteOffset, vertices.byteLength / 4);
        if (stride === 24) {
          const expanded = new Float32Array(count * 20);
          for (let i = 0; i < count; i++) {
            for (let axis = 0; axis < 3; axis++) {
              expanded[i * 20 + axis] = packed[i * 6 + axis];
              expanded[i * 20 + 4 + axis] = packed[i * 6 + 3 + axis];
            }
            expanded[i * 20 + 3] = 1;
            expanded.fill(1, i * 20 + 16, i * 20 + 20);
          }
          packed = expanded;
        }
        const packedIndices =
          indexStride === 2
            ? Uint32Array.from(new Uint16Array(buffer, indices.byteOffset, indices.byteLength / 2))
            : new Uint32Array(buffer, indices.byteOffset, indices.byteLength / 4);
        geometry = { vertices: packed, indices: packedIndices };
        validatePreparedGeometry(geometry);
        shared.set(key, geometry);
      }
      return geometry;
    });
  });
  let decoded = 0;
  const images = (doc.images ?? []).map((image) => {
    if (!image || image.mimeType !== 'image/png' || image.uri !== undefined)
      throw new TypeError('.margo images must be embedded PNG; export textures as embedded PNG sections, not URIs');
    const { bytes } = section(image.section, 4),
      png = new DataView(buffer, bytes.byteOffset, bytes.byteLength);
    if (
      bytes.length < 33 ||
      png.getUint32(0) !== 0x89504e47 ||
      png.getUint32(4) !== 0x0d0a1a0a ||
      png.getUint32(8) !== 13 ||
      png.getUint32(12) !== 0x49484452 ||
      bytes[24] !== 8 ||
      bytes[25] !== 6 ||
      bytes[26] ||
      bytes[27] ||
      bytes[28]
    )
      throw new TypeError('Invalid .margo RGBA8 PNG; embed 8-bit RGBA, non-interlaced PNG images');
    const width = png.getUint32(16),
      height = png.getUint32(20);
    decoded += width * height * 4;
    if (!width || !height || width > 4096 || height > 4096 || decoded > maxBytes)
      throw new RangeError('.margo images exceed decoded size limit; use textures of at most 4096 x 4096 pixels');
    return bytes;
  });
  // The untrusted metadata has passed the .margo scene and resource checks above.
  return { document: doc as GLTFDocument, geometry, images };
}

/**
 * Decodes `.margo` bytes and attaches the scene to `engine` as a glTF Pro `PBRModel` (WebGPU only). Aborting `signal`
 * rejects with its reason and closes any decoded images. `maxNodes` defaults to 100,000.
 *
 * @example
 * const model = await parseMargo(engine, await file.arrayBuffer(), { signal });
 */
export async function parseMargo(
  engine: EngineKernel,
  input: ArrayBuffer | ArrayBufferView,
  { signal, maxNodes }: MargoOptions & { signal?: AbortSignal } = {},
): Promise<PBRModel> {
  signal?.throwIfAborted();
  const asset = decodeMargo(input, { maxNodes }),
    images: ImageBitmap[] = [];
  try {
    for (const bytes of asset.images) {
      signal?.throwIfAborted();
      const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }), {
        colorSpaceConversion: 'none',
        premultiplyAlpha: 'none',
      }).catch((error) => {
        // The browser rejects undecodable bytes with a DOMException: report it as the loader's own error.
        throw new TypeError(
          `.margo image ${images.length} could not be decoded (${error?.message ?? error}); re-export it as a valid PNG`,
        );
      });
      images.push(image);
      const png = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      if (image.width !== png.getUint32(16) || image.height !== png.getUint32(20))
        throw new RangeError(
          'Decoded .margo image size mismatch; the PNG header disagrees with its pixels, so re-export the image',
        );
    }
    signal?.throwIfAborted();
    return parsePreparedPBR(engine, asset.document, asset.geometry, images, { maxNodes });
  } catch (error) {
    for (const image of images) image.close();
    throw error;
  }
}

/**
 * Fetches a .margo file over HTTP(S) through `fetch` (default `globalThis.fetch`) and parses it like parseMargo.
 *
 * @example
 * const model = await loadMargo(engine, '/scene.margo', { signal: AbortSignal.timeout(10_000) });
 */
export async function loadMargo(
  engine: EngineKernel,
  url: string | URL,
  {
    signal,
    maxNodes,
    fetch: get = globalThis.fetch,
  }: MargoOptions & { signal?: AbortSignal; fetch?: typeof fetch } = {},
): Promise<PBRModel> {
  signal?.throwIfAborted();
  const target = new URL(url, globalThis.location?.href);
  if (!['http:', 'https:'].includes(target.protocol))
    throw new TypeError(
      '.margo URL must use HTTP(S); pass an http: or https: URL, or read the file yourself and call parseMargo',
    );
  const bytes = await readResponse(await get(target, { signal }), { maxBytes, signal, label: '.margo download' });
  return parseMargo(engine, bytes, { signal, maxNodes });
}
