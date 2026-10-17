import { parseJSON as parseSafeJSON } from '../../shared/json.js';
import { assetURL } from '../../shared/asset-url.js';
import { readResponse } from '../../shared/loading.js';
import { meshoptDecodeGltfBuffer } from '@margoengine/decoders/meshopt';
import type { DracoDecodeOptions, KTX2Decoder, TranscodedKTX2Result } from '@margoengine/decoders';
import { checkCount, countLimit } from '../../shared/limits.js';
import type { PBRInstances } from './instancing.js';
import type { ExtendedPlan } from './shader.js';
import type {
  GLTFDocument,
  GLTFBufferView,
  GLTFTexture,
  GLTFInstancing,
  GLTFExtensions,
  GLTFTextureInfo,
} from '../../shared/gltf.js';
export type { GLTFDocument } from '../../shared/gltf.js';
/** Retained mip bytes let compressed textures upload again after device restoration. */
export interface KTX2Image {
  readonly ktx2: TranscodedKTX2Result;
  readonly width: number;
  readonly height: number;
  close(): void;
}
export type GLTFImage = ImageBitmap | KTX2Image | GLTFCompressedImage | undefined;
export interface GLTFImageOptions {
  signal?: AbortSignal;
  device?: GPUDevice;
  ktx2?: {
    transcode(
      data: Uint8Array,
      options?: { signal?: AbortSignal },
    ): Promise<GLTFCompressedImage | TranscodedKTX2Result>;
  };
}
/** Async codecs stay on the owning thread; meshopt is synchronous and can be packed in a parser worker. */
export const asyncCompression = (doc: GLTFDocument): boolean =>
  !!doc.meshes?.some((mesh) => mesh?.primitives?.some((p) => p?.extensions?.KHR_draco_mesh_compression)) ||
  !!doc.textures?.some((texture) => texture?.extensions?.KHR_texture_basisu) ||
  !!doc.images?.some((image) => image?.mimeType === 'image/ktx2');
export const assetLimit = 64 * 1024 * 1024;
/** A byte budget derived from `maxDownloadBytes` was exceeded: the error names the option to raise. */
export const overBudget = (message: string, bytes: number): RangeError =>
  new RangeError(`${message} (${bytes} bytes; raise the maxDownloadBytes option)`);
/** Validates a `maxDownloadBytes` option (default assetLimit). */
export function downloadLimit(bytes: number = assetLimit): number {
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new RangeError('maxDownloadBytes must be a positive integer');
  return bytes;
}
/** A transcoded texture, such as a KTX2Decoder result: every mip level, in a format the device has enabled. */
export interface GLTFCompressedImage {
  width: number;
  height: number;
  format: GPUTextureFormat;
  mipmaps: readonly { data: Uint8Array; width: number; height: number }[];
}
/** A decoded glTF image slot; undefined when a KTX2 image was skipped because no ktx2 decoder was passed. */

/** Optional decoders. Structurally matches @margoengine/decoders (DracoDecoder, MeshoptDecoder, KTX2Decoder) without importing it. */
export interface GLTFDecoderHooks {
  draco?: {
    decode(data: Uint8Array, options: GLTFDracoDecodeOptions): Promise<GLTFDracoGeometry>;
  };
  meshopt?: {
    decodeGltfBuffer(
      target: Uint8Array,
      count: number,
      stride: number,
      source: Uint8Array,
      mode: string,
      filter?: string,
    ): void;
  };
  ktx2?: { transcode(data: Uint8Array, options?: { signal?: AbortSignal }): Promise<GLTFCompressedImage> };
  /** EXT_mesh_gpu_instancing: `instancing` from @margoengine/gltf-pro/instancing. */
  instancing?: { read(asset: GLTFAsset, extension: GLTFInstancing): PBRInstances | undefined };
  /** KHR_materials_iridescence, anisotropy and diffuse_transmission: `extendedMaterials` from @margoengine/gltf-pro/extended. */
  materials?: GLTFExtendedMaterials;
}
/** Structural decoder boundary; supplied hooks may omit metadata derived from accessor declarations. */
export interface GLTFDracoDecodeOptions extends DracoDecodeOptions {
  attributeIds: Record<string, number>;
  componentTypes: Record<string, number>;
}
export interface GLTFDracoGeometry {
  vertexCount?: number;
  positions?: ArrayLike<number>;
  normals?: ArrayLike<number>;
  uvs?: ArrayLike<number>;
  colors?: ArrayLike<number>;
  indices?: ArrayLike<number>;
  attributes?: Record<string, { array: ArrayLike<number>; itemSize?: number; componentType?: number }>;
}
/** What gltf-pro needs to shade extended materials (`extendedMaterials` from @margoengine/gltf-pro/extended implements it). */
export interface GLTFExtendedMaterials {
  /**
   * A glTF material's `extensions` read for its thin film, anisotropy and diffuse transmission, or undefined when none is
   * in use (every factor 0): the features, map slots 13-17 (texture infos) and 12 uniform floats (rows iri, aniso, dtr).
   */
  parse(
    extensions: GLTFExtensions,
  ): { features: Omit<ExtendedPlan, 'slots'>; maps: (GLTFTextureInfo | undefined)[]; rows: number[] } | undefined;
  /** The binding plan for a material's 18 map slots (`extendedPlan`). */
  plan(maps: readonly ({ index: number } | undefined)[], features: Omit<ExtendedPlan, 'slots'>): ExtendedPlan;
  /** The extended physical shader for a plan (`extendedShader`). */
  shader(plan: ExtendedPlan): string;
}
const supported = new Set([
  'KHR_mesh_quantization',
  'KHR_texture_transform',
  'KHR_materials_emissive_strength',
  'KHR_materials_unlit',
  'KHR_lights_punctual',
  'KHR_materials_clearcoat',
  'KHR_materials_transmission',
  'KHR_materials_ior',
  'KHR_materials_dispersion',
  'KHR_materials_volume',
  'KHR_materials_sheen',
  'KHR_materials_specular',
  'KHR_materials_variants',
  'EXT_texture_webp',
  'EXT_texture_avif',
  'EXT_mesh_gpu_instancing',
]);
const hookFor: Record<string, keyof GLTFDecoderHooks> = {
  KHR_draco_mesh_compression: 'draco',
  EXT_meshopt_compression: 'meshopt',
  KHR_meshopt_compression: 'meshopt',
  KHR_texture_basisu: 'ktx2',
  KHR_materials_iridescence: 'materials',
  KHR_materials_anisotropy: 'materials',
  KHR_materials_diffuse_transmission: 'materials',
};
const meshopt = (def: GLTFBufferView) =>
  def?.extensions?.EXT_meshopt_compression ?? def?.extensions?.KHR_meshopt_compression;
