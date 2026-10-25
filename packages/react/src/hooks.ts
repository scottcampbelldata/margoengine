'use client';
import { useEffect, useSyncExternalStore } from 'react';
import type { EngineKernel } from '@margoengine/core';
import {
  clearLoaderCache,
  idleProgress,
  loaderAsset,
  retainAsset,
  subscribeProgress,
  type Loader,
  type LoadProgress,
} from './assets.js';
import { useScene } from './internal.js';

/** The Canvas engine: meshes, scenes, views, lighting, plugins and `render()`. Use it inside `<Canvas>`. */
export function useEngine(): EngineKernel {
  return useScene().engine as unknown as EngineKernel;
}
/** The Canvas engine's active camera. Change it in effects or `useFrame`; changes show on the next frame. */
export function useCamera(): EngineKernel['camera'] {
  return useScene().engine.camera as unknown as EngineKernel['camera'];
}
/**
 * Loads `url` with `load` and suspends until it is ready: wrap the component in `<Suspense>`. Each Canvas caches the
 * result per loader and URL, so every component asking for the same file shares one load; the load is aborted when
 * the last of them unmounts first. Pass the context's `fetch` to the loader to count it in `useProgress`. Keep `load`
 * stable (define it outside the component), or every render starts a new load. A failed load throws its error to the
 * nearest error boundary and stays failed: call `clearLoader(load, url)` before resetting the boundary to retry.
 *
 * ```tsx
 * const plyLoader: Loader<LoadedGeometry> = (url, { fetch, signal }) => load(url, parsePLY, { fetch, signal });
 * const cloud = useLoader(plyLoader, '/scan.ply');
 * ```
 */
export function useLoader<T>(load: Loader<T>, url: string): T {
  const { assetCache } = useScene(),
    [asset, map] = loaderAsset(assetCache, load, url);
  useEffect(() => retainAsset(assetCache, url, asset, map), [assetCache, url, asset, map]);
  if (asset.status === 'pending') throw asset.promise;
  // Kept, not dropped here: React renders again after an error, and a fresh load per render would fail forever.
  if (asset.status === 'rejected') throw asset.error;
  return asset.value as T;
}
/** Forgets `load`'s cached result for `url` (or every URL) on every Canvas, so the next `useLoader` loads again. */
export function clearLoader<T>(load: Loader<T>, url?: string): void {
  clearLoaderCache(load, url);
}
/**
 * The Canvas's loading progress for a loading bar: files loaded and started, a 0-100 `progress`, the current file and
 * failed URLs. Covers `Model`, `Gltf`, `Fbx`, `Environment` and `useLoader` loads. Re-renders only when it changes.
 * Needs the optional `@margoengine/cache`; without it the progress stays idle.
 */
export function useProgress(): LoadProgress {
  const { assetCache } = useScene();
  return useSyncExternalStore(
    (listener) => subscribeProgress(assetCache, listener),
    () => assetCache.tracker.state,
    () => idleProgress,
  );
}
export type { Loader, LoaderContext, LoadProgress } from './assets.js';
