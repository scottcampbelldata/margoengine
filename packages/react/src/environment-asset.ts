import { entry, trackedFetch, type AssetCache, type AssetEntry, type EnvironmentSource } from './assets.js';
import { optionalPeer } from './optional.js';

/** The cached load of an .hdr or .exr `src` (the environment package's module with the decoded image). */
export function environmentAsset(cache: AssetCache, src: string): AssetEntry<EnvironmentSource> {
  return entry(cache, cache.environments, src, async (signal) => {
    // Only a file needs a decoder, and `/load` imports just the one this file's signature names (`/loaders` would
    // pull all three); every other binding loads `/main`, which holds none.
    const [api, loader] = await Promise.all([
      optionalPeer('@margoengine/environment', () => import('@margoengine/environment/main')),
      optionalPeer('@margoengine/environment', () => import('@margoengine/environment/load')),
    ]);
    signal.throwIfAborted();
    const fetch = await trackedFetch(cache);
    signal.throwIfAborted();
    const image = await loader.loadEnvironmentImage(src, { signal, fetch });
    signal.throwIfAborted();
    // EnvironmentSource.api keeps its declared shape (the whole environment module; the locked API reports name it),
    // but only `.Environment` is read from it, so the direct decoder exports are left out.
    return { api: { ...api, ...loader } as EnvironmentSource['api'], image };
  });
}
