/// <reference lib="esnext.disposable" preserve="true" />
// Streaming OGC 3D Tiles 1.1: tileset JSON (explicit and implicit tiling, external tilesets), screen-space-error
// selection with ADD and REPLACE refinement, optional level skipping, a priority fetch queue, a memory budget with
// least-recently-used eviction, metadata and progress events. Engine-free: content is handed to a `ContentFactory`
// (the engine renderer in renderer.ts makes gltf-pro models). Written from the OGC 3D Tiles 1.1 specification.
import { MargoError } from '@margoengine/math/errors';
import { type BoundingVolumeJSON, type TileBounds, createBounds } from './bounds.js';
import { type TileContent, contentMagic, parseContent } from './formats.js';
import {
  type ImplicitTilingJSON,
  type Subtree,
  availabilityIndex,
  expandTemplate,
  implicitBounds,
  mortonIndex,
  parseSubtree,
} from './implicit.js';
import { type TileMatrix, fromArray, identity, multiply } from './matrix.js';
import { FetchQueue, type Priority } from './queue.js';

/** How a tile's children add detail: ADD draws them on top of it, REPLACE draws them instead of it. */
export type Refine = 'ADD' | 'REPLACE';
/** Content state of a tile. */
export type TileState = 'unloaded' | 'loading' | 'ready' | 'failed';

/** What a content factory returns: something drawable with a size in bytes, shown or hidden each update. */
export interface TileRenderable {
  /** Bytes this content holds (GPU and CPU); counted against `memoryBudget`. */
  readonly bytes: number;
  /** Set by the tileset each update: true while the tile is selected for drawing. */
  visible: boolean;
  /** Frees the content; called on eviction and on `tileset.dispose()`. */
  dispose(): void;
}

/** Turns parsed content into a renderable. Throw (or reject) to fail the tile; honour `signal`. */
export type ContentFactory = (
  content: TileContent,
  tile: TilesetTile,
  signal: AbortSignal,
) => TileRenderable | Promise<TileRenderable>;

/** A metadata entity of 3D Tiles 1.1 (`tileset.metadata`, `tile.metadata`, `content.metadata`, groups). */
export interface MetadataEntity {
  class: string;
  properties?: Record<string, unknown>;
}

/** A tile JSON object (the parts this package reads). */
export interface TileJSON {
  boundingVolume: BoundingVolumeJSON;
  viewerRequestVolume?: BoundingVolumeJSON;
  geometricError: number;
  refine?: Refine;
  transform?: readonly number[];
  content?: ContentJSON;
  contents?: ContentJSON[];
  children?: TileJSON[];
  implicitTiling?: ImplicitTilingJSON;
  metadata?: MetadataEntity;
}
/** A tile content JSON object. */
export interface ContentJSON {
  uri?: string;
  /** 3D Tiles 1.0 pre-release name of `uri`. */
  url?: string;
  boundingVolume?: BoundingVolumeJSON;
  metadata?: MetadataEntity;
  group?: number;
}
/** A tileset JSON object (the parts this package reads). */
export interface TilesetJSON {
  asset: { version: string; tilesetVersion?: string };
  geometricError: number;
  root: TileJSON;
  properties?: Record<string, unknown>;
  schema?: MetadataSchema;
  schemaUri?: string;
  metadata?: MetadataEntity;
  groups?: MetadataEntity[];
  extensionsUsed?: string[];
  extensionsRequired?: string[];
}
/** A metadata schema (classes with typed properties and defaults); only `default` values are interpreted. */
export interface MetadataSchema {
  id?: string;
  classes?: Record<string, { properties?: Record<string, { type?: string; default?: unknown; required?: boolean }> }>;
  enums?: Record<string, unknown>;
}

interface ImplicitContext {
  readonly scheme: 'QUADTREE' | 'OCTREE';
  readonly subtreeLevels: number;
  readonly availableLevels: number;
  readonly subtreeTemplate: string;
  readonly contentTemplates: readonly string[];
  readonly base: string;
  readonly rootBounds: TileBounds;
  readonly rootError: number;
  readonly refine: Refine;
  readonly transform: TileMatrix;
  readonly subtrees: Map<string, Subtree>;
}