export function integer(value: unknown, label: string, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min)
    throw new TypeError('Invalid glTF ' + label);
  return value;
}
export function entry<T>(array: readonly T[] | undefined, id: unknown, label: string): T {
  const value = array?.[integer(id, label)];
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Missing glTF ' + label);
  return value;
}
/** UTF-8 bytes as text; malformed UTF-8 throws TypeError('Invalid glTF JSON: not UTF-8'). */
function utf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new TypeError('Invalid glTF JSON: not UTF-8');
  }
}
/**
 * glTF JSON text (or UTF-8 bytes) as a document. Malformed JSON throws TypeError('Invalid glTF JSON: ...'), not
 * SyntaxError, and nesting deeper than 256 levels is refused before parsing: structured clone (worker replies) and
 * recursive readers would overflow the stack on a document nested thousands deep. No real glTF comes close.
 */
export function parseJSON(source: string | Uint8Array): GLTFDocument {
  const text = typeof source === 'string' ? source : utf8(source);
  for (let i = 0, depth = 0, string = false; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (string) {
      if (c === 92)
        i++; // backslash: skip the escaped character
      else if (c === 34) string = false;
    } else if (c === 34) string = true;
    else if (c === 91 || c === 123) {
      if (++depth > 256) throw new TypeError('Invalid glTF JSON: nested deeper than 256 levels');
    } else if (c === 93 || c === 125) depth--;
  }
  try {
    return parseSafeJSON<GLTFDocument>(text);
  } catch (error) {
    throw error instanceof SyntaxError ? new TypeError('Invalid glTF JSON: ' + error.message) : error;
  }
}
const lists = ['buffers', 'bufferViews', 'accessors', 'meshes', 'nodes', 'scenes', 'materials', 'textures', 'images'];
lists.push('samplers', 'skins', 'animations', 'cameras');
const objects = (list: unknown): boolean =>
  list === undefined ||
  (Array.isArray(list) && list.every((v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v)));
/**
 * The trust-boundary check every load runs before reading a document: glTF 2.0, every top-level list an array of
 * objects (so later reads never meet null or a number), the nested lists loaders iterate (primitives and their morph
 * targets, animation samplers and channels) too, and the extension name lists arrays.
 */
