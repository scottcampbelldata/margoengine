import type { EngineKernel } from '@margoengine/core';
import type { GLTFImage, PBRModel } from '@margoengine/gltf-pro';
import {
  closeImages,
  disposeSource,
  entry,
  preloadAsset,
  trackedFetch,
  type AssetCache,
  type AssetEntry,
  type ModelFormat,
  type ModelSource,
} from './assets.js';
import { optionalPeer } from './optional.js';

/** Loads a model file into a gltf-pro model: gltf-pro's `loadGLTF`, or the FBX loader the `<Fbx>` binding passes. */
export type ModelLoader = (
  engine: EngineKernel,
  src: string,
  options: { signal: AbortSignal; fetch: typeof fetch },
) => Promise<PBRModel>;
/** Imports the loader of a format other than glTF (the `<Fbx>` binding's `@margoengine/fbx`). */
export type FormatLoader = () => Promise<ModelLoader>;

const gltfPro = () => optionalPeer('@margoengine/gltf-pro', () => import('@margoengine/gltf-pro'));

async function copyImages(images: readonly GLTFImage[]): Promise<GLTFImage[]> {
  const copies: GLTFImage[] = [];
  try {
    for (let i = 0; i < images.length; i++) {
      const image = images[i];
      if (!image) continue;
      copies[i] =
        'ktx2' in image
          ? { ...image, close() {} }
          : 'mipmaps' in image
            ? { ...image }
            : await createImageBitmap(image, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    }
    return copies;
  } catch (error) {
    closeImages(copies);
    throw error;
  }
}
async function loadModel(
  cache: AssetCache,
  src: string,
  signal: AbortSignal,
  format?: FormatLoader,
): Promise<ModelSource> {
  const api = await gltfPro();
  signal.throwIfAborted();
  const loader: ModelLoader = format ? await format() : api.loadGLTF;
  const fetch = await trackedFetch(cache);
  signal.throwIfAborted();
  const model = await loader(cache.engine!, src, { signal, fetch });
  model.root.visible = false;
  let copies: GLTFImage[] = [];
  try {
    signal.throwIfAborted();
    // Retain decoded CPU data, never a shared mutable model instance. Every mount
    // owns its transforms, materials, GPU resources and disposable image copies.
    const images: GLTFImage[] = [];
    for (let i = 0; i < (model.asset.doc.images?.length ?? 0); i++) {
      try {
        images[i] = model.image(i);
      } catch (error) {
        if (!(error instanceof TypeError) || error.message !== 'Missing decoded glTF image') throw error;
      }
    }
    copies = await copyImages(images);
    signal.throwIfAborted();
    return { api, asset: model.asset, images: copies, first: model };
  } catch (error) {
    closeImages(copies);
    model.dispose();
    throw error;
  }
}
export async function instantiateModel(source: ModelSource, engine: EngineKernel): Promise<PBRModel> {
  if (source.first) {
    const model = source.first;
    source.first = null;
    return model;
  }
  const images = await copyImages(source.images);
  let model: PBRModel | undefined;
  try {
    model = new source.api.PBRModel(engine, source.asset, images);
    engine.use(model);
    return model;
  } catch (error) {
    if (model) model.dispose();
    else closeImages(images);
    throw error;
  }
}
/** The cached source of `src` on this Canvas: glTF through gltf-pro, or `format`'s loader for `'fbx'`. */
export function modelAsset(
  cache: AssetCache,
  src: string,
  format: ModelFormat = 'model',
  load?: FormatLoader,
): AssetEntry<ModelSource> {
  return entry(
    cache,
    format === 'fbx' ? cache.fbx : cache.models,
    src,
    (signal) => loadModel(cache, src, signal, load),
    disposeSource,
  );
}
/** Loads `src` into every Canvas's cache (or once one exists) without showing it: `Gltf.preload`, `Fbx.preload`. */
export function preloadModel(src: string, format: ModelFormat = 'model', load?: FormatLoader): Promise<void> {
  return preloadAsset(`${format}:${src}`, (cache) => {
    const asset = modelAsset(cache, src, format, load);
    asset.users++;
    return asset.promise
      .then(() => {
        if (asset.status === 'rejected') throw asset.error;
        // A preloaded model must not appear in the scene before it is mounted.
        const source = asset.value!;
        if (source.first) {
          source.first.dispose();
          source.first = null;
        }
      })
      .finally(() => {
        asset.users--;
      });
  });
}