/** One tile of the tree. Explicit tiles come from JSON; implicit ones are created as their subtrees arrive. */
export class TilesetTile {
  /** Unique within the tileset: the content URL, or the JSON path / implicit coordinates. */
  readonly id: string;
  readonly parent: TilesetTile | null;
  /** Children known so far (implicit and external children appear once their subtree or tileset has loaded). */
  children: TilesetTile[] = [];
  /** Depth from the tileset root (external tileset roots continue the count). */
  readonly depth: number;
  readonly geometricError: number;
  readonly refine: Refine;
  /** Computed transform: every ancestor's `transform` times this one's, float64, tileset coordinates. */
  readonly transform: TileMatrix;
  readonly bounds: TileBounds;
  readonly contentBounds?: TileBounds;
  readonly viewerRequestVolume?: TileBounds;
  /** Absolute content URLs (3D Tiles 1.1 allows several); empty for an empty tile. */
  readonly contentUrls: readonly string[];
  /** `tile.metadata`, and per content `content.metadata` and `content.group`. */
  readonly metadata?: MetadataEntity;
  readonly contentMetadata: readonly (MetadataEntity | undefined)[];
  readonly contentGroups: readonly (number | undefined)[];
  /** Implicit coordinates (level, x, y, z) for implicit tiles. */
  readonly implicit?: { readonly level: number; readonly x: number; readonly y: number; readonly z: number };
  state: TileState = 'unloaded';
  /** True once its content turned out to be an external tileset (its child is that tileset's root). */
  external = false;
  /** Parsed contents while ready. */
  contents: TileContent[] = [];
  renderable?: TileRenderable;
  /** Why the last load failed. */
  error?: Error;
  /** Selection values of the last update: distance from the camera and screen-space error in pixels. */
  distance = Infinity;
  screenSpaceError = 0;
  /** Last update that drew or needed this tile. */
  lastUsed = -1;
  /** @internal */
  context?: ImplicitContext;
  /** @internal */
  expanded = false;
  constructor(init: {
    id: string;
    parent: TilesetTile | null;
    geometricError: number;
    refine: Refine;
    transform: TileMatrix;
    bounds: TileBounds;
    contentBounds?: TileBounds;
    viewerRequestVolume?: TileBounds;
    contentUrls: readonly string[];
    metadata?: MetadataEntity;
    contentMetadata?: readonly (MetadataEntity | undefined)[];
    contentGroups?: readonly (number | undefined)[];
    implicit?: { level: number; x: number; y: number; z: number };
    context?: ImplicitContext;
  }) {
    this.id = init.id;
    this.parent = init.parent;
    this.depth = init.parent ? init.parent.depth + 1 : 0;
    this.geometricError = init.geometricError;
    this.refine = init.refine;
    this.transform = init.transform;
    this.bounds = init.bounds;
    this.contentBounds = init.contentBounds;
    this.viewerRequestVolume = init.viewerRequestVolume;
    this.contentUrls = init.contentUrls;
    this.metadata = init.metadata;
    this.contentMetadata = init.contentMetadata ?? [];
    this.contentGroups = init.contentGroups ?? [];
    this.implicit = init.implicit;
    this.context = init.context;
  }
  /** True when the tile has content to load (an empty tile only groups its children). */
  get hasContent(): boolean {
    return this.contentUrls.length > 0 && !this.external;
  }
}

/** The camera, in tileset coordinates, for one update. */
export interface TilesView {
  /** Camera position, tileset (usually ECEF) coordinates. */
  readonly position: ArrayLike<number>;
  /** 6 frustum planes [a, b, c, d] (a x + b y + c z + d >= 0 inside), tileset coordinates. Omit to keep every tile. */
  readonly planes?: ArrayLike<number>;
  /** Drawing-buffer height in pixels. */
  readonly screenHeight: number;
  /** Vertical field of view in degrees (perspective). Default 60. */
  readonly fov?: number;
  /** World height the view shows, for orthographic cameras (screen-space error then ignores distance). */
  readonly orthographicHeight?: number;
}

/** Options of `Tileset.load` and `Tileset.from`. */
export interface TilesetOptions {
  /** Fetch to use (a custom one serves tests, auth headers or an offline cache). Default `globalThis.fetch`. */
  fetch?: (input: string, init?: { signal?: AbortSignal }) => Promise<Response>;
  /** Aborts the tileset load, every request, and makes the tileset stop requesting. */
  signal?: AbortSignal;
  /** Refine while a tile's screen-space error is above this many pixels. Default 16. */
  maximumScreenSpaceError?: number;
  /** Requests in flight at once. Default 6. */
  maxConcurrentRequests?: number;
  /** Bytes of ready content to keep; least recently used tiles outside the view are evicted past it. Default 512 MiB. */
  memoryBudget?: number;
  /**
   * Skip levels of detail: do not load REPLACE ancestors whose error is more than `skipScreenSpaceErrorFactor` times the
   * target, so the view fills in at its final detail sooner (holes show until it does). Default false.
   */
  skipLevelOfDetail?: boolean;
  /** See `skipLevelOfDetail`. Default 16. */
  skipScreenSpaceErrorFactor?: number;
  /** Makes renderables from parsed content. Default: keep the parsed content only (bytes = content size). */
  content?: ContentFactory;
}

