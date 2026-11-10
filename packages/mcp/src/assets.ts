import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fault, rangeError, typeError } from '../../shared/errors.js';
import type { LiveConnection } from './live.js';
import type { Json, ToolDefinition } from './server.js';

/** Public catalogues supported by the asset tools. */
export type AssetProvider = 'polyhaven' | 'ambientcg' | 'khronos';
/** Runtime asset category. */
export type AssetKind = 'model' | 'hdri' | 'texture';
/** A CC0 catalogue result, including its source and licence evidence. */
export interface CatalogAsset {
  id: string;
  provider: AssetProvider;
  kind: AssetKind;
  title: string;
  source: string;
  license: 'CC0-1.0';
  licenseUrl: string;
  credit: string;
}
/** A selectable download variant; dependencies preserve their relative paths. */
export interface AssetFile {
  variant: string;
  url: string;
  size?: number;
  md5?: string;
  include?: Record<string, { url: string; size?: number; md5?: string }>;
}
/** A completed local download, including every dependency and provenance manifest. */
export interface DownloadedAsset {
  asset: CatalogAsset;
  directory: string;
  entry: string;
  files: { path: string; sha256: string; bytes: number }[];
  manifest: string;
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
/** Asset service options. File destinations are server-configured, never tool-controlled. */
export interface AssetLibraryOptions {
  /** Destination directory, required. Each download creates its own new subdirectory. */
  directory: string;
  /** Public URL serving directory, required only for wire_asset. */
  publicUrl?: string;
  /** Optional connected page with an assets-page installer. */
  live?: LiveConnection;
  /** Fetch implementation, default globalThis.fetch. */
  fetch?: typeof fetch;
  /** Total download and unpacked-byte cap, default 256 MiB. */
  maxBytes?: number;
  /** Whole operation deadline, default 120000 ms. */
  timeoutMs?: number;
}
type Data = Record<string, unknown>;
const record = (v: unknown): Data => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Data) : {});
const CC0 = 'https://creativecommons.org/publicdomain/zero/1.0/';
const KHR = 'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/';
const providers: AssetProvider[] = ['polyhaven', 'ambientcg', 'khronos'];
const kinds: AssetKind[] = ['model', 'hdri', 'texture'];
const idOf = (id: string) => {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw typeError('Pass a catalogue asset id, without paths', 'mcp');
  return id;
};
function safePath(root: string, name: string): string {
  if (!name || name.includes('\\') || name.includes(':') || name.split('/').some((p) => !p || p === '.' || p === '..'))
    throw typeError('Asset dependency has an unsafe path; choose another asset', 'mcp');
  const path = resolve(root, name);
  if (!path.startsWith(resolve(root) + sep)) throw typeError('Asset path escapes its download directory', 'mcp');
  return path;
}
function providerUrl(value: string, provider: AssetProvider): URL {
  const url = new URL(value);
  const hosts =
    provider === 'polyhaven'
      ? ['api.polyhaven.com', 'dl.polyhaven.org', 'dl.polyhaven.com']
      : provider === 'ambientcg'
        ? [
            'ambientcg.com',
            'acg-download.struffelproductions.com',
            'acg-download2.struffelproductions.com',
            'acg-download3.struffelproductions.com',
          ]
        : ['raw.githubusercontent.com'];
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    !hosts.includes(url.hostname) ||
    (url.port && url.port !== '443') ||
    (provider === 'khronos' && !url.pathname.startsWith('/KhronosGroup/glTF-Sample-Assets/'))
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

/** Searches official metadata, downloads bounded CC0 assets and wires completed downloads into a connected app. */
export class AssetLibrary {
  private readonly get: typeof fetch;
  private readonly max: number;
  private readonly timeout: number;
  private readonly known = new Map<string, CatalogAsset>();
  private readonly downloaded = new Map<string, DownloadedAsset>();
  constructor(private readonly options: AssetLibraryOptions) {
    this.get = options.fetch ?? globalThis.fetch;
    this.max = options.maxBytes ?? 256 * 1024 * 1024;
    this.timeout = options.timeoutMs ?? 120000;
    if (!Number.isSafeInteger(this.max) || this.max < 1 || !Number.isSafeInteger(this.timeout) || this.timeout < 1)
      throw rangeError('maxBytes and timeoutMs must be positive safe integers', 'mcp');
  }
  private active(signal?: AbortSignal): AbortSignal {
    return AbortSignal.any([AbortSignal.timeout(this.timeout), ...(signal ? [signal] : [])]);
  }
  private async bytes(url: string, provider: AssetProvider, signal: AbortSignal, cap = this.max): Promise<Uint8Array> {
    let target = providerUrl(url, provider);
    for (let redirect = 0; redirect <= 5; redirect++) {
      const response = await this.get(target, {
        signal,
        redirect: 'manual',
        headers: { 'User-Agent': 'MargoEngine-MCP/1.0 asset-tools' },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location) throw fault('failed', 'Asset redirect has no location; choose another asset', 'mcp');
        target = providerUrl(new URL(location, target).href, provider);
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
  private async json(url: string, provider: AssetProvider, signal: AbortSignal): Promise<unknown> {
    return JSON.parse(new TextDecoder().decode(await this.bytes(url, provider, signal, 16 * 1024 * 1024)));
  }
  private remember(asset: CatalogAsset): CatalogAsset {
    this.known.set(`${asset.provider}:${asset.id}`, asset);
    return asset;
  }
  /** Searches names and tags. Khronos results require every legal record to explicitly declare CC0-1.0. */
  async search(options: AssetSearchOptions): Promise<CatalogAsset[]> {
    const { query, provider, kind } = options,
      limit = options.limit ?? 10,
      offset = options.offset ?? 0;
    if (
      typeof query !== 'string' ||
      query.length > 500 ||
      (provider && !providers.includes(provider)) ||
      (kind && !kinds.includes(kind))
    )
      throw typeError('Use a query up to 500 characters and a listed provider/kind', 'mcp');
    if (!Number.isInteger(limit) || limit < 1 || limit > 25 || !Number.isInteger(offset) || offset < 0)
      throw rangeError('limit must be 1 to 25 and offset nonnegative', 'mcp');
    const signal = this.active(options.signal);
    signal.throwIfAborted();
    const result: CatalogAsset[] = [],
      words = query.toLowerCase().split(/\s+/).filter(Boolean);
    for (const source of provider ? [provider] : providers) {
      if (source === 'polyhaven') {
        const type = kind === 'model' ? 'models' : kind === 'hdri' ? 'hdris' : kind === 'texture' ? 'textures' : 'all';
        const rows = record(await this.json(`https://api.polyhaven.com/assets?type=${type}`, source, signal));
        const exact = query.toLowerCase().replace(/[^a-z0-9]/g, '');
        const matches = Object.entries(rows)
          .filter(([id, v]) => words.every((w) => `${id} ${JSON.stringify(v)}`.toLowerCase().includes(w)))
          .sort(
            ([a], [b]) =>
              Number(b.toLowerCase().replace(/[^a-z0-9]/g, '') === exact) -
              Number(a.toLowerCase().replace(/[^a-z0-9]/g, '') === exact),
          )
          .slice(offset, offset + limit);
        for (const [id, value] of matches) {
          const row = record(value),
            t = Number(row.type);
          result.push(
            this.remember({
              provider: source,
              id,
              kind: t === 0 ? 'hdri' : t === 2 ? 'model' : 'texture',
              title: String(row.name ?? id),
              source: `https://polyhaven.com/a/${id}`,
              license: 'CC0-1.0',
              licenseUrl: CC0,
              credit: `Poly Haven; ${Object.keys(record(row.authors)).join(', ')}`,
            }),
          );
        }
      } else if (source === 'ambientcg') {
        const url = new URL('https://ambientcg.com/api/v3/assets');
        url.search = new URLSearchParams({
          q: query,
          type: kind === 'model' ? '3d-model' : kind === 'texture' ? 'material' : (kind ?? ''),
          limit: String(limit),
          offset: String(offset),
          include: 'title,type,url',
        }).toString();
        const data = record(await this.json(url.href, source, signal));
        for (const value of (data.assets as Data[]) ?? []) {
          result.push(
            this.remember({
              provider: source,
              id: String(value.id),
              kind: value.type === 'hdri' ? 'hdri' : value.type === '3d-model' ? 'model' : 'texture',
              title: String(value.title ?? value.id),
              source: `https://ambientcg.com/a/${value.id}`,
              license: 'CC0-1.0',
              licenseUrl: CC0,
              credit: 'ambientCG',
            }),
          );
        }
      } else if (!kind || kind === 'model') {
        const rows = (await this.json(`${KHR}model-index.json`, source, signal)) as Data[];
        const matches = rows
          .filter((r) => words.every((w) => `${r.name} ${r.label} ${JSON.stringify(r.tags)}`.toLowerCase().includes(w)))
          .sort(
            (a, b) =>
              Number(String(b.name).toLowerCase() === query.toLowerCase()) -
              Number(String(a.name).toLowerCase() === query.toLowerCase()),
          )
          .slice(offset, offset + limit * 4);
        for (const row of matches) {
          if (result.filter((a) => a.provider === source).length >= limit) break;
          const id = idOf(String(row.name));
          const meta = record(await this.json(`${KHR}${id}/metadata.json`, source, signal));
          const legal = (meta.legal as Data[]) ?? [];
          if (!legal.length || !legal.every((l) => (l.spdx ?? l.license) === 'CC0-1.0')) continue;
          result.push(
            this.remember({
              provider: source,
              id,
              kind: 'model',
              title: String(row.label ?? id),
              source: `https://github.khronos.org/glTF-Assets/Models/${id}/`,
              license: 'CC0-1.0',
              licenseUrl: CC0,
              credit: legal.map((l) => `${l.artist ?? l.owner ?? ''} (${l.year ?? ''})`).join('; '),
            }),
          );
        }
      }
    }
    return result;
  }
  private asset(reference: string): CatalogAsset {
    const asset = this.known.get(reference);
    if (!asset) throw typeError('Unknown asset reference; call search_assets first', 'mcp');
    idOf(asset.id);
    return asset;
  }
  /** Lists exact map/resolution/format variants for a result from search. */
  async files(reference: string, signal?: AbortSignal): Promise<AssetFile[]> {
    const asset = this.asset(reference),
      active = this.active(signal);
    if (asset.provider === 'polyhaven')
      return flatten(await this.json(`https://api.polyhaven.com/files/${asset.id}`, asset.provider, active));
    if (asset.provider === 'ambientcg') {
      const data = record(
        await this.json(`https://ambientcg.com/api/v3/assets?id=${asset.id}&include=downloads`, asset.provider, active),
      );
      const row = record((data.assets as unknown[])?.[0]);
      return ((row.downloads as Data[]) ?? []).map((d) => ({
        variant: String(d.attributes),
        url: String(d.url),
        size: Number(d.size),
      }));
    }
    const rows = (await this.json(`${KHR}model-index.json`, asset.provider, active)) as Data[];
    const row = rows.find((r) => r.name === asset.id);
    return Object.entries(record(row?.variants)).map(([variant, file]) => ({
      variant,
      url: `${KHR}${asset.id}/${encodeURIComponent(variant)}/${encodeURIComponent(String(file))}`,
    }));
  }
  /** Downloads a chosen variant and all dependencies, preserving licence and SHA-256 provenance. Cleans up on failure. */
  async download(reference: string, variant: string, signal?: AbortSignal): Promise<DownloadedAsset> {
    const asset = this.asset(reference),
      active = this.active(signal);
    active.throwIfAborted();
    const file = (await this.files(reference, active)).find((f) => f.variant === variant);
    if (!file) throw typeError('Unknown variant; call asset_files first', 'mcp');
    const root = resolve(this.options.directory);
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, `${asset.provider}-${asset.id}-`));
    const files: DownloadedAsset['files'] = [];
    let used = 0;
    const save = async (name: string, bytes: Uint8Array) => {
      used += bytes.length;
      if (used > this.max)
        throw rangeError('Downloaded/unpacked asset exceeds maxBytes; select a smaller variant', 'mcp');
      const path = safePath(directory, name);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes, { flag: 'wx', signal: active });
      files.push({ path: name, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length });
    };
    const fetchFile = async (name: string, value: { url: string; size?: number; md5?: string }) => {
      safePath(directory, name);
      const bytes = await this.bytes(value.url, asset.provider, active, this.max - used);
      if (value.size !== undefined && bytes.length !== value.size)
        throw fault('failed', 'Asset size differs from metadata; refresh the catalogue', 'mcp');
      if (value.md5 && createHash('md5').update(bytes).digest('hex') !== value.md5)
        throw fault('failed', 'Asset checksum differs from metadata; refresh the catalogue', 'mcp');
      await save(name, bytes);
      return bytes;
    };
    try {
      let entry = decodeURIComponent(new URL(file.url).pathname.split('/').at(-1)!);
      if (new URL(file.url).searchParams.has('file')) entry = new URL(file.url).searchParams.get('file')!;
      const bytes = await fetchFile(entry, file);
      for (const [name, value] of Object.entries(file.include ?? {})) await fetchFile(name, value);
      if (/\.gltf$/i.test(entry) && !file.include) {
        const document = JSON.parse(new TextDecoder().decode(bytes));
        for (const value of [...(document.buffers ?? []), ...(document.images ?? [])])
          if (typeof value.uri === 'string' && !value.uri.startsWith('data:')) {
            safePath(directory, value.uri);
            if (!files.some((f) => f.path === value.uri))
              await fetchFile(value.uri, { url: new URL(value.uri, file.url).href });
          }
      }
      if (/\.zip$/i.test(entry)) {
        const { readZipDirectory, readZipEntry } = await import('@margoengine/loaders/common');
        const entries = readZipDirectory(bytes, { maxEntries: 1000, signal: active });
        for (const item of entries) {
          if (item.name.endsWith('/')) continue;
          safePath(directory, item.name);
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
      const manifest = join(directory, 'margo-asset.json');
      await writeFile(manifest, JSON.stringify({ asset, variant, url: file.url, files }, null, 2), {
        flag: 'wx',
        signal: active,
      });
      const result = { asset: { ...asset }, directory, entry, files, manifest };
      this.downloaded.set(directory, result);
      return result;
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }
  /** Wires one completed download through the page's app/optional-package loader, using the configured public URL. */
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
      { ...options, kind: asset.asset.kind, url: url.href, license: asset.asset.license, source: asset.asset.source },
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
      'CC0 assets from Poly Haven, ambientCG and verified Khronos samples. Search first, list exact variants, download with licence manifest, then wire into the live page.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        provider: { enum: providers },
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
