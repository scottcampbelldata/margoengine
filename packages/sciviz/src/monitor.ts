/// <reference lib="esnext.disposable" preserve="true" />
import { fault, rangeError } from '../../shared/errors.js';
import type { Figure, Layer } from './figure.js';
import type { LayerResources } from './resources.js';
import type { ColumnarTable } from './table.js';

export type { LayerResources } from './resources.js';

/** Input counts. A missing count is unknown, never silently zero. */
export interface DataCounts {
  readonly points?: number;
  readonly voxels?: number;
  readonly cells?: number;
  readonly edges?: number;
  readonly rows?: number;
}

/** Allocation payload, excluding driver padding, object overhead, pipelines and shared engine targets. */
export interface MemoryBytes {
  /** Live GPU buffer descriptor sizes and uncompressed texture texels. */
  readonly gpuBytes: number;
  /** Retained JS ArrayBuffer backing stores, counted once even for overlapping views. */
  readonly jsDataBytes: number;
  /** Ordinary numeric arrays have no specified representation: eight bytes per element is an estimate. */
  readonly jsArrayBytesEstimate: number;
}

/** One stable layer identity and its current data inventory. */
export interface LayerStats extends MemoryBytes {
  readonly id: number;
  readonly name: string;
  readonly counts: DataCounts;
  /** False means the optional/custom layer needs a resource adapter through track(). */
  readonly inventoryAvailable: boolean;
}

/** A JSON-safe observation. Layer inventories may overlap; figure totals are deduplicated. */
export interface FigureStatsSnapshot extends MemoryBytes {
  readonly layers: readonly LayerStats[];
  readonly unreportedLayers: number;
  readonly counts: DataCounts;
}

/** Adapts arbitrary optional layers and table storage without inspecting their private fields. */
export interface StatsAdapter {
  /** Live values, evaluated on every snapshot. */
  readonly resources: () => LayerResources;
  readonly counts?: () => DataCounts;
  readonly name?: string;
}

type Inventory = { memoryResources: LayerResources };
const inventory = (value: object): value is object & Inventory => 'memoryResources' in value;
const blank = (): { gpuBytes: number; jsDataBytes: number; jsArrayBytesEstimate: number } => ({
  gpuBytes: 0,
  jsDataBytes: 0,
  jsArrayBytesEstimate: 0,
});

function measure(resources: LayerResources, cpu: Set<object>, gpu: Set<object>): MemoryBytes {
  const out = blank();
  for (const data of resources.cpu) {
    if (!data) continue;
    const key = ArrayBuffer.isView(data) ? data.buffer : data;
    if (cpu.has(key)) continue;
    cpu.add(key);
    if (ArrayBuffer.isView(data)) out.jsDataBytes += data.buffer.byteLength;
    else out.jsArrayBytesEstimate += data.length * 8;
  }
  for (const resource of resources.gpu) {
    if (!resource) continue;
    const key = 'texture' in resource ? resource.texture : resource;
    if (gpu.has(key)) continue;
    gpu.add(key);
    if ('texture' in resource) {
      const t = resource.texture;
      for (let mip = 0; mip < t.mipLevelCount; mip++) {
        const depth = t.dimension === '3d' ? Math.max(1, t.depthOrArrayLayers >> mip) : t.depthOrArrayLayers;
        out.gpuBytes +=
          Math.max(1, t.width >> mip) * Math.max(1, t.height >> mip) * depth * t.sampleCount * resource.bytesPerTexel;
      }
    } else out.gpuBytes += resource.size;
  }
  return out;
}

function countsFor(layer: Layer): DataCounts {
  if ('kind' in layer && layer.kind === 'scatter') return { points: layer.count };
  if ('kind' in layer && layer.kind === 'line') return { points: layer.line.count, edges: layer.line.segmentCount };
  if ('rects' in layer && layer.rects instanceof Float32Array) return { cells: layer.rects.length / 4 };
  if ('dims' in layer && Array.isArray(layer.dims)) {
    const dims = layer.dims as number[];
    return { voxels: dims.reduce((a, b) => a * b, 1), cells: dims.reduce((a, b) => a * (b - 1), 1) };
  }
  if ('nx' in layer && 'ny' in layer && typeof layer.nx === 'number' && typeof layer.ny === 'number')
    return { cells: (layer.nx - 1) * (layer.ny - 1) };
  if ('nodes' in layer && 'edges' in layer && typeof layer.nodes === 'number' && typeof layer.edges === 'number')
    return { points: layer.nodes, edges: layer.edges };
  return {};
}

