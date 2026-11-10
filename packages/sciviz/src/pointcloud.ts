/// <reference lib="esnext.disposable" preserve="true" />
// Clean room: Schütz 2016 additive octrees; COPC 1.0; Vega-Lite keyed predicates.
// Streaming, decoding and drawing stay in points. This entry owns the figure mapping and interaction.
import type { PointsPlugin, PointCloud } from '@margoengine/points';
import {
  OctreeCloud,
  buildOctree,
  type OctreeSource,
  type OctreeNode,
  type OctreeNodeData,
  type OctreeCloudOptions,
} from '@margoengine/points/octree';
import { multiplyMatrices } from '@margoengine/math/mat4';
import { fault, rangeError } from '../../shared/errors.js';
import type { Figure } from './figure.js';
import { resolveColormap, rangeOption, type Bounds, type ColormapSource } from './layer.js';
import { nearestPoint, selectPoints, type SelectRegion } from './pick.js';
import { selectionOperation, type RowKey, type SelectionOperation, type SelectionStore } from './link.js';

/** A scalar column, a vector component, elevation, or original RGB. */
export interface PointCloudColour {
  /** Default elevation. Other names are the source's attribute keys; rgb keeps original colours. */
  readonly attribute?: string;
  /** Zero-based vector component. Default 0. */
  readonly component?: number;
  readonly colormap?: ColormapSource;
  /** Global range, identical across nodes. Default the source z extent for elevation, [0, 1] otherwise. */
  readonly range?: readonly [number, number];
}
/** Loading, display and stable selection identity. */
export interface PointCloudLayerOptions extends PointCloudColour {
  readonly name?: string;
  /** World position of local zero; inferred by openPointCloud, otherwise [0, 0, 0]. */
  readonly origin?: readonly [number, number, number];
  /** At least the root's point count. Default max(2,000,000, root.count). */
  readonly pointBudget?: number;
  /** Resident points including off-screen cache. Default 3 x pointBudget. */
  readonly maxLoadedPoints?: number;
  readonly minNodePixels?: number;
  readonly maxConcurrentLoads?: number;
  readonly material?: OctreeCloudOptions['material'];
  /** Default node id plus point index, prefixed with name; in-memory octrees use original rowIds. */
  readonly rowKey?: (node: OctreeNode, index: number, data: OctreeNodeData) => RowKey;
  /** Shared selection; an open universe avoids allocating one key per remote point. */
  readonly selection?: SelectionStore;
  /** Selection brush identity. Default name or a unique layer identity. */
  readonly selectionSource?: string;
  /** Brightness of unselected points. Default 0.12. */
  readonly fade?: number;
  readonly signal?: AbortSignal;
}
/** Attribute pick, in world data units, with a stable row identity. */
export interface PointCloudPick {
  readonly layer: PointCloudLayer;
  readonly node: OctreeNode;
  readonly index: number;
  readonly rowId: RowKey;
  readonly position: readonly [number, number, number];
  readonly attributes: Readonly<Record<string, number | readonly number[]>>;
  readonly distance: number;
}
interface Resident {
  node: OctreeNode;
  data: OctreeNodeData;
  base: Uint32Array | null;
}
let serial = 0;

/** An octree in a figure's linear 3D data frame, with bounded resident attributes and keyed interaction. */
export class PointCloudLayer extends EventTarget {
  readonly bounds: Bounds;
  readonly name: string;
  readonly octree: OctreeCloud;
  readonly points: PointsPlugin;
  readonly origin: readonly [number, number, number];
  readonly caption =
    'Metadata and hierarchy load first. Coarse points load next; moving closer adds visible detail under the point budget. Off-screen nodes are cached, then evicted with their attributes. Picks and brushes describe resident visible points, not unloaded points.';
  readonly #figure: Figure;
  readonly #options: PointCloudLayerOptions;
  readonly #resident = new Map<PointCloud, Resident>();
  readonly #pending = new WeakMap<Float32Array, { node: OctreeNode; data: OctreeNodeData }>();
  readonly #events = new AbortController();
  #colour: PointCloudColour;
  #error: unknown;
  #disposed = false;
  #operation: SelectionOperation = 'replace';
  #colourWrites = 0;

