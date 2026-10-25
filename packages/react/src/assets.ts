import type { EngineKernel } from '@margoengine/core';
import { optionalPeer } from './optional.js';
import type { GLTFAsset, GLTFImage, PBRModel } from '@margoengine/gltf-pro';
import type { LoadingManager } from '@margoengine/cache/manager';

type EnvironmentAPI = typeof import('@margoengine/environment');
export interface ModelSource {
  api: typeof import('@margoengine/gltf-pro');
  asset: GLTFAsset;
  images: GLTFImage[];
  first: PBRModel | null;
}
export interface EnvironmentSource {
  api: EnvironmentAPI;
  image: Awaited<ReturnType<EnvironmentAPI['loadEnvironmentImage']>>;
}
export interface AssetEntry<T> {
  status: 'pending' | 'resolved' | 'rejected';
  promise: Promise<void>;
  value?: T;
  error?: unknown;
  abort: AbortController;
  users: number;
}
/** Loading progress of one Canvas, from `useProgress()`. Counts restart when loading resumes after being idle. */
export interface LoadProgress {
  /** Files are loading. */
  active: boolean;
  /** Files finished, failed ones included. */
  loaded: number;
  /** Files started. */
  total: number;
  /** 0 to 100: by bytes when every size is known, else by files. */
  progress: number;
  /** The file most recently started or advanced. */
  item: string;
  /** URLs that failed since loading last started. */
  errors: readonly string[];
}
/** What a `useLoader` loader receives besides the URL. */
export interface LoaderContext {
  /** The Canvas engine. */
  engine: EngineKernel;
  /** Aborts when the last component using the URL unmounts, or the Canvas is torn down. */
  signal: AbortSignal;
  /** Fetch that counts toward `useProgress`; pass it as the loader's `fetch` option. */
  fetch: typeof fetch;
}
/** Loads one URL for `useLoader`, for example `(url, { fetch, signal }) => load(url, parsePLY, { fetch, signal })`. */
export type Loader<T> = (url: string, context: LoaderContext) => Promise<T>;
interface Tracker {
  manager: Promise<LoadingManager | null> | null;
  state: LoadProgress;
  listeners: Set<() => void>;
}
export interface AssetCache {
  engine: EngineKernel | null;
  disposed: boolean;
  models: Map<string, AssetEntry<ModelSource>>;
  fbx: Map<string, AssetEntry<ModelSource>>;
  environments: Map<string, AssetEntry<EnvironmentSource>>;
  loaders: Map<Loader<unknown>, Map<string, AssetEntry<unknown>>>;
  tracker: Tracker;
}
/** Progress before anything loads. */
export const idleProgress: LoadProgress = { active: false, loaded: 0, total: 0, progress: 0, item: '', errors: [] };
// One LoadingManager per Canvas, made on the first load. Without the optional @margoengine/cache the loads run on
// plain fetch and useProgress stays idle: progress is a convenience, never a reason for a load to fail.
function trackedFetch(cache: AssetCache): Promise<typeof fetch> {
  const tracker = cache.tracker;
  tracker.manager ??= import('@margoengine/cache/manager').then(
    ({ LoadingManager }) => {
      const publish = (state: Partial<LoadProgress>) => {
        tracker.state = { ...tracker.state, ...state };
        for (const listener of tracker.listeners) listener();
      };
      return new LoadingManager({
        onStart: (url, loaded, total) =>
          publish({
            active: true,
            item: url,
            loaded,
            total,
            // A new batch starts with its first item.
            errors: total === 1 ? [] : tracker.state.errors,
            progress: (100 * loaded) / total,
          }),
        onProgress: (url, loaded, total, bytes) =>
          publish({
            item: url,
            loaded,
            total,
            progress: bytes.total ? (100 * bytes.loaded) / bytes.total : (100 * loaded) / total,
          }),
        onLoad: () => publish({ active: false, progress: 100 }),
        onError: (url) => publish({ errors: [...tracker.state.errors, url] }),
      });
    },
    () => null,
  );
  return tracker.manager.then((manager) =>
    manager ? manager.fetch : (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init),
  );
}
/** Subscribes to a Canvas's loading progress, for `useSyncExternalStore`. */
export function subscribeProgress(cache: AssetCache, listener: () => void): () => void {
  cache.tracker.listeners.add(listener);
  return () => {
    cache.tracker.listeners.delete(listener);
  };
}
const active = new Set<AssetCache>();
export type ModelFormat = 'model' | 'fbx';
type AssetKind = ModelFormat | 'environment';
const queued = new Map<
  string,
  { src: string; kind: AssetKind; promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void }
>();
export function createAssetCache(engine: EngineKernel | null): AssetCache {
  return {
    engine,
    disposed: false,
    models: new Map(),
    fbx: new Map(),
    environments: new Map(),
    loaders: new Map(),
    tracker: { manager: null, state: idleProgress, listeners: new Set() },
  };
}

