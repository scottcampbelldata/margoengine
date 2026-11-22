import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fault, rangeError, typeError } from '../../shared/errors.js';
import type { LiveConnection } from './live.js';
import type { Json, ToolDefinition } from './server.js';

// Sources (GAP-FILM-ASSETLIB): licences are SPDX identifiers and `AND` expressions (SPDX Specification 2.3, Annex D,
// https://spdx.github.io/spdx-spec/v2.3/SPDX-license-expressions/); a reused folder is checked file by file with SHA-256
// (FIPS 180-4); relative glTF uris are URI references (RFC 3986, glTF 2.0 section 3.6.1); the Smithsonian source follows
// the Open Access API documentation (https://edan.si.edu/openaccess/apidocs/) and sends its api.data.gov key in the
// X-Api-Key header (https://api.data.gov/docs/developer-manual/), so it never reaches a URL, a log or a manifest.

/** Catalogue names: the built-in sources and any {@link AssetSource} passed in `sources`. */
export type AssetProvider = 'polyhaven' | 'ambientcg' | 'khronos' | 'smithsonian' | (string & {});
/** Runtime asset category. */
export type AssetKind = 'model' | 'hdri' | 'texture' | 'image';
/** A catalogue result, with its source and its own licence. */
export interface CatalogAsset {
  id: string;
  provider: AssetProvider;
  kind: AssetKind;
  title: string;
  source: string;
  /**
   * The item's licence as an SPDX identifier (`'CC0-1.0'`, `'CC-BY-4.0'`), or an SPDX `AND` expression when the item
   * carries several. The library returns only items whose every licence is in its `licenses` option.
   */
  license: string;
  licenseUrl: string;
  credit: string;
}
/** A selectable download variant; dependencies preserve their relative paths. */
export interface AssetFile {
  variant: string;
  url: string;
  /** File name to save the download as, when the URL's last path segment is not one (for example a delivery service). */
  name?: string;
  size?: number;
  md5?: string;
  include?: Record<string, { url: string; size?: number; md5?: string }>;
}
/** A completed local download, including every dependency and provenance manifest. */
export interface DownloadedAsset {
  asset: CatalogAsset;
  variant: string;
  /** The asset's own folder for this variant: the same folder every time the same asset and variant are asked for. */
  directory: string;
  entry: string;
  files: { path: string; sha256: string; bytes: number }[];
  manifest: string;
  /** True when the folder was already complete (every file's size and SHA-256 checked) and nothing was downloaded. */
  reused: boolean;
}
/** Search options. Defaults: every provider and kind, ten results, offset zero. */
export interface AssetSearchOptions {
  query: string;
  provider?: AssetProvider;
  kind?: AssetKind;
  limit?: number;
  offset?: number;
  signal?: AbortSignal;
}
/** What the library gives an {@link AssetSource}: bounded, host-checked requests and the licences it accepts. */
export interface AssetSourceContext {
  /** GETs JSON from one of the source's hosts (https, redirects kept on them, 16 MiB cap, the library's User-Agent). */
  json(url: string): Promise<unknown>;
  signal: AbortSignal;
  /** SPDX identifiers the library accepts; a source may skip other items early. */
  licenses: ReadonlySet<string>;
}
/** A catalogue the library can search and download from. The library checks every URL against `hosts`. */
export interface AssetSource {
  /** Name used in references (`name:id`): lower-case letters, digits and dashes. */
  name: string;
  /** Hosts every catalogue and download URL must be on, over https. */
  hosts: readonly string[];
  /** Kinds the source offers. */
  kinds: readonly AssetKind[];
  /** Headers sent with this source's requests, such as an API key header. Never written to a manifest. */
  headers?: Readonly<Record<string, string>>;
  search(
    options: { query: string; kind?: AssetKind; limit: number; offset: number },
    context: AssetSourceContext,
  ): Promise<CatalogAsset[]>;
  /** One asset by id, without a search; undefined when the source has no such asset. */
  lookup(id: string, context: AssetSourceContext): Promise<CatalogAsset | undefined>;
  files(asset: CatalogAsset, context: AssetSourceContext): Promise<AssetFile[]>;
}
/** Asset service options. File destinations are server-configured, never tool-controlled. */
export interface AssetLibraryOptions {
  /** Destination directory, required. Each asset and variant has one folder in it, reused when complete. */
  directory: string;
  /** Public URL serving directory, required only for wire_asset. */
  publicUrl?: string;
  /** Optional connected page with an assets-page installer. */
  live?: LiveConnection;
  /** Fetch implementation, default globalThis.fetch. */
  fetch?: typeof fetch;
  /**
   * The User-Agent sent with every catalogue and download request. Poly Haven's API terms ask each application to name
   * itself, so an app passes its own (RFC 9110 10.1.5: product tokens such as `'MyFilmApp/2.1 (+https://example.com)'`).
   * Printable ASCII, 1 to 256 characters. Default `'MargoEngine-MCP/1.0 asset-tools'`.
   */
  userAgent?: string;
  /**
   * SPDX licence identifiers an item may carry; an item with any other licence is left out of searches and refused by
   * reference. Default `['CC0-1.0']`. Add `'CC-BY-4.0'` to take Khronos samples that need a credit, and show `credit`.
   */
  licenses?: readonly string[];
  /** More catalogues, after the built-in ones; one with a built-in name replaces it. See {@link smithsonianSource}. */
  sources?: readonly AssetSource[];
  /** Total download and unpacked-byte cap, default 256 MiB. */
  maxBytes?: number;
  /** Whole operation deadline, default 120000 ms. */
  timeoutMs?: number;
}
type Data = Record<string, unknown>;
const record = (v: unknown): Data => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Data) : {});
const CC0 = 'https://creativecommons.org/publicdomain/zero/1.0/';
const KHR = 'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/';
const kinds: AssetKind[] = ['model', 'hdri', 'texture', 'image'];
/** Deed URLs of common SPDX licences; any other identifier links to its SPDX page. */
const LICENSE_URLS: Record<string, string> = {
  'CC0-1.0': CC0,
  'CC-BY-4.0': 'https://creativecommons.org/licenses/by/4.0/',
  'CC-BY-SA-4.0': 'https://creativecommons.org/licenses/by-sa/4.0/',
  'CC-BY-3.0': 'https://creativecommons.org/licenses/by/3.0/',
  'CC-BY-NC-4.0': 'https://creativecommons.org/licenses/by-nc/4.0/',
};
/** The licence page of an SPDX identifier or `AND` expression (its first identifier). */
export function licenseUrl(spdx: string): string {
  const first = spdx.split(' AND ')[0];
  return LICENSE_URLS[first] ?? `https://spdx.org/licenses/${encodeURIComponent(first)}.html`;
}
const idOf = (id: string) => {
  if (!/^[A-Za-z0-9_~-]{1,128}$/.test(id)) throw typeError('Pass a catalogue asset id, without paths', 'mcp');
  return id;
};
function safePath(root: string, name: string): string {
  if (!name || name.includes('\\') || name.includes(':') || name.split('/').some((p) => !p || p === '.' || p === '..'))
    throw typeError('Asset dependency has an unsafe path; choose another asset', 'mcp');
  const path = resolve(root, name);
  if (!path.startsWith(resolve(root) + sep)) throw typeError('Asset path escapes its download directory', 'mcp');
  return path;
}
/** The file path a relative URI reference names: query and fragment dropped, percent escapes decoded. */
function localName(uri: string): string {
  try {
    return decodeURIComponent(uri.replace(/[?#].*$/, ''));
  } catch {
    throw typeError('Asset dependency has a malformed URI; choose another asset', 'mcp');
  }
}
function sourceUrl(value: string, source: AssetSource): URL {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    !source.hosts.includes(url.hostname) ||
    (url.port && url.port !== '443') ||
    (source.name === 'khronos' && !url.pathname.startsWith('/KhronosGroup/glTF-Sample-Assets/'))
  )
    throw typeError('Catalogue URL is outside the provider allow list; use an official asset', 'mcp');
  return url;
}
function flatten(value: unknown, path: string[] = []): AssetFile[] {
  const row = record(value);
  if (typeof row.url === 'string')
    return [
      {
        variant: path.join('/'),
        url: row.url,
        ...(typeof row.size === 'number' ? { size: row.size } : {}),
        ...(typeof row.md5 === 'string' ? { md5: row.md5 } : {}),
        ...(row.include ? { include: row.include as AssetFile['include'] } : {}),
      },
    ];
  return Object.entries(row).flatMap(([key, child]) => flatten(child, [...path, key]));
}
/** The folder name of one asset and variant: readable, and distinct for variants that read alike (`1k/gltf`, `1k_gltf`). */
function folderOf(asset: CatalogAsset, variant: string): string {
  const readable = variant.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 64);
  return `${asset.provider}-${asset.id}-${readable}-${createHash('sha256').update(variant).digest('hex').slice(0, 8)}`;
}

const polyHaven: AssetSource = {
  name: 'polyhaven',
  hosts: ['api.polyhaven.com', 'dl.polyhaven.org', 'dl.polyhaven.com'],
  kinds: ['model', 'hdri', 'texture'],
  async search({ query, kind, limit, offset }, { json }) {
    const type = kind === 'model' ? 'models' : kind === 'hdri' ? 'hdris' : kind === 'texture' ? 'textures' : 'all';
    const rows = record(await json(`https://api.polyhaven.com/assets?type=${type}`));
    const words = query.toLowerCase().split(/\s+/).filter(Boolean),
      exact = query.toLowerCase().replace(/[^a-z0-9]/g, '');
    return Object.entries(rows)
      .filter(([id, v]) => words.every((w) => `${id} ${JSON.stringify(v)}`.toLowerCase().includes(w)))
      .sort(
        ([a], [b]) =>
          Number(b.toLowerCase().replace(/[^a-z0-9]/g, '') === exact) -
          Number(a.toLowerCase().replace(/[^a-z0-9]/g, '') === exact),
      )
      .slice(offset, offset + limit)
      .map(([id, value]) => polyHavenAsset(id, record(value)));
  },
  async lookup(id, { json }) {
    const row = record(await json(`https://api.polyhaven.com/info/${encodeURIComponent(id)}`));
    return row.name === undefined && row.type === undefined ? undefined : polyHavenAsset(id, row);
  },
  async files(asset, { json }) {
    return flatten(await json(`https://api.polyhaven.com/files/${encodeURIComponent(asset.id)}`));
  },
};
function polyHavenAsset(id: string, row: Data): CatalogAsset {
  const t = Number(row.type);
  return {
    provider: 'polyhaven',
    id,
    kind: t === 0 ? 'hdri' : t === 2 ? 'model' : 'texture',
    title: String(row.name ?? id),
    source: `https://polyhaven.com/a/${id}`,
    license: 'CC0-1.0',
    licenseUrl: CC0,
    credit: `Poly Haven; ${Object.keys(record(row.authors)).join(', ')}`,
  };
}

const ambientCG: AssetSource = {
  name: 'ambientcg',
  hosts: [
    'ambientcg.com',
    'acg-download.struffelproductions.com',
    'acg-download2.struffelproductions.com',
    'acg-download3.struffelproductions.com',
  ],
  kinds: ['model', 'hdri', 'texture'],
  async search({ query, kind, limit, offset }, { json }) {
    const url = new URL('https://ambientcg.com/api/v3/assets');
    url.search = new URLSearchParams({
      q: query,
      type: kind === 'model' ? '3d-model' : kind === 'texture' ? 'material' : (kind ?? ''),
      limit: String(limit),
      offset: String(offset),
      include: 'title,type,url',
    }).toString();
    return ((record(await json(url.href)).assets as Data[]) ?? []).map(ambientAsset);
  },
  async lookup(id, { json }) {
    const url = `https://ambientcg.com/api/v3/assets?id=${encodeURIComponent(id)}&include=title,type,url`;
    const row = ((record(await json(url)).assets as Data[]) ?? []).find((a) => String(a.id) === id);
    return row && ambientAsset(row);
  },
  async files(asset, { json }) {
    const url = `https://ambientcg.com/api/v3/assets?id=${encodeURIComponent(asset.id)}&include=downloads`;
    const row = record((record(await json(url)).assets as unknown[])?.[0]);
    return ((row.downloads as Data[]) ?? []).map((d) => ({
      variant: String(d.attributes),
      url: String(d.url),
      ...(typeof d.size === 'number' && Number.isFinite(d.size) ? { size: d.size } : {}),
    }));
  },
};
function ambientAsset(value: Data): CatalogAsset {
  return {
    provider: 'ambientcg',
    id: String(value.id),
    kind: value.type === 'hdri' ? 'hdri' : value.type === '3d-model' ? 'model' : 'texture',
    title: String(value.title ?? value.id),
    source: `https://ambientcg.com/a/${value.id}`,
    license: 'CC0-1.0',
    licenseUrl: CC0,
    credit: 'ambientCG',
  };
}

const khronos: AssetSource = {
  name: 'khronos',
  hosts: ['raw.githubusercontent.com'],
  kinds: ['model'],
  async search({ query, kind, limit, offset }, context) {
    if (kind && kind !== 'model') return [];
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const rows = (await context.json(`${KHR}model-index.json`)) as Data[];
    const matches = rows
      .filter((r) => words.every((w) => `${r.name} ${r.label} ${JSON.stringify(r.tags)}`.toLowerCase().includes(w)))
      .sort(
        (a, b) =>
          Number(String(b.name).toLowerCase() === query.toLowerCase()) -
          Number(String(a.name).toLowerCase() === query.toLowerCase()),
      )
      .slice(offset, offset + limit * 4);
    const result: CatalogAsset[] = [];
    for (const row of matches) {
      if (result.length >= limit) break;
      const asset = await khronosAsset(idOf(String(row.name)), String(row.label ?? row.name), context, true);
      if (asset) result.push(asset);
    }
    return result;
  },
  async lookup(id, context) {
    const row = ((await context.json(`${KHR}model-index.json`)) as Data[]).find((r) => r.name === id);
    return row ? khronosAsset(id, String(row.label ?? id), context, false) : undefined;
  },
  async files(asset, { json }) {
    const rows = (await json(`${KHR}model-index.json`)) as Data[];
    const row = rows.find((r) => r.name === asset.id);
    return Object.entries(record(row?.variants)).map(([variant, file]) => ({
      variant,
      url: `${KHR}${asset.id}/${encodeURIComponent(variant)}/${encodeURIComponent(String(file))}`,
    }));
  },
};
/**
 * A Khronos sample with the licences of all its legal records; undefined when none is given, or with `accepted` when
 * any is not accepted (a search skips it early; a lookup returns it and the library refuses it by name).
 */
async function khronosAsset(
  id: string,
  title: string,
  context: AssetSourceContext,
  accepted: boolean,
): Promise<CatalogAsset | undefined> {
  const meta = record(await context.json(`${KHR}${id}/metadata.json`));
  const legal = Array.isArray(meta.legal) ? (meta.legal as unknown[]).map(record) : [];
  const spdx = [...new Set(legal.map((l) => String(l.spdx ?? l.license ?? '')))];
  if (!legal.length || !spdx.every(Boolean) || (accepted && !spdx.every((s) => context.licenses.has(s))))
    return undefined;
  const license = spdx.join(' AND ');
  return {
    provider: 'khronos',
    id,
    kind: 'model',
    title,
    source: `https://github.khronos.org/glTF-Assets/Models/${id}/`,
    license,
    licenseUrl: licenseUrl(license),
    credit: legal.map((l) => `${l.artist ?? l.owner ?? ''} (${l.year ?? ''})`).join('; '),
  };
}

/** Options of {@link smithsonianSource}. */
export interface SmithsonianSourceOptions {
  /** An api.data.gov key; it is sent in the `X-Api-Key` header, never in a URL or a manifest. */
  apiKey: string;
}

/**
 * Smithsonian Open Access as an {@link AssetSource}: images and 3D models (GLB) of the records the Open Access API
 * marks CC0. Ids are `<record id>~<media index>`. Needs a free api.data.gov key.
 *
 * @example
 * import {AssetLibrary, smithsonianSource} from '@margoengine/mcp/assets';
 * const library = new AssetLibrary({directory: 'assets', sources: [smithsonianSource({apiKey: 'DEMO_KEY'})]});
 */
export function smithsonianSource({ apiKey }: SmithsonianSourceOptions): AssetSource {
  if (typeof apiKey !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(apiKey))
    throw typeError('smithsonianSource needs an api.data.gov key (letters, digits, _ and -)', 'mcp');
  const API = 'https://api.si.edu/openaccess/api/v1.0/';
  const media = (row: Data) => {
    const list = record(record(record(row.content).descriptiveNonRepeating).online_media).media;
    return Array.isArray(list) ? list.map(record) : [];
  };
  const isModel = (m: Data) => m.type === '3d_package' || /3d/i.test(String(m.type ?? ''));
  // Open Access marks each media item's usage: 'CC0', or usage conditions that need the Smithsonian's own terms.
  const asset = (row: Data, index: number, m: Data): CatalogAsset => {
    const cc0 = record(m.usage).access === 'CC0';
    return {
      provider: 'smithsonian',
      id: `${idOf(String(row.id))}~${index}`,
      kind: isModel(m) ? 'model' : 'image',
      title: String(row.title ?? row.id),
      source: String(
        record(record(row.content).descriptiveNonRepeating).record_link ?? `https://www.si.edu/object/${row.id}`,
      ),
      license: cc0 ? 'CC0-1.0' : 'LicenseRef-Smithsonian-usage-conditions',
      licenseUrl: cc0 ? CC0 : 'https://www.si.edu/termsofuse',
      credit: `Smithsonian${row.unitCode ? ` (${row.unitCode})` : ''}`,
    };
  };
  const content = async (id: string, json: AssetSourceContext['json']) => {
    const at = id.lastIndexOf('~'),
      index = Number(id.slice(at + 1));
    if (at < 1 || !Number.isSafeInteger(index)) return undefined;
    const row = record(record(await json(`${API}content/${encodeURIComponent(id.slice(0, at))}`)).response);
    const m = media(row)[index];
    return m && { row, index, m };
  };
  return {
    name: 'smithsonian',
    hosts: ['api.si.edu', 'ids.si.edu', '3d-api.si.edu'],
    kinds: ['image', 'model'],
    headers: { 'X-Api-Key': apiKey },
    async search({ query, kind, limit, offset }, { json, licenses }) {
      if (kind && kind !== 'image' && kind !== 'model') return [];
      const url = new URL(`${API}search`);
      url.search = new URLSearchParams({
        q: `${query || '*'}${kind === 'model' ? ' AND online_media_type:"3D Images"' : ''}`,
        start: String(offset),
        rows: String(limit),
      }).toString();
      const out: CatalogAsset[] = [];
      for (const row of ((record(record(await json(url.href)).response).rows as unknown[]) ?? []).map(record))
        for (const [index, m] of media(row).entries()) {
          if (kind && (kind === 'model') !== isModel(m)) continue;
          const found = asset(row, index, m);
          if (licenses.has(found.license) && out.length < limit) out.push(found);
        }
      return out;
    },
    async lookup(id, { json }) {
      const found = await content(id, json);
      return found && asset(found.row, found.index, found.m);
    },
    async files(item, { json }) {
      const found = await content(item.id, json);
      if (!found) return [];
      const name = item.id.replace('~', '-');
      if (isModel(found.m))
        return (Array.isArray(found.m.resources) ? found.m.resources.map(record) : [])
          .filter((r) => /\.glb(?:[?#]|$)/i.test(String(r.url ?? '')))
          .map((r) => ({ variant: String(r.label ?? r.url), url: String(r.url), name: `${name}.glb` }));
      return typeof found.m.content === 'string'
        ? [{ variant: 'image', url: found.m.content, name: `${name}.jpg` }]
        : [];
    },
  };
}

/** Searches official metadata, downloads bounded assets of accepted licences and wires completed downloads into a page. */
export class AssetLibrary {
  private readonly get: typeof fetch;
  private readonly agent: string;
  private readonly max: number;
  private readonly timeout: number;
  private readonly licenses: ReadonlySet<string>;
  private readonly sources = new Map<string, AssetSource>();
  private readonly known = new Map<string, CatalogAsset>();
  private readonly downloaded = new Map<string, DownloadedAsset>();
  private readonly pending = new Map<string, Promise<DownloadedAsset>>();
  constructor(private readonly options: AssetLibraryOptions) {
    this.get = options.fetch ?? globalThis.fetch;
    this.agent = options.userAgent ?? 'MargoEngine-MCP/1.0 asset-tools';
    if (typeof this.agent !== 'string' || !/^[ -~]{1,256}$/.test(this.agent) || this.agent.trim() !== this.agent)
      throw rangeError('userAgent must be 1 to 256 printable ASCII characters, such as MyApp/1.0', 'mcp');
    this.max = options.maxBytes ?? 256 * 1024 * 1024;
    this.timeout = options.timeoutMs ?? 120000;
    if (!Number.isSafeInteger(this.max) || this.max < 1 || !Number.isSafeInteger(this.timeout) || this.timeout < 1)
      throw rangeError('maxBytes and timeoutMs must be positive safe integers', 'mcp');
    const licenses = options.licenses ?? ['CC0-1.0'];
    if (
      !Array.isArray(licenses) ||
      !licenses.length ||
      !licenses.every((l) => typeof l === 'string' && /^[A-Za-z0-9.+-]+$/.test(l))
    )
      throw typeError('licenses must be SPDX identifiers, such as CC0-1.0', 'mcp');
    this.licenses = new Set(licenses);
    for (const source of [polyHaven, ambientCG, khronos, ...(options.sources ?? [])]) {
      if (
        !source ||
        typeof source.name !== 'string' ||
        !/^[a-z0-9-]{1,32}$/.test(source.name) ||
        !Array.isArray(source.hosts) ||
        !source.hosts.length ||
        typeof source.search !== 'function' ||
        typeof source.lookup !== 'function' ||
        typeof source.files !== 'function'
      )
        throw typeError('An asset source needs a name (a-z, 0-9, -), hosts and search, lookup and files', 'mcp');
      this.sources.set(source.name, source);
    }
  }
  /** Names of the catalogues this library searches, built-in ones first. */
  get providers(): string[] {
    return [...this.sources.keys()];
  }
  private active(signal?: AbortSignal): AbortSignal {
    return AbortSignal.any([AbortSignal.timeout(this.timeout), ...(signal ? [signal] : [])]);
  }
  private source(name: string): AssetSource {
    const source = this.sources.get(name);
    if (!source) throw typeError(`Unknown asset provider; use one of ${this.providers.join(', ')}`, 'mcp');
    return source;
  }
  private context(source: AssetSource, signal: AbortSignal): AssetSourceContext {
    return {
      json: async (url) =>
        JSON.parse(new TextDecoder().decode(await this.bytes(url, source, signal, 16 * 1024 * 1024))) as unknown,
      signal,
      licenses: this.licenses,
    };
  }
  private async bytes(url: string, source: AssetSource, signal: AbortSignal, cap = this.max): Promise<Uint8Array> {
    let target = sourceUrl(url, source);
    for (let redirect = 0; redirect <= 5; redirect++) {
      const response = await this.get(target, {
        signal,
        redirect: 'manual',
        headers: { ...source.headers, 'User-Agent': this.agent },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location) throw fault('failed', 'Asset redirect has no location; choose another asset', 'mcp');
        target = sourceUrl(new URL(location, target).href, source);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw fault('failed', `Asset HTTP ${response.status}; check the provider status`, 'mcp');
      }
      if (Number(response.headers.get('content-length')) > cap) {
        await response.body?.cancel();
        throw rangeError('Asset exceeds maxBytes; select a smaller variant', 'mcp');
      }
      if (!response.body) throw fault('failed', 'Empty asset response; choose another variant', 'mcp');
      const reader = response.body.getReader(),
        chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          signal.throwIfAborted();
          const { value, done } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > cap) throw rangeError('Asset exceeds maxBytes; select a smaller variant', 'mcp');
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      return bytes;
    }
    throw fault('failed', 'Too many asset redirects; select another variant', 'mcp');
  }
  /** True when every licence of the item is accepted. */
  private allowed(asset: CatalogAsset): boolean {
    return typeof asset.license === 'string' && asset.license.split(' AND ').every((l) => this.licenses.has(l));
  }
  private remember(asset: CatalogAsset): CatalogAsset {
    this.known.set(`${asset.provider}:${asset.id}`, asset);
    return asset;
  }
  /** Searches names and tags. Only items whose every licence is in `licenses` are returned. */
  async search(options: AssetSearchOptions): Promise<CatalogAsset[]> {
    const { query, provider, kind } = options,
      limit = options.limit ?? 10,
      offset = options.offset ?? 0;
    if (
      typeof query !== 'string' ||
      query.length > 500 ||
      (provider !== undefined && !this.sources.has(provider)) ||
      (kind && !kinds.includes(kind))
    )
      throw typeError('Use a query up to 500 characters and a listed provider/kind', 'mcp');
    if (!Number.isInteger(limit) || limit < 1 || limit > 25 || !Number.isInteger(offset) || offset < 0)
      throw rangeError('limit must be 1 to 25 and offset nonnegative', 'mcp');
    const signal = this.active(options.signal);
    signal.throwIfAborted();
    const result: CatalogAsset[] = [];
    for (const source of provider ? [this.source(provider)] : this.sources.values()) {
      if (kind && !source.kinds.includes(kind)) continue;
      const found = await source.search({ query, kind, limit, offset }, this.context(source, signal));
      for (const asset of found) {
        if (asset.provider !== source.name) continue;
        idOf(asset.id);
        if (this.allowed(asset)) result.push(this.remember({ ...asset }));
      }
    }
    return result;
  }
  /**
   * One asset by its reference (`provider:id`), from an earlier search or, without one, from the provider's own
   * record of that id. Refuses an asset whose licence is not in `licenses`.
   */
  async lookup(reference: string, signal?: AbortSignal): Promise<CatalogAsset> {
    const known = this.known.get(reference);
    if (known) return { ...known };
    const colon = typeof reference === 'string' ? reference.indexOf(':') : -1;
    if (colon < 1) throw typeError('Pass an asset reference, provider:id', 'mcp');
    const source = this.source(reference.slice(0, colon)),
      id = idOf(reference.slice(colon + 1)),
      active = this.active(signal);
    active.throwIfAborted();
    const asset = await source.lookup(id, this.context(source, active));
    if (!asset || asset.provider !== source.name || asset.id !== id)
      throw typeError('Unknown asset reference; check the id or search for it', 'mcp');
    if (!this.allowed(asset))
      throw typeError(`Asset licence ${asset.license} is not in licenses; add it to accept the asset`, 'mcp');
    return { ...this.remember({ ...asset }) };
  }
  /** Lists exact map/resolution/format variants of an asset. */
  async files(reference: string, signal?: AbortSignal): Promise<AssetFile[]> {
    const asset = await this.lookup(reference, signal),
      source = this.source(asset.provider);
    return source.files(asset, this.context(source, this.active(signal)));
  }
  /**
   * Downloads a variant and all its dependencies into the asset's own folder for that variant, with a manifest of
   * licence, source and SHA-256 of every file. A folder already complete is reused (every file's size and SHA-256
   * checked), so asking again downloads nothing; calls for the same folder at once share one download. A download is
   * written to a new folder and moved into place when complete, so a failure or an abort leaves nothing behind.
   */
  async download(reference: string, variant: string, signal?: AbortSignal): Promise<DownloadedAsset> {
    const asset = await this.lookup(reference, signal);
    const directory = join(resolve(this.options.directory), folderOf(asset, variant));
    const running = this.pending.get(directory);
    if (running) return running;
    const job = this.fetchVariant(asset, variant, directory, signal).finally(() => this.pending.delete(directory));
    this.pending.set(directory, job);
    return job;
  }
  /** The complete download in `directory`, or undefined when it is missing, partial or changed. */
  private async complete(
    asset: CatalogAsset,
    variant: string,
    directory: string,
  ): Promise<DownloadedAsset | undefined> {
    const manifest = join(directory, 'margo-asset.json');
    let saved: Data;
    try {
      saved = record(JSON.parse(await readFile(manifest, 'utf8')));
    } catch {
      return undefined;
    }
    const files = Array.isArray(saved.files) ? (saved.files as DownloadedAsset['files']) : [];
    if (saved.variant !== variant || typeof saved.entry !== 'string' || !files.length) return undefined;
    for (const file of files) {
      try {
        const path = safePath(directory, String(file.path));
        if ((await stat(path)).size !== file.bytes) return undefined;
        if (
          createHash('sha256')
            .update(await readFile(path))
            .digest('hex') !== file.sha256
        )
          return undefined;
      } catch {
        return undefined;
      }
    }
    return { asset: { ...asset }, variant, directory, entry: saved.entry, files, manifest, reused: true };
  }
  private async fetchVariant(
    asset: CatalogAsset,
    variant: string,
    directory: string,
    signal?: AbortSignal,
  ): Promise<DownloadedAsset> {
    const active = this.active(signal);
    active.throwIfAborted();
    const ready = await this.complete(asset, variant, directory);
    if (ready) {
      this.downloaded.set(directory, ready);
      return ready;
    }
    const source = this.source(asset.provider);
    const file = (await source.files(asset, this.context(source, active))).find((f) => f.variant === variant);
    if (!file) throw typeError('Unknown variant; call asset_files first', 'mcp');
    const root = resolve(this.options.directory);
    await mkdir(root, { recursive: true });
    const incoming = await mkdtemp(join(root, '.incoming-'));
    const files: DownloadedAsset['files'] = [];
    let used = 0;
    const save = async (name: string, bytes: Uint8Array) => {
      used += bytes.length;
      if (used > this.max)
        throw rangeError('Downloaded/unpacked asset exceeds maxBytes; select a smaller variant', 'mcp');
      const path = safePath(incoming, name);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes, { flag: 'wx', signal: active });
      files.push({ path: name, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length });
    };
    const fetchFile = async (name: string, value: { url: string; size?: number; md5?: string }) => {
      safePath(incoming, name);
      const bytes = await this.bytes(value.url, source, active, this.max - used);
      if (value.size !== undefined && bytes.length !== value.size)
        throw fault('failed', 'Asset size differs from metadata; refresh the catalogue', 'mcp');
      if (value.md5 && createHash('md5').update(bytes).digest('hex') !== value.md5)
        throw fault('failed', 'Asset checksum differs from metadata; refresh the catalogue', 'mcp');
      await save(name, bytes);
      return bytes;
    };
    try {
      let entry = file.name ?? decodeURIComponent(new URL(file.url).pathname.split('/').at(-1)!);
      if (!file.name && new URL(file.url).searchParams.has('file')) entry = new URL(file.url).searchParams.get('file')!;
      const bytes = await fetchFile(entry, file);
      for (const [name, value] of Object.entries(file.include ?? {})) await fetchFile(name, value);
      if (/\.gltf$/i.test(entry) && !file.include) {
        const document = JSON.parse(new TextDecoder().decode(bytes));
        for (const value of [...(document.buffers ?? []), ...(document.images ?? [])])
          if (typeof value.uri === 'string' && !value.uri.startsWith('data:')) {
            // A glTF uri is a URI reference (glTF 2.0, 3.6.1 and RFC 3986): fetch it as written, save it decoded, as a
            // loader resolving it against the .gltf file asks for it.
            const name = localName(value.uri);
            safePath(incoming, name);
            if (!files.some((f) => f.path === name)) await fetchFile(name, { url: new URL(value.uri, file.url).href });
          }
      }
      if (/\.zip$/i.test(entry)) {
        const { readZipDirectory, readZipEntry } = await import('@margoengine/loaders/common');
        const entries = readZipDirectory(bytes, { maxEntries: 1000, signal: active });
        for (const item of entries) {
          if (item.name.endsWith('/')) continue;
          safePath(incoming, item.name);
          if (item.size > this.max - used)
            throw rangeError('Unpacked asset exceeds maxBytes; select a smaller variant', 'mcp');
          await save(item.name, await readZipEntry(bytes, item, { maxEntryBytes: this.max - used, signal: active }));
        }
        const match = files.find((f) =>
          asset.kind === 'model'
            ? /\.(glb|gltf)$/i.test(f.path)
            : asset.kind === 'hdri'
              ? /\.(hdr|exr)$/i.test(f.path)
              : /(?:color|diffuse|albedo).*\.(jpg|png)$/i.test(f.path),
        );
        if (match) entry = match.path;
      }
      await writeFile(
        join(incoming, 'margo-asset.json'),
        JSON.stringify({ asset, variant, url: file.url, entry, files }, null, 2),
        { flag: 'wx', signal: active },
      );
      // Move the finished folder into place; a stale or partial folder there (a changed or interrupted earlier
      // download) is replaced. Another process that finished the same folder first wins, and its copy is used.
      await rm(directory, { recursive: true, force: true });
      try {
        await rename(incoming, directory);
      } catch (error) {
        const other = await this.complete(asset, variant, directory);
        if (!other) throw error;
        await rm(incoming, { recursive: true, force: true });
        this.downloaded.set(directory, other);
        return other;
      }
      const result = {
        asset: { ...asset },
        variant,
        directory,
        entry,
        files,
        manifest: join(directory, 'margo-asset.json'),
        reused: false,
      };
      this.downloaded.set(directory, result);
      return result;
    } catch (error) {
      await rm(incoming, { recursive: true, force: true });
      throw error;
    }
  }
  /**
   * Wires one completed download through the page's app/optional-package loader, using the configured public URL. An
   * `image` is installed as a texture (a material map).
   */
  async wire(directory: string, options: { target?: string; slot?: string } = {}, signal?: AbortSignal): Promise<Json> {
    const asset = this.downloaded.get(directory);
    if (!asset || !this.options.publicUrl || !this.options.live)
      throw typeError('Download the asset and configure publicUrl and live before wiring it', 'mcp');
    const folder = directory.slice(resolve(this.options.directory).length + 1);
    const url = new URL(
      `${encodeURIComponent(folder)}/${asset.entry.split('/').map(encodeURIComponent).join('/')}`,
      this.options.publicUrl.endsWith('/') ? this.options.publicUrl : this.options.publicUrl + '/',
    );
    await readFile(asset.manifest, { signal });
    return this.options.live.request(
      'asset',
      {
        ...options,
        // A picture goes onto a material map, as a texture does.
        kind: asset.asset.kind === 'image' ? 'texture' : asset.asset.kind,
        url: url.href,
        license: asset.asset.license,
        source: asset.asset.source,
      },
      this.active(signal),
    );
  }
}

/** MCP search, variants, download and scene-wiring tools over one server-configured asset library. */
export function createAssetTools(library: AssetLibrary): ToolDefinition[] {
  return (['search_assets', 'asset_files', 'download_asset', 'wire_asset'] as const).map((name) => ({
    name,
    title: name.replaceAll('_', ' '),
    description:
      'Assets from Poly Haven, ambientCG, Khronos samples and any added catalogue, each with its own licence. Search, or name an asset as provider:id, list exact variants, download with a licence manifest (a repeated download reuses its folder), then wire into the live page.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        provider: { enum: library.providers },
        kind: { enum: kinds },
        limit: { type: 'integer', minimum: 1, maximum: 25 },
        offset: { type: 'integer', minimum: 0 },
        reference: { type: 'string' },
        variant: { type: 'string' },
        directory: { type: 'string' },
        target: { type: 'string' },
        slot: { type: 'string' },
      },
      required:
        name === 'search_assets'
          ? ['query']
          : name === 'wire_asset'
            ? ['directory']
            : name === 'download_asset'
              ? ['reference', 'variant']
              : ['reference'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: name === 'search_assets' || name === 'asset_files', openWorldHint: true },
    async run(args, { signal }) {
      const value =
        name === 'search_assets'
          ? await library.search({ ...args, signal } as unknown as AssetSearchOptions)
          : name === 'asset_files'
            ? await library.files(String(args.reference), signal)
            : name === 'download_asset'
              ? await library.download(String(args.reference), String(args.variant), signal)
              : await library.wire(
                  String(args.directory),
                  { target: args.target as string | undefined, slot: args.slot as string | undefined },
                  signal,
                );
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(value) }],
        structuredContent: { value: value as unknown as Json },
      };
    },
  }));
}