/** Counts reported by `progress` and `idle` events and `tileset.progress`. */
export interface TilesProgress {
  /** Requests waiting. */
  readonly queued: number;
  /** Requests in flight. */
  readonly loading: number;
  /** Tiles with content ready. */
  readonly ready: number;
  /** Tiles whose last load failed. */
  readonly failed: number;
  /** Tiles selected for drawing in the last update. */
  readonly selected: number;
  /** Bytes of ready content, and the budget. */
  readonly bytes: number;
  readonly memoryBudget: number;
}

/** Events of a `Tileset`. */
export interface TilesetEvents {
  tileload: { tile: TilesetTile };
  tileunload: { tile: TilesetTile };
  error: { tile?: TilesetTile; error: Error };
  progress: TilesProgress;
  /** After an update that left nothing queued or loading (the view is complete). */
  idle: TilesProgress;
}

/** Result of `tileset.update`. */
export interface TilesFrame {
  /** Tiles drawn this update, in traversal order. */
  readonly selected: readonly TilesetTile[];
  /** Tiles wanted but not ready (queued or loading). */
  readonly pending: number;
}

const DEFAULT_BUDGET = 512 * 1024 * 1024;

function resolveUrl(uri: string, base: string): string {
  try {
    return new URL(uri, base).href;
  } catch {
    throw new TypeError(
      `Cannot resolve tile URI ${JSON.stringify(uri)} against ${base}; give absolute URLs or a tileset URL`,
    );
  }
}

function checkNumber(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw new TypeError(`Invalid ${what}; it must be a finite number of 0 or more`);
  return value;
}

/** A streaming 3D Tiles tileset. Call `update(view)` every frame; it selects, requests, shows and evicts tiles. */
export class Tileset {
  readonly url: string;
  readonly json: TilesetJSON;
  readonly root: TilesetTile;
  /** Tileset metadata schema, when the tileset has one (inline or from `schemaUri`). */
  readonly schema?: MetadataSchema;
  /** `tileset.metadata`. */
  readonly metadata?: MetadataEntity;
  /** `tileset.groups`. */
  readonly groups: readonly MetadataEntity[];
  maximumScreenSpaceError: number;
  memoryBudget: number;
  skipLevelOfDetail: boolean;
  skipScreenSpaceErrorFactor: number;
  /** Bytes of ready content now. */
  bytes = 0;
  /** True after an update where the visible tiles alone passed `memoryBudget` (refinement then waits). */
  overBudget = false;
  disposed = false;
  private readonly fetcher: NonNullable<TilesetOptions['fetch']>;
  private readonly queue: FetchQueue;
  private readonly controller = new AbortController();
  private readonly factory?: ContentFactory;
  private readonly listeners = new Map<keyof TilesetEvents, Set<(event: never) => void>>();
  private readonly ready = new Set<TilesetTile>();
  private readonly failed = new Set<TilesetTile>();
  private readonly failedSubtrees = new Map<string, Error>();
  private frame = 0;
  private shown: TilesetTile[] = [];
  private pending = 0;
  private wasIdle = false;

