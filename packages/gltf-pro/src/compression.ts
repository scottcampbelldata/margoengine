import type {DracoDecoder, DecodedDracoGeometry} from '@margoengine/decoders';
import {GLTFAsset, entry, integer, assetLimit} from './asset.js';

export interface GLTFLoadOptions {
  signal?: AbortSignal;
  /** Optional reusable decoder. The caller retains ownership; otherwise a decoder is created and disposed per load. */
  draco?: Pick<DracoDecoder, 'decode'>;
}

const decoded = new WeakMap<GLTFAsset, Map<object, Float32Array>>();
const widths: Record<string, number> = {SCALAR:1,VEC2:2,VEC3:3,VEC4:4,MAT4:16};
const fields = {POSITION:'positions',NORMAL:'normals',TEXCOORD_0:'uvs',COLOR_0:'colors'} as const;
const scales: Record<number, number> = {5120:127,5121:255,5122:32767,5123:65535};

/** Draco topology belongs to the primitive, including when no index accessor is declared. */
export function compressedIndices(asset:GLTFAsset, primitive:any):Float32Array|undefined {
  if (!primitive.extensions?.KHR_draco_mesh_compression) return;
  const indices = decoded.get(asset)?.get(primitive);
  if (!indices) throw new Error('Draco primitives require loadGLTF or parseGLTFAsync');
  return indices;
}

export async function decompressPrimitives(asset:GLTFAsset, {signal,draco}:GLTFLoadOptions = {}):Promise<void> {
  signal?.throwIfAborted();
  let owned:DracoDecoder|undefined;
  const ready = decoded.get(asset) ?? new Map<object, Float32Array>();
  decoded.set(asset, ready);
  try {
    for (const mesh of asset.doc.meshes ?? []) for (const p of mesh.primitives ?? []) {
      const ext = p.extensions?.KHR_draco_mesh_compression;
      if (!ext || ready.has(p)) continue;
      if ((p.mode ?? 4) !== 4) throw new Error('PBR requires triangle primitives');
      if (!ext.attributes || typeof ext.attributes !== 'object' || Array.isArray(ext.attributes)) throw new TypeError('Invalid glTF Draco attributes');
      const componentTypes:Record<string,number> = {}, attributeIds:Record<string,number> = {}, attributeWidths:Record<string,number> = {};
      const position = entry(asset.doc.accessors,p.attributes?.POSITION,'Draco POSITION');
      const vertexCount = integer(position.count,'Draco vertex count',3);
      if (position.type !== 'VEC3' || vertexCount > 1_000_000) throw new RangeError('Invalid glTF Draco POSITION size');
      let bytes = 0;
      for (const [semantic,id] of Object.entries(ext.attributes)) {
        const def = entry(asset.doc.accessors,p.attributes?.[semantic],'Draco attribute');
        const count = integer(def.count,'Draco accessor count',1), width = Object.hasOwn(widths,def.type) ? widths[def.type] : undefined;
        if (!width || count !== vertexCount) throw new RangeError('Invalid glTF Draco accessor size');
        bytes += count * width * 4;
        componentTypes[semantic] = integer(def.componentType,'Draco component type');
        attributeIds[semantic] = integer(id,'Draco attribute id');
        attributeWidths[semantic] = width;
      }
      const indexDef = p.indices === undefined ? undefined : entry(asset.doc.accessors,p.indices,'Draco indices');
      if (indexDef) {
        if (indexDef.type !== 'SCALAR' || ![5121,5123,5125].includes(indexDef.componentType) || indexDef.normalized) throw new TypeError('Invalid glTF Draco indices');
        const count = integer(indexDef.count,'Draco index count',1);
        if (count > 1_000_000 || count % 3) throw new RangeError('Invalid glTF Draco index count');
        bytes += count * 4;
      }
      if (bytes > assetLimit * 4) throw new RangeError('Decoded glTF exceeds byte budget');
      const source = asset.view(ext.bufferView);
      if (bytes > asset.remainingDecodedBytes) throw new RangeError('Decoded glTF exceeds byte budget');
      const maxIndices = indexDef ? indexDef.count : Math.min(1_000_000,Math.floor((asset.remainingDecodedBytes - bytes) / 4));
      if (maxIndices < 3) throw new RangeError('Decoded glTF exceeds index byte budget');
      if (!draco) {
        const {DracoDecoder} = await import('@margoengine/decoders');
        signal?.throwIfAborted();
        draco = owned = new DracoDecoder();
      }
      const result:DecodedDracoGeometry = await draco.decode(source,{attributeIds,componentTypes,signal,
        limits:{maxVertices:vertexCount,maxIndices,maxDecodedBytes:asset.remainingDecodedBytes,attributeWidths}});
      signal?.throwIfAborted();
      const count = integer(result.vertexCount,'Draco vertex count',3), indices = result.indices;
      if (count > 1_000_000 || !(indices instanceof Uint16Array || indices instanceof Uint32Array) || !indices.length || indices.length > 1_000_000 || indices.length % 3 || indices.some(i=>i>=count) || indexDef && indices.length !== indexDef.count) throw new RangeError('Invalid glTF Draco triangle indices');
      if (indexDef && indices.some(i=>i>({5121:255,5123:65535,5125:4294967295}[indexDef.componentType as 5121]))) throw new RangeError('Draco indices exceed accessor component type');
      for (const semantic of Object.keys(attributeIds)) {
        const id = p.attributes[semantic], def = entry(asset.doc.accessors,id,'Draco attribute');
        const field = Object.hasOwn(fields,semantic) ? fields[semantic as keyof typeof fields] : undefined, extra = result.attributes?.[semantic];
        const values = field ? result[field] : extra?.array;
        if (!ArrayBuffer.isView(values) || values instanceof DataView || def.count !== count || values.length !== count * widths[def.type] || !field && (extra?.itemSize !== widths[def.type] || extra.componentType !== def.componentType)) throw new RangeError('Mismatched glTF Draco attribute '+semantic);
        // The decoder already normalizes COLOR_0; integer UVs and extra channels retain their encoded values.
        const normalized = Float32Array.from(values);
        if (def.normalized && semantic !== 'COLOR_0') {
          const scale = scales[def.componentType];
          if (!scale) throw new TypeError('Invalid normalized Draco attribute');
          for (let i=0;i<normalized.length;i++) normalized[i] = Math.max(-1,normalized[i]/scale);
        }
        asset.setDecodedAccessor(id,normalized);
      }
      if (p.indices === undefined) asset.reserveDecodedBytes(indices.length * 4);
      const values = Float32Array.from(indices);
      if (p.indices !== undefined) asset.setDecodedAccessor(p.indices,values);
      // Shared accessors retain one accounted array, including across distinct primitive definitions.
      ready.set(p,p.indices === undefined ? values : asset.accessor(p.indices,'SCALAR'));
    }
  } finally {owned?.dispose();}
}
