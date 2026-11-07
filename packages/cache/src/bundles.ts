import { margoError } from '../../shared/errors.js';
import { HashedAssets } from './hashed.js';
import type { AssetCache } from './index.js';

/** One bundle of a manifest: its own files and the bundles it needs. */
export interface BundleDefinition {
  /** URL (absolute, or relative to the manifest's base) to the SHA-256 hex of the file's bytes. */
  files: Readonly<Record<string, string>>;
  /** Names of the bundles this one needs; their files load with it. Default none. */
  deps?: readonly string[];
}
/** A release's bundles, for example one per level plus a shared one. Build it when you publish. */
export interface BundleManifest {
  /** The release, for your own reference. */
  version?: string;
  bundles: Readonly<Record<string, BundleDefinition>>;
}
/** Options for `new AssetBundles(...)`. */
export interface AssetBundlesOptions {
  /** Base URL that relative file URLs resolve against. Default the page's URL. */
  base?: string | URL;
}
/** Passed to `onProgress` after each file of a load. */
export interface BundleProgress {
  /** The bundle being loaded. */
  bundle: string;
  /** The file just finished. */
  url: string;
  /** Files finished so far, of `total`. */
  loaded: number;
  /** Files of the bundle and all its dependencies. */
  total: number;
}
/** Options for `bundles.load(...)`. */
export interface BundleLoadOptions {
  /** Aborts the load; files already stored stay stored. */
  signal?: AbortSignal;
  /** Called after each file. */
  onProgress?: (progress: BundleProgress) => void;
  /** Files fetched at once. Default 4. */
  concurrency?: number;
}
/** Result of `bundles.update(...)`. */
export interface BundleUpdate {
  /** Stored files dropped because the new manifest changed or removed them. */
  dropped: number;
  /** Bundles whose files, or whose dependencies' files, changed or were added or removed; load these again. */
  changed: string[];
}

/**
 * Versioned asset bundles on top of an {@link AssetCache}: a manifest names each bundle's files with their SHA-256 and the
 * bundles it depends on, so an app downloads a level and its shared assets as one unit, offline afterwards, and a new
 * release downloads only the files whose hash changed. Files are stored by content hash through {@link HashedAssets}, so
 * a file shared by two bundles is stored and downloaded once. Pass `bundles.fetch` as a loader's `fetch` option: a
 * listed file is answered from its hashed copy.
 */
export class AssetBundles {
  private manifest!: BundleManifest;
  private hashes!: Record<string, string>;
  private readonly assets: HashedAssets;
  private readonly base?: string;

  /** @throws TypeError when the manifest names a missing dependency, has a dependency cycle or gives one URL two hashes. */
  constructor(
    private readonly cache: Pick<AssetCache, 'fetch' | 'delete' | 'flush'>,
    manifest: BundleManifest,
    { base }: AssetBundlesOptions = {},
  ) {
    this.base = base === undefined ? globalThis.location?.href : String(base);
    this.assets = new HashedAssets(cache, this.read(manifest));
  }

  private resolve(url: string): string {
    return new URL(url, this.base).href;
  }

  /** Checks a manifest and returns its URL-to-hash map. */
  private read(manifest: BundleManifest): Record<string, string> {
    const hashes: Record<string, string> = {},
      bundles = manifest?.bundles;
    if (!bundles || typeof bundles !== 'object')
      throw new TypeError('Bundle manifest needs a bundles object; pass {bundles: {name: {files, deps}}}');
    for (const [name, bundle] of Object.entries(bundles)) {
      for (const dep of bundle?.deps ?? [])
        if (!Object.hasOwn(bundles, dep))
          throw new TypeError(`Bundle ${name} depends on ${dep}, which the manifest does not list; add it`);
      for (const [url, hash] of Object.entries(bundle?.files ?? {})) {
        const key = this.resolve(url);
        if (!/^[0-9a-f]{64}$/.test(hash))
          throw new TypeError(`Bundle ${name} gives ${url} hash ${hash}; use the lowercase SHA-256 hex of hashBytes`);
        if (hashes[key] && hashes[key] !== hash)
          throw new TypeError(
            `${url} has two hashes in the manifest; one URL is one file, give each version its own URL`,
          );
        hashes[key] = hash;
      }
    }
    for (const name of Object.keys(bundles)) this.order(name, bundles);
    this.manifest = manifest;
    this.hashes = hashes;
    return hashes;
  }