export function checkDocument(doc: GLTFDocument): void {
  if (!doc || typeof doc !== 'object' || doc.asset?.version !== '2.0') throw new TypeError('Expected glTF 2.0');
  const record = doc as unknown as Record<string, unknown>;
  for (const key of lists) if (!objects(record[key])) throw new TypeError('Invalid glTF ' + key);
  for (const mesh of doc.meshes ?? [])
    if (!objects(mesh.primitives) || !(mesh.primitives ?? []).every((p) => objects(p.targets)))
      throw new TypeError('Invalid glTF primitives');
  for (const animation of doc.animations ?? [])
    if (!objects(animation.samplers) || !objects(animation.channels)) throw new TypeError('Invalid glTF animation');
  for (const key of ['extensionsRequired', 'extensionsUsed'])
    if (record[key] !== undefined && !Array.isArray(record[key])) throw new TypeError('Invalid glTF ' + key);
}
export function container(
  input: string | object | ArrayBuffer | ArrayBufferView,
  limit = assetLimit,
): { doc: GLTFDocument; binary?: Uint8Array } {
  if (typeof input === 'string') {
    // Every UTF-16 unit encodes to at least one byte: a long string fails before it is encoded.
    if (input.length > limit || new TextEncoder().encode(input).length > limit)
      throw overBudget('glTF JSON exceeds byte budget', limit);
    return { doc: parseJSON(input) };
  }
  if (!(input instanceof ArrayBuffer) && !ArrayBuffer.isView(input)) return { doc: input as GLTFDocument };
  const data =
    input instanceof ArrayBuffer
      ? new Uint8Array(input)
      : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (data.length >= 4 && new DataView(data.buffer, data.byteOffset).getUint32(0, true) !== 0x46546c67) {
    // JSON bytes: the budget is checked before the text is decoded, so a huge input is not copied twice first.
    if (data.length > limit) throw overBudget('glTF JSON exceeds byte budget', limit);
    return container(utf8(data), limit);
  }
  if (data.length > limit) throw overBudget('glTF exceeds download budget', limit);
  if (data.length < 20) throw new RangeError('Invalid GLB size');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (
    view.getUint32(0, true) !== 0x46546c67 ||
    view.getUint32(4, true) !== 2 ||
    view.getUint32(8, true) !== data.length
  )
    throw new TypeError('Invalid GLB header');
  let doc: GLTFDocument | undefined, binary: Uint8Array | undefined;
  for (let offset = 12; offset < data.length; ) {
    if (offset + 8 > data.length) throw new RangeError('Truncated GLB chunk');
    const length = view.getUint32(offset, true),
      type = view.getUint32(offset + 4, true);
    offset += 8;
    if (length % 4 || offset + length > data.length) throw new RangeError('Invalid GLB chunk');
    const chunk = data.subarray(offset, offset + length);
    if (offset === 20 && type !== 0x4e4f534a) throw new TypeError('GLB JSON must be first');
    if (type === 0x4e4f534a) {
      if (doc) throw new TypeError('Duplicate GLB JSON');
      doc = parseJSON(chunk);
    } else if (type === 0x004e4942) {
      if (binary) throw new TypeError('Duplicate GLB binary');
      binary = chunk;
    }
    offset += length;
  }
  if (!doc) throw new TypeError('Missing GLB JSON');
  return { doc, binary };
}
export function embedded(uri: string, limit = assetLimit): Uint8Array {
  const match = /^data:[^;,]+;base64,([A-Za-z0-9+/]*={0,2})$/.exec(uri);
  if (match && match[1].length > (limit * 4) / 3 + 4) throw overBudget('glTF exceeds download budget', limit);
  if (!match) throw new TypeError('Invalid glTF data URI');
  let text: string;
  try {
    text = atob(match[1]); // throws on a bad length or misplaced padding the pattern lets through
  } catch {
    throw new TypeError('Invalid glTF data URI');
  }
  return Uint8Array.from(text, (c) => c.charCodeAt(0));
}
export const componentSizes: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
export const components: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const meshoptExtension = 'EXT_meshopt_compression',
  dracoExtension = 'KHR_draco_mesh_compression',
  basisuExtension = 'KHR_texture_basisu';