  /** Fetches tileset JSON (and its `schemaUri`) and returns the tileset. Aborts with `options.signal`. */
  static async load(url: string | URL, options: TilesetOptions = {}): Promise<Tileset> {
    const href = String(url),
      fetcher = options.fetch ?? globalThis.fetch?.bind(globalThis);
    if (!fetcher) throw new MargoError('unsupported', 'No fetch available; pass options.fetch');
    const json = await fetchJSON(fetcher, href, options.signal);
    let schema: MetadataSchema | undefined;
    if (json && typeof json === 'object' && typeof (json as TilesetJSON).schemaUri === 'string')
      schema = (await fetchJSON(
        fetcher,
        resolveUrl((json as TilesetJSON).schemaUri!, href),
        options.signal,
      )) as MetadataSchema;
    return new Tileset(json, href, options, schema);
  }
  /** A tileset from JSON already in memory; relative URIs resolve against `url`. */
  static from(json: unknown, url: string | URL, options: TilesetOptions = {}): Tileset {
    return new Tileset(json, String(url), options);
  }
  private constructor(json: unknown, url: string, options: TilesetOptions, schema?: MetadataSchema) {
    this.url = url;
    this.json = checkTileset(json, url);
    this.fetcher = options.fetch ?? globalThis.fetch?.bind(globalThis);
    if (!this.fetcher) throw new MargoError('unsupported', 'No fetch available; pass options.fetch');
    this.maximumScreenSpaceError = checkNumber(options.maximumScreenSpaceError ?? 16, 'maximumScreenSpaceError');
    this.memoryBudget = checkNumber(options.memoryBudget ?? DEFAULT_BUDGET, 'memoryBudget');
    this.skipLevelOfDetail = options.skipLevelOfDetail ?? false;
    this.skipScreenSpaceErrorFactor = checkNumber(
      options.skipScreenSpaceErrorFactor ?? 16,
      'skipScreenSpaceErrorFactor',
    );
    this.factory = options.content;
    if (options.signal) {
      if (options.signal.aborted) this.controller.abort(options.signal.reason);
      else
        options.signal.addEventListener('abort', () => this.controller.abort(options.signal!.reason), { once: true });
    }
    this.queue = new FetchQueue({ maxConcurrent: options.maxConcurrentRequests ?? 6, signal: this.controller.signal });
    this.schema = schema ?? this.json.schema;
    this.metadata = this.json.metadata;
    this.groups = this.json.groups ?? [];
    this.root = this.buildTile(this.json.root, null, identity(), url, 'root', 'REPLACE');
  }