/** Installed explicitly; no import side effects or automatic frame hooks. */
export class FigureStats {
  readonly #figure: Figure;
  readonly #adapters = new Map<object, StatsAdapter>();
  readonly #ids = new WeakMap<object, number>();
  #next = 1;
  #disposed = false;
  constructor(figure: Figure) {
    this.#figure = figure;
  }

  /** Tracks a borrowed typed table, including int64 storage and validity bitmaps. Strings/object overhead are excluded. */
  trackTable(table: ColumnarTable, name = 'table'): () => void {
    return this.track(table, {
      name,
      counts: () => ({ rows: table.length }),
      resources: () => ({
        cpu: Object.values(table.columns).flatMap((column) => [column.values, column.validity]),
        gpu: [],
      }),
    });
  }

  /** Adds inventory for a custom layer or external table. Returns an unregister function. */
  track(key: object, adapter: StatsAdapter): () => void {
    if (this.#disposed) throw fault('disposed', 'Figure stats is disposed', 'sciviz');
    this.#adapters.set(key, adapter);
    return () => {
      if (this.#adapters.get(key) === adapter) this.#adapters.delete(key);
    };
  }

  /** Live snapshot; totals deduplicate shared backing stores and GPU resources across layers. */
  snapshot(): FigureStatsSnapshot {
    if (this.#disposed) throw fault('disposed', 'Figure stats is disposed', 'sciviz');
    const layers = this.#figure.layers;
    const members = new Set<object>([...layers, ...this.#adapters.keys()]);
    for (const key of members)
      if (inventory(key)) for (const child of key.memoryResources.children ?? []) members.add(child);
    const keys = [...members];
    const totals = blank(),
      cpu = new Set<object>(),
      gpu = new Set<object>(),
      counts: Record<string, number> = {};
    const rows = keys.map((key) => {
      const adapter = this.#adapters.get(key);
      const layer = layers.includes(key as Layer) ? (key as Layer) : undefined;
      const source =
        adapter?.resources() ??
        (inventory(key)
          ? key.memoryResources
          : layer && 'kind' in layer && layer.kind === 'scatter'
            ? {
                cpu: [...layer.cloud.memoryResources.cpu, layer.positions, layer.values],
                gpu: layer.cloud.memoryResources.gpu,
              }
            : layer && 'kind' in layer && layer.kind === 'line'
              ? {
                  cpu: [...layer.line.memoryResources.cpu, layer.positions, layer.values],
                  gpu: layer.line.memoryResources.gpu,
                }
              : undefined);
      const resources = source ?? { cpu: [], gpu: [] };
      const memory = measure(resources, new Set(), new Set());
      const unique = measure(resources, cpu, gpu);
      for (const field of ['gpuBytes', 'jsDataBytes', 'jsArrayBytesEstimate'] as const) totals[field] += unique[field];
      const count = adapter?.counts?.() ?? (layer ? countsFor(layer) : {});
      for (const [field, n] of Object.entries(count)) {
        if (!Number.isSafeInteger(n) || n < 0) throw rangeError(`Invalid ${field} count ${n}`, 'sciviz');
        counts[field] = (counts[field] ?? 0) + n;
      }
      let id = this.#ids.get(key);
      if (id === undefined) {
        id = this.#next++;
        this.#ids.set(key, id);
      }
      return {
        ...memory,
        id,
        name:
          adapter?.name ??
          ('name' in key && typeof key.name === 'string'
            ? key.name
            : 'kind' in key
              ? String(key.kind)
              : key.constructor.name),
        counts: count,
        inventoryAvailable: source !== undefined,
      };
    });
    return { ...totals, counts, layers: rows, unreportedLayers: rows.filter((row) => !row.inventoryAvailable).length };
  }

  dispose(): void {
    this.#adapters.clear();
    this.#disposed = true;
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}

/** Adds fig.stats without changing Figure's root imports. Repeat installation returns the same monitor. */
export function installFigureStats<T extends Figure>(figure: T): T & { readonly stats: FigureStats } {
  if ('stats' in figure) {
    if (figure.stats instanceof FigureStats) return figure as T & { readonly stats: FigureStats };
    throw fault('state', 'Figure already has a different stats property', 'sciviz');
  }
  return Object.defineProperty(figure, 'stats', { value: new FigureStats(figure), configurable: true }) as T & {
    readonly stats: FigureStats;
  };
}

export { sweepLimits } from './monitor-sweep.js';
export type { SweepOptions, SweepCase, SweepReport, SweepRow, SweepMetadata } from './monitor-sweep.js';
