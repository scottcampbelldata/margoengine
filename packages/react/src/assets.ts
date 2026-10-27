import type { EngineKernel } from '@margoengine/core';
import type { GLTFAsset, GLTFImage, PBRModel } from '@margoengine/gltf-pro';
import type { LoadingManager } from '@margoengine/cache/manager';
import type * as EnvironmentModule from '@margoengine/environment';
import type * as GltfProModule from '@margoengine/gltf-pro';

type EnvironmentAPI = typeof EnvironmentModule;
export interface ModelSource {
  api: typeof GltfProModule;
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
// One LoadingManager per Canvas, made on the first load (@margoengine/cache, a dependency). If it fails to load, the
// loads run on plain fetch and useProgress stays idle: progress is a convenience, never a reason for a load to fail.
export function trackedFetch(cache: AssetCache): Promise<typeof fetch> {
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
// A queued preload carries its own start function, given by the binding that owns the URL's loader (`Gltf.preload`,
// `Fbx.preload`, `Environment.preload`), so this module reaches no optional package.
const queued = new Map<
  string,
  {
    start: (cache: AssetCache) => Promise<void>;
    promise: Promise<void>;
    resolve: () => void;
    reject: (error: unknown) => void;
  }
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

export function closeImages(images: readonly GLTFImage[]): void {
  for (const image of images) if (image && 'close' in image) image.close();
}
export function disposeSource(source: ModelSource): void {
  source.first?.dispose();
  source.first = null;
  closeImages(source.images);
  source.images = [];
}
/** The cache entry of `src` in `map`, loading it with `load` on first use. */
export function entry<T>(
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
export function activateAssetCache(cache: AssetCache): void {
  if (!cache.engine) return;
  cache.disposed = false;
  active.add(cache);
  for (const [key, request] of queued) {
    queued.delete(key);
    request.start(cache).then(request.resolve, request.reject);
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
/**
 * Warms `key` in every active Canvas with `start`, or queues it until a Canvas exists: the shared machinery of
 * `Gltf.preload`, `Fbx.preload` and `Environment.preload`.
 */
export function preloadAsset(key: string, start: (cache: AssetCache) => Promise<void>): Promise<void> {
  if (active.size) return Promise.all([...active].map((cache) => start(cache))).then(() => {});
  const cached = queued.get(key);
  if (cached) return cached.promise;
  let resolve!: () => void, reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  queued.set(key, { start, promise, resolve, reject });
  return promise;
}
