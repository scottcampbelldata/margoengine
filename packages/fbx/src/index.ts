import type {EngineKernel} from '@margoengine/core';
import {parseGLTF, type PBRModel} from '@margoengine/gltf-pro';
import {FBXLoader} from 'three/addons/loaders/FBXLoader.js';
import {GLTFExporter} from 'three/addons/exporters/GLTFExporter.js';
import {LoadingManager, MeshStandardMaterial, type Mesh, type Material, type Texture, type Color} from 'three';
import {readResponse} from '../../shared/loading.js';
export interface FBXOptions {resourcePath?: string; signal?: AbortSignal}
const budget = 64 * 1024 * 1024;

/** Browser conversion preserves FBX bones, animation clips and morph channels as glTF. */
export async function convertFBX(input: ArrayBuffer | ArrayBufferView, {resourcePath = '', signal}: FBXOptions = {}): Promise<ArrayBuffer> {
  signal?.throwIfAborted();
  if (!(input instanceof ArrayBuffer) && !ArrayBuffer.isView(input) || input.byteLength < 32 || input.byteLength > budget) throw new RangeError('Invalid FBX byte budget');
  if (resourcePath && !['http:', 'https:'].includes(new URL(resourcePath, globalThis.location?.href).protocol)) throw new TypeError('FBX resources need HTTP(S)');
  const bytes = input instanceof ArrayBuffer ? input : new Uint8Array(input.buffer, input.byteOffset, input.byteLength).slice().buffer;
  const manager = new LoadingManager(); let loading = false, loadError: Error | undefined, done!: () => void;
  const ready = new Promise<void>(resolve => {done = resolve;});
  manager.onStart = () => {loading = true;}; manager.onLoad = done; manager.onError = url => {loadError = new Error('FBX texture failed: ' + url);};
  const scene = new FBXLoader(manager).parse(bytes, resourcePath), materials = new Set<Material>(), textures = new Set<Texture>(), geometries = new Set<Mesh['geometry']>();
  try {
    if (loading) {
      let abort!: () => void;
      try {await Promise.race([ready, new Promise<never>((_, reject) => {abort = () => reject(signal!.reason); signal?.addEventListener('abort', abort, {once: true});})]);}
      finally {signal?.removeEventListener('abort', abort);}
    }
    signal?.throwIfAborted(); if (loadError) throw loadError;
    let vertices = 0;
    const converted = new Map<Material, MeshStandardMaterial>();
    scene.traverse(object => {
      const mesh = object as Mesh; if (!mesh.isMesh) return;
      vertices += mesh.geometry.getAttribute('position')?.count ?? 0; if (vertices > 1_000_000) throw new RangeError('FBX geometry budget exceeded'); geometries.add(mesh.geometry);
      const normalize = (material: Material): Material => {
        materials.add(material); for (const value of Object.values(material)) if ((value as Texture)?.isTexture) textures.add(value as Texture);
        if ((material as MeshStandardMaterial).isMeshStandardMaterial) return material;
        let pbr = converted.get(material);
        if (!pbr) {
          const legacy = material as Material & {color?: Color; map?: Texture; normalMap?: Texture; shininess?: number};
          pbr = new MeshStandardMaterial({color: legacy.color, map: legacy.map ?? null, normalMap: legacy.normalMap ?? null, opacity: material.opacity, transparent: material.transparent, side: material.side,
            roughness: Math.max(0.045, Math.min(1, Math.sqrt(2 / ((legacy.shininess ?? 0) + 2))))});
          pbr.name = material.name; converted.set(material, pbr); materials.add(pbr);
        }
        return pbr;
      };
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(normalize) : normalize(mesh.material);
    });
    if (!vertices) throw new RangeError('FBX has no mesh geometry');
    const result = await new GLTFExporter().parseAsync(scene, {binary: true, animations: scene.animations});
    signal?.throwIfAborted(); if (!(result instanceof ArrayBuffer) || result.byteLength > budget * 2) throw new RangeError('FBX conversion budget exceeded'); return result;
  } finally {
    scene.traverse(object => {const mesh = object as Mesh; if (mesh.isMesh) {geometries.add(mesh.geometry); for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) materials.add(material);}});
    for (const material of materials) for (const value of Object.values(material)) if ((value as Texture)?.isTexture) textures.add(value as Texture);
    for (const geometry of geometries) geometry.dispose(); for (const material of materials) material.dispose(); for (const texture of textures) texture.dispose();
  }
}

export async function parseFBX(engine: EngineKernel, input: ArrayBuffer | ArrayBufferView, options: FBXOptions = {}): Promise<PBRModel> {
  const glb = await convertFBX(input, options), view = new DataView(glb), jsonLength = view.getUint32(12, true), doc = JSON.parse(new TextDecoder().decode(new Uint8Array(glb, 20, jsonLength))), images: ImageBitmap[] = [];
  const binaryStart = 28 + jsonLength;
  try {
    for (const image of doc.images ?? []) {
      const source = doc.bufferViews[image.bufferView];
      const bitmap = await createImageBitmap(new Blob([new Uint8Array(glb, binaryStart + (source.byteOffset ?? 0), source.byteLength)], {type: image.mimeType}), {colorSpaceConversion: 'none', premultiplyAlpha: 'none'});
      images.push(bitmap); if (images.reduce((sum, item) => sum + item.width * item.height, 0) > 16_000_000) throw new RangeError('FBX texture pixel budget exceeded');
    }
    options.signal?.throwIfAborted(); return parseGLTF(engine, glb, [], images);
  } catch (error) {for (const image of images) image.close(); throw error;}
}
export async function loadFBX(engine: EngineKernel, url: string | URL, options: FBXOptions = {}): Promise<PBRModel> {
  const target = new URL(url, globalThis.location?.href); if (!['http:', 'https:'].includes(target.protocol)) throw new TypeError('FBX URL needs HTTP(S)');
  const response = await fetch(target, {signal: options.signal}), bytes = await readResponse(response, {maxBytes: budget, signal: options.signal, label: 'FBX'});
  return parseFBX(engine, bytes, {...options, resourcePath: options.resourcePath ?? new URL('.', response.url || target).href});
}
