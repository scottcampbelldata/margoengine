import type { TraceMaterial, VoxelTraceScene } from '@margoengine/voxel-pathtracer';
import { multiplyMatrices } from '@margoengine/math/mat4';
import type { PBRMeshTraceScene, TracePBRMesh, TracePBRMaterial, TracePBRTexture } from './mesh-pbr-types.js';
import { MargoError } from '@margoengine/math/errors';
import { waitForFeature } from './feature-wait.js';

/** Owned triangle snapshot returned by a loaded glTF model's CPU-query API. */
export interface TraceGLTFGeometry {
  /** gltf-pro's 20-float vertex rows. */
  vertices: Float32Array;
  /** Triangle vertex indices. */
  indices: Uint32Array;
  /** Column-major node-to-world transform. */
  matrix: Float32Array;
  /** Index in the captured primitive list. */
  primitiveIndex?: number;
}

/** Structural subset of PBRModel consumed by the optional adapter; no runtime glTF dependency. */
export interface TraceLoadedGLTF {
  /** Validated glTF JSON document from the loader. */
  readonly asset: {readonly doc: object};
  /** Loaded triangle primitives, retained in loader order. */
  readonly primitives: readonly {
    definition: {material?: number};
    material: object;
    uvs?: Float32Array;
    instances?: {readonly data: Float32Array;readonly count: number};
  }[];
  /** Snapshot current vertices/indices/matrices, reading deformed vertices back when necessary. */
  readPickingGeometry(): Promise<readonly TraceGLTFGeometry[]>;
  /** Borrow a decoded image. The loaded model retains ownership. */
  image(index: number): unknown;
}
interface TextureInfo {index:number;texCoord?:number;extensions?:unknown}
interface GLTFDocumentSnapshot {
  materials?: readonly {
    pbrMetallicRoughness?: {baseColorFactor?:readonly number[];metallicFactor?:number;roughnessFactor?:number;baseColorTexture?:TextureInfo;metallicRoughnessTexture?:TextureInfo};
    normalTexture?: TextureInfo & {scale?:number};
    emissiveTexture?:TextureInfo;emissiveFactor?:readonly number[];
    alphaMode?:string;alphaCutoff?:number;doubleSided?:boolean;
    extensions?:{KHR_materials_emissive_strength?:unknown};
  }[];
  textures?: readonly {source?:number;sampler?:number;extensions?:{
    KHR_texture_basisu?:{source:number};EXT_texture_webp?:{source:number};EXT_texture_avif?:{source:number};
  }}[];
  samplers?: readonly {wrapS?:number;wrapT?:number;magFilter?:number}[];
}

/** Snapshot options for a loaded glTF model. */
export interface TraceGLTFOptions {
  /** Cancels preparation; caller owns the loaded model throughout the snapshot. */
  signal?: AbortSignal;
  /** Optional existing voxel scene. Its palette is independent of mesh materials. */
  scene?: VoxelTraceScene;
  /** Decode a compressed or streamed image to owned RGBA8. Ordinary bitmaps need no callback. */
  imagePixels?: (imageIndex: number, signal?: AbortSignal) => Promise<{width: number; height: number; data: Uint8Array | Uint8ClampedArray}>;
}

