// USD composition for the import: sublayers, references, payloads, inherits, specializes and variants, from any mix of
// text and binary layers, in a .usdz or spread over files.
import type { EngineKernel } from '@margoengine/core';
import type { PBRModel } from '@margoengine/gltf-pro/model';
import { fetchBytes, LoaderError, readZipDirectory, readZipEntry } from '@margoengine/loaders/common';
import { parseCrate, type Specs } from './crate.js';
import type { ExtensionHooks, LayerRead, USDExtension, USDIssue } from './extension.js';
import { assetFromSpecs, type USDAsset, type USDOptions } from './index.js';
import { readTextLayer } from './layer.js';
import { composeStage, type ComposeIssue } from './stage.js';

const decoder = new TextDecoder();
/** Options of `composition()`. */
export interface CompositionOptions {
  /** Variant selections that beat the file's, by prim path: `{ '/Model': { shadingVariant: 'red' } }`. */
  variants?: Record<string, Record<string, string>>;
  /** Layers the archive does not hold, by id: a path from the root layer's folder. */
  layers?: Record<string, string | Uint8Array> | Map<string, string | Uint8Array>;
  /** False leaves payloads out, as a stage opened with `LoadNone` does. Default true. */
  payloads?: boolean;
}
interface Composition extends ExtensionHooks {
  options: CompositionOptions;
}
function layerBytes(value: string | Uint8Array | undefined): Uint8Array | undefined {
  return typeof value === 'string' ? new TextEncoder().encode(value) : value;
}
/** One layer's specs: Crate by its magic, text by its header. Anything else, such as Alembic, has no specs. */
function readLayer(data: Uint8Array, read: Pick<LayerRead, 'maxBytes' | 'maxDepth' | 'signal'>): Specs | undefined {
  if (data.length < 8) return undefined;
  const head = decoder.decode(data.subarray(0, 8));
  if (head === 'PXR-USDC') return parseCrate(data, read.maxBytes, read.maxDepth, true);
  if (!head.startsWith('#usda ')) return undefined;
  return readTextLayer(decoder.decode(data), read.maxDepth, read.signal);
}
function compose(
  read: LayerRead,
  options: CompositionOptions,
  lookup: (id: string) => Uint8Array | undefined,
  missing?: Set<string>,
): Specs {
  const cache = new Map<string, Specs | undefined>();
  return composeStage(read.id, {
    variants: options.variants,
    payloads: options.payloads,
    issues: read.issues as ComposeIssue[],
    signal: read.signal,
    layer(id) {
      if (cache.has(id)) return cache.get(id);
      const data = id === read.id ? read.data : lookup(id);
      if (!data) missing?.add(id);
      const specs = data && readLayer(data, read);
      if (data && !specs) read.issues.push({ code: 'unsupported-layer', message: `${id} is not a USD layer this reader knows` });
      cache.set(id, specs);
      return specs;
    },
  }).specs;
}
/**
 * USD composition for `parseUSDA`, `parseUSDC`, `parseUSDZ` and `loadUSDZ`: pass `extensions: [composition()]`.
 * The layers of a `.usdz` come from the archive and others from `layers`; a file spread over a folder or a server loads
 * through `parseUSDFiles` or `loadUSDFiles`. What cannot be opened is left out and listed in `USDAsset.issues`, as
 * OpenUSD warns and goes on.
 */