  /** Subscribes to an event; returns the unsubscribe function. */
  on<K extends keyof TilesetEvents>(type: K, listener: (event: TilesetEvents[K]) => void): () => void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(listener as (event: never) => void);
    return () => set.delete(listener as (event: never) => void);
  }
  private emit<K extends keyof TilesetEvents>(type: K, event: TilesetEvents[K]): void {
    for (const listener of this.listeners.get(type) ?? []) (listener as (event: TilesetEvents[K]) => void)(event);
  }

  /** Current counts (the payload of `progress`). */
  get progress(): TilesProgress {
    return {
      queued: this.queue.queued,
      loading: this.queue.inFlight,
      ready: this.ready.size,
      failed: this.failed.size,
      selected: this.shown.length,
      bytes: this.bytes,
      memoryBudget: this.memoryBudget,
    };
  }

  /** Every tile known so far, depth first. */
  *tiles(): IterableIterator<TilesetTile> {
    const stack = [this.root];
    while (stack.length) {
      const tile = stack.pop()!;
      yield tile;
      for (let i = tile.children.length - 1; i >= 0; i--) stack.push(tile.children[i]);
    }
  }

  /** A metadata entity's properties with the schema's `default` values filled in for properties it leaves out. */
  properties(entity: MetadataEntity | undefined): Record<string, unknown> {
    if (!entity) return {};
    const out: Record<string, unknown> = {},
      definition = this.schema?.classes?.[entity.class]?.properties ?? {};
    for (const [name, property] of Object.entries(definition))
      if (property.default !== undefined) out[name] = property.default;
    return Object.assign(out, entity.properties);
  }

  /** Screen-space error in pixels of an error in metres at a distance, for a view. */
  static screenSpaceError(geometricError: number, distance: number, view: TilesView): number {
    if (view.orthographicHeight !== undefined) return (geometricError * view.screenHeight) / view.orthographicHeight;
    if (distance <= 0) return geometricError > 0 ? Infinity : 0;
    const fov = ((view.fov ?? 60) * Math.PI) / 180;
    return (geometricError * view.screenHeight) / (2 * distance * Math.tan(fov / 2));
  }

  /**
   * Selects the tiles to draw for a view, shows them, hides the rest, queues missing content by priority, evicts past
   * the memory budget and emits `progress` (and `idle` once nothing is pending).
   */
  update(view: TilesView): TilesFrame {
    if (this.disposed) throw new MargoError('disposed', 'Tileset is disposed; load a new Tileset');
    if (!(view.screenHeight > 0))
      throw new RangeError('Invalid view.screenHeight; pass the drawing-buffer height in pixels');
    if (view.planes !== undefined && view.planes.length < 24)
      throw new RangeError('Invalid view.planes; pass 24 numbers (6 planes)');
    this.frame++;
    this.queue.begin();
    this.pending = 0;
    const selected: TilesetTile[] = [];
    this.visit(this.root, view, selected);
    const drawn = new Set(selected);
    for (const tile of this.shown) if (!drawn.has(tile) && tile.renderable) tile.renderable.visible = false;
    for (const tile of selected) if (tile.renderable) tile.renderable.visible = true;
    this.shown = selected;
    this.evict();
    this.overBudget = this.bytes > this.memoryBudget;
    if (!this.controller.signal.aborted) this.queue.flush();
    const progress = this.progress;
    this.emit('progress', progress);
    const idle = this.pending === 0 && progress.queued === 0 && progress.loading === 0;
    if (idle && !this.wasIdle) this.emit('idle', progress);
    this.wasIdle = idle;
    return { selected, pending: this.pending };
  }

  /** Forgets failed loads so the next update requests them again (after a network error is fixed). */
  retry(): void {
    for (const tile of this.failed) {
      tile.state = 'unloaded';
      tile.error = undefined;
    }
    this.failed.clear();
    this.failedSubtrees.clear();
  }

  /** Aborts every request and frees every renderable. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.controller.abort(new DOMException('Tileset disposed', 'AbortError'));
    this.queue.clear();
    for (const tile of [...this.ready]) this.unload(tile);
    this.listeners.clear();
  }
  [Symbol.dispose](): void {
    this.dispose();
  }

  // Returns true when the tile's part of the view is covered: drawn by it or its descendants, or nothing to draw.
  private visit(tile: TilesetTile, view: TilesView, selected: TilesetTile[]): boolean {
    const distance = tile.bounds.distanceTo(view.position);
    tile.distance = distance;
    if (view.planes && !tile.bounds.intersectsFrustum(view.planes)) return true;
    if (tile.viewerRequestVolume && !tile.viewerRequestVolume.contains(view.position)) return true;
    const sse = Tileset.screenSpaceError(tile.geometricError, distance, view);
    tile.screenSpaceError = sse;
    // Implicit tiles need their subtree before their content availability and children are known.
    if (tile.context && !this.expand(tile)) return false;
    // An external tileset loads before it can refine; the tile itself draws nothing.
    if (tile.contentUrls.length && !tile.external && tile.state !== 'ready' && this.mightBeTileset(tile)) {
      this.want(tile, [0, tile.depth]);
      return false;
    }
    const content = tile.hasContent,
      contentVisible =
        !content || !tile.contentBounds || !view.planes || tile.contentBounds.intersectsFrustum(view.planes);
    const refine = tile.children.length > 0 && (sse > this.maximumScreenSpaceError || !content || tile.external);
    if (!refine) {
      if (!content || !contentVisible) return true;
      this.want(tile, [1, distance]);
      if (tile.state === 'ready') {
        this.draw(tile, selected);
        return true;
      }
      return false;
    }
    if (tile.refine === 'ADD') {
      if (content && contentVisible) {
        this.want(tile, [0, tile.depth]);
        if (tile.state === 'ready') this.draw(tile, selected);
      }
      for (const child of tile.children) this.visit(child, view, selected);
      return !content || !contentVisible || tile.state === 'ready';
    }
    const mark = selected.length;
    const fallback =
      content &&
      contentVisible &&
      (!this.skipLevelOfDetail || sse <= this.maximumScreenSpaceError * this.skipScreenSpaceErrorFactor);
    if (fallback) this.want(tile, [0, tile.depth]);
    let covered = true;
    for (const child of tile.children) covered = this.visit(child, view, selected) && covered;
    if (covered) return true;
    if (content && contentVisible && tile.state === 'ready') {
      // A child is still missing: draw this tile instead of a partial set of descendants (no holes, no overlap).
      selected.length = mark;
      this.draw(tile, selected);
      return true;
    }
    return false;
  }

  private mightBeTileset(tile: TilesetTile): boolean {
    // Content URIs ending in .json are tilesets (the specification's convention); others are sniffed after fetching.
    return tile.contentUrls.length === 1 && /\.json($|[?#])/i.test(tile.contentUrls[0]);
  }

  // Drawn and wanted tiles are "used" this update and never evicted by it; ready tiles merely passed through (a
  // REPLACE parent whose children all drew) are not, so LRU eviction can free them first.
  private draw(tile: TilesetTile, selected: TilesetTile[]): void {
    tile.lastUsed = this.frame;
    selected.push(tile);
  }

  private want(tile: TilesetTile, priority: Priority): void {
    tile.lastUsed = this.frame;
    if (tile.state === 'ready') return;
    if (tile.state === 'failed') return;
    // Past the budget only hole-filling loads (group 0) start; refinement waits until eviction frees memory.
    if (this.overBudget && priority[0] === 1) return;
    this.pending++;
    this.queue.want(tile.id, priority, (signal) => this.loadTile(tile, signal));
  }

  /** Fetches bytes with this tileset's fetch (auth headers, caches); a non-OK answer throws code `failed`. */
  fetchBytes(url: string, signal?: AbortSignal): Promise<Uint8Array> {
    return fetchBytes(this.fetcher, url, signal);
  }
  private async loadTile(tile: TilesetTile, signal: AbortSignal): Promise<void> {
    tile.state = 'loading';
    const created: TileRenderable[] = [];
    try {
      const contents: TileContent[] = [];
      for (const url of tile.contentUrls) {
        const bytes = await fetchBytes(this.fetcher, url, signal);
        if (contentMagic(bytes) === 'json') {
          const json = parseJSONBytes(bytes, url);
          if (json && typeof json === 'object' && 'root' in json) {
            if (tile.contentUrls.length !== 1)
              throw new TypeError('A tile with several contents cannot hold an external tileset; give it one content');
            this.attachExternal(tile, json, url);
            return;
          }
        }
        contents.push(parseContent(bytes));
      }
      signal.throwIfAborted();
      for (const content of contents) {
        if (!this.factory) continue;
        created.push(await this.factory(content, tile, signal));
        signal.throwIfAborted();
      }
      if (this.disposed) throw new DOMException('Tileset disposed', 'AbortError');
      tile.contents = contents;
      tile.renderable = this.factory ? group(created) : dataOnly(contents);
      tile.renderable.visible = false;
      tile.state = 'ready';
      this.ready.add(tile);
      this.bytes += tile.renderable.bytes;
      this.emit('tileload', { tile });
    } catch (error) {
      for (const renderable of created) renderable.dispose();
      if (signal.aborted || (error as Error)?.name === 'AbortError') {
        tile.state = 'unloaded';
        return;
      }
      this.fail(tile, error);
    }
  }

  private fail(tile: TilesetTile, error: unknown): void {
    const cause = error instanceof Error ? error.message : String(error);
    // An unsupported format keeps its own fix; anything else (network, parse, factory) names the retry.
    const failure =
      error instanceof MargoError && error.code === 'unsupported'
        ? error
        : new MargoError(
            'failed',
            `Tile ${tile.id} failed to load (${cause}); fix the file or the server, then call tileset.retry()`,
          );
    tile.state = 'failed';
    tile.error = failure;
    this.failed.add(tile);
    this.emit('error', { tile, error: failure });
  }

  private attachExternal(tile: TilesetTile, json: unknown, url: string): void {
    const external = checkTileset(json, url);
    tile.children = [this.buildTile(external.root, tile, tile.transform, url, `${url}#root`, tile.refine)];
    tile.external = true;
    tile.state = 'ready';
  }

  private unload(tile: TilesetTile): void {
    if (!tile.renderable) return;
    this.bytes -= tile.renderable.bytes;
    tile.renderable.dispose();
    tile.renderable = undefined;
    tile.contents = [];
    tile.state = 'unloaded';
    this.ready.delete(tile);
    this.emit('tileunload', { tile });
  }

  private evict(): void {
    if (this.bytes <= this.memoryBudget) return;
    const candidates = [...this.ready].filter((tile) => tile.lastUsed !== this.frame);
    candidates.sort((a, b) => a.lastUsed - b.lastUsed || b.depth - a.depth);
    for (const tile of candidates) {
      if (this.bytes <= this.memoryBudget) break;
      this.unload(tile);
    }
  }

  private buildTile(
    json: TileJSON,
    parent: TilesetTile | null,
    parentTransform: TileMatrix,
    base: string,
    path: string,
    inherited: Refine,
  ): TilesetTile {
    if (!json || typeof json !== 'object') throw new TypeError(`Invalid tile at ${path}; it must be an object`);
    const geometricError = checkNumber(json.geometricError, `${path}.geometricError`);
    if (json.refine !== undefined && json.refine !== 'ADD' && json.refine !== 'REPLACE')
      throw new TypeError(`Invalid ${path}.refine ${JSON.stringify(json.refine)}; use "ADD" or "REPLACE"`);
    const refine = json.refine ?? inherited;
    if (
      json.transform !== undefined &&
      (!Array.isArray(json.transform) || json.transform.length !== 16 || !json.transform.every(Number.isFinite))
    )
      throw new TypeError(`Invalid ${path}.transform; give 16 finite numbers (column-major)`);
    const transform = json.transform
      ? multiply(parentTransform, fromArray(json.transform))
      : Float64Array.from(parentTransform);
    const contents = json.contents ?? (json.content ? [json.content] : []);
    const urls = contents.map((c, i) => {
      const uri = c?.uri ?? c?.url;
      if (typeof uri !== 'string')
        throw new TypeError(`Invalid ${path}.content${contents.length > 1 ? `s[${i}]` : ''}; give it a uri`);
      return uri;
    });
    const bounds = createBounds(json.boundingVolume, transform);
    if (json.implicitTiling) {
      const it = json.implicitTiling;
      if (it.subdivisionScheme !== 'QUADTREE' && it.subdivisionScheme !== 'OCTREE')
        throw new TypeError(`Invalid ${path}.implicitTiling.subdivisionScheme; use "QUADTREE" or "OCTREE"`);
      // 3DTILES_implicit_tiling (the 1.0 extension) named it maximumLevel, one less than availableLevels.
      const available = it.availableLevels ?? (it as { maximumLevel?: number }).maximumLevel! + 1;
      if (!Number.isInteger(it.subtreeLevels) || it.subtreeLevels < 1 || !Number.isInteger(available) || available < 1)
        throw new TypeError(
          `Invalid ${path}.implicitTiling; subtreeLevels and availableLevels must be whole numbers of 1 or more`,
        );
      if (typeof it.subtrees?.uri !== 'string')
        throw new TypeError(`Invalid ${path}.implicitTiling.subtrees; give a uri template`);
      const context: ImplicitContext = {
        scheme: it.subdivisionScheme,
        subtreeLevels: it.subtreeLevels,
        availableLevels: available,
        subtreeTemplate: it.subtrees.uri,
        contentTemplates: urls,
        base,
        rootBounds: bounds,
        rootError: geometricError,
        refine,
        transform,
        subtrees: new Map(),
      };
      return new TilesetTile({
        id: `${base}#${path}/0/0/0/0`,
        parent,
        geometricError,
        refine,
        transform,
        bounds,
        contentUrls: [],
        metadata: json.metadata,
        implicit: { level: 0, x: 0, y: 0, z: 0 },
        context,
      });
    }
    const tile = new TilesetTile({
      id: urls.length ? resolveUrl(urls[0], base) : `${base}#${path}`,
      parent,
      geometricError,
      refine,
      transform,
      bounds,
      contentBounds: contents[0]?.boundingVolume ? createBounds(contents[0].boundingVolume, transform) : undefined,
      viewerRequestVolume: json.viewerRequestVolume ? createBounds(json.viewerRequestVolume, transform) : undefined,
      contentUrls: urls.map((u) => resolveUrl(u, base)),
      metadata: json.metadata,
      contentMetadata: contents.map((c) => c.metadata),
      contentGroups: contents.map((c) => c.group),
    });
    if (json.children !== undefined && !Array.isArray(json.children))
      throw new TypeError(`Invalid ${path}.children; it must be an array`);
    tile.children = (json.children ?? []).map((child, i) =>
      this.buildTile(child, tile, transform, base, `${path}.children[${i}]`, refine),
    );
    return tile;
  }

  // Implicit tiles: ensures the tile's subtree is loaded (requesting it if not), then fills in its content URLs
  // and children once. Returns false while the subtree is missing.
  private expand(tile: TilesetTile): boolean {
    if (tile.expanded) return true;
    const context = tile.context!,
      { level, x, y, z } = tile.implicit!,
      octree = context.scheme === 'OCTREE',
      local = level % context.subtreeLevels,
      rootLevel = level - local,
      rx = x >> local,
      ry = y >> local,
      rz = z >> local,
      key = `${rootLevel}/${rx}/${ry}/${rz}`,
      subtree = context.subtrees.get(key);
    if (!subtree) {
      const failure = this.failedSubtrees.get(key);
      if (failure) return false;
      const url = resolveUrl(expandTemplate(context.subtreeTemplate, rootLevel, rx, ry, rz), context.base);
      this.pending++;
      this.queue.want(`subtree:${url}`, [0, tile.depth - 0.5], async (signal) => {
        try {
          const bytes = await fetchBytes(this.fetcher, url, signal);
          context.subtrees.set(
            key,
            await parseSubtree(bytes, context.scheme, context.subtreeLevels, (uri) =>
              fetchBytes(this.fetcher, resolveUrl(uri, url), signal),
            ),
          );
        } catch (error) {
          if (signal.aborted || (error as Error)?.name === 'AbortError') return;
          const failure = new MargoError(
            'failed',
            `Subtree ${url} failed to load (${error instanceof Error ? error.message : String(error)}); fix the file or the server, then call tileset.retry()`,
          );
          this.failedSubtrees.set(key, failure);
          this.emit('error', { tile, error: failure });
        }
      });
      return false;
    }
    const lx = x - (rx << local),
      ly = y - (ry << local),
      lz = z - (rz << local),
      index = availabilityIndex(local, lx, ly, octree ? lz : undefined);
    const urls = context.contentTemplates
      .filter((_, i) => subtree.contents[i]?.get(index))
      .map((template) => resolveUrl(expandTemplate(template, level, x, y, z), context.base));
    (tile as { contentUrls: readonly string[] }).contentUrls = urls;
    if (urls.length) (tile as { id: string }).id = urls[0];
    const children: TilesetTile[] = [];
    if (level + 1 < context.availableLevels) {
      for (let i = 0; i < (octree ? 8 : 4); i++) {
        const cx = 2 * x + (i & 1),
          cy = 2 * y + ((i >> 1) & 1),
          cz = octree ? 2 * z + ((i >> 2) & 1) : 0;
        const available =
          local + 1 < context.subtreeLevels
            ? subtree.tiles.get(
                availabilityIndex(
                  local + 1,
                  2 * lx + (i & 1),
                  2 * ly + ((i >> 1) & 1),
                  octree ? 2 * lz + ((i >> 2) & 1) : undefined,
                ),
              )
            : subtree.childSubtrees.get(
                mortonIndex(
                  cx - (rx << (local + 1)),
                  cy - (ry << (local + 1)),
                  octree ? cz - (rz << (local + 1)) : undefined,
                ),
              );
        if (!available) continue;
        children.push(
          new TilesetTile({
            id: `${context.base}#implicit/${level + 1}/${cx}/${cy}/${cz}`,
            parent: tile,
            geometricError: context.rootError / 2 ** (level + 1),
            refine: context.refine,
            transform: context.transform,
            bounds: implicitBounds(context.rootBounds, context.scheme, level + 1, cx, cy, cz),
            contentUrls: [],
            implicit: { level: level + 1, x: cx, y: cy, z: cz },
            context,
          }),
        );
      }
    }
    tile.children = children;
    tile.expanded = true;
    return true;
  }
}

