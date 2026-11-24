import { entry, trackedFetch, type AssetCache, type AssetEntry, type EnvironmentSource } from './assets.js';
import { optionalPeer } from './optional.js';

/** The cached load of an .hdr or .exr `src` (the environment package's module with the decoded image). */
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
