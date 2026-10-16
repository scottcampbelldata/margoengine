import {readResponse} from '../../shared/loading.js';
import {meshoptDecodeGltfBuffer} from '@margoengine/decoders/meshopt';
import type {KTX2Decoder, TranscodedKTX2Result} from '@margoengine/decoders';
export type GLTFDocument = Record<string, any>;
/** Retained mip bytes let compressed textures upload again after device restoration. */
export interface KTX2Image {readonly ktx2:TranscodedKTX2Result;readonly width:number;readonly height:number;close():void}
export type GLTFImage=ImageBitmap|KTX2Image;
export interface GLTFImageOptions {signal?:AbortSignal;device?:GPUDevice;ktx2?:Pick<KTX2Decoder,'transcode'>}
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
const meshoptExtension = 'EXT_meshopt_compression', dracoExtension = 'KHR_draco_mesh_compression',basisuExtension='KHR_texture_basisu';
/** Basis Universal replaces the ordinary PNG/JPEG source, including optional fallbacks. */
export function textureSource(def:any):number {
  const extension=def.extensions?.[basisuExtension];
  if(extension!==undefined&&(!extension||typeof extension!=='object'||Array.isArray(extension)))throw new TypeError('Invalid glTF KHR_texture_basisu');
  return integer(extension===undefined?def.source:extension.source,'image source');
}
function accessorLayout(doc: GLTFDocument, id: unknown, type?: string) {
  const index = integer(id, 'accessor'), def = entry(doc.accessors, index, 'accessor');
  if (type && def.type !== type) throw new TypeError('Invalid glTF accessor type');
  const size = typeof def.componentType === 'number' ? componentSizes[def.componentType] : undefined, width = typeof def.type === 'string' && Object.hasOwn(components, def.type) ? components[def.type] : undefined, count = integer(def.count, 'accessor count', 1);
  if (!size || !width || count > 1_000_000 || def.normalized !== undefined && typeof def.normalized !== 'boolean' || def.normalized && [5125,5126].includes(def.componentType)) throw new TypeError('Unsupported glTF accessor');
  return {index, def, size, width, count};
}
export class GLTFAsset {
  readonly buffers: Uint8Array[];
  private readonly cache = new Map<number, Float32Array>();
  private readonly viewCache = new Map<number, Uint8Array>();
  private decoded = 0;
  /** @internal Remaining retained decode budget, checked before decoder output allocation. */
  get remainingDecodedBytes(): number {return assetLimit * 4 - this.decoded;}
  /** @internal Account for retained decoded data, including topology without an accessor. */
  reserveDecodedBytes(byteLength: number): void {
    integer(byteLength, 'decoded byte length');
    if (this.decoded + byteLength > assetLimit * 4) throw new RangeError('Decoded glTF exceeds byte budget');
    this.decoded += byteLength;
  }
  constructor(readonly doc: GLTFDocument, buffers: Array<ArrayBuffer | ArrayBufferView>, binary?: Uint8Array) {
    if (!doc || doc.asset?.version !== '2.0') throw new TypeError('Expected glTF 2.0');
    for (const key of ['buffers','bufferViews','accessors','meshes','nodes','scenes','materials','textures','images','samplers','skins','animations','extensionsRequired'])
      if (doc[key] !== undefined && !Array.isArray(doc[key])) throw new TypeError('Invalid glTF ' + key);
    const unsupported = doc.extensionsRequired?.filter((name: unknown) => name !== dracoExtension && name !== meshoptExtension && name !== basisuExtension && name !== 'KHR_texture_transform');
    if (unsupported?.length) throw new Error('Required glTF extensions are unsupported: ' + unsupported.join(', '));
    if ((doc.nodes?.length ?? 0) > 100_000) throw new RangeError('Too many glTF nodes');
    let total = 0;
    this.buffers = (doc.buffers ?? []).map((def: any, i: number) => {
      if (!def || typeof def !== 'object' || Array.isArray(def)) throw new TypeError('Invalid glTF buffer');
      const length = integer(def.byteLength, 'buffer length', 1);
      const fallback = def.extensions?.[meshoptExtension]?.fallback;
      if (fallback !== undefined && typeof fallback !== 'boolean') throw new TypeError('Invalid glTF meshopt fallback');
      const input = buffers[i], placeholder = (!input || input.byteLength === 0) && !def.uri && (i !== 0 || !binary);
      if (fallback === true || placeholder && doc.extensionsRequired?.includes(meshoptExtension)) {
        const views = (doc.bufferViews ?? []).filter((view: any) => view?.buffer === i);
        if (!views.length || views.some((view: any) => !view.extensions?.[meshoptExtension]) || doc.bufferViews?.some((view: any) => view?.extensions?.[meshoptExtension]?.buffer === i)) throw new TypeError('Invalid glTF meshopt fallback references');
        return new Uint8Array();
      }
      const data = input ? input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : def.uri ? embedded(def.uri) : i === 0 ? binary : undefined;
      if (!data || length > data.length) throw new RangeError('Truncated glTF buffer');
      total += data.byteLength; if (total > assetLimit) throw new RangeError('glTF buffers exceed byte budget');
      return data.subarray(0, length);
    });
  }
  view(id: unknown): Uint8Array {
    const index = integer(id, 'bufferView'), def = entry(this.doc.bufferViews, index, 'bufferView'), bufferId = integer(def.buffer, 'buffer reference'), buffer = this.buffers[bufferId];
    const offset = integer(def.byteOffset ?? 0, 'view offset'), length = integer(def.byteLength, 'view length', 1);
    const declaredLength = integer(entry(this.doc.buffers, bufferId, 'buffer').byteLength, 'buffer length', 1);
    if (length > declaredLength || offset > declaredLength - length) throw new RangeError('Invalid glTF bufferView bounds');
    const extension = def.extensions?.[meshoptExtension];
    if (extension !== undefined) {
      const cached = this.viewCache.get(index); if (cached) return cached;
      if (!extension || typeof extension !== 'object' || Array.isArray(extension)) throw new TypeError('Invalid glTF meshopt extension');
      const source = this.buffers[integer(extension.buffer, 'meshopt buffer reference')], sourceOffset = integer(extension.byteOffset ?? 0, 'meshopt offset'), sourceLength = integer(extension.byteLength, 'meshopt length', 1);
      const count = integer(extension.count, 'meshopt count', 1), stride = integer(extension.byteStride, 'meshopt stride', 1), mode = extension.mode, filter = extension.filter ?? 'NONE';
      if (!source || sourceLength > source.length || sourceOffset > source.length - sourceLength) throw new RangeError('Invalid glTF meshopt source bounds');
      if (!Number.isSafeInteger(count * stride) || count * stride !== length || def.byteStride !== undefined && def.byteStride !== stride) throw new RangeError('Invalid glTF meshopt decoded layout');
      if (mode === 'ATTRIBUTES' ? stride > 256 || stride % 4 !== 0 : !['TRIANGLES','INDICES'].includes(mode) || ![2,4].includes(stride) || mode === 'TRIANGLES' && count % 3 !== 0) throw new TypeError('Invalid glTF meshopt mode/stride/count');
      if (!['NONE','OCTAHEDRAL','QUATERNION','EXPONENTIAL'].includes(filter) || filter !== 'NONE' && mode !== 'ATTRIBUTES' || filter === 'OCTAHEDRAL' && ![4,8].includes(stride) || filter === 'QUATERNION' && stride !== 8 || filter === 'EXPONENTIAL' && stride % 4 !== 0) throw new TypeError('Invalid glTF meshopt filter');
      if (this.decoded + length > assetLimit * 4) throw new RangeError('Decoded glTF exceeds byte budget');
      const bytes = meshoptDecodeGltfBuffer(source.subarray(sourceOffset, sourceOffset + sourceLength), count, stride, mode, filter);
      this.reserveDecodedBytes(bytes.byteLength); this.viewCache.set(index, bytes); return bytes;
    }
    if (!buffer || offset + length > buffer.length) throw new RangeError('Invalid glTF bufferView bounds');
    return buffer.subarray(offset, offset + length);
  }
  /** Supply already normalized Draco data before constructing a PBR model. */
  setDecodedAccessor(id: unknown, values: Float32Array): void {
    const {index, width, count} = accessorLayout(this.doc, id);
    if (!(values instanceof Float32Array) || values.length !== count * width) throw new RangeError('Mismatched decoded glTF accessor');
    if (values.some(value => !Number.isFinite(value))) throw new RangeError('Non-finite decoded glTF accessor');
    const cached = this.cache.get(index);
    if (cached) {
      if (cached !== values && cached.some((value, i) => value !== values[i])) throw new TypeError('Conflicting decoded glTF accessor');
      return;
    }
    this.reserveDecodedBytes(values.byteLength); this.cache.set(index, values);
  }
  accessor(id: unknown, type?: string): Float32Array {
    const {index, def, size, width, count} = accessorLayout(this.doc, id, type);
    const cached = this.cache.get(index); if (cached) return cached;
    this.reserveDecodedBytes(count * width * 4);
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
    } else if (!def.sparse || def.byteOffset) {
      if (this.doc.meshes?.some((mesh: any) => mesh?.primitives?.some((primitive: any) => primitive?.extensions?.[dracoExtension] && (primitive.indices === index || Object.keys(primitive.extensions[dracoExtension].attributes ?? {}).some(semantic => primitive.attributes?.[semantic] === index))))) throw new Error('Draco geometry requires parseGLTFAsync or loadGLTF');
      throw new TypeError('Accessor has no data or invalid offset');
    }
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
function ktxSources(doc:GLTFDocument):Set<number> {
  const sources=new Set<number>();
  for(const texture of doc.textures??[])if(texture?.extensions?.[basisuExtension]!==undefined){
    const source=textureSource(texture),def=entry(doc.images,source,'KTX2 image');
    if(def.mimeType!==undefined&&def.mimeType!=='image/ktx2'||def.bufferView!==undefined&&def.mimeType!=='image/ktx2')throw new TypeError('KHR_texture_basisu requires image/ktx2');
    sources.add(source);
  }
  for(let i=0;i<(doc.images?.length??0);i++)if(doc.images[i]?.mimeType==='image/ktx2')sources.add(i);
  return sources;
}
function unusedBasisuFallbacks(doc:GLTFDocument):Set<number> {
  const fallbacks=new Set<number>(),selected=new Set<number>();
  for(const texture of doc.textures??[]){
    if(texture?.extensions?.[basisuExtension]!==undefined){
      selected.add(textureSource(texture));
      if(Number.isSafeInteger(texture.source)&&texture.source>=0)fallbacks.add(texture.source);
    }else if(Number.isSafeInteger(texture?.source)&&texture.source>=0)selected.add(texture.source);
  }
  for(const source of selected)fallbacks.delete(source);return fallbacks;
}
function ktxHeader(data:Uint8Array,asset:GLTFAsset,device?:GPUDevice):{width:number;height:number;levels:number} {
  const magic=[171,75,84,88,32,50,48,187,13,10,26,10];
  if(data.length<80||magic.some((v,i)=>data[i]!==v))throw new TypeError('Invalid glTF KTX2 header');
  const view=new DataView(data.buffer,data.byteOffset,data.byteLength),width=view.getUint32(20,true),height=view.getUint32(24,true),levels=view.getUint32(40,true);
  if(!width||!height||width%4||height%4||width*height>16_777_216||width>(device?.limits.maxTextureDimension2D??16384)||height>(device?.limits.maxTextureDimension2D??16384)||view.getUint32(28,true)||view.getUint32(32,true)||view.getUint32(36,true)!==1||!levels||levels>Math.floor(Math.log2(Math.max(width,height)))+1)throw new RangeError('Invalid glTF KTX2 dimensions or mip levels');
  let worstBytes=0;for(let level=0;level<levels;level++)worstBytes+=Math.max(1,width>>level)*Math.max(1,height>>level)*4;
  if(worstBytes>asset.remainingDecodedBytes)throw new RangeError('glTF KTX2 exceeds decoded byte budget');
  return {width,height,levels};
}
function validateKTX2(result:TranscodedKTX2Result,header:ReturnType<typeof ktxHeader>,asset:GLTFAsset):KTX2Image {
  const formats={rgba8:['rgba8unorm',1,4],bc7:['bc7-rgba-unorm',4,16],'astc-4x4':['astc-4x4-unorm',4,16],etc2:['etc2-rgba8unorm',4,16]} as const;
  const format=result&&Object.hasOwn(formats,result.target)?formats[result.target]:undefined,base=typeof result?.format==='string'?result.format.replace(/-srgb$/,''):undefined;
  if(!format||base!==format[0]||result.width!==header.width||result.height!==header.height||!Array.isArray(result.mipmaps)||result.mipmaps.length!==header.levels||typeof result.srgb!=='boolean'||typeof result.hasAlpha!=='boolean')throw new TypeError('Invalid transcoded glTF KTX2 image');
  let total=0;
  for(let level=0;level<result.mipmaps.length;level++){
    const mip=result.mipmaps[level];
    const width=Math.max(1,header.width>>level),height=Math.max(1,header.height>>level),length=Math.ceil(width/format[1])*Math.ceil(height/format[1])*format[2];
    if(!mip||mip.width!==width||mip.height!==height||!(mip.data instanceof Uint8Array)||mip.data.byteLength!==length||mip.byteLength!==length)throw new RangeError('Invalid transcoded glTF KTX2 mip');
    total+=length;
  }
  asset.reserveDecodedBytes(total);
  return {ktx2:result,width:result.width,height:result.height,close(){}};
}
function ktxDecoder(asset:GLTFAsset,options:GLTFImageOptions) {
  let decoder=options.ktx2,owned:KTX2Decoder|undefined;
  return {
    async decode(data:Uint8Array):Promise<KTX2Image> {
      options.signal?.throwIfAborted();const header=ktxHeader(data,asset,options.device);
      if(!decoder){const {KTX2Decoder}=await import('@margoengine/decoders');options.signal?.throwIfAborted();decoder=owned=new KTX2Decoder({device:options.device});}
      const result=await decoder.transcode(data,{signal:options.signal});options.signal?.throwIfAborted();return validateKTX2(result,header,asset);
    },
    close(){owned?.dispose();}
  };
}
/** Async only for requested KTX2 images; caller-supplied ordinary bitmaps retain their synchronous path. */
export async function decodeKTX2Images(asset:GLTFAsset,images:readonly GLTFImage[]=[],options:GLTFImageOptions={}):Promise<GLTFImage[]> {
  options.signal?.throwIfAborted();const sources=ktxSources(asset.doc);if(!sources.size)return images as GLTFImage[];
  const decoded=images.slice(),decoder=ktxDecoder(asset,options);
  try {
    for(const source of sources){
      if(decoded[source]){if(!('ktx2' in decoded[source]))throw new TypeError('KHR_texture_basisu requires decoded KTX2 images');continue;}
      const def=entry(asset.doc.images,source,'KTX2 image');
      const data=def.bufferView!==undefined?asset.view(def.bufferView):typeof def.uri==='string'&&def.uri.startsWith('data:')?embedded(def.uri):undefined;
      if(!data)throw new Error('External KTX2 images require loadGLTF');decoded[source]=await decoder.decode(data);
    }
    return decoded;
  }finally{decoder.close();}
}
export async function loadAsset(url: string | URL, signal?: AbortSignal, prepare?: (asset: GLTFAsset) => Promise<void>,imageOptions:GLTFImageOptions={}): Promise<{asset: GLTFAsset; images: GLTFImage[]}> {
  signal?.throwIfAborted(); let base = new URL(url, globalThis.location?.href), total = 0;
  const fetchBytes = async (target: URL, root = false) => {
    if (!['http:','https:'].includes(target.protocol)) throw new TypeError('glTF URL must use HTTP(S)');
    const response = await fetch(target, {signal}); if (root && response.url) base = new URL(response.url);
    const bytes = await readResponse(response, {maxBytes: assetLimit - total, signal, label: 'glTF download'}); total += bytes.length; return bytes;
  };
  const bytes = await fetchBytes(base, true), glb = bytes.length >= 4 && new DataView(bytes.buffer, bytes.byteOffset).getUint32(0,true) === 0x46546c67;
  const {doc,binary} = container(glb ? bytes : new TextDecoder('utf-8',{fatal:true}).decode(bytes)), buffers: Uint8Array[] = [], images: GLTFImage[] = [];
  for (let i = 0; i < (doc.buffers?.length ?? 0); i++) {
    const def = entry(doc.buffers, i, 'buffer');
    if (def.extensions?.[meshoptExtension]?.fallback === true) continue;
    if (!def.uri) {if (i === 0 && binary) buffers[i] = binary;}
    else if (def.uri.startsWith('data:')) {const b = embedded(def.uri); total += b.length; if (total > assetLimit) throw new RangeError('glTF exceeds download budget'); buffers[i] = b;}
    else buffers[i] = await fetchBytes(new URL(def.uri,base));
  }
  const asset = new GLTFAsset(doc,buffers,binary),sources=ktxSources(doc),fallbacks=unusedBasisuFallbacks(doc),decoder=ktxDecoder(asset,{...imageOptions,signal});let decodedImages=0;
  try {
    signal?.throwIfAborted(); await prepare?.(asset); signal?.throwIfAborted();
    for (let index=0;index<(doc.images?.length??0);index++) {
      if(fallbacks.has(index))continue;
      const def=entry(doc.images,index,'image');
      let data: Uint8Array;
      if (def.bufferView !== undefined) data = asset.view(def.bufferView);
      else if (typeof def.uri === 'string' && def.uri.startsWith('data:')) {data = embedded(def.uri); total += data.length; if (total > assetLimit) throw new RangeError('glTF exceeds download budget');}
      else if (typeof def.uri === 'string') data = await fetchBytes(new URL(def.uri,base));
      else throw new TypeError('Invalid glTF image');
      const bitmap = sources.has(index)?await decoder.decode(data):await createImageBitmap(new Blob([new Uint8Array(data)],{type:def.mimeType}), {colorSpaceConversion:'none',premultiplyAlpha:'none'});
      images[index]=bitmap;
      decodedImages+=bitmap.width*bitmap.height*4;
      if (bitmap.width * bitmap.height > 16_777_216 || decodedImages>assetLimit*4) throw new RangeError('glTF images exceed decoded size limit');
      signal?.throwIfAborted();
    }
    return {asset,images};
  } catch (error) {for (const image of images) image?.close(); throw error;}finally{decoder.close();}
}