/** Basis Universal replaces the ordinary PNG/JPEG source, including optional fallbacks. */
export function textureSource(def: GLTFTexture): number {
  const extension = def.extensions?.[basisuExtension];
  if (extension !== undefined && (!extension || typeof extension !== 'object' || Array.isArray(extension)))
    throw new TypeError('Invalid glTF KHR_texture_basisu');
  return integer(extension === undefined ? def.source : extension.source, 'image source');
}
function accessorLayout(doc: GLTFDocument, id: unknown, type?: string) {
  const index = integer(id, 'accessor'),
    def = entry(doc.accessors, index, 'accessor');
  if (type && def.type !== type) throw new TypeError('Invalid glTF accessor type');
  const size = typeof def.componentType === 'number' ? componentSizes[def.componentType] : undefined,
    width = typeof def.type === 'string' && Object.hasOwn(components, def.type) ? components[def.type] : undefined,
    count = integer(def.count, 'accessor count', 1);
  if (
    !size ||
    !width ||
    (def.normalized !== undefined && typeof def.normalized !== 'boolean') ||
    (def.normalized && [5125, 5126].includes(def.componentType))
  )
    throw new TypeError(
      `Unsupported glTF accessor ${index} (componentType ${def.componentType}, type ${def.type}${def.normalized ? ', normalized' : ''})`,
    );
  return { index, def, size, width, count };
}
const normalizers: Record<number, number> = { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 };
function component(view: DataView, at: number, type: number): number {
  switch (type) {
    case 5126:
      return view.getFloat32(at, true);
    case 5125:
      return view.getUint32(at, true);
    case 5123:
      return view.getUint16(at, true);
    case 5122:
      return view.getInt16(at, true);
    case 5121:
      return view.getUint8(at);
    default:
      return view.getInt8(at);
  }
}
export class GLTFAsset {
  readonly buffers: Uint8Array[];
  private readonly cache = new Map<number, Float32Array>();
  private readonly viewCache = new Map<number, Uint8Array>();
  private decoded = 0;
  /** @internal Remaining retained decode budget, checked before decoder output allocation. */
  get remainingDecodedBytes(): number {
    return this.maxBytes * 4 - this.decoded;
  }
  /** @internal Account for retained decoded data, including topology without an accessor. */
  reserveDecodedBytes(byteLength: number): void {
    integer(byteLength, 'decoded byte length');
    if (this.decoded + byteLength > this.maxBytes * 4) throw new RangeError('Decoded glTF exceeds byte budget');
    this.decoded += byteLength;
  }
  constructor(
    readonly doc: GLTFDocument,
    buffers: Array<ArrayBuffer | ArrayBufferView>,
    binary?: Uint8Array,
    readonly hooks: GLTFDecoderHooks = {},
    readonly maxBytes: number = assetLimit,
    readonly maxNodes: number = 100_000,
  ) {
    downloadLimit(maxBytes);
    countLimit('maxNodes', maxNodes);
    checkDocument(doc);
    const missing = (doc.extensionsRequired ?? []).filter(
      (name: string) =>
        !supported.has(name) &&
        ![dracoExtension, meshoptExtension, 'KHR_meshopt_compression', basisuExtension].includes(name) &&
        !hooks[hookFor[name]],
    );
    if (missing.length)
      throw new Error(
        'Required glTF extensions are unsupported: ' +
          missing
            .map((name: string) => (hookFor[name] ? name + ' (pass a ' + hookFor[name] + ' decoder)' : name))
            .join(', '),
      );
    checkCount('Too many glTF nodes', doc.nodes?.length ?? 0, maxNodes, 'maxNodes');
    let total = 0;
    this.buffers = (doc.buffers ?? []).map((def, i) => {
      if (!def || typeof def !== 'object' || Array.isArray(def)) throw new TypeError('Invalid glTF buffer');
      const length = integer(def.byteLength, 'buffer length', 1);
      const fallback = def.extensions?.[meshoptExtension]?.fallback;
      if (fallback !== undefined && typeof fallback !== 'boolean') throw new TypeError('Invalid glTF meshopt fallback');
      const input = buffers[i],
        placeholder = (!input || input.byteLength === 0) && !def.uri && (i !== 0 || !binary);
      if (fallback === true || (placeholder && doc.extensionsRequired?.includes(meshoptExtension))) {
        const views = (doc.bufferViews ?? []).filter((view) => view?.buffer === i);
        if (
          !views.length ||
          views.some((view) => !view.extensions?.[meshoptExtension]) ||
          doc.bufferViews?.some((view) => view?.extensions?.[meshoptExtension]?.buffer === i)
        )
          throw new TypeError('Invalid glTF meshopt fallback references');
        return new Uint8Array();
      }
      const data = input
        ? input instanceof ArrayBuffer
          ? new Uint8Array(input)
          : new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
        : def.uri
          ? embedded(def.uri, maxBytes)
          : i === 0
            ? binary
            : undefined;
      if (!data || length > data.length) throw new RangeError('Truncated glTF buffer');
      total += data.byteLength;
      if (total > maxBytes) throw overBudget('glTF buffers exceed byte budget', maxBytes);
      return data.subarray(0, length);
    });
  }
  view(id: unknown): Uint8Array {
    const index = integer(id, 'bufferView'),
      def = entry(this.doc.bufferViews, index, 'bufferView'),
      bufferId = integer(def.buffer, 'buffer reference'),
      buffer = this.buffers[bufferId];
    const offset = integer(def.byteOffset ?? 0, 'view offset'),
      length = integer(def.byteLength, 'view length', 1);
    const declaredLength = integer(entry(this.doc.buffers, bufferId, 'buffer').byteLength, 'buffer length', 1);
    if (length > declaredLength || offset > declaredLength - length)
      throw new RangeError('Invalid glTF bufferView bounds');
    const extension = meshopt(def);
    if (extension !== undefined) {
      const cached = this.viewCache.get(index);
      if (cached) return cached;
      if (!extension || typeof extension !== 'object' || Array.isArray(extension))
        throw new TypeError('Invalid glTF meshopt extension');
      const source = this.buffers[integer(extension.buffer, 'meshopt buffer reference')],
        sourceOffset = integer(extension.byteOffset ?? 0, 'meshopt offset'),
        sourceLength = integer(extension.byteLength, 'meshopt length', 1);
      const count = integer(extension.count, 'meshopt count', 1),
        stride = integer(extension.byteStride, 'meshopt stride', 1),
        mode = extension.mode,
        filter = extension.filter ?? 'NONE';
      if (!source || sourceLength > source.length || sourceOffset > source.length - sourceLength)
        throw new RangeError('Invalid glTF meshopt source bounds');
      if (
        !Number.isSafeInteger(count * stride) ||
        count * stride !== length ||
        (def.byteStride !== undefined && def.byteStride !== stride)
      )
        throw new RangeError('Invalid glTF meshopt decoded layout');
      if (
        mode === 'ATTRIBUTES'
          ? stride > 256 || stride % 4 !== 0
          : !['TRIANGLES', 'INDICES'].includes(mode) ||
            ![2, 4].includes(stride) ||
            (mode === 'TRIANGLES' && count % 3 !== 0)
      )
        throw new TypeError('Invalid glTF meshopt mode/stride/count');
      if (
        !['NONE', 'OCTAHEDRAL', 'QUATERNION', 'EXPONENTIAL', 'COLOR'].includes(filter) ||
        (filter !== 'NONE' && mode !== 'ATTRIBUTES') ||
        (['OCTAHEDRAL', 'COLOR'].includes(filter) && ![4, 8].includes(stride)) ||
        (filter === 'QUATERNION' && stride !== 8) ||
        (filter === 'EXPONENTIAL' && stride % 4 !== 0)
      )
        throw new TypeError('Invalid glTF meshopt filter');
      if (this.decoded + length > this.maxBytes * 4) throw new RangeError('Decoded glTF exceeds byte budget');
      const sourceBytes = source.subarray(sourceOffset, sourceOffset + sourceLength);
      let bytes: Uint8Array;
      if (this.hooks.meshopt) {
        bytes = new Uint8Array(length);
        this.hooks.meshopt.decodeGltfBuffer(bytes, count, stride, sourceBytes, mode, filter);
      } else bytes = meshoptDecodeGltfBuffer(sourceBytes, count, stride, mode, filter);
      this.reserveDecodedBytes(bytes.byteLength);
      this.viewCache.set(index, bytes);
      return bytes;
    }
    if (!buffer || offset + length > buffer.length) throw new RangeError('Invalid glTF bufferView bounds');
    return buffer.subarray(offset, offset + length);
  }
  /** Supply already normalized Draco data before constructing a PBR model. */
  setDecodedAccessor(id: unknown, values: Float32Array): void {
    const { index, width, count } = accessorLayout(this.doc, id);
    if (!(values instanceof Float32Array) || values.length !== count * width)
      throw new RangeError('Mismatched decoded glTF accessor');
    if (values.some((value) => !Number.isFinite(value))) throw new RangeError('Non-finite decoded glTF accessor');
    const cached = this.cache.get(index);
    if (cached) {
      if (cached !== values && cached.some((value, i) => value !== values[i]))
        throw new TypeError('Conflicting decoded glTF accessor');
      return;
    }
    this.reserveDecodedBytes(values.byteLength);
    this.cache.set(index, values);
  }
  async decode(signal?: AbortSignal): Promise<void> {
    const { decompressPrimitives } = await import('./compression.js');
    const hook = this.hooks.draco;
    // The retained structural hook permits omitted derived metadata; the built-in decoder's strict contract remains unchanged.
    const draco = hook
      ? {
          decode: async (data: Uint8Array, options: GLTFDracoDecodeOptions) => {
            const result = await hook.decode(data, options),
              vertexCount = result.vertexCount ?? (result.positions?.length as number) / 3;
            const attributes =
              result.attributes &&
              Object.fromEntries(
                Object.entries(result.attributes).map(([name, value]) => {
                  const attribute = value as { array: ArrayLike<number>; itemSize?: number; componentType?: number };
                  return [
                    name,
                    {
                      ...attribute,
                      itemSize: attribute.itemSize ?? attribute.array.length / vertexCount,
                      componentType: attribute.componentType ?? options.componentTypes[name],
                    },
                  ];
                }),
              );
            return {
              ...result,
              vertexCount,
              attributes,
              indices:
                result.indices ??
                (Number.isSafeInteger(vertexCount) && vertexCount >= 3 && vertexCount <= 1_000_000
                  ? Uint32Array.from({ length: vertexCount }, (_, i) => i)
                  : undefined),
            };
          },
        }
      : undefined;
    await decompressPrimitives(this, { signal, draco });
  }
  accessor(id: unknown, type?: string): Float32Array {
    const { index, def, size, width, count } = accessorLayout(this.doc, id, type);
    const cached = this.cache.get(index);
    if (cached) return cached;
    this.reserveDecodedBytes(count * width * 4);
    const output = new Float32Array(count * width);
    // Element i lands at row i, or at row ids[i] for sparse values.
    const read = (bytes: Uint8Array, offset: number, stride: number, n: number, ids?: number[]) => {
      if (offset % size || stride % size || offset + (n - 1) * stride + width * size > bytes.length)
        throw new RangeError('Invalid glTF accessor bounds/alignment');
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
        type: number = def.componentType,
        divisor = def.normalized ? (normalizers[type] ?? 1) : 0;
      for (let i = 0; i < n; i++) {
        const row = (ids ? ids[i] : i) * width;
        for (let c = 0, at = offset + i * stride; c < width; c++, at += size) {
          let value = component(view, at, type);
          if (divisor) value = Math.max(-1, value / divisor);
          if (!Number.isFinite(Math.fround(value))) throw new RangeError('Non-finite glTF accessor');
          output[row + c] = value;
        }
      }
    };
    if (def.bufferView !== undefined) {
      const v = entry(this.doc.bufferViews, def.bufferView, 'bufferView'),
        stride = integer(v.byteStride ?? size * width, 'stride', size * width);
      if (stride > 252 || integer(v.byteOffset ?? 0, 'view offset') % size)
        throw new RangeError('Invalid glTF stride/alignment');
      read(this.view(def.bufferView), integer(def.byteOffset ?? 0, 'accessor offset'), stride, count);
    } else if (!def.sparse || def.byteOffset) {
      if (
        this.doc.meshes?.some((mesh) =>
          mesh?.primitives?.some(
            (primitive) =>
              primitive?.extensions?.[dracoExtension] &&
              (primitive.indices === index ||
                Object.keys(primitive.extensions[dracoExtension].attributes ?? {}).some(
                  (semantic) => primitive.attributes?.[semantic] === index,
                )),
          ),
        )
      )
        throw new Error('Draco geometry requires parseGLTFAsync or loadGLTF');
      throw new TypeError('Accessor has no data or invalid offset');
    }
    if (def.sparse) {
      const sparse = def.sparse,
        n = integer(sparse.count, 'sparse count', 1),
        indices = sparse.indices,
        values = sparse.values,
        indexSize = componentSizes[indices?.componentType];
      if (n > count || ![5121, 5123, 5125].includes(indices?.componentType))
        throw new TypeError('Invalid glTF sparse indices');
      const bytes = this.view(indices.bufferView),
        at = integer(indices.byteOffset ?? 0, 'sparse offset');
      if (
        at % indexSize ||
        at + n * indexSize > bytes.length ||
        entry(this.doc.bufferViews, indices.bufferView, 'sparse indices').byteStride !== undefined ||
        entry(this.doc.bufferViews, values?.bufferView, 'sparse values').byteStride !== undefined
      )
        throw new RangeError('Invalid sparse bounds/stride');
      const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
        ids: number[] = [];
      let previous = -1;
      for (let i = 0; i < n; i++) {
        const p = at + i * indexSize,
          id = indexSize === 1 ? v.getUint8(p) : indexSize === 2 ? v.getUint16(p, true) : v.getUint32(p, true);
        if (id <= previous || id >= count) throw new RangeError('Invalid sparse index order/bounds');
        ids.push(id);
        previous = id;
      }
      read(this.view(values.bufferView), integer(values.byteOffset ?? 0, 'sparse values offset'), size * width, n, ids);
    }
    this.cache.set(index, output);
    return output;
  }
}
function ktxSources(doc: GLTFDocument): Set<number> {
  const sources = new Set<number>();
  for (const texture of doc.textures ?? [])
    if (texture?.extensions?.[basisuExtension] !== undefined) {
      const source = textureSource(texture),
        def = entry(doc.images, source, 'KTX2 image');
      if (
        (def.mimeType !== undefined && def.mimeType !== 'image/ktx2') ||
        (def.bufferView !== undefined && def.mimeType !== 'image/ktx2')
      )
        throw new TypeError('KHR_texture_basisu requires image/ktx2');
      sources.add(source);
    }
  for (let i = 0; i < (doc.images?.length ?? 0); i++) if (doc.images![i]?.mimeType === 'image/ktx2') sources.add(i);
  return sources;
}
function unusedBasisuFallbacks(doc: GLTFDocument): Set<number> {
  const fallbacks = new Set<number>(),
    selected = new Set<number>();
  for (const texture of doc.textures ?? []) {
    if (texture?.extensions?.[basisuExtension] !== undefined) {
      selected.add(textureSource(texture));
      if (Number.isSafeInteger(texture.source) && texture.source! >= 0) fallbacks.add(texture.source!);
    } else if (Number.isSafeInteger(texture?.source) && texture.source! >= 0) selected.add(texture.source!);
  }
  for (const source of selected) fallbacks.delete(source);
  return fallbacks;
}
function ktxHeader(
  data: Uint8Array,
  asset: GLTFAsset,
  device?: GPUDevice,
): { width: number; height: number; levels: number } {
  const magic = [171, 75, 84, 88, 32, 50, 48, 187, 13, 10, 26, 10];
  if (data.length < 80 || magic.some((v, i) => data[i] !== v)) throw new TypeError('Invalid glTF KTX2 header');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength),
    width = view.getUint32(20, true),
    height = view.getUint32(24, true),
    levels = view.getUint32(40, true);
  if (
    !width ||
    !height ||
    width % 4 ||
    height % 4 ||
    width * height > 16_777_216 ||
    width > (device?.limits.maxTextureDimension2D ?? 16384) ||
    height > (device?.limits.maxTextureDimension2D ?? 16384) ||
    view.getUint32(28, true) ||
    view.getUint32(32, true) ||
    view.getUint32(36, true) !== 1 ||
    !levels ||
    levels > Math.floor(Math.log2(Math.max(width, height))) + 1
  )
    throw new RangeError('Invalid glTF KTX2 dimensions or mip levels');
  let worstBytes = 0;
  for (let level = 0; level < levels; level++)
    worstBytes += Math.max(1, width >> level) * Math.max(1, height >> level) * 4;
  if (worstBytes > asset.remainingDecodedBytes) throw new RangeError('glTF KTX2 exceeds decoded byte budget');
  return { width, height, levels };
}
function validateKTX2(result: TranscodedKTX2Result, header: ReturnType<typeof ktxHeader>, asset: GLTFAsset): KTX2Image {
  const formats = {
    rgba8: ['rgba8unorm', 1, 4],
    bc7: ['bc7-rgba-unorm', 4, 16],
    'astc-4x4': ['astc-4x4-unorm', 4, 16],
    etc2: ['etc2-rgba8unorm', 4, 16],
  } as const;
  const format = result && Object.hasOwn(formats, result.target) ? formats[result.target] : undefined,
    base = typeof result?.format === 'string' ? result.format.replace(/-srgb$/, '') : undefined;
  if (
    !format ||
    base !== format[0] ||
    result.width !== header.width ||
    result.height !== header.height ||
    !Array.isArray(result.mipmaps) ||
    result.mipmaps.length !== header.levels ||
    typeof result.srgb !== 'boolean' ||
    typeof result.hasAlpha !== 'boolean'
  )
    throw new TypeError('Invalid transcoded glTF KTX2 image');
  let total = 0;
  for (let level = 0; level < result.mipmaps.length; level++) {
    const mip = result.mipmaps[level];
    const width = Math.max(1, header.width >> level),
      height = Math.max(1, header.height >> level),
      length = Math.ceil(width / format[1]) * Math.ceil(height / format[1]) * format[2];
    if (
      !mip ||
      mip.width !== width ||
      mip.height !== height ||
      !(mip.data instanceof Uint8Array) ||
      mip.data.byteLength !== length ||
      mip.byteLength !== length
    )
      throw new RangeError('Invalid transcoded glTF KTX2 mip');
    total += length;
  }
  asset.reserveDecodedBytes(total);
  return { ktx2: result, width: result.width, height: result.height, close() {} };
}
function ktxDecoder(asset: GLTFAsset, options: GLTFImageOptions) {
  let decoder = options.ktx2,
    owned: KTX2Decoder | undefined;
  return {
    async decode(data: Uint8Array): Promise<KTX2Image> {
      options.signal?.throwIfAborted();
      const header = ktxHeader(data, asset, options.device);
      if (!decoder) {
        const { KTX2Decoder } = await import('@margoengine/decoders');
        options.signal?.throwIfAborted();
        decoder = owned = new KTX2Decoder({ device: options.device });
      }
      const result = (await decoder.transcode(data, { signal: options.signal })) as TranscodedKTX2Result;
      options.signal?.throwIfAborted();
      return validateKTX2(result, header, asset);
    },
    close() {
      owned?.dispose();
    },
  };
}
/** Async only for requested KTX2 images; caller-supplied ordinary bitmaps retain their synchronous path. */
export async function decodeKTX2Images(
  asset: GLTFAsset,
  images: readonly GLTFImage[] = [],
  options: GLTFImageOptions = {},
): Promise<GLTFImage[]> {
  options.signal?.throwIfAborted();
  const sources = ktxSources(asset.doc);
  if (!sources.size) return images as GLTFImage[];
  const decoded = images.slice(),
    decoder = ktxDecoder(asset, options);
  try {
    for (const source of sources) {
      if (decoded[source]) {
        if (!('ktx2' in decoded[source])) throw new TypeError('KHR_texture_basisu requires decoded KTX2 images');
        continue;
      }
      const def = entry(asset.doc.images, source, 'KTX2 image');
      const data =
        def.bufferView !== undefined
          ? asset.view(def.bufferView)
          : typeof def.uri === 'string' && def.uri.startsWith('data:')
            ? embedded(def.uri, asset.maxBytes)
            : undefined;
      if (!data) throw new Error('External KTX2 images require loadGLTF');
      decoded[source] = await decoder.decode(data);
    }
    return decoded;
  } finally {
    decoder.close();
  }
}
export interface AssetOptions {
  signal?: AbortSignal;
  decoders?: GLTFDecoderHooks;
  buffers?: Array<ArrayBuffer | ArrayBufferView>;
  /** Fetch for the file and its external buffers and images, for example `@margoengine/cache`'s `cache.fetch`. Default `globalThis.fetch`. */
  fetch?: typeof fetch;
  allowedURLs?: readonly string[];
  /**
   * Most bytes the file, its buffers and embedded or external images may total (default 64 MiB). Decoded accessors,
   * packed geometry and decoded images may each use 4x this. Exceeding it throws a RangeError naming this option.
   */
  maxDownloadBytes?: number;
  /** Most glTF nodes the file may have, each one a core mesh (default 100,000; up to core's 8,388,608 entities). */
  maxNodes?: number;
}
/** Fetch (url) or parse (input) a glTF, decode compressed geometry and images. External URIs resolve against url, else the page. */
export async function loadAsset(
  url: string | URL | undefined,
  options: AssetOptions | AbortSignal = {},
  inputOrPrepare?: string | object | ArrayBuffer | ArrayBufferView | ((asset: GLTFAsset) => Promise<void>),
  imageOptions: GLTFImageOptions = {},
  deferCompression = false,
  downloadedBytes = 0,
): Promise<{ asset: GLTFAsset; images: GLTFImage[]; deferred?: boolean; baseURL?: string; downloadedBytes?: number }> {
  const config: AssetOptions = 'aborted' in options ? { signal: options as AbortSignal } : (options as AssetOptions);
  const {
    signal,
    decoders = {},
    buffers: provided = [],
    fetch: get = globalThis.fetch,
    maxDownloadBytes,
    maxNodes,
    allowedURLs,
  } = config;
  const prepare = typeof inputOrPrepare === 'function' ? inputOrPrepare : undefined;
  const input = typeof inputOrPrepare === 'function' ? undefined : inputOrPrepare;
  const limit = downloadLimit(maxDownloadBytes);
  signal?.throwIfAborted();
  let base = url === undefined ? undefined : new URL(url, globalThis.location?.href),
    total = downloadedBytes;
  const fetchBytes = async (target: URL, root = false) => {
    if (!['http:', 'https:'].includes(target.protocol)) throw new TypeError('glTF URL must use HTTP(S)');
    const response = await get(target, { signal });
    if (root && response.url) base = new URL(response.url);
    const bytes = await readResponse(response, { maxBytes: limit - total, signal, label: 'glTF download' }).catch(
      (error) => {
        throw error instanceof RangeError ? overBudget(error.message, limit) : error;
      },
    );
    total += bytes.length;
    return bytes;
  };
  const resolve = (uri: string) => assetURL(uri, base ?? globalThis.location?.href, allowedURLs, 'glTF resource');
  const { doc, binary } = container(input ?? (await fetchBytes(base!, true)), limit),
    buffers: Uint8Array[] = [],
    images: GLTFImage[] = [];
  checkDocument(doc);
  for (let i = 0; i < (doc.buffers?.length ?? 0); i++) {
    const def = entry(doc.buffers, i, 'buffer');
    if (provided[i]) {
      const given = provided[i];
      buffers[i] =
        given instanceof ArrayBuffer
          ? new Uint8Array(given)
          : new Uint8Array(given.buffer, given.byteOffset, given.byteLength);
      continue;
    }
    if (def.extensions?.[meshoptExtension]?.fallback === true) continue;
    if (!def.uri) {
      if (i === 0 && binary) buffers[i] = binary;
    } else if (typeof def.uri !== 'string') throw new TypeError('Invalid glTF buffer uri');
    else if (def.uri.startsWith('data:')) {
      const b = embedded(def.uri, limit);
      total += b.length;
      if (total > limit) throw new RangeError('glTF exceeds download budget');
      buffers[i] = b;
    } else buffers[i] = await fetchBytes(resolve(def.uri));
  }
  const asset = new GLTFAsset(doc, buffers, binary, decoders, limit, maxNodes);
  if (deferCompression && asyncCompression(doc))
    return { asset, images, deferred: true, baseURL: base?.href, downloadedBytes: total };
  const sources = ktxSources(doc),
    fallbacks = unusedBasisuFallbacks(doc),
    decoder = ktxDecoder(asset, { ...imageOptions, ktx2: imageOptions.ktx2 ?? decoders.ktx2, signal });
  let decodedImages = 0;
  await asset.decode(signal);
  try {
    signal?.throwIfAborted();
    await prepare?.(asset);
    signal?.throwIfAborted();
    for (let index = 0; index < (doc.images?.length ?? 0); index++) {
      if (fallbacks.has(index)) continue;
      const def = entry(doc.images, index, 'image');
      let data: Uint8Array;
      if (def.bufferView !== undefined) data = asset.view(def.bufferView);
      else if (typeof def.uri === 'string' && def.uri.startsWith('data:')) {
        data = embedded(def.uri, limit);
        total += data.length;
        if (total > limit) throw overBudget('glTF exceeds download budget', limit);
      } else if (typeof def.uri === 'string') data = await fetchBytes(resolve(def.uri));
      else throw new TypeError('Invalid glTF image');
      const bitmap = sources.has(index) ? await decoder.decode(data) : await decodeImage(data, def.mimeType, index);
      images[index] = bitmap;
      decodedImages += bitmap.width * bitmap.height * 4;
      if (bitmap.width * bitmap.height > 16_777_216 || decodedImages > limit * 4)
        throw new RangeError('glTF images exceed decoded size limit');
      signal?.throwIfAborted();
    }
    return { asset, images };
  } catch (error) {
    closeImages(images);
    throw error;
  } finally {
    decoder.close();
  }
}
/** Image bytes as an ImageBitmap; bytes the browser cannot decode throw TypeError('glTF image N could not be decoded (...)'). */
export async function decodeImage(data: Uint8Array, type: string | undefined, index: number): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(new Blob([new Uint8Array(data)], { type }), {
      colorSpaceConversion: 'none',
      premultiplyAlpha: 'none',
    });
  } catch (error) {
    // The browser rejects with a DOMException (InvalidStateError); report it as the loader's own error.
    throw new TypeError(
      `glTF image ${index} could not be decoded (${error instanceof Error ? error.message : error}); check the file`,
    );
  }
}
export function closeImages(images: readonly GLTFImage[]): void {
  for (const image of images) if (image && 'close' in image) image.close();
}
