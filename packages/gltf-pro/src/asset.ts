import {readResponse} from '../../shared/loading.js';
import type {PBRInstances} from './instancing.js';
export type GLTFDocument = Record<string, any>;
export const assetLimit = 64 * 1024 * 1024;
/** A transcoded texture, such as a KTX2Decoder result: every mip level, in a format the device has enabled. */
export interface GLTFCompressedImage {width: number; height: number; format: GPUTextureFormat; mipmaps: readonly {data: Uint8Array; width: number; height: number}[]}
/** A decoded glTF image slot; undefined when a KTX2 image was skipped because no ktx2 decoder was passed. */
export type GLTFImage = ImageBitmap | GLTFCompressedImage | undefined;
/** Optional decoders. Structurally matches @margoengine/decoders (DracoDecoder, MeshoptDecoder, KTX2Decoder) without importing it. */
export interface GLTFDecoderHooks {
  draco?: {decode(data: Uint8Array, options: {attributeIds: Record<string, number>; componentTypes: Record<string, number>; signal?: AbortSignal}): Promise<{positions?: ArrayLike<number>; normals?: ArrayLike<number>; uvs?: ArrayLike<number>; colors?: ArrayLike<number>; indices?: ArrayLike<number>; attributes?: Record<string, {array: ArrayLike<number>}>}>};
  meshopt?: {decodeGltfBuffer(target: Uint8Array, count: number, stride: number, source: Uint8Array, mode: string, filter?: string): void};
  ktx2?: {transcode(data: Uint8Array, options?: {signal?: AbortSignal}): Promise<GLTFCompressedImage>};
  /** EXT_mesh_gpu_instancing: `instancing` from @margoengine/gltf-pro/instancing. */
  instancing?: {read(asset: GLTFAsset, extension: any): PBRInstances};
}
const supported = new Set(['KHR_mesh_quantization','KHR_texture_transform','KHR_materials_emissive_strength','KHR_materials_unlit','KHR_lights_punctual','KHR_materials_clearcoat','KHR_materials_transmission','KHR_materials_ior','KHR_materials_volume','KHR_materials_sheen','KHR_materials_specular','EXT_texture_webp','EXT_texture_avif','EXT_mesh_gpu_instancing']);
const hookFor: Record<string, keyof GLTFDecoderHooks> = {KHR_draco_mesh_compression: 'draco', EXT_meshopt_compression: 'meshopt', KHR_meshopt_compression: 'meshopt', KHR_texture_basisu: 'ktx2'};
const meshopt = (def: any) => def?.extensions?.EXT_meshopt_compression ?? def?.extensions?.KHR_meshopt_compression;
export function integer(value: unknown, label: string, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) throw new TypeError('Invalid glTF ' + label);
  return value;
}
export function entry(array: any[], id: unknown, label: string): any {
  const value = array?.[integer(id, label)];
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Missing glTF ' + label);
  return value;
}
export function container(input: string | object | ArrayBuffer | ArrayBufferView): {doc: GLTFDocument; binary?: Uint8Array} {
  if (typeof input === 'string') {
    if (new TextEncoder().encode(input).length > assetLimit) throw new RangeError('glTF JSON exceeds byte budget');
    return {doc: JSON.parse(input)};
  }
  if (!(input instanceof ArrayBuffer) && !ArrayBuffer.isView(input)) return {doc: input as GLTFDocument};
  const data = input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (data.length >= 4 && new DataView(data.buffer, data.byteOffset).getUint32(0, true) !== 0x46546c67) return container(new TextDecoder('utf-8', {fatal: true}).decode(data));
  if (data.length < 20 || data.length > assetLimit) throw new RangeError('Invalid GLB size');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== data.length) throw new TypeError('Invalid GLB header');
  let doc: GLTFDocument | undefined, binary: Uint8Array | undefined;
  for (let offset = 12; offset < data.length;) {
    if (offset + 8 > data.length) throw new RangeError('Truncated GLB chunk');
    const length = view.getUint32(offset, true), type = view.getUint32(offset + 4, true); offset += 8;
    if (length % 4 || offset + length > data.length) throw new RangeError('Invalid GLB chunk');
    const chunk = data.subarray(offset, offset + length);
    if (offset === 20 && type !== 0x4e4f534a) throw new TypeError('GLB JSON must be first');
    if (type === 0x4e4f534a) {if (doc) throw new TypeError('Duplicate GLB JSON'); doc = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(chunk));}
    else if (type === 0x004e4942) {if (binary) throw new TypeError('Duplicate GLB binary'); binary = chunk;}
    offset += length;
  }
  if (!doc) throw new TypeError('Missing GLB JSON');
  return {doc, binary};
}
function embedded(uri: string): Uint8Array {
  const match = /^data:[^;,]+;base64,([A-Za-z0-9+/]*={0,2})$/.exec(uri);
  if (!match || match[1].length > assetLimit * 4 / 3 + 4) throw new TypeError('Invalid glTF data URI');
  return Uint8Array.from(atob(match[1]), c => c.charCodeAt(0));
}
const componentSizes: Record<number, number> = {5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4};
const components: Record<string, number> = {SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16};
const normalizers: Record<number, number> = {5120: 127, 5121: 255, 5122: 32767, 5123: 65535};
function component(view: DataView, at: number, type: number): number {
  switch (type) {
    case 5126: return view.getFloat32(at, true);
    case 5125: return view.getUint32(at, true);
    case 5123: return view.getUint16(at, true);
    case 5122: return view.getInt16(at, true);
    case 5121: return view.getUint8(at);
    default: return view.getInt8(at);
  }
}
export class GLTFAsset {
  readonly buffers: Uint8Array[];
  private readonly cache = new Map<number, Float32Array>();
  private readonly views = new Map<number, Uint8Array>();
  private decoded = 0;
  constructor(readonly doc: GLTFDocument, buffers: Array<ArrayBuffer | ArrayBufferView>, binary?: Uint8Array, readonly hooks: GLTFDecoderHooks = {}) {
    if (!doc || doc.asset?.version !== '2.0') throw new TypeError('Expected glTF 2.0');
    for (const key of ['buffers','bufferViews','accessors','meshes','nodes','scenes','materials','textures','images','samplers','skins','animations','extensionsRequired'])
      if (doc[key] !== undefined && !Array.isArray(doc[key])) throw new TypeError('Invalid glTF ' + key);
    const missing = (doc.extensionsRequired ?? []).filter((name: string) => !supported.has(name) && !hooks[hookFor[name]]);
    if (missing.length) throw new Error('Required glTF extensions are unsupported: ' + missing.map((name: string) => hookFor[name] ? name + ' (pass a ' + hookFor[name] + ' decoder)' : name).join(', '));
    if ((doc.nodes?.length ?? 0) > 100_000) throw new RangeError('Too many glTF nodes');
    let total = 0;
    this.buffers = (doc.buffers ?? []).map((def: any, i: number) => {
      const input = buffers[i], data = input ? input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : def.uri ? embedded(def.uri) : i === 0 ? binary : undefined;
      const length = integer(def.byteLength, 'buffer length', 1);
      if (!data || length > data.length) {if (meshopt(def)?.fallback) return new Uint8Array(0); throw new RangeError('Truncated glTF buffer');}
      total += data.byteLength; if (total > assetLimit) throw new RangeError('glTF buffers exceed byte budget');
      return data.subarray(0, length);
    });
  }
  view(id: unknown): Uint8Array {
    const index = integer(id, 'bufferView'), def = entry(this.doc.bufferViews, index, 'bufferView'), m = meshopt(def), decoder = this.hooks.meshopt;
    if (!m || !decoder) return this.bytes(def);
    let out = this.views.get(index);
    if (!out) {
      const count = integer(m.count, 'meshopt count', 1), stride = integer(m.byteStride, 'meshopt stride', 1);
      this.budget(count * stride); out = new Uint8Array(count * stride);
      decoder.decodeGltfBuffer(out, count, stride, this.bytes(m), m.mode, m.filter); this.views.set(index, out);
    }
    return out;
  }
  private bytes(def: any): Uint8Array {
    const buffer = this.buffers[integer(def.buffer, 'buffer reference')], offset = integer(def.byteOffset ?? 0, 'view offset'), length = integer(def.byteLength, 'view length', 1);
    if (!buffer || offset + length > buffer.length) throw new RangeError('Invalid glTF bufferView bounds');
    return buffer.subarray(offset, offset + length);
  }
  private budget(bytes: number): void {this.decoded += bytes; if (this.decoded > assetLimit * 4) throw new RangeError('Decoded glTF exceeds byte budget');}
  /** Decode KHR_draco_mesh_compression primitives with the draco hook; their accessors then return the decoded data. */
  async decode(signal?: AbortSignal): Promise<void> {
    const draco = this.hooks.draco, jobs: Promise<void>[] = [];
    if (draco) for (const mesh of this.doc.meshes ?? []) for (const p of mesh?.primitives ?? []) {
      const ext = p?.extensions?.KHR_draco_mesh_compression; if (!ext) continue;
      const ids = ext.attributes ?? {}, a = p.attributes ?? {}, componentTypes: Record<string, number> = {};
      for (const key in ids) componentTypes[key] = entry(this.doc.accessors, a[key], 'Draco attribute').componentType;
      jobs.push(draco.decode(this.view(ext.bufferView), {attributeIds: ids, componentTypes, signal}).then(g => {
        const named: Record<string, ArrayLike<number> | undefined> = {POSITION: g.positions, NORMAL: g.normals, TEXCOORD_0: g.uvs, COLOR_0: g.colors};
        for (const key in ids) this.fill(a[key], named[key] ?? g.attributes?.[key]?.array);
        if (p.indices !== undefined) this.fill(p.indices, g.indices);
      }));
    }
    await Promise.all(jobs); signal?.throwIfAborted();
  }
  private fill(id: unknown, data: ArrayLike<number> | undefined): void {
    const index = integer(id, 'accessor'), def = entry(this.doc.accessors, index, 'accessor'), n = integer(def.count, 'accessor count', 1) * (components[def.type] ?? 0);
    if (!data || data.length !== n) throw new RangeError('Draco output does not match its glTF accessor');
    const scale = def.normalized && !(data instanceof Float32Array) ? normalizers[def.componentType] ?? 1 : 1, out = Float32Array.from(data, v => scale > 1 ? Math.max(-1, v / scale) : v);
    if (out.some(v => !Number.isFinite(v))) throw new RangeError('Non-finite Draco attribute');
    this.budget(out.byteLength); this.cache.set(index, out);
  }
  accessor(id: unknown, type?: string): Float32Array {
    const index = integer(id, 'accessor'), def = entry(this.doc.accessors, index, 'accessor');
    if (type && def.type !== type) throw new TypeError('Invalid glTF accessor type');
    const cached = this.cache.get(index); if (cached) return cached;
    const size = componentSizes[def.componentType], width = components[def.type], count = integer(def.count, 'accessor count', 1);
    if (!size || !width || count > 1_000_000 || def.normalized !== undefined && typeof def.normalized !== 'boolean' || def.normalized && [5125,5126].includes(def.componentType)) throw new TypeError('Unsupported glTF accessor');
    this.budget(count * width * 4);
    const output = new Float32Array(count * width);
    // Element i lands at row i, or at row ids[i] for sparse values.
    const read = (bytes: Uint8Array, offset: number, stride: number, n: number, ids?: number[]) => {
      if (offset % size || stride % size || offset + (n - 1) * stride + width * size > bytes.length) throw new RangeError('Invalid glTF accessor bounds/alignment');
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), type: number = def.componentType, divisor = def.normalized ? normalizers[type] ?? 1 : 0;
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
      const v = entry(this.doc.bufferViews, def.bufferView, 'bufferView'), stride = integer(v.byteStride ?? size * width, 'stride', size * width);
      if (stride > 252 || integer(v.byteOffset ?? 0, 'view offset') % size) throw new RangeError('Invalid glTF stride/alignment');
      read(this.view(def.bufferView), integer(def.byteOffset ?? 0, 'accessor offset'), stride, count);
    } else if (!def.sparse || def.byteOffset) throw new TypeError('Accessor has no data or invalid offset');
    if (def.sparse) {
      const sparse = def.sparse, n = integer(sparse.count, 'sparse count', 1), indices = sparse.indices, values = sparse.values, indexSize = componentSizes[indices?.componentType];
      if (n > count || ![5121,5123,5125].includes(indices?.componentType)) throw new TypeError('Invalid glTF sparse indices');
      const bytes = this.view(indices.bufferView), at = integer(indices.byteOffset ?? 0, 'sparse offset');
      if (at % indexSize || at + n * indexSize > bytes.length || entry(this.doc.bufferViews,indices.bufferView,'sparse indices').byteStride!==undefined || entry(this.doc.bufferViews,values?.bufferView,'sparse values').byteStride!==undefined) throw new RangeError('Invalid sparse bounds/stride');
      const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), ids: number[] = []; let previous = -1;
      for (let i = 0; i < n; i++) {const p = at + i * indexSize, id = indexSize === 1 ? v.getUint8(p) : indexSize === 2 ? v.getUint16(p,true) : v.getUint32(p,true); if (id <= previous || id >= count) throw new RangeError('Invalid sparse index order/bounds'); ids.push(id); previous = id;}
      read(this.view(values.bufferView), integer(values.byteOffset ?? 0, 'sparse values offset'), size * width, n, ids);
    }
    this.cache.set(index, output); return output;
  }
}
export interface AssetOptions {signal?: AbortSignal; decoders?: GLTFDecoderHooks; buffers?: Array<ArrayBuffer | ArrayBufferView>; /** Fetch for the file and its external buffers and images, for example `@margoengine/cache`'s `cache.fetch`. Default `globalThis.fetch`. */ fetch?: typeof fetch}
/** Fetch (url) or parse (input) a glTF, decode compressed geometry and images. External URIs resolve against url, else the page. */
export async function loadAsset(url: string | URL | undefined, {signal, decoders = {}, buffers: provided = [], fetch: get = globalThis.fetch}: AssetOptions = {}, input?: string | object | ArrayBuffer | ArrayBufferView): Promise<{asset: GLTFAsset; images: GLTFImage[]}> {
  signal?.throwIfAborted(); let base = url === undefined ? undefined : new URL(url, globalThis.location?.href), total = 0;
  const fetchBytes = async (target: URL, root = false) => {
    if (!['http:','https:'].includes(target.protocol)) throw new TypeError('glTF URL must use HTTP(S)');
    const response = await get(target, {signal}); if (root && response.url) base = new URL(response.url);
    const bytes = await readResponse(response, {maxBytes: assetLimit - total, signal, label: 'glTF download'}); total += bytes.length; return bytes;
  };
  const resolve = (uri: string) => new URL(uri, base ?? globalThis.location?.href);
  const {doc,binary} = container(input ?? await fetchBytes(base!, true)), buffers: Uint8Array[] = [], images: GLTFImage[] = [];
  for (const [i, def] of (doc.buffers ?? []).entries()) {
    const given = provided[i];
    if (given) buffers.push(given instanceof ArrayBuffer ? new Uint8Array(given) : new Uint8Array(given.buffer, given.byteOffset, given.byteLength));
    else if (!def.uri) buffers.push(i === 0 && binary || new Uint8Array());
    else if (def.uri.startsWith('data:')) {const b = embedded(def.uri); total += b.length; if (total > assetLimit) throw new RangeError('glTF exceeds download budget'); buffers.push(b);}
    else if (meshopt(def)?.fallback && decoders.meshopt) buffers.push(new Uint8Array());
    else buffers.push(await fetchBytes(resolve(def.uri)));
  }
  const asset = new GLTFAsset(doc,buffers,binary,decoders);let decodedImages=0;
  await asset.decode(signal);
  try {
    for (const def of doc.images ?? []) {
      const ktx2 = def.mimeType === 'image/ktx2' || /\.ktx2$/i.test(def.uri ?? '');
      if (ktx2 && !decoders.ktx2) {images.push(undefined); continue;}
      let data: Uint8Array;
      if (def.bufferView !== undefined) data = asset.view(def.bufferView);
      else if (typeof def.uri === 'string' && def.uri.startsWith('data:')) {data = embedded(def.uri); total += data.length; if (total > assetLimit) throw new RangeError('glTF exceeds download budget');}
      else if (typeof def.uri === 'string') data = await fetchBytes(resolve(def.uri));
      else throw new TypeError('Invalid glTF image');
      const image = ktx2 ? await decoders.ktx2!.transcode(data, {signal}) : await createImageBitmap(new Blob([new Uint8Array(data)],{type:def.mimeType}), {colorSpaceConversion:'none',premultiplyAlpha:'none'});
      images.push(image);
      decodedImages+='mipmaps' in image?image.mipmaps.reduce((sum,m)=>sum+m.data.byteLength,0):image.width*image.height*4;
      if (image.width * image.height > 16_777_216 || decodedImages>assetLimit*4) throw new RangeError('glTF images exceed decoded size limit');
      signal?.throwIfAborted();
    }
    return {asset,images};
  } catch (error) {closeImages(images); throw error;}
}
export function closeImages(images: readonly GLTFImage[]): void {for (const image of images) if (image && 'close' in image) image.close();}