function closeImages(images: readonly GLTFImage[]): void {
  for (const image of images) if (image && 'close' in image) image.close();
}
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
function disposeSource(source: ModelSource): void {
  source.first?.dispose();
  source.first = null;
  closeImages(source.images);
  source.images = [];
}
async function loadModel(
  cache: AssetCache,
  src: string,
  signal: AbortSignal,
  format: ModelFormat,
): Promise<ModelSource> {
  const api = await optionalPeer('@margoengine/gltf-pro', () => import('@margoengine/gltf-pro'));
  signal.throwIfAborted();
  const loader =
    format === 'fbx'
      ? (await optionalPeer('@margoengine/fbx', () => import('@margoengine/fbx'))).loadFBX
      : api.loadGLTF;
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
function entry<T>(
  cache: AssetCache,
  map: Map<string, AssetEntry<T>>,
  src: string,
  load: (signal: AbortSignal) => Promise<T>,
  dispose?: (value: T) => void,
): AssetEntry<T> {
  const cached = map.get(src);
  if (cached) return cached;
  const result: AssetEntry<T> = {
    status: 'pending',
    promise: Promise.resolve(),
    abort: new AbortController(),
    users: 0,
  };
  map.set(src, result);
  result.promise = load(result.abort.signal)
    .then((value) => {
      if (cache.disposed || result.abort.signal.aborted) {
        dispose?.(value);
        throw result.abort.signal.reason ?? new Error('Canvas disposed');
      }
      result.value = value;
      result.status = 'resolved';
    })
    .catch((error) => {
      result.error = error;
      result.status = 'rejected';
    });
  return result;
}
export function modelAsset(cache: AssetCache, src: string, format: ModelFormat = 'model'): AssetEntry<ModelSource> {
  return entry(
    cache,
    format === 'fbx' ? cache.fbx : cache.models,
    src,
    (signal) => loadModel(cache, src, signal, format),
    disposeSource,
  );
}
export function environmentAsset(cache: AssetCache, src: string): AssetEntry<EnvironmentSource> {
  return entry(cache, cache.environments, src, async (signal) => {
    const api = await optionalPeer('@margoengine/environment', () => import('@margoengine/environment'));
    signal.throwIfAborted();
    const fetch = await trackedFetch(cache);
    signal.throwIfAborted();
    const image = await api.loadEnvironmentImage(src, { signal, fetch });
    signal.throwIfAborted();
    return { api, image };
  });
}
/** The entry of `load` for `src` on this Canvas, started on first use, and the map it lives in. */
export function loaderAsset<T>(
  cache: AssetCache,
  load: Loader<T>,
  src: string,
): [AssetEntry<T>, Map<string, AssetEntry<T>>] {
  let map = cache.loaders.get(load as Loader<unknown>) as Map<string, AssetEntry<T>> | undefined;
  if (!map) cache.loaders.set(load as Loader<unknown>, (map = new Map()) as Map<string, AssetEntry<unknown>>);
  const asset = entry(cache, map, src, async (signal) => {
    const fetch = await trackedFetch(cache);
    signal.throwIfAborted();
    return load(src, { engine: cache.engine!, signal, fetch });
  });
  return [asset, map];
}
export function clearLoaderCache<T>(load: Loader<T>, src?: string): void {
  for (const cache of active) {
    const map = cache.loaders.get(load as Loader<unknown>);
    if (!map) continue;
    for (const [key, asset] of map)
      if (src === undefined || key === src) {
        if (!asset.users) asset.abort.abort();
        map.delete(key);
      }
  }
}
export function retainAsset<T>(
  cache: AssetCache,
  src: string,
  asset: AssetEntry<T>,
  map: Map<string, AssetEntry<T>>,
): () => void {
  asset.users++;
  return () => {
    if (--asset.users === 0) {
      asset.abort.abort();
      if (asset.status !== 'resolved' && map.get(src) === asset) map.delete(src);
    }
    if (cache.disposed) asset.abort.abort();
  };
}
function warm(cache: AssetCache, src: string, kind: AssetKind): Promise<void> {
  const asset = kind === 'environment' ? environmentAsset(cache, src) : modelAsset(cache, src, kind);
  asset.users++;
  return asset.promise
    .then(() => {
      if (asset.status === 'rejected') throw asset.error;
      // A preloaded model must not appear in the scene before it is mounted.
      if (kind !== 'environment') {
        const source = asset.value as ModelSource;
        if (source.first) {
          source.first.dispose();
          source.first = null;
        }
      }
    })
    .finally(() => {
      asset.users--;
    });
}
/** Warm the URL cache of active canvases. Before Canvas is ready, queue the same
 * promise until an engine exists. GPU-backed glTF loading requires that engine. */
export function preload(
  src: string,
  kind: AssetKind = /\.(hdr|exr)$/i.test(src.split(/[?#]/, 1)[0])
    ? 'environment'
    : /\.fbx$/i.test(src.split(/[?#]/, 1)[0])
      ? 'fbx'
      : 'model',
): Promise<void> {
  if (active.size) return Promise.all([...active].map((cache) => warm(cache, src, kind))).then(() => {});
  const key = kind + ':' + src,
    cached = queued.get(key);
  if (cached) return cached.promise;
  let resolve!: () => void, reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  queued.set(key, { src, kind, promise, resolve, reject });
  return promise;
}
export function activateAssetCache(cache: AssetCache): void {
  if (!cache.engine) return;
  cache.disposed = false;
  active.add(cache);
  for (const [key, request] of queued) {
    queued.delete(key);
    warm(cache, request.src, request.kind).then(request.resolve, request.reject);
  }
}
export function disposeAssetCache(cache: AssetCache): void {
  active.delete(cache);
  cache.disposed = true;
  for (const map of [cache.models, cache.fbx])
    for (const asset of map.values()) {
      asset.abort.abort();
      if (asset.value) disposeSource(asset.value);
    }
  for (const asset of cache.environments.values()) asset.abort.abort();
  for (const map of cache.loaders.values()) for (const asset of map.values()) asset.abort.abort();
  cache.loaders.clear();
  cache.models.clear();
  cache.fbx.clear();
  cache.environments.clear();
}
