/// <reference lib="esnext.disposable" preserve="true" />
// Clean-room adapter from the public Streamed SOG v1 specification. No exporter or rival engine source read.
import { MargoError } from '@margoengine/math/errors';
import type { SplatData } from './data.js';
import type { SplatLodNode, SplatLodSource } from './lod.js';
import { parseSog, type SogFiles } from './sog.js';

/** Loading options for a streamed SOG hierarchy. */
export interface StreamedSogOptions {
  /** Cancels manifest, metadata and subsequent chunk requests. */
  signal?: AbortSignal;
  /** Fetch implementation, for authentication or local file maps. Default global fetch. */
  fetch?: typeof fetch;
  /** Most decoded, idle chunks retained on the CPU. Default 2; zero retains none. */
  cacheChunks?: number;
}
interface Range {
  file: number;
  offset: number;
  count: number;
}
interface SpatialNode {
  bound: { min: [number, number, number]; max: [number, number, number] };
  children?: [SpatialNode, SpatialNode];
  lods?: Record<string, Range>;
  errors?: number[];
}
interface Manifest {
  version?: number;
  model?: string;
  lodLevels: number;
  filenames: string[];
  tree: SpatialNode;
  environment?: string | null;
  lodErrors?: boolean;
  count?: number;
  counts?: number[];
}
interface ChunkMeta {
  version: number;
  count: number;
  shN?: { bands: number };
  [key: string]: unknown;
}
interface Chunk {
  url: URL;
  meta: ChunkMeta;
  bytes: Uint8Array;
  pending?: { controller: AbortController; promise: Promise<SplatData>; users: number };
  data?: SplatData;
}

/**
 * An abortable, lazy streamed SOG source. Spatial interior nodes hold no splats; each leaf is a chain from its
 * coarsest available LOD to its finest. The environment is an unconditional sibling of the spatial tree.
 * Metadata is resident; texture requests and decoded chunks are shared, with independent caller cancellation.
 */
export class StreamedSogSource implements SplatLodSource {
  readonly nodes: readonly SplatLodNode[];
  /** Uniform coefficient count, promoted to the largest chunk's degree (0, 4, 9, 16 or 25). */
  readonly coefficients: number;
  private readonly abort = new AbortController();
  private readonly idle = new Map<Chunk, SplatData>();
  private readonly cacheChunks: number;
  private readonly ranges: readonly (Range | undefined)[];
  private readonly chunks: Chunk[];
  private readonly fetcher: typeof fetch;
  private readonly stop?: () => void;
  private readonly signal?: AbortSignal;
  private dead = false;

  /** Use {@link loadStreamedSog}; the constructor takes validated manifest metadata. */
  private constructor(
    nodes: SplatLodNode[],
    ranges: (Range | undefined)[],
    chunks: Chunk[],
    options: StreamedSogOptions,
  ) {
    this.nodes = nodes;
    this.ranges = ranges;
    this.chunks = chunks;
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.cacheChunks = options.cacheChunks ?? 2;
    this.coefficients = chunks.reduce(
      (largest, c) => Math.max(largest, c.meta.shN ? (c.meta.shN.bands + 1) ** 2 : 0),
      0,
    );
    this.signal = options.signal;
    this.stop = options.signal ? () => this.dispose() : undefined;
    options.signal?.addEventListener('abort', this.stop!, { once: true });
  }

