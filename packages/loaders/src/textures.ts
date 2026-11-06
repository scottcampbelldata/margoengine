// The files a model names by path, read through the caller's resolver, as LDraw reads its parts.
import type { AssetResolver } from './types.js';
import { throwIfAborted } from './util.js';

/** Options of {@link loadTextures}. */
export interface LoadTexturesOptions {
  /** Stops the reads; the promise then rejects with a `LoaderError` code `aborted`. */
  signal?: AbortSignal;
}

/** What {@link loadTextures} returns. */
export interface LoadedTextures {
  /** Each file's bytes, by the path as the model wrote it. */
  textures: Map<string, Uint8Array>;
  /** The paths no spelling of which could be read, with the resolver's last error. */
  missing: { path: string; error: unknown }[];
}

/** Old tools wrote upper-case 8.3 names, folders of their own PC and `Images:wall.jpg` volumes: the spellings to ask for, in order. */
function spellings(path: string): string[] {
  const clean = path.replaceAll('\\', '/'),
    base = clean.slice(Math.max(clean.lastIndexOf('/'), clean.lastIndexOf(':')) + 1);
  return [...new Set([path, clean, clean.toLowerCase(), base, base.toLowerCase()])];
}

/**
 * Reads the texture files a model names (`materials[i].texture` of `parse3DS`, `images` of `parseLWO`, `skins` of
 * `parseMD2`) through `resolve`, asking for each path as written, then with forward slashes, in lower case, and by its
 * base name. A file that cannot be read is listed in `missing`, so one lost skin does not lose the model.
 *
 * Decode the bytes with what fits: `createImageBitmap` for PNG, JPEG and BMP, `parseTGA` from
 * `@margoengine/decoders/tga`, and `parsePCX` from `@margoengine/decoders/pcx` for Quake skins.
 *
 * @param paths The paths, each read once.
 * @param resolve Reads one path; `resolveFromURL` from `@margoengine/loaders/ldraw` makes one for a hosted folder.
 * @param options An AbortSignal.
 * @returns The bytes by path, and what is missing.
 * @throws LoaderError with code `aborted`.
 *
 * @example
 * ```ts
 * import { resolveFromURL } from '@margoengine/loaders/ldraw';
 * import { parseMD2 } from '@margoengine/loaders/md2';
 * import { loadTextures } from '@margoengine/loaders/textures';
 *
 * const model = parseMD2(await (await fetch('/models/tank.md2')).arrayBuffer());
 * const { textures, missing } = await loadTextures(model.skins, resolveFromURL('/models/'));
 * console.log(textures.size, missing);
 * ```
 */
export async function loadTextures(
  paths: Iterable<string>,
  resolve: AssetResolver,
  { signal }: LoadTexturesOptions = {},
): Promise<LoadedTextures> {
  const textures = new Map<string, Uint8Array>(),
    missing: LoadedTextures['missing'] = [];
  for (const path of new Set(paths)) {
    let error: unknown;
    for (const name of spellings(path)) {
      throwIfAborted(signal, 'textures');
      try {
        const read = await resolve(name);
        textures.set(path, typeof read === 'string' ? new TextEncoder().encode(read) : read);
        break;
      } catch (failure) {
        // The next spelling may be the one the folder holds; the last failure is reported in `missing`.
        error = failure;
      }
    }
    throwIfAborted(signal, 'textures');
    if (!textures.has(path)) missing.push({ path, error });
  }
  return { textures, missing };
}