/** Snapshot loaded glTF geometry, materials, images and affine instance placements for meshPBR(). */
export async function traceSceneFromGLTF(model: TraceLoadedGLTF, options: TraceGLTFOptions = {}): Promise<PBRMeshTraceScene> {
  const { signal } = options;
  signal?.throwIfAborted();
  const doc = model.asset.doc as GLTFDocumentSnapshot;
  const definitions = structuredClone(doc.materials ?? []);
  const textures = structuredClone(doc.textures ?? []), samplers = structuredClone(doc.samplers ?? []);
  const primitives = model.primitives.map(p => ({definition: structuredClone(p.definition), material: p.material,
    uvs: p.uvs?.slice(), instances: p.instances ? {data: p.instances.data.slice(), count: p.instances.count} : undefined}));
  const base = options.scene ?? {revision: 1, models: [], instances: [], materials: []};
  const {models, ...rest} = base;
  const scene: VoxelTraceScene = {...structuredClone(rest), models: models.map(model => {
    const {contentKey, ...data} = model;
    return {...structuredClone(data), ...(contentKey === undefined ? {} : {contentKey})};
  })};
  const geometry = await waitForFeature(model.readPickingGeometry(), signal);
  signal?.throwIfAborted();
  const ids = new Map<object, number>();
  const materials: TracePBRMaterial[] = [];
  const palettes: TraceMaterial[] = [...scene.materials];
  const meshes: TracePBRMesh[] = [];
  const instances: NonNullable<PBRMeshTraceScene['meshInstances']>[number][] = [];
  const decoded = new Map<number, {width: number; height: number; data: Uint8Array | Uint8ClampedArray}>();
  // Capture material definitions before any image decoding can yield to caller edits.
  const image = async (info: {index: number; texCoord?: number; extensions?: unknown} | undefined): Promise<TracePBRTexture | undefined> => {
    if (!info) return undefined;
    signal?.throwIfAborted();
    const texture = textures[info.index];
    const source = texture?.extensions?.KHR_texture_basisu?.source ?? texture?.source ??
      texture?.extensions?.EXT_texture_webp?.source ?? texture?.extensions?.EXT_texture_avif?.source;
    if (!texture || source === undefined) throw new TypeError('Mesh PBR glTF texture has no image source; re-export the file with a valid texture source');
    let pixels = decoded.get(source);
    if (!pixels) {
      if (options.imagePixels) pixels = await waitForFeature(options.imagePixels(source, signal), signal);
      else {
       const borrowed = model.image(source);
       if (typeof ImageBitmap !== 'undefined' && borrowed instanceof ImageBitmap) {
        const canvas = new OffscreenCanvas(borrowed.width, borrowed.height);
        const context = canvas.getContext('2d', {willReadFrequently: true});
        if (!context) throw new MargoError('unsupported', 'Mesh PBR needs a 2D image decoder; provide imagePixels: https://margoengine.com/errors#voxel-pathtracer');
        context.drawImage(borrowed, 0, 0);
        const rgba = context.getImageData(0, 0, borrowed.width, borrowed.height);
        pixels = {width: rgba.width, height: rgba.height, data: rgba.data};
       } else throw new MargoError('unsupported', 'Mesh PBR compressed or streamed images need imagePixels: https://margoengine.com/errors#voxel-pathtracer');
      }
      signal?.throwIfAborted();
      pixels = {...pixels, data: pixels.data.slice()};
      decoded.set(source, pixels);
    }
    const sampler = texture.sampler === undefined ? undefined : samplers[texture.sampler];
    const address = (value: number | undefined) => value === 33071 ? 'clamp' as const : value === 33648 ? 'mirror' as const : 'repeat' as const;
    const ext = (info.extensions as {KHR_texture_transform?: {offset?: number[]; scale?: number[]; rotation?: number; texCoord?: number}} | undefined)?.KHR_texture_transform;
    const scale = ext?.scale ?? [1,1], offset = ext?.offset ?? [0,0], c = Math.cos(ext?.rotation ?? 0), s = Math.sin(ext?.rotation ?? 0);
    return {...pixels, texCoord: ext?.texCoord ?? info.texCoord ?? 0, wrapS: address(sampler?.wrapS), wrapT: address(sampler?.wrapT),
      filter: sampler?.magFilter === 9728 ? 'nearest' : 'linear',
      transform: [c*scale[0]!, -s*scale[1]!, offset[0]!, s*scale[0]!, c*scale[1]!, offset[1]!]};
  };
  for (const [index, part] of geometry.entries()) {
    signal?.throwIfAborted();
    const primitive = part.primitiveIndex === undefined ? undefined : primitives[part.primitiveIndex];
    if (!primitive) throw new MargoError('unsupported', 'Mesh PBR needs unmerged glTF primitives; load without static merging: https://margoengine.com/errors#voxel-pathtracer');
    let id = ids.get(primitive.material);
    if (id === undefined) {
      id = materials.length + 1;
      ids.set(primitive.material, id);
      const def = primitive.definition.material === undefined ? undefined : definitions[primitive.definition.material];
      if (def?.alphaMode === 'BLEND') throw new MargoError('unsupported', 'Mesh PBR supports OPAQUE and MASK; use transmission for volume transparency: https://margoengine.com/errors#voxel-pathtracer');
      const pbr = def?.pbrMetallicRoughness;
      materials.push({id, baseColorFactor: (pbr?.baseColorFactor ?? [1,1,1,1]) as [number,number,number,number],
        metallicFactor: pbr?.metallicFactor ?? 1, roughnessFactor: pbr?.roughnessFactor ?? 1,
        emissiveFactor: (def?.emissiveFactor ?? [0,0,0]) as [number,number,number],
        emissiveStrength: (def?.extensions?.KHR_materials_emissive_strength as {emissiveStrength?: number} | undefined)?.emissiveStrength ?? 1,
        normalScale: def?.normalTexture?.scale ?? 1, doubleSided: def?.doubleSided ?? false,
        alphaMode: def?.alphaMode === 'MASK' ? 'MASK' : 'OPAQUE', alphaCutoff: def?.alphaCutoff ?? .5,
        baseColorTexture: await image(pbr?.baseColorTexture), metallicRoughnessTexture: await image(pbr?.metallicRoughnessTexture),
        normalTexture: await image(def?.normalTexture), emissiveTexture: await image(def?.emissiveTexture)});
    }
    const count = part.vertices.length / 20, positions = new Float32Array(count*3), normals = new Float32Array(count*3),
      tangents = new Float32Array(count*4), colors = new Float32Array(count*4), uvSets = Array.from({length: 4}, () => new Float32Array(count*2));
    for (let i=0;i<count;i++) {
      const at=i*20;positions.set(part.vertices.subarray(at,at+3),i*3);normals.set(part.vertices.subarray(at+4,at+7),i*3);
      tangents.set(part.vertices.subarray(at+8,at+12),i*4);colors.set(part.vertices.subarray(at+16,at+20),i*4);
      uvSets[0]!.set(part.vertices.subarray(at+12,at+14),i*2);uvSets[1]!.set(part.vertices.subarray(at+14,at+16),i*2);
      if(primitive.uvs){uvSets[2]!.set(primitive.uvs.subarray(i*4,i*4+2),i*2);uvSets[3]!.set(primitive.uvs.subarray(i*4+2,i*4+4),i*2);}
    }
    const mesh=`gltf-${index}`;
    meshes.push({id: mesh, material: id, positions, indices: part.indices.slice(), normals, colors, uvSets, uvs: uvSets[0],
      ...(tangents.some(n=>n!==0)?{tangents}:{})});
    if (primitive.instances) {
      const rows=primitive.instances.data.slice(), count=primitive.instances.count;
      for(let i=0;i<count;i++){
        const matrix=new Float32Array(16);multiplyMatrices(part.matrix,rows.subarray(i*24,i*24+16),matrix);
        instances.push({id:`${mesh}-${i}`,mesh,transform:matrix});
      }
    }else instances.push({id:mesh,mesh,transform:part.matrix.slice()});
  }
  signal?.throwIfAborted();
  return {...scene, materials: palettes, meshes, meshInstances: instances, pbrMaterials: materials};
}