  /** Loads a manifest and its small chunk metadata; no texture is fetched until `load`. */
  static async open(url: string | URL, options: StreamedSogOptions = {}): Promise<StreamedSogSource> {
    options.signal?.throwIfAborted();
    const cache = options.cacheChunks ?? 2;
    if (!Number.isSafeInteger(cache) || cache < 0)
      throw new RangeError('cacheChunks must be an integer of 0 or more; set the decoded chunk cache size');
    const fetcher = options.fetch ?? globalThis.fetch,
      base = new URL(url, globalThis.location?.href),
      manifest = await readJson<Manifest>(base, fetcher, options.signal);
    if (manifest.version !== undefined && manifest.version !== 1)
      throw new RangeError('Unsupported streamed SOG version; export version 1');
    if (
      !Number.isSafeInteger(manifest.lodLevels) ||
      manifest.lodLevels < 1 ||
      !Array.isArray(manifest.filenames) ||
      !manifest.filenames.length ||
      manifest.filenames.some((f) => typeof f !== 'string' || !f)
    )
      throw new RangeError('Invalid streamed SOG levels or filenames; supply a complete lod-meta.json');
    // The manifest's model covers every chunk, including chunks whose meta.json omits it: a 2D Gaussian (2dgs) capture
    // is refused before any chunk is fetched, never drawn as ordinary 3D Gaussians (KB5472a).
    if (manifest.model !== undefined && manifest.model !== 'antialiased')
      throw new MargoError(
        'unsupported',
        `Streamed SOG model ${manifest.model} is not supported; 2D Gaussian scenes cannot be drawn here.`,
      );
    const filenames = [...manifest.filenames];
    if (manifest.environment != null) {
      if (typeof manifest.environment !== 'string' || !manifest.environment)
        throw new RangeError('Invalid environment path; use a SOG meta.json path');
      filenames.push(manifest.environment);
    }
    // Bounded metadata concurrency avoids opening thousands of connections for a large capture.
    const chunks: Chunk[] = new Array(filenames.length);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(8, filenames.length) }, async () => {
        while (next < filenames.length) {
          const i = next++,
            chunkUrl = new URL(filenames[i], base),
            response = await fetcher(chunkUrl, { signal: options.signal });
          if (!response.ok)
            throw new MargoError(
              'failed',
              `SOG metadata ${chunkUrl} returned HTTP ${response.status}; check the URL and server access`,
            );
          const bytes = new Uint8Array(await response.arrayBuffer()),
            meta = JSON.parse(new TextDecoder().decode(bytes)) as ChunkMeta;
          if (
            ![2, 3].includes(meta.version) ||
            !Number.isSafeInteger(meta.count) ||
            meta.count < 1 ||
            meta.count > 3_000_000 ||
            (meta.shN &&
              (!Number.isInteger(meta.shN.bands) ||
                meta.shN.bands < 1 ||
                meta.shN.bands > (meta.version === 3 ? 4 : 3)))
          )
            throw new RangeError('Invalid SOG chunk version, count or SH degree; supply SOG v2 or v3 chunks');
          chunks[i] = { url: chunkUrl, bytes, meta };
        }
      }),
    );
    const nodes: SplatLodNode[] = [],
      ranges: (Range | undefined)[] = [],
      runs = manifest.filenames.map(() => [] as { offset: number; count: number; level: number }[]),
      counts = new Array<number>(manifest.lodLevels).fill(0),
      seen = new Set<SpatialNode>();
    const sphere = (node: SpatialNode) => {
      const { min, max } = node?.bound ?? {};
      if (
        !Array.isArray(min) ||
        !Array.isArray(max) ||
        min.length !== 3 ||
        max.length !== 3 ||
        min.some((x, a) => !Number.isFinite(x) || !Number.isFinite(max[a]) || x > max[a])
      )
        throw new RangeError('Invalid streamed SOG bounds; supply finite ordered xyz min/max');
      const center = min.map((x, a) => x / 2 + max[a] / 2) as [number, number, number];
      return { center, radius: Math.hypot(...max.map((x, a) => x / 2 - min[a] / 2)) };
    };
    const append = (node: SpatialNode, depth: number): number => {
      if (depth > 128 || seen.has(node))
        throw new RangeError('Invalid streamed SOG tree depth or cycle; supply an acyclic spatial tree');
      seen.add(node);
      const bounds = sphere(node),
        at = nodes.length;
      if (node.children) {
        if (node.lods || !Array.isArray(node.children) || node.children.length !== 2)
          throw new RangeError('A streamed SOG interior needs exactly two children and no lods; repair the manifest');
        nodes.push({ ...bounds, count: 0, error: 0, children: [] });
        ranges.push(undefined);
        const children = node.children.map((c) => append(c, depth + 1));
        nodes[at] = { ...bounds, count: 0, error: 0, children };
      } else {
        if (!node.lods || typeof node.lods !== 'object')
          throw new RangeError('A streamed SOG leaf needs lods; repair the manifest');
        const levels = Object.keys(node.lods)
          .map((key) => {
            const level = Number(key),
              r = node.lods![key];
            if (
              !/^\d+$/.test(key) ||
              !Number.isSafeInteger(level) ||
              level >= manifest.lodLevels ||
              !r ||
              !Number.isSafeInteger(r.file) ||
              r.file < 0 ||
              r.file >= manifest.filenames.length ||
              !Number.isSafeInteger(r.offset) ||
              r.offset < 0 ||
              !Number.isSafeInteger(r.count) ||
              r.count < 1 ||
              r.offset + r.count > chunks[r.file].meta.count
            )
              throw new RangeError('Invalid streamed SOG LOD range; use in-bounds file, offset and count');
            runs[r.file].push({ ...r, level });
            counts[level] += r.count;
            return level;
          })
          .sort((a, b) => b - a);
        if (!levels.length) throw new RangeError('A streamed SOG leaf has no levels; supply at least one splat range');
        if (manifest.lodErrors === true) {
          let previous = -Infinity;
          for (const level of [...levels].reverse()) {
            const error = node.errors?.[level];
            if (error === undefined || !Number.isFinite(error) || error < 0 || error < previous)
              throw new RangeError(
                'Invalid streamed SOG errors; supply non-negative non-decreasing errors for held levels',
              );
            previous = error;
          }
        }
        const finest = node.lods[String(levels.at(-1))]!.count;
        levels.forEach((level, k) => {
          const r = node.lods![String(level)],
            last = k === levels.length - 1;
          nodes.push({
            ...bounds,
            count: r.count,
            error: last
              ? 0
              : manifest.lodErrors === true
                ? node.errors![level]
                : bounds.radius * Math.cbrt(Math.max(0, 1 - r.count / finest)),
            children: last ? [] : [nodes.length + 1],
          });
          ranges.push(r);
        });
      }
      return at;
    };
    if (manifest.environment != null) {
      const bounds = sphere(manifest.tree);
      nodes.push({ ...bounds, count: 0, error: 0, children: [] });
      ranges.push(undefined);
      const env = chunks.length - 1;
      nodes.push({ ...bounds, count: chunks[env].meta.count, error: 0, children: [] });
      ranges.push({ file: env, offset: 0, count: chunks[env].meta.count });
      const spatial = append(manifest.tree, 0);
      nodes[0] = { ...bounds, count: 0, error: 0, children: [1, spatial] };
    } else append(manifest.tree, 0);
    for (let i = 0; i < runs.length; i++) {
      const sorted = runs[i].sort((a, b) => a.offset - b.offset);
      let end = 0;
      for (const r of sorted) {
        if (r.offset !== end || r.level !== sorted[0].level)
          throw new RangeError(
            'SOG chunk runs must cover a single level without overlaps or gaps; repair the manifest',
          );
        end += r.count;
      }
      if (end !== chunks[i].meta.count)
        throw new RangeError('SOG chunk runs do not cover its count; repair the manifest');
    }
    if (
      (manifest.count !== undefined && manifest.count !== counts.reduce((a, b) => a + b, 0)) ||
      (manifest.counts !== undefined &&
        (!Array.isArray(manifest.counts) ||
          manifest.counts.length !== counts.length ||
          counts.some((n, i) => n !== manifest.counts![i])))
    )
      throw new RangeError('Streamed SOG count totals disagree with its ranges; repair the manifest');
    options.signal?.throwIfAborted();
    return new StreamedSogSource(nodes, ranges, chunks, options);
  }

  /** Fetches and decodes only the chunk holding this node, then copies its storage-order run. */
  async load(index: number, signal: AbortSignal): Promise<SplatData> {
    signal.throwIfAborted();
    this.signal?.throwIfAborted();
    if (this.dead) throw new MargoError('disposed', 'Streamed SOG source was disposed; open a new source');
    const range = this.ranges[index];
    if (!Number.isInteger(index) || !this.nodes[index])
      throw new RangeError('Unknown streamed SOG node; use an index from nodes');
    if (!range) return { positions: new Float32Array(), covariances: new Float32Array(), colors: new Float32Array() };
    const chunk = this.chunks[range.file],
      data = await this.acquire(chunk, signal),
      { offset, count } = range,
      coefficients = this.coefficients,
      sh = coefficients ? new Float32Array(count * coefficients * 3) : undefined,
      old = data.sphericalHarmonics ? data.sphericalHarmonics.length / (data.positions.length / 3) / 3 : 0;
    signal.throwIfAborted();
    this.abort.signal.throwIfAborted();
    if (sh)
      for (let i = 0; i < count; i++) {
        if (old)
          sh.set(
            data.sphericalHarmonics!.subarray((offset + i) * old * 3, (offset + i + 1) * old * 3),
            i * coefficients * 3,
          );
        else
          for (let c = 0; c < 3; c++)
            sh[i * coefficients * 3 + c] = (data.colors[(offset + i) * 4 + c] - 0.5) / 0.2820947918;
      }
    return {
      positions: data.positions.slice(offset * 3, (offset + count) * 3),
      covariances: data.covariances.slice(offset * 6, (offset + count) * 6),
      colors: data.colors.slice(offset * 4, (offset + count) * 4),
      ...(sh ? { sphericalHarmonics: sh } : {}),
    };
  }

  private async acquire(chunk: Chunk, signal: AbortSignal): Promise<SplatData> {
    if (chunk.data) {
      this.idle.delete(chunk);
      this.idle.set(chunk, chunk.data);
      return chunk.data;
    }
    if (!chunk.pending) {
      const controller = new AbortController(),
        combined = AbortSignal.any([controller.signal, this.abort.signal]);
      const promise = this.decode(chunk, combined);
      chunk.pending = { controller, promise, users: 0 };
    }
    const pending = chunk.pending;
    pending.users++;
    try {
      const data = await new Promise<SplatData>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        pending.promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
      });
      signal.throwIfAborted();
      this.abort.signal.throwIfAborted();
      if (this.cacheChunks) {
        chunk.data = data;
        this.idle.delete(chunk);
        this.idle.set(chunk, data);
        while (this.idle.size > this.cacheChunks) {
          const oldest = this.idle.keys().next().value!;
          oldest.data = undefined;
          this.idle.delete(oldest);
        }
      }
      return data;
    } finally {
      if (--pending.users === 0) {
        pending.controller.abort();
        if (chunk.pending === pending) chunk.pending = undefined;
      }
    }
  }
  private async decode(chunk: Chunk, signal: AbortSignal): Promise<SplatData> {
    const files: SogFiles = { 'meta.json': chunk.bytes },
      names = new Set<string>();
    for (const value of Object.values(chunk.meta)) {
      if (value && typeof value === 'object' && 'files' in value && Array.isArray(value.files))
        for (const name of value.files) {
          if (typeof name !== 'string') throw new RangeError('Invalid SOG texture name; supply string filenames');
          names.add(name);
        }
    }
    await Promise.all(
      [...names].map(async (name) => {
        const response = await this.fetcher(new URL(name, chunk.url), { signal });
        if (!response.ok)
          throw new MargoError('failed', `SOG texture ${name} returned HTTP ${response.status}; check the chunk files`);
        files[name] = await response.arrayBuffer();
      }),
    );
    return parseSog(files, { signal });
  }
  /** Releases decoded chunks and cancels pending requests. Idempotent. */
  dispose(): void {
    if (this.dead) return;
    this.dead = true;
    this.abort.abort(new MargoError('disposed', 'Streamed SOG source was disposed; open a new source'));
    this.signal?.removeEventListener('abort', this.stop!);
    for (const chunk of this.chunks) chunk.data = undefined;
    this.idle.clear();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
async function readJson<T>(url: URL, fetcher: typeof fetch, signal?: AbortSignal): Promise<T> {
  const response = await fetcher(url, { signal });
  if (!response.ok)
    throw new MargoError('failed', `Streamed SOG manifest returned HTTP ${response.status}; check ${url}`);
  return response.json() as Promise<T>;
}
/** Opens a streamed SOG v1 or pre-release manifest as a lazy {@link SplatLodSource}. */
export function loadStreamedSog(url: string | URL, options: StreamedSogOptions = {}): Promise<StreamedSogSource> {
  return StreamedSogSource.open(url, options);
}