export function composition(options: CompositionOptions = {}): USDExtension {
  const extra = options.layers,
    get = (id: string) => (extra instanceof Map ? extra.get(id) : extra?.[id]);
  const hook: Composition = {
    name: 'compose',
    options,
    compose: (read) => compose(read, options, (id) => read.entries.get(id) ?? layerBytes(get(id))),
  };
  return hook;
}
/** Reads a file by its id: a path from the root layer's folder. */
export type USDFileReader = (id: string) => Promise<Uint8Array | undefined> | Uint8Array | undefined;
const isZip = (data: Uint8Array) => data[0] === 0x50 && data[1] === 0x4b;
/** The files of a `.usdz` under `<id>[<entry>]`, and the id of its root layer. */
async function unpack(id: string, data: Uint8Array, files: Map<string, Uint8Array>, maxBytes: number, signal?: AbortSignal) {
  const directory = readZipDirectory(data, { maxEntries: 10_000 });
  let root: (typeof directory)[number] | undefined;
  for (const entry of directory) {
    if (!root || entry.headerOffset < root.headerOffset) root = entry;
    files.set(`${id}[${entry.name}]`, await readZipEntry(data, entry, { maxEntryBytes: maxBytes, signal }));
  }
  if (!root) throw new LoaderError('USD', 'syntax', `${id} holds no layers`);
  return `${id}[${root.name}]`;
}
/** The asset paths a composed scene reads, shader files above all. */
function assets(specs: Specs): string[] {
  const out = new Set<string>();
  for (const path in specs) {
    const fields = specs[path].fields;
    if (fields.typeName === 'asset' && typeof fields.default === 'string' && fields.default) out.add(fields.default);
  }
  return [...out];
}
/** A composed stage: one flat spec map, every file it read and what it had to leave out. */
export interface USDStage {
  /**
   * Prims and properties by path, as one static layer would hold them: `/A` and `/A.size`. Each has `specType` (6 a
   * prim, 1 an attribute, 8 a relationship) and `fields` (`typeName`, `default`, `timeSamples`, `targetPaths`,
   * `connectionPaths`, metadata). Sample times are in the stage's time, with every layer offset applied.
   */
  specs: Specs;
  /** Every file read, by id, for textures as much as layers. */
  files: Map<string, Uint8Array>;
  issues: USDIssue[];
}
/**
 * Composes a stage spread over files. `read` gets each id once, the root first: only the layers the stage really uses
 * are read, so a variant that is not selected costs nothing. `.usdz` files among them are opened.
 */
export async function composeUSDFiles(root: string, read: USDFileReader, options: USDOptions & CompositionOptions = {}): Promise<USDStage> {
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024,
    maxDepth = options.maxDepth ?? 32,
    files = new Map<string, Uint8Array>(),
    aliases = new Map<string, string>(),
    absent = new Set<string>();
  const fetchId = async (id: string) => {
    if (files.has(id) || aliases.has(id) || absent.has(id)) return;
    options.signal?.throwIfAborted();
    // A file inside a package is there once its package is.
    const open = id.endsWith(']') ? id.indexOf('[') : -1;
    if (open >= 0) {
      await fetchId(id.slice(0, open));
      if (!files.has(id)) absent.add(id);
      return;
    }
    const data = await read(id);
    if (!data) absent.add(id);
    else if (isZip(data)) aliases.set(id, await unpack(id, data, files, maxBytes, options.signal));
    else files.set(id, data);
  };
  await fetchId(root);
  const rootId = aliases.get(root) ?? root;
  const rootData = files.get(rootId);
  if (!rootData) throw new LoaderError('USD', 'syntax', `could not read ${root}`);
  const issues: USDIssue[] = [];
  let specs: Specs;
  for (let pass = 0; ; pass++) {
    if (pass > 256) throw new LoaderError('USD', 'limit', 'layers exceed limit: too many passes');
    const missing = new Set<string>();
    issues.length = 0;
    specs = compose(
      { id: rootId, data: rootData, entries: files, maxBytes, maxDepth, issues, signal: options.signal },
      options,
      (id) => files.get(aliases.get(id) ?? id),
      missing,
    );
    const wanted = [...missing].filter((id) => !absent.has(id));
    if (!wanted.length) break;
    for (const id of wanted) await fetchId(id);
  }
  for (const id of assets(specs)) await fetchId(id);
  return { specs, files, issues };
}
/** `composeUSDFiles`, then the scene as a `USDAsset`. */
export async function parseUSDFiles(root: string, read: USDFileReader, options: USDOptions & CompositionOptions = {}): Promise<USDAsset> {
  const { specs, files, issues } = await composeUSDFiles(root, read, options);
  return assetFromSpecs(specs, files, options, issues);
}
/** `parseUSDFiles` over `fetch`: each layer and texture is fetched relative to `url`, then attached to `engine`. */
export async function loadUSDFiles(
  engine: EngineKernel,
  url: string | URL,
  options: USDOptions & CompositionOptions = {},
): Promise<PBRModel> {
  const base = new URL(url, globalThis.location?.href),
    root = base.pathname.slice(base.pathname.lastIndexOf('/') + 1);
  const asset = await parseUSDFiles(
    decodeURIComponent(root),
    async (id) => {
      try {
        return await fetchBytes(new URL(id, base), {
          maxBytes: options.maxBytes ?? 64 * 1024 * 1024,
          signal: options.signal,
          fetch: options.fetch,
        });
      } catch (error) {
        if (error instanceof LoaderError && error.code !== 'limit') return undefined;
        throw error;
      }
    },
    options,
  );
  return asset.create(engine, options);
}
