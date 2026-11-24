// The asset library as data: an index of the models, textures and skies a film loads by id from a folder or a URL the
// app serves (the files themselves are never in the repository; each library folder has a LABEL.md saying where every
// item came from). The index is `library.json` at the library root, written by `tools/library-index.mjs` from the
// folders (`<subject>/<kind>/<id>/<id>_2k.gltf`, `<subject>/hdri/<id>_2k.hdr`). This module reads and checks it, so a
// scene asks for an asset by id and the page loads the file with the package that owns the format (`@margoengine/gltf`
// for models, `@margoengine/environment` for skies). With no library a scene draws its procedural pieces and fetches nothing.

/** What an asset is: a `model` (glTF), a `sky` (an HDR panorama) or a `texture`. */
export type AssetType = 'model' | 'sky' | 'texture';
/** One asset of the library. */
export interface LibraryAsset {
  /** Unique across the library, as the source names it (`ocean_buoy`). */
  readonly id: string;
  /** The film or subject folder it sits in (`japan-2011-coast`). */
  readonly subject: string;
  /** The folder kind (`boats`, `buildings`, `plants`, `hdri` ...). */
  readonly kind: string;
  readonly type: AssetType;
  /** Path of the file to load, relative to the library root, with forward slashes. */
  readonly file: string;
  /** Bytes of the file (0 when unknown). */
  readonly bytes: number;
}
/** The checked index. */
export interface Library {
  readonly root: string;
  readonly assets: readonly LibraryAsset[];
  readonly byId: ReadonlyMap<string, LibraryAsset>;
}
/** The asset types an index may hold. */
export const ASSET_TYPES: readonly AssetType[] = ['model', 'sky', 'texture'];

const SAFE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const joinRoot = (root: string, file: string) => (root.endsWith('/') || root === '' ? root : root + '/') + file;

/**
 * Checks an index (`{ version: 1, assets: [...] }`) and returns it with a lookup by id.
 * @throws TypeError when `data` is not an index object; RangeError for a missing or repeated id, an unknown type, or a
 * file path that is empty, absolute or climbs out of the root. The message names the asset.
 */
export function parseLibrary(data: unknown, root = ''): Library {
  const d = data as { version?: unknown; assets?: unknown };
  if (typeof d !== 'object' || d === null || d.version !== 1 || !Array.isArray(d.assets))
    throw new TypeError('A library index is { version: 1, assets: [...] }; build it with tools/library-index.mjs.');
  const byId = new Map<string, LibraryAsset>();
  for (const [i, a] of (d.assets as Record<string, unknown>[]).entries()) {
    const id = a?.id;
    if (typeof id !== 'string' || !id) throw new RangeError(`Library asset ${i} has no id; give each asset a unique id.`);
    if (byId.has(id)) throw new RangeError(`Library asset ${id} is listed twice; ids are unique across the library.`);
    if (!ASSET_TYPES.includes(a.type as AssetType))
      throw new RangeError(`Library asset ${id} has type ${String(a.type)}; use ${ASSET_TYPES.join(', ')}.`);
    const file = a.file;
    if (typeof file !== 'string' || !SAFE.test(file) || file.split('/').some((p) => p === '..' || p === '.'))
      throw new RangeError(
        `Library asset ${id} has file ${String(file)}; use a relative path of letters, digits, dot, dash and underscore inside the root.`,
      );
    byId.set(id, {
      id,
      subject: String(a.subject ?? ''),
      kind: String(a.kind ?? ''),
      type: a.type as AssetType,
      file,
      bytes: typeof a.bytes === 'number' && a.bytes >= 0 ? a.bytes : 0,
    });
  }
  return Object.freeze({ root, assets: Object.freeze([...byId.values()]), byId });
}

/**
 * Fetches and checks `library.json` under `root` (a URL, with or without the closing slash). The request aborts with
 * `signal`.
 * @throws RangeError when the request fails (the message names the URL and status); a bad index throws as {@link parseLibrary}.
 */
export async function fetchLibrary(
  root: string,
  options: { signal?: AbortSignal; fetch?: typeof fetch } = {},
): Promise<Library> {
  const get = options.fetch ?? fetch;
  const url = joinRoot(root, 'library.json');
  const response = await get(url, { signal: options.signal });
  if (!response.ok)
    throw new RangeError(
      `Could not load the asset library index ${url} (status ${response.status}); serve the library folder and run tools/library-index.mjs.`,
    );
  return parseLibrary(await response.json(), root);
}

/**
 * The URL of an asset's file under the library root.
 * @throws RangeError for an id not in the library.
 */
export function assetUrl(library: Library, id: string): string {
  const a = library.byId.get(id);
  if (!a) throw new RangeError(`Unknown library asset ${id}; use an id from library.assets.`);
  return joinRoot(library.root, a.file);
}

/** The assets of a subject and/or kind and/or type, in index order. */
export function findAssets(
  library: Library,
  match: { subject?: string; kind?: string; type?: AssetType } = {},
): LibraryAsset[] {
  return library.assets.filter(
    (a) =>
      (match.subject === undefined || a.subject === match.subject) &&
      (match.kind === undefined || a.kind === match.kind) &&
      (match.type === undefined || a.type === match.type),
  );
}

export { libraryMesh, type LibraryMeshOptions, type LibraryMeshPart } from './library-mesh.js';
export { libraryParts, type LibraryGeometry, type LibraryPartsOptions, type LibraryTexturedPart } from './library-parts.js';