  /** Loads the points renderer lazily and attaches a complete layer to the figure. */
  static async create(
    figure: Figure,
    source: OctreeSource,
    options: PointCloudLayerOptions = {},
  ): Promise<PointCloudLayer> {
    options.signal?.throwIfAborted();
    const { PointsPlugin } = await import('@margoengine/points');
    options.signal?.throwIfAborted();
    const layer = new PointCloudLayer(figure, source, options, PointsPlugin);
    try {
      return figure.addLayer(layer);
    } catch (error) {
      layer.dispose();
      throw error;
    }
  }

  private constructor(
    figure: Figure,
    source: OctreeSource,
    options: PointCloudLayerOptions,
    Plugin: typeof PointsPlugin,
  ) {
    super();
    options.signal?.throwIfAborted();
    const budget = options.pointBudget ?? Math.max(2_000_000, source.root.count);
    if (!Number.isSafeInteger(budget) || budget < Math.max(1, source.root.count))
      throw rangeError('pointBudget must be a positive integer at least the source root count', 'sciviz');
    if (options.fade !== undefined && !(options.fade >= 0 && options.fade <= 1))
      throw rangeError('fade must be between 0 and 1', 'sciviz');
    this.#figure = figure;
    this.#options = options;
    this.#colour = this.#checkedColour(options);
    this.origin = options.origin ?? [0, 0, 0];
    if (this.origin.length !== 3 || !this.origin.every(Number.isFinite))
      throw rangeError('origin must contain three finite coordinates', 'sciviz');
    const b = source.root.bounds,
      o = this.origin;
    this.bounds = [b[0] + o[0], b[3] + o[0], b[1] + o[1], b[4] + o[1], b[2] + o[2], b[5] + o[2]];
    this.name = options.name ?? `pointcloud-${++serial}`;
    const wrapped: OctreeSource = {
      root: source.root,
      load: async (node, signal) => {
        const data = await source.load(node, signal);
        signal.throwIfAborted();
        if (data.positions.length !== node.count * 3)
          throw rangeError(`Node ${node.id} point count differs from its hierarchy`, 'sciviz');
        for (const [name, values] of Object.entries(data.attributes ?? {}))
          if (node.count ? !Number.isInteger(values.length / node.count) || values.length < node.count : values.length)
            throw rangeError(`Node ${node.id} attribute ${name} has an invalid length`, 'sciviz');
        if (data.rowIds && data.rowIds.length !== node.count)
          throw rangeError(`Node ${node.id} rowIds has an invalid length`, 'sciviz');
        this.#pending.set(data.positions, { node, data });
        return data;
      },
    };
    this.octree = new OctreeCloud(
      {
        add: <T extends PointCloud>(cloud: T): T => {
          const entry = this.#pending.get(cloud.positions)!;
          this.#pending.delete(cloud.positions);
          const resident = { ...entry, base: cloud.colors?.slice() ?? null };
          this.#paint(cloud, resident);
          this.#resident.set(cloud, resident);
          return this.points.add(cloud);
        },
        remove: (cloud) => {
          this.#resident.delete(cloud as PointCloud);
          this.points.remove(cloud);
        },
      },
      wrapped,
      { ...options, pointBudget: budget, material: options.material ?? { size: 3, shape: 'round' } },
    );
    this.points = Plugin.attach(figure.engine, { name: `figure-pointcloud-${++serial}`, pointBudget: budget });
    figure.engine.use(this.octree);
    this.octree.onError((node, error) => {
      this.#error = error;
      this.dispatchEvent(new CustomEvent('loaderror', { detail: { node, error } }));
    });
    options.selection?.subscribe(() => this.#refresh(), { signal: this.#events.signal });
    figure.addEventListener(
      'selection',
      (e) => this.select((e as CustomEvent<{ region: SelectRegion }>).detail.region, { operation: this.#operation }),
      { signal: this.#events.signal },
    );
    const canvas = figure.engine.canvas as HTMLCanvasElement;
    canvas.addEventListener?.(
      'pointerdown',
      (event) => {
        this.#operation = selectionOperation(event);
      },
      { signal: this.#events.signal },
    );
    canvas.addEventListener?.(
      'pointermove',
      (event) => {
        const rect = canvas.getBoundingClientRect();
        this.dispatchEvent(
          new CustomEvent('pick', { detail: this.pick(event.clientX - rect.left, event.clientY - rect.top) }),
        );
      },
      { signal: this.#events.signal },
    );
    options.signal?.addEventListener('abort', () => this.dispose(), { once: true, signal: this.#events.signal });
  }

  #checkedColour(colour: PointCloudColour): PointCloudColour {
    rangeOption(colour.range, 'point cloud colour range');
    if (!Number.isInteger(colour.component ?? 0) || (colour.component ?? 0) < 0)
      throw rangeError('attribute component must be a nonnegative integer', 'sciviz');
    resolveColormap(colour.colormap);
    return { ...colour };
  }
  #key(node: OctreeNode, index: number, data: OctreeNodeData): RowKey {
    return this.#options.rowKey?.(node, index, data) ?? `${this.name}/${data.rowIds?.[index] ?? `${node.id}/${index}`}`;
  }
  #paint(cloud: PointCloud, entry: Resident): void {
    const { node, data } = entry,
      colour = this.#colour;
    const attr = colour.attribute ?? 'elevation',
      component = colour.component ?? 0;
    const values = data.attributes?.[attr],
      components = values ? values.length / node.count : 0;
    if (attr !== 'rgb' && attr !== 'elevation' && !values)
      throw rangeError(`Attribute ${attr} is absent from node ${node.id}`, 'sciviz');
    if (values && component >= components)
      throw rangeError(`Attribute ${attr} has no component ${component}`, 'sciviz');
    const range = colour.range ?? (attr === 'elevation' ? [this.bounds[4], this.bounds[5]] : [0, 1]);
    const table = resolveColormap(colour.colormap).table(256);
    const bytes = new Uint8Array(cloud.count * 4),
      selection = this.#options.selection;
    for (let i = 0; i < cloud.count; i++) {
      const value =
        attr === 'elevation' ? data.positions[i * 3 + 2] + this.origin[2] : values?.[i * components + component];
      const k =
        Math.round(Math.max(0, Math.min(1, ((value ?? NaN) - range[0]) / (range[1] - range[0] || 1))) * 255) * 4;
      const rgb = attr === 'rgb' ? (entry.base?.[i] ?? 0xffffffff) : null;
      const selected = selection ? selection.has(this.#key(node, i, data)) : true;
      const fade = selected ? 1 : (this.#options.fade ?? 0.12);
      for (let c = 0; c < 3; c++)
        bytes[i * 4 + c] = Math.round((rgb === null ? (table[k + c] ?? 0) * 255 : (rgb >>> (c * 8)) & 255) * fade);
      bytes[i * 4 + 3] = rgb === null ? (Number.isFinite(value) ? 255 : 0) : rgb >>> 24;
    }
    cloud.setColors(bytes, 4);
    this.#colourWrites++;
  }
  #refresh(): void {
    for (const [cloud, entry] of this.#resident) this.#paint(cloud, entry);
  }
  /** Recolours resident nodes and future loads with the same global mapping. No network reads. */
  setColour(colour: PointCloudColour): void {
    this.#check();
    const next = this.#checkedColour(colour),
      attr = next.attribute ?? 'elevation';
    for (const { data, node } of this.#resident.values()) {
      if (attr === 'rgb' || attr === 'elevation') continue;
      const values = data.attributes?.[attr];
      if (!values || (next.component ?? 0) >= values.length / node.count)
        throw rangeError(`Attribute ${attr} or its component is absent from node ${node.id}`, 'sciviz');
    }
    this.#colour = next;
    this.#refresh();
  }
  /** Updates draw and streaming budgets together. */
  setPointBudget(budget: number): void {
    this.#check();
    if (!Number.isSafeInteger(budget) || budget < Math.max(1, this.octree.source.root.count))
      throw rangeError('pointBudget must be at least the source root count', 'sciviz');
    this.octree.pointBudget = this.points.pointBudget = budget;
  }
  /** Float64 origin subtraction happens before float32 upload, retaining local survey precision. */
  setModel(model: Float32Array): void {
    const out = this.octree.matrix,
      b = this.#figure.bounds,
      o = this.origin;
    out.set(model);
    for (let r = 0; r < 3; r++)
      out[12 + r] = -(
        model[r] * ((b[0] + b[1]) / 2 - o[0]) +
        model[4 + r] * ((b[2] + b[3]) / 2 - o[1]) +
        model[8 + r] * ((b[4] + b[5]) / 2 - o[2])
      );
  }
  get stats(): Readonly<{
    drawn: number;
    loaded: number;
    loading: number;
    failed: number;
    attributeBytes: number;
    colourWrites: number;
  }> {
    let attributeBytes = 0;
    for (const { data } of this.#resident.values())
      for (const values of Object.values(data.attributes ?? {})) attributeBytes += values.byteLength;
    return { ...this.octree.stats, attributeBytes, colourWrites: this.#colourWrites };
  }
  #view() {
    const canvas = this.#figure.engine.canvas as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect?.();
    return {
      matrix: multiplyMatrices(this.#figure.engine.camera.matrix, this.octree.matrix),
      width: rect?.width || canvas.width,
      height: rect?.height || canvas.height,
    };
  }
  #pick(entry: Resident, index: number, distance: number): PointCloudPick {
    const { node, data } = entry,
      attributes: Record<string, number | readonly number[]> = {};
    for (const [name, values] of Object.entries(data.attributes ?? {})) {
      const c = values.length / node.count;
      attributes[name] = c === 1 ? values[index] : Array.from(values.subarray(index * c, (index + 1) * c));
    }
    return {
      layer: this,
      node,
      index,
      rowId: this.#key(node, index, data),
      distance,
      attributes,
      position: [0, 1, 2].map((a) => data.positions[index * 3 + a] + this.origin[a]) as [number, number, number],
    };
  }
  /** Nearest visible resident point and all its attributes, in canvas CSS pixels. */
  pick(x: number, y: number, radius = 8): PointCloudPick | null {
    this.#check();
    if (![x, y, radius].every(Number.isFinite) || radius < 0)
      throw rangeError('pick needs finite pixels and a nonnegative radius', 'sciviz');
    const { matrix, width, height } = this.#view();
    let best: PointCloudPick | null = null;
    for (const [cloud, entry] of this.#resident)
      if (cloud.visible) {
        const hit = nearestPoint(matrix, cloud.positions, width, height, x, y, radius);
        if (hit && (!best || hit.distance < best.distance)) best = this.#pick(entry, hit.index, hit.distance);
      }
    return best;
  }
  /** Selects visible resident points by rectangle or lasso. Unloaded points are never inferred. */
  select(region: SelectRegion, options: { readonly operation?: SelectionOperation } = {}): readonly RowKey[] {
    this.#check();
    const { matrix, width, height } = this.#view(),
      keys: RowKey[] = [];
    for (const [cloud, entry] of this.#resident)
      if (cloud.visible)
        for (const index of selectPoints(matrix, cloud.positions, width, height, region))
          keys.push(this.#key(entry.node, index, entry.data));
    this.#options.selection?.select(keys, { source: this.#options.selectionSource ?? this.name, ...options });
    return keys;
  }
  #check(): void {
    if (this.#disposed) throw fault('disposed', 'Point cloud layer is disposed', 'sciviz');
  }
  /** Resolves when the current camera's visible detail is loaded; rejects on load failure or abort. */
  async ready(options: { readonly signal?: AbortSignal } = {}): Promise<void> {
    for (;;) {
      this.#check();
      options.signal?.throwIfAborted();
      if (this.#error !== undefined) throw this.#error;
      const engine = this.#figure.engine;
      this.octree.select({
        position: engine.camera.position,
        planes: engine.camera.planes,
        screenHeight: engine.canvas.height || 1,
        fov: engine.camera.fov,
      });
      if (!this.octree.stats.loading) return;
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          clearTimeout(timer);
          reject(options.signal!.reason);
        };
        const timer = setTimeout(() => {
          options.signal?.removeEventListener('abort', onAbort);
          resolve();
        }, 16);
        options.signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#events.abort();
    this.octree.dispose();
    if (this.#figure.engine.hasPlugin(this.points.name)) this.#figure.engine.removePlugin(this.points.name);
    this.#resident.clear();
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}

/** Adds any points octree, COPC or Potree source to a 3D figure. */
export function pointcloud(
  figure: Figure,
  source: OctreeSource,
  options: PointCloudLayerOptions = {},
): Promise<PointCloudLayer> {
  return PointCloudLayer.create(figure, source, options);
}
/** Opens the existing points readers lazily; LAS/LAZ loads one file, then builds its in-memory octree. */
export async function openPointCloud(
  figure: Figure,
  url: string | URL,
  options: PointCloudLayerOptions & {
    readonly format: 'copc' | 'potree' | 'las' | 'laz';
    readonly fetch?: typeof fetch;
  },
): Promise<PointCloudLayer> {
  options.signal?.throwIfAborted();
  if (options.format === 'copc') {
    const { CopcSource } = await import('@margoengine/points/copc');
    const source = await CopcSource.open(url, options);
    return pointcloud(figure, source, { ...options, origin: options.origin ?? source.origin });
  }
  if (options.format === 'potree') {
    const { PotreeSource } = await import('@margoengine/points/potree');
    const source = await PotreeSource.open(url, { ...options, attributes: 'all' });
    return pointcloud(figure, source, { ...options, origin: options.origin ?? source.origin });
  }
  if (options.format !== 'las' && options.format !== 'laz') throw rangeError('Unknown point cloud format', 'sciviz');
  const response = await (options.fetch ?? globalThis.fetch)(url, { signal: options.signal });
  if (!response.ok) throw fault('failed', `Point cloud request failed: HTTP ${response.status}`, 'sciviz');
  const { parseLAS } = await import('@margoengine/points/las');
  const data = await parseLAS(new Uint8Array(await response.arrayBuffer()), {
    signal: options.signal,
    origin: options.origin,
  });
  options.signal?.throwIfAborted();
  const rgbScale = data.rgb?.some((v) => v > 255) ? 65535 : 255;
  const source = buildOctree(
    {
      positions: data.positions,
      attributes: {
        intensity: data.intensity,
        classification: data.classification,
        return_number: data.returnNumber,
        number_of_returns: data.numberOfReturns,
        scan_angle: data.scanAngle,
        point_source_id: data.pointSourceId,
        ...(data.gpsTime ? { gps_time: data.gpsTime } : {}),
        ...data.extra,
      },
      colors: data.rgb ? Float32Array.from(data.rgb, (n) => n / rgbScale) : undefined,
    },
    { grid: 16, maxPointsPerNode: 10_000 },
  );
  return pointcloud(figure, source, { ...options, origin: data.origin });
}
