import type { EngineKernel } from '@margoengine/core';
import type { PBRModel } from '@margoengine/gltf/pbr-model';
import { decodeImage } from '@margoengine/decoders/image';
import { readLightmap, applyLightmap, type ImportedLightmap } from '@margoengine/lightmap/imported';
import { decodeMargo, parseMargo, type MargoOptions } from './index.js';
import { readResponse } from '../../shared/loading.js';
import { captureScene } from '../../shared/scene-scope.js';
import { maxBytes } from './container.js';

/** One object's linear diffuse irradiance at its second UV set. */
export interface MargoLightmap { node: number; lightmap: ImportedLightmap; }
/** Read embedded Cycles lightmaps without a GPU. Aborts before and between bounded image decodes. */
export async function decodeMargoLightmaps(input: ArrayBuffer | ArrayBufferView, options: MargoOptions & { signal?: AbortSignal } = {}): Promise<MargoLightmap[]> {
  options.signal?.throwIfAborted();
  const asset = decodeMargo(input, options), result: MargoLightmap[] = [];
  for (const [node, value] of (asset.document.nodes ?? []).entries()) {
    const meta = (value.extras as { margo?: { lightmap?: { texture: number; scale: number; texCoord: number; radiometry: string } } } | undefined)?.margo?.lightmap;
    if (meta === undefined) continue;
    if (!meta || !Number.isSafeInteger(meta.texture) || meta.texCoord !== 1 || meta.radiometry !== 'irradiance')
      throw new TypeError('Invalid .margo lightmap metadata; re-export with Cycles lightmap baking enabled');
    const image = asset.document.textures?.[meta.texture]?.source;
    if (image === undefined || !asset.images[image]) throw new TypeError('Invalid .margo lightmap texture; re-export the embedded image');
    options.signal?.throwIfAborted();
    const decoded = await decodeImage(asset.images[image], { signal: options.signal });
    result.push({ node, lightmap: readLightmap({ ...decoded, scale: meta.scale }) });
  }
  options.signal?.throwIfAborted();
  return result;
}
/** Load a static .margo and apply its external Cycles bakes through lightmap/imported. */
export async function parseMargoLightmap(engine: EngineKernel, input: ArrayBuffer | ArrayBufferView, options: MargoOptions & { signal?: AbortSignal } = {}): Promise<PBRModel> {
  // The model and its lightmap plugins are made after the awaits below: they go in the scene this call started in
  // (KB-OWN-BLEND2), not the one active once the images are decoded.
  const scope = captureScene(engine),
    maps = await decodeMargoLightmaps(input, options),
    model = await scope.run(() => parseMargo(engine, input, options));
  try {
    for (const { node, lightmap } of maps) scope.run(() => applyLightmap(model, lightmap, [node]));
    return model;
  } catch (error) { model.dispose(); throw error; }
}
/** Fetch a .margo with abort and the existing 256 MiB bound, then apply its lightmaps. */
export async function loadMargoLightmap(engine: EngineKernel, url: string | URL, options: MargoOptions & { signal?: AbortSignal; fetch?: typeof fetch } = {}): Promise<PBRModel> {
  options.signal?.throwIfAborted();
  const scope = captureScene(engine),
    target = new URL(url, globalThis.location?.href);
  if (!['http:', 'https:'].includes(target.protocol)) throw new TypeError('Lightmap URL must use HTTP(S); read local bytes and call parseMargoLightmap');
  const bytes = await readResponse(await (options.fetch ?? globalThis.fetch)(target, { signal: options.signal }), { maxBytes, signal: options.signal });
  return scope.run(() => parseMargoLightmap(engine, bytes, options));
}