  /**
   * The bundle and every bundle it needs, dependencies first.
   * @throws TypeError for a name the manifest does not list, or a dependency cycle.
   */
  order(name: string, bundles = this.manifest.bundles): string[] {
    const out: string[] = [],
      visiting = new Set<string>();
    const visit = (current: string, path: string[]) => {
      if (out.includes(current)) return;
      if (visiting.has(current))
        throw new TypeError(`Bundle dependencies form a cycle (${[...path, current].join(' -> ')}); remove one`);
      if (!Object.hasOwn(bundles, current))
        throw new TypeError(`No bundle named ${current}; the manifest lists ${Object.keys(bundles).join(', ')}`);
      visiting.add(current);
      for (const dep of bundles[current].deps ?? []) visit(dep, [...path, current]);
      visiting.delete(current);
      out.push(current);
    };
    visit(name, []);
    return out;
  }

  /**
   * Absolute URLs of every file a bundle needs, its dependencies' first, each once.
   * @throws TypeError for a name the manifest does not list.
   */
  files(name: string): string[] {
    const urls = new Set<string>();
    for (const bundle of this.order(name))
      for (const url of Object.keys(this.manifest.bundles[bundle].files ?? {})) urls.add(this.resolve(url));
    return [...urls];
  }

  /**
   * Downloads (or finds stored) every file of a bundle and its dependencies, checks each against its hash and waits
   * until the cache has written them, so the bundle then loads offline.
   * @throws TypeError for a name the manifest does not list.
   * @throws RangeError for a `concurrency` under 1.
   * @throws MargoError `'failed'` when a file's bytes do not match the manifest or the server answers an error status.
   */
  async load(name: string, { signal, onProgress, concurrency = 4 }: BundleLoadOptions = {}): Promise<void> {
    if (!(concurrency >= 1)) throw new RangeError('Bundle load concurrency must be at least 1');
    const queue = this.files(name),
      total = queue.length;
    let loaded = 0;
    const worker = async () => {
      for (let url = queue.shift(); url !== undefined; url = queue.shift()) {
        signal?.throwIfAborted();
        const response = await this.assets.fetch(url, { signal });
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          throw margoError(
            'failed',
            `Bundle ${name}: ${url} answered HTTP ${response.status}; publish the files with the manifest`,
          );
        }
        await response.arrayBuffer();
        onProgress?.({ bundle: name, url, loaded: ++loaded, total });
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, total)) }, worker));
    await this.cache.flush();
  }

  /** Fetch-compatible: a file a bundle lists is answered from its hashed copy; anything else passes through. */
  readonly fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : this.resolve(String(input));
    return this.assets.fetch(this.hashes[url] ? url : input, init);
  };

  /**
   * Moves to a new release: drops the stored files whose hash changed or that are gone, and says which bundles to
   * load again. Unchanged files stay stored and are not downloaded again.
   * @throws TypeError when the new manifest is invalid; the old one stays in use.
   */
  async update(manifest: BundleManifest): Promise<BundleUpdate> {
    const old = this.manifest,
      before = this.hashes,
      after = this.read(manifest),
      // What a bundle loads: each bundle of its order with its files and their hashes.
      sign = (bundles: BundleManifest['bundles'], hashes: Record<string, string>, name: string) =>
        JSON.stringify(
          this.order(name, bundles).map((b) => [
            b,
            Object.keys(bundles[b].files ?? {})
              .map((url) => `${this.resolve(url)} ${hashes[this.resolve(url)]}`)
              .sort(),
          ]),
        );
    const changed = Object.keys(manifest.bundles).filter(
      (name) =>
        !Object.hasOwn(old.bundles, name) || sign(old.bundles, before, name) !== sign(manifest.bundles, after, name),
    );
    return { dropped: await this.assets.update(after), changed };
  }
}
