import { margoError } from '../../shared/errors.js';
import type { AssetCache } from './index.js';

/** The hash of a file's bytes, as lowercase SHA-256 hex; for building a manifest. */
export async function hashBytes(data: BufferSource): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
const versioned = (url: string, hash: string) => {
  const at = url.indexOf('#'),
    plain = at < 0 ? url : url.slice(0, at);
  return `${plain}${plain.includes('?') ? '&' : '?'}v=${hash}`;
};

/**
 * Per-file versioning for an {@link AssetCache}. A manifest maps each URL to the SHA-256 of its bytes, so a release drops
 * only the files that changed, where the cache's own `version` drops all of them. A listed file is requested as
 * `url?v=<hash>`, kept under that name, and its bytes are checked once per session. Files not listed pass straight
 * through. Pass `assets.fetch` as a loader's `fetch` option.
 */
export class HashedAssets {
  private manifest: Readonly<Record<string, string>>;
  private readonly checked = new Set<string>();

  constructor(
    private readonly cache: Pick<AssetCache, 'fetch' | 'delete'>,
    manifest: Readonly<Record<string, string>>,
  ) {
    this.manifest = manifest;
  }
  /**
   * Fetch-compatible, by a listed file's URL as the manifest spells it.
   * @throws MargoError `'failed'` when the bytes do not match the manifest; the stored copy is dropped first.
   */
  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input),
      hash = this.manifest[url];
    if (!hash) return this.cache.fetch(input, init);
    const name = versioned(url, hash),
      // A Request keeps its signal, headers and credentials on the versioned URL.
      response = await this.cache.fetch(input instanceof Request ? new Request(name, input) : name, init);
    if (!response.ok || this.checked.has(name)) return response;
    const actual = await hashBytes(await response.clone().arrayBuffer());
    if (actual !== hash) {
      await this.cache.delete(name);
      throw margoError(
        'failed',
        `${url} has hash ${actual}, not the manifest's ${hash}; publish the file and manifest together`,
      );
    }
    this.checked.add(name);
    return response;
  };
  /** Moves to a new manifest and drops the stored copies it no longer names. Returns how many were dropped. */
  async update(manifest: Readonly<Record<string, string>>): Promise<number> {
    const old = this.manifest;
    this.manifest = manifest;
    let dropped = 0;
    for (const url of Object.keys(old))
      if (manifest[url] !== old[url]) {
        const name = versioned(url, old[url]);
        await this.cache.delete(name);
        this.checked.delete(name);
        dropped++;
      }
    return dropped;
  }
}