function group(renderables: TileRenderable[]): TileRenderable {
  if (renderables.length === 1) return renderables[0];
  let visible = false;
  return {
    bytes: renderables.reduce((sum, r) => sum + r.bytes, 0),
    get visible() {
      return visible;
    },
    set visible(value: boolean) {
      visible = value;
      for (const r of renderables) r.visible = value;
    },
    dispose: () => {
      for (const r of renderables) r.dispose();
    },
  };
}

function dataOnly(contents: TileContent[]): TileRenderable {
  return { bytes: contents.reduce((sum, c) => sum + c.byteLength, 0), visible: false, dispose: () => undefined };
}

async function fetchBytes(
  fetcher: NonNullable<TilesetOptions['fetch']>,
  url: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  signal?.throwIfAborted();
  const response = await fetcher(url, { signal });
  if (!response.ok)
    throw new MargoError('failed', `GET ${url} answered ${response.status}; check the URL and the server`);
  return new Uint8Array(await response.arrayBuffer());
}

async function fetchJSON(
  fetcher: NonNullable<TilesetOptions['fetch']>,
  url: string,
  signal?: AbortSignal,
): Promise<unknown> {
  return parseJSONBytes(await fetchBytes(fetcher, url, signal), url);
}

const utf8 = /* @__PURE__ */ new TextDecoder();
function parseJSONBytes(bytes: Uint8Array, url: string): unknown {
  try {
    return JSON.parse(utf8.decode(bytes));
  } catch (error) {
    throw new TypeError(`Invalid JSON at ${url} (${(error as Error).message}); fix the tileset file`);
  }
}

function checkTileset(json: unknown, url: string): TilesetJSON {
  if (!json || typeof json !== 'object') throw new TypeError(`Invalid tileset ${url}; it must be a JSON object`);
  const t = json as TilesetJSON;
  if (!t.asset || typeof t.asset.version !== 'string')
    throw new TypeError(`Invalid tileset ${url}: asset.version is missing; add "asset": {"version": "1.1"}`);
  if (!t.root || typeof t.root !== 'object')
    throw new TypeError(`Invalid tileset ${url}: root is missing; add a root tile`);
  checkNumber(t.geometricError, `${url} geometricError`);
  const known = new Set([
    '3DTILES_implicit_tiling',
    '3DTILES_metadata',
    '3DTILES_content_gltf',
    '3DTILES_multiple_contents',
  ]);
  for (const name of t.extensionsRequired ?? [])
    if (!known.has(name))
      throw new MargoError(
        'unsupported',
        `Tileset ${url} requires extension ${name}, which this loader does not implement; use a tileset without it`,
      );
  return t;
}
