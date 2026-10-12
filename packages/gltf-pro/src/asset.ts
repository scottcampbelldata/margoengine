import {readResponse} from '../../shared/loading.js';
export type GLTFDocument = Record<string, any>;
export const assetLimit = 64 * 1024 * 1024;
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
export class GLTFAsset {
  readonly buffers: Uint8Array[];
  private readonly cache = new Map<number, Float32Array>();
  private decoded = 0;
  constructor(readonly doc: GLTFDocument, buffers: Array<ArrayBuffer | ArrayBufferView>, binary?: Uint8Array) {
    if (!doc || doc.asset?.version !== '2.0') throw new TypeError('Expected glTF 2.0');
    for (const key of ['buffers','bufferViews','accessors','meshes','nodes','scenes','materials','textures','images','samplers','skins','animations','extensionsRequired'])
      if (doc[key] !== undefined && !Array.isArray(doc[key])) throw new TypeError('Invalid glTF ' + key);
    if (doc.extensionsRequired?.length) throw new Error('Required glTF extensions are unsupported: ' + doc.extensionsRequired.join(', '));
    if ((doc.nodes?.length ?? 0) > 100_000) throw new RangeError('Too many glTF nodes');
    let total = 0;
    this.buffers = (doc.buffers ?? []).map((def: any, i: number) => {
      const input = buffers[i], data = input ? input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : def.uri ? embedded(def.uri) : i === 0 ? binary : undefined;
      const length = integer(def.byteLength, 'buffer length', 1);
      if (!data || length > data.length) throw new RangeError('Truncated glTF buffer');
      total += data.byteLength; if (total > assetLimit) throw new RangeError('glTF buffers exceed byte budget');
      return data.subarray(0, length);
    });
  }
  view(id: unknown): Uint8Array {
    const def = entry(this.doc.bufferViews, id, 'bufferView'), buffer = this.buffers[integer(def.buffer, 'buffer reference')];
    const offset = integer(def.byteOffset ?? 0, 'view offset'), length = integer(def.byteLength, 'view length', 1);
    if (!buffer || offset + length > buffer.length) throw new RangeError('Invalid glTF bufferView bounds');
    return buffer.subarray(offset, offset + length);
  }
  accessor(id: unknown, type?: string): Float32Array {
    const index = integer(id, 'accessor'), def = entry(this.doc.accessors, index, 'accessor');
    if (type && def.type !== type) throw new TypeError('Invalid glTF accessor type');
    const cached = this.cache.get(index); if (cached) return cached;
    const size = componentSizes[def.componentType], width = components[def.type], count = integer(def.count, 'accessor count', 1);
    if (!size || !width || count > 1_000_000 || def.normalized !== undefined && typeof def.normalized !== 'boolean' || def.normalized && [5125,5126].includes(def.componentType)) throw new TypeError('Unsupported glTF accessor');
    this.decoded += count * width * 4; if (this.decoded > assetLimit * 4) throw new RangeError('Decoded glTF exceeds byte budget');
    const output = new Float32Array(count * width);
    const read = (bytes: Uint8Array, offset: number, stride: number, n: number, write: (i: number, c: number, v: number) => void) => {
      if (offset % size || stride % size || offset + (n - 1) * stride + width * size > bytes.length) throw new RangeError('Invalid glTF accessor bounds/alignment');
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (let i = 0; i < n; i++) for (let c = 0; c < width; c++) {
        const at = offset + i * stride + c * size;
        let value = def.componentType === 5126 ? view.getFloat32(at, true) : def.componentType === 5125 ? view.getUint32(at, true) : def.componentType === 5123 ? view.getUint16(at, true) : def.componentType === 5122 ? view.getInt16(at, true) : def.componentType === 5121 ? view.getUint8(at) : view.getInt8(at);
        if (def.normalized) value = Math.max(-1, value / ({5120:127,5121:255,5122:32767,5123:65535}[def.componentType as 5120] ?? 1));
        if (!Number.isFinite(Math.fround(value))) throw new RangeError('Non-finite glTF accessor');
        write(i, c, value);
      }
    };
    if (def.bufferView !== undefined) {
      const v = entry(this.doc.bufferViews, def.bufferView, 'bufferView'), stride = integer(v.byteStride ?? size * width, 'stride', size * width);
      if (stride > 252 || integer(v.byteOffset ?? 0, 'view offset') % size) throw new RangeError('Invalid glTF stride/alignment');
      read(this.view(def.bufferView), integer(def.byteOffset ?? 0, 'accessor offset'), stride, count, (i,c,v) => {output[i * width + c] = v;});
    } else if (!def.sparse || def.byteOffset) throw new TypeError('Accessor has no data or invalid offset');
    if (def.sparse) {
      const sparse = def.sparse, n = integer(sparse.count, 'sparse count', 1), indices = sparse.indices, values = sparse.values, indexSize = componentSizes[indices?.componentType];
      if (n > count || ![5121,5123,5125].includes(indices?.componentType)) throw new TypeError('Invalid glTF sparse indices');
      const bytes = this.view(indices.bufferView), at = integer(indices.byteOffset ?? 0, 'sparse offset');
      if (at % indexSize || at + n * indexSize > bytes.length || entry(this.doc.bufferViews,indices.bufferView,'sparse indices').byteStride!==undefined || entry(this.doc.bufferViews,values?.bufferView,'sparse values').byteStride!==undefined) throw new RangeError('Invalid sparse bounds/stride');
      const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), ids: number[] = []; let previous = -1;
      for (let i = 0; i < n; i++) {const p = at + i * indexSize, id = indexSize === 1 ? v.getUint8(p) : indexSize === 2 ? v.getUint16(p,true) : v.getUint32(p,true); if (id <= previous || id >= count) throw new RangeError('Invalid sparse index order/bounds'); ids.push(id); previous = id;}
      read(this.view(values.bufferView), integer(values.byteOffset ?? 0, 'sparse values offset'), size * width, n, (i,c,v) => {output[ids[i] * width + c] = v;});
    }
    this.cache.set(index, output); return output;
  }
}
export async function loadAsset(url: string | URL, signal?: AbortSignal): Promise<{asset: GLTFAsset; images: ImageBitmap[]}> {
  signal?.throwIfAborted(); let base = new URL(url, globalThis.location?.href), total = 0;
  const fetchBytes = async (target: URL, root = false) => {
    if (!['http:','https:'].includes(target.protocol)) throw new TypeError('glTF URL must use HTTP(S)');
    const response = await fetch(target, {signal}); if (root && response.url) base = new URL(response.url);
    const bytes = await readResponse(response, {maxBytes: assetLimit - total, signal, label: 'glTF download'}); total += bytes.length; return bytes;
  };
  const bytes = await fetchBytes(base, true), glb = bytes.length >= 4 && new DataView(bytes.buffer, bytes.byteOffset).getUint32(0,true) === 0x46546c67;
  const {doc,binary} = container(glb ? bytes : new TextDecoder('utf-8',{fatal:true}).decode(bytes)), buffers: Uint8Array[] = [], images: ImageBitmap[] = [];
  for (const def of doc.buffers ?? []) {
    if (!def.uri) buffers.push(binary ?? new Uint8Array());
    else if (def.uri.startsWith('data:')) {const b = embedded(def.uri); total += b.length; if (total > assetLimit) throw new RangeError('glTF exceeds download budget'); buffers.push(b);}
    else buffers.push(await fetchBytes(new URL(def.uri,base)));
  }
  const asset = new GLTFAsset(doc,buffers,binary);let decodedImages=0;
  try {
    for (const def of doc.images ?? []) {
      let data: Uint8Array;
      if (def.bufferView !== undefined) data = asset.view(def.bufferView);
      else if (typeof def.uri === 'string' && def.uri.startsWith('data:')) {data = embedded(def.uri); total += data.length; if (total > assetLimit) throw new RangeError('glTF exceeds download budget');}
      else if (typeof def.uri === 'string') data = await fetchBytes(new URL(def.uri,base));
      else throw new TypeError('Invalid glTF image');
      const bitmap = await createImageBitmap(new Blob([new Uint8Array(data)],{type:def.mimeType}), {colorSpaceConversion:'none',premultiplyAlpha:'none'});
      images.push(bitmap);
      decodedImages+=bitmap.width*bitmap.height*4;
      if (bitmap.width * bitmap.height > 16_777_216 || decodedImages>assetLimit*4) throw new RangeError('glTF images exceed decoded size limit');
      signal?.throwIfAborted();
    }
    return {asset,images};
  } catch (error) {for (const image of images) image.close(); throw error;}
}
