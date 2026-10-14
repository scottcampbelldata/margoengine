import type {EngineKernel} from '@margoengine/core';
import {parseGLTF, type PBRModel} from '@margoengine/gltf-pro';
import {readResponse} from '../../shared/loading.js';
import {readFBX} from './reader.js';
import {fbxToGLB} from './convert.js';
export interface FBXOptions {resourcePath?: string; signal?: AbortSignal}
const budget = 64 * 1024 * 1024;

/** Native binary (7.x) and ASCII FBX to GLB: hierarchy, pivots, Phong/Lambert as PBR, textures, skins, blend shapes and animation clips. */
export async function convertFBX(input: ArrayBuffer | ArrayBufferView, {resourcePath = '', signal}: FBXOptions = {}): Promise<ArrayBuffer> {
  signal?.throwIfAborted();
  if (!(input instanceof ArrayBuffer) && !ArrayBuffer.isView(input) || input.byteLength < 32 || input.byteLength > budget) throw new RangeError('Invalid FBX byte budget');
  const http = (url: URL) => {if (!['http:', 'https:'].includes(url.protocol)) throw new TypeError('FBX resources need HTTP(S)'); return url;};
  if (resourcePath) http(new URL(resourcePath, globalThis.location?.href));
  const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  const records = await readFBX(bytes); signal?.throwIfAborted();
  const texture = async (name: string) => {
    let url: URL; try {url = new URL(resourcePath + name, globalThis.location?.href);} catch {throw new Error('FBX texture failed: ' + name);}
    const response = await fetch(http(url), {signal}).catch(error => {if (signal?.aborted) throw error; throw new Error('FBX texture failed: ' + url.href);});
    if (!response.ok) throw new Error('FBX texture failed: ' + url.href);
    return readResponse(response, {maxBytes: budget, signal, label: 'FBX texture'});
  };
  const result = await fbxToGLB(records, texture, 1_000_000, signal);
  signal?.throwIfAborted(); if (result.byteLength > budget * 2) throw new RangeError('FBX conversion budget exceeded'); return result;
}

export async function parseFBX(engine: EngineKernel, input: ArrayBuffer | ArrayBufferView, options: FBXOptions = {}): Promise<PBRModel> {
  const glb = await convertFBX(input, options), view = new DataView(glb), jsonLength = view.getUint32(12, true), doc = JSON.parse(new TextDecoder().decode(new Uint8Array(glb, 20, jsonLength))), images: ImageBitmap[] = [];
  const binaryStart = 28 + jsonLength;
  try {
    let pixels = 0;
    for (const image of doc.images ?? []) {
      options.signal?.throwIfAborted();
      const source = doc.bufferViews[image.bufferView];
      const bitmap = await createImageBitmap(new Blob([new Uint8Array(glb, binaryStart + (source.byteOffset ?? 0), source.byteLength)], {type: image.mimeType}), {colorSpaceConversion: 'none', premultiplyAlpha: 'none'});
      images.push(bitmap); pixels += bitmap.width * bitmap.height;
      if (pixels > 16_000_000) throw new RangeError('FBX texture pixel budget exceeded');
    }
    options.signal?.throwIfAborted(); return parseGLTF(engine, glb, [], images);
  } catch (error) {for (const image of images) image.close(); throw error;}
}
export async function loadFBX(engine: EngineKernel, url: string | URL, options: FBXOptions = {}): Promise<PBRModel> {
  const target = new URL(url, globalThis.location?.href); if (!['http:', 'https:'].includes(target.protocol)) throw new TypeError('FBX URL needs HTTP(S)');
  const response = await fetch(target, {signal: options.signal}), bytes = await readResponse(response, {maxBytes: budget, signal: options.signal, label: 'FBX'});
  return parseFBX(engine, bytes, {...options, resourcePath: options.resourcePath ?? new URL('.', response.url || target).href});
}
