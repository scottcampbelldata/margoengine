/// <reference lib="esnext.disposable" preserve="true" />
// Draws a streaming 3D Tiles tileset with the engine: glTF / GLB / b3dm content becomes @margoengine/gltf-pro models,
// pnts content becomes @margoengine/points clouds; both are optional peers loaded with import() on the first tile
// that needs them. Tileset coordinates (ECEF, z-up, float64) map to the engine's y-up float32 world through a
// float64 frame matrix; see the README's "Coordinates and precision".
import type { EngineKernel, EnginePlugin, Mesh, Vec3 } from '@margoengine/core';
import { MargoError } from '@margoengine/math/errors';
import { type MeasurableModel, modelGpuBytes } from './memory.js';
import type { InstancesContent, ModelContent, PointsContent, TileContent } from './formats.js';
import {
  type TileMatrix,
  Y_UP_TO_Z_UP,
  Z_UP_TO_Y_UP,
  decompose,
  invert,
  multiply,
  transformPoint,
  translation,
} from './matrix.js';
import { type TilesetTile, type TileRenderable, Tileset, type TilesetOptions, type TilesFrame } from './tileset.js';
import { cartographicToEcef, eastNorthUpToEcef } from './wgs84.js';

/** Optional content decoration owned and disposed with its tile. Bytes are added to the tile budget. */
export interface TilesContentDecoration {
  readonly bytes: number;
  dispose(): void;
}
/** A loaded content item exposed to an optional decorator, before the tile becomes visible. */
export type TilesDecorationContext = {
  signal?: AbortSignal;
  fetch?: (url: string, signal: AbortSignal) => Promise<Uint8Array>;
} & (
  | { kind: 'model'; model: TilesModel; content: ModelContent; tile: TilesetTile }
  | { kind: 'points'; cloud: unknown; content: PointsContent; tile: TilesetTile }
  | { kind: 'instances'; model: TilesModel; content: InstancesContent; tile: TilesetTile }
);
/** Optional entry hook for feature styling and selection. No optional implementation is imported by tiles root. */
export type TilesContentDecorator = (
  context: TilesDecorationContext,
) => TilesContentDecoration | Promise<TilesContentDecoration>;

/** A floating origin (such as `FloatingOrigin` from `@margoengine/cameras/origin`): float64 placement around the camera. */
export interface TilesOrigin {
  /** Places a root mesh at a float64 world position and keeps it there across rebases. */
  place(mesh: Mesh, world: ArrayLike<number>): void;
  /** Stops tracking a mesh. */
  forget(mesh: Mesh): void;
  /** Float64 world position of local [0, 0, 0]. */
  readonly origin: Vec3;
  /** Float64 world position of the camera. */
  readonly cameraPosition: Vec3;
}

/** The part of a gltf-pro model the renderer uses. */
export interface TilesModel {
  readonly root: Mesh;
  dispose(): void;
}

/** What a content drawer (such as `i3dm` from `@margoengine/tiles/i3dm`) gets from the renderer. */
export interface TilesContentHost {
  /** Decorates content using the renderer option, if provided. */
  decorate(context: TilesDecorationContext): TilesContentDecoration | Promise<TilesContentDecoration> | undefined;
  readonly engine: EngineKernel;
  /** The tileset JSON's URL. */
  readonly url: string;
  /** Loads a glTF / GLB with the renderer's `loadModel`. */
  loadModel(gltf: Uint8Array, signal: AbortSignal): Promise<TilesModel>;
  /** Places a root mesh at a float64 world matrix (through the floating origin when there is one). */
  place(mesh: Mesh, matrix: TileMatrix): void;
  /** Stops a floating origin tracking a mesh placed with `place`. */
  forget(mesh: Mesh): void;
  /** frame x tile transform x RTC (x y-up to z-up when `gltf`), float64. */
  contentMatrix(tile: TilesetTile, rtc?: readonly number[], gltf?: boolean): TileMatrix;
  /** Fetches bytes with the tileset's own fetch and signal. */
  fetch(url: string, signal: AbortSignal): Promise<Uint8Array>;
  /** What the memory budget counts (the renderer's `budget` option). */
  readonly budget: 'gpu' | 'content';
  /** Bytes a tile's model counts against the memory budget: its GPU bytes (`budget: 'gpu'`) or `fileBytes`. */
  measure(model: TilesModel, fileBytes: number): number;
  /** Calls `listener` at the end of every selection update (after tile visibility is set); returns the unsubscribe. */
  onUpdate(listener: () => void): () => void;
  /** Float64 world position of engine-local [0, 0, 0]: the floating origin's, or [0, 0, 0] without one. */
  offset(): Vec3;
}

/** Draws glTF content of a kind the default model path does not, such as `splats` from `@margoengine/tiles/splats`. */
export type TilesModelDrawer = (
  host: TilesContentHost,
  content: ModelContent,
  tile: TilesetTile,
  signal: AbortSignal,
) => Promise<TileRenderable>;

/** True when glTF / GLB / b3dm content holds Gaussian splats (KHR_gaussian_splatting in its glTF JSON). */
export function holdsSplats(content: ModelContent): boolean {
  const bytes = content.gltf;
  let json = bytes;
  // GLB: 12-byte header, then the JSON chunk's length and type, then the JSON.
  if (bytes.byteLength >= 20 && bytes[0] === 0x67 && bytes[1] === 0x6c && bytes[2] === 0x54 && bytes[3] === 0x46) {
    const length = new DataView(bytes.buffer, bytes.byteOffset + 12, 4).getUint32(0, true);
    json = bytes.subarray(20, Math.min(bytes.byteLength, 20 + length));
  }
  return new TextDecoder().decode(json).includes('"KHR_gaussian_splatting"');
}

/** Draws Instanced 3D Model (i3dm) content; `i3dm` from `@margoengine/tiles/i3dm` is one. */
export type TilesInstancesDrawer = (
  host: TilesContentHost,
  content: InstancesContent,
  tile: TilesetTile,
  signal: AbortSignal,
) => Promise<TileRenderable>;

/** Options of `TilesRenderer.load`. */
export interface TilesRendererOptions extends Omit<TilesetOptions, 'content'> {
  /** Optional content decoration, for example `style.decorate` from tiles/style. Default: none. */
  decorate?: TilesContentDecorator;
  /**
   * Tileset to world: `'enu'` (default) puts the east-north-up frame at the root volume's centre at the world origin
   * (x east, y up, -z north), so city-scale data stays within a few kilometres of 0; `'local'` only turns z-up into
   * y-up (for tilesets in local metres); or a column-major 4x4 matrix of your own. ENU falls back to `'local'` when
   * the root is within 100 km of the earth's centre (the tileset is not geo-referenced).
   */
  frame?: 'enu' | 'local' | ArrayLike<number>;
  /** A floating origin; placed meshes follow it, and selection reads the camera from it. */
  origin?: TilesOrigin;
  /** Loads one glTF / GLB into the engine. Default: gltf-pro's `parseGLTFAsync`. */
  loadModel?: (engine: EngineKernel, gltf: Uint8Array, signal: AbortSignal) => Promise<TilesModel>;
  /**
   * What `memoryBudget` counts: `'gpu'` (default) the GPU memory each tile's model takes (vertex, index and uv buffers,
   * textures with their mip chains, point and splat buffers), so the cache limit matches what the device holds;
   * `'content'` the bytes of each tile's file, as `Tileset` alone does.
   */
  budget?: 'gpu' | 'content';
  /** Point budget of the points plugin made for pnts tiles. Default 2,000,000. */
  pointBudget?: number;
  /**
   * Draws i3dm (instanced) content: pass `i3dm` from `@margoengine/tiles/i3dm`. Without it an i3dm tile fails with
   * code `unsupported` and the rest of the tileset still draws.
   */
  i3dm?: TilesInstancesDrawer;
  /**
   * Decodes Draco-compressed pnts (3DTILES_draco_point_compression): pass `dracoPoints` from
   * `@margoengine/tiles/metadata`. Without it such a tile fails with code `unsupported`.
   */
  dracoPoints?: (content: PointsContent, signal: AbortSignal) => Promise<PointsContent>;
  /**
   * Draws glTF content that holds Gaussian splats (KHR_gaussian_splatting): pass `splats` from
   * `@margoengine/tiles/splats`. Without it such a tile fails with code `unsupported`.
   */
  splats?: TilesModelDrawer;
}

interface PointsHost {
  add<T>(item: T): T;
  remove(item: unknown): void;
  dispose(): void;
}

let count = 0;

/** Engine plugin that streams and draws a 3D Tiles tileset each frame. */
export class TilesRenderer implements EnginePlugin {
  readonly name: string;
  readonly tileset: Tileset;
  /** Tileset to world (float64, column-major). */
  readonly frame: TileMatrix;
  /** World to tileset. */
  readonly inverseFrame: TileMatrix;
  /** The last update's selection. */
  last: TilesFrame = { selected: [], pending: 0 };
  /** Set false to freeze the selection (tiles stay as they are while the camera moves). */
  enabled = true;
  disposed = false;
  private engine?: EngineKernel;
  private readonly origin?: TilesOrigin;
  private readonly loadModel: NonNullable<TilesRendererOptions['loadModel']>;
  private readonly pointBudget: number;
  private readonly budget: 'gpu' | 'content';
  private readonly i3dm?: TilesInstancesDrawer;
  private readonly dracoPoints?: TilesRendererOptions['dracoPoints'];
  private readonly splats?: TilesModelDrawer;
  private readonly decorate?: TilesContentDecorator;
  private readonly listeners = new Set<() => void>();
  private host?: TilesContentHost;
  private points?: Promise<{ host: PointsHost; PointCloud: new (options: object) => object }>;
  private readonly planes = new Float64Array(24);

  /** Fetches the tileset JSON, attaches the renderer to the engine and returns it. Aborts with `options.signal`. */
  static async load(
    engine: EngineKernel,
    url: string | URL,
    options: TilesRendererOptions = {},
  ): Promise<TilesRenderer> {
    let renderer: TilesRenderer | undefined;
    const tileset = await Tileset.load(url, {
      ...options,
      content: (content, tile, signal) => renderer!.createContent(content, tile, signal),
    });
    renderer = new TilesRenderer(tileset, options);
    engine.use(renderer);
    return renderer;
  }
  /** The same as `load`, under the name every engine feature has: fetches the tileset and attaches the renderer. */
  static attach(engine: EngineKernel, url: string | URL, options: TilesRendererOptions = {}): Promise<TilesRenderer> {
    return TilesRenderer.load(engine, url, options);
  }
  private constructor(tileset: Tileset, options: TilesRendererOptions) {
    this.name = `tiles-${++count}`;
    this.tileset = tileset;
    this.origin = options.origin;
    this.pointBudget = options.pointBudget ?? 2_000_000;
    this.budget = options.budget ?? 'gpu';
    if (this.budget !== 'gpu' && this.budget !== 'content')
      throw new TypeError(`Invalid budget ${JSON.stringify(this.budget)}; use 'gpu' or 'content'`);
    this.i3dm = options.i3dm;
    this.dracoPoints = options.dracoPoints;
    this.splats = options.splats;
    this.decorate = options.decorate;
    this.loadModel =
      options.loadModel ??
      (async (engine, gltf, signal) => {
        const { parseGLTFAsync } = await import('@margoengine/gltf-pro');
        return parseGLTFAsync(engine, gltf, { signal });
      });
    const frame = options.frame ?? 'enu';
    if (typeof frame === 'string' && frame !== 'enu' && frame !== 'local')
      throw new TypeError(`Invalid frame ${JSON.stringify(frame)}; use 'enu', 'local' or a 4x4 matrix`);
    if (typeof frame !== 'string') {
      if (frame.length !== 16) throw new TypeError('Invalid frame matrix; give 16 numbers, column-major');
      this.frame = Float64Array.from(frame);
    } else {
      const c = tileset.root.bounds.center;
      this.frame =
        frame === 'enu' && Math.hypot(c[0], c[1], c[2]) > 100_000
          ? multiply(Z_UP_TO_Y_UP, invert(eastNorthUpToEcef(c[0], c[1], c[2])))
          : Float64Array.from(Z_UP_TO_Y_UP);
    }
    this.inverseFrame = invert(this.frame);
  }
  setup(engine: EngineKernel): void {
    if (this.engine && this.engine !== engine)
      throw new MargoError('attached', 'TilesRenderer is attached to another engine; load one renderer per engine');
    this.engine = engine;
  }
  /** World position (engine coordinates, float64) of an ECEF point. */
  toWorld(ecef: ArrayLike<number>): Vec3 {
    return transformPoint(this.frame, ecef);
  }
  /** ECEF of a world position. */
  toTileset(world: ArrayLike<number>): Vec3 {
    return transformPoint(this.inverseFrame, world);
  }
  /** World position of a longitude, latitude (degrees) and height (metres above WGS84). */
  cartographicToWorld(longitude: number, latitude: number, height = 0): Vec3 {
    return this.toWorld(cartographicToEcef((longitude * Math.PI) / 180, (latitude * Math.PI) / 180, height));
  }
  onPreUpdate(): void {
    if (this.enabled && this.engine && !this.tileset.disposed) this.update();
  }
  /** Runs selection for the engine's camera now (the engine also does this every frame). */
  update(): TilesFrame {
    const engine = this.engine;
    if (!engine)
      throw new MargoError('state', 'TilesRenderer is not attached; create it with TilesRenderer.load(engine, url)');
    const camera = engine.camera,
      o = this.origin?.origin ?? [0, 0, 0],
      world = this.origin?.cameraPosition ?? camera.position,
      f = this.frame,
      planes = this.planes;
    for (let p = 0; p < 6; p++) {
      const a = camera.planes[p * 4],
        b = camera.planes[p * 4 + 1],
        c = camera.planes[p * 4 + 2],
        d = camera.planes[p * 4 + 3] - (a * o[0] + b * o[1] + c * o[2]);
      // n . (F x + t) + d = (F^T n) . x + (n . t + d)
      for (let j = 0; j < 3; j++) planes[p * 4 + j] = a * f[j * 4] + b * f[j * 4 + 1] + c * f[j * 4 + 2];
      planes[p * 4 + 3] = a * f[12] + b * f[13] + c * f[14] + d;
    }
    const height = TilesRenderer.orthographicHeight(camera.matrix);
    this.last = this.tileset.update({
      position: this.toTileset(world),
      planes,
      screenHeight: engine.canvas.height || 1,
      fov: camera.fov,
      // An orthographic camera (a constant clip w, as CameraProjection from @margoengine/cameras makes): its view
      // height in tileset units, so screen-space error follows the zoom rather than the distance.
      ...(height === undefined ? {} : { orthographicHeight: height / Math.hypot(f[0], f[1], f[2]) }),
    });
    for (const listener of this.listeners) listener();
    return this.last;
  }
  /**
   * The world height an orthographic view-projection `matrix` (column-major) shows, or undefined for a perspective one
   * (or for no matrix, or core's all-zero matrix before the first frame).
   * Orthographic means the clip w row is (0, 0, 0, w): then NDC y spans 2 over a world height of 2 w / |row y|.
   */
  static orthographicHeight(matrix: ArrayLike<number> | undefined): number | undefined {
    if (!matrix) return undefined;
    const w = matrix[15],
      scale = Math.max(Math.abs(matrix[3]), Math.abs(matrix[7]), Math.abs(matrix[11]));
    if (!(Math.abs(w) > 0) || scale > 1e-9 * Math.abs(w)) return undefined;
    const row = Math.hypot(matrix[1], matrix[5], matrix[9]);
    return row > 0 ? (2 * Math.abs(w)) / row : undefined;
  }
  /** World matrix (float64) of a tile's glTF content: frame x tile transform x RTC x y-up to z-up. */
  contentMatrix(tile: TilesetTile, rtc?: readonly number[], gltf = true): TileMatrix {
    let m = multiply(this.frame, tile.transform);
    if (rtc) m = multiply(m, translation(rtc[0], rtc[1], rtc[2]));
    return gltf ? multiply(m, Y_UP_TO_Z_UP) : m;
  }
  private place(mesh: Mesh, matrix: TileMatrix): void {
    const { translation: t, rotation, scale } = decompose(matrix);
    mesh.setQuaternion(rotation);
    mesh.setScale(scale);
    if (this.origin) this.origin.place(mesh, t);
    else mesh.setPosition(t);
  }
  /** @internal The content factory: models for glTF and b3dm, clouds for pnts, groups for cmpt. */
  async createContent(content: TileContent, tile: TilesetTile, signal: AbortSignal): Promise<TileRenderable> {
    const engine = this.engine;
    if (!engine)
      throw new MargoError('state', 'TilesRenderer is not attached; create it with TilesRenderer.load(engine, url)');
    switch (content.type) {
      case 'glb':
      case 'gltf':
      case 'b3dm': {
        if (holdsSplats(content)) {
          if (!this.splats)
            throw new MargoError(
              'unsupported',
              "Gaussian splat tiles (KHR_gaussian_splatting) need their drawer: import { splats } from '@margoengine/tiles/splats' and pass { splats } to TilesRenderer.load",
            );
          return this.splats((this.host ??= this.contentHost(engine)), content, tile, signal);
        }
        const model = await this.loadModel(engine, content.gltf, signal);
        if (signal.aborted) {
          model.dispose();
          signal.throwIfAborted();
        }
        this.place(model.root, this.contentMatrix(tile, content.type === 'b3dm' ? content.rtcCenter : undefined));
        model.root.visible = false;
        let decoration: TilesContentDecoration | undefined;
        try {
          decoration = await this.decorate?.({
            kind: 'model',
            model,
            content,
            tile,
            signal,
            fetch: (url, signal) => this.tileset.fetchBytes(url, signal),
          });
          signal.throwIfAborted();
        } catch (error) {
          decoration?.dispose();
          this.origin?.forget(model.root);
          model.dispose();
          throw error;
        }
        const renderer = this;
        return {
          get bytes() {
            return renderer.measure(model, content.byteLength) + (decoration?.bytes ?? 0);
          },
          get visible() {
            return model.root.visible;
          },
          set visible(value: boolean) {
            model.root.visible = value;
          },
          dispose: () => {
            decoration?.dispose();
            this.origin?.forget(model.root);
            model.dispose();
          },
        };
      }
      case 'pnts': {
        if (content.draco) {
          if (!this.dracoPoints)
            throw new MargoError(
              'unsupported',
              "Draco-compressed pnts needs its decoder: import { dracoPoints } from '@margoengine/tiles/metadata' and pass { dracoPoints } to TilesRenderer.load",
            );
          content = await this.dracoPoints(content, signal);
          signal.throwIfAborted();
        }
        const { host, PointCloud } = await (this.points ??= this.loadPoints(engine));
        const anchor = engine.createMesh();
        this.place(anchor, this.contentMatrix(tile, content.rtcCenter, false));
        const colors = content.colors;
        const cloud = host.add(
          new PointCloud({
            positions: content.positions,
            colors,
            colorComponents: colors ? 4 : undefined,
            material: { size: 2 },
          }),
        ) as { visible: boolean; attach(mesh: Mesh): void };
        cloud.attach(anchor);
        cloud.visible = false;
        let decoration: TilesContentDecoration | undefined;
        try {
          decoration = await this.decorate?.({
            kind: 'points',
            cloud,
            content,
            tile,
            signal,
            fetch: (url, signal) => this.tileset.fetchBytes(url, signal),
          });
          signal.throwIfAborted();
        } catch (error) {
          decoration?.dispose();
          host.remove(cloud);
          this.origin?.forget(anchor);
          anchor.dispose();
          throw error;
        }
        return {
          // Points upload their positions (float32 xyz) and RGBA8 colours.
          bytes:
            (this.budget === 'gpu' ? (content.positions.length / 3) * (12 + (colors ? 4 : 0)) : content.byteLength) +
            (decoration?.bytes ?? 0),
          get visible() {
            return cloud.visible;
          },
          set visible(value: boolean) {
            cloud.visible = value;
          },
          dispose: () => {
            decoration?.dispose();
            host.remove(cloud);
            this.origin?.forget(anchor);
            anchor.dispose();
          },
        };
      }
      case 'cmpt': {
        const parts: TileRenderable[] = [];
        try {
          for (const inner of content.tiles) parts.push(await this.createContent(inner, tile, signal));
        } catch (error) {
          for (const part of parts) part.dispose();
          throw error;
        }
        let visible = false;
        return {
          get bytes() {
            return parts.reduce((sum, p) => sum + p.bytes, 0);
          },
          get visible() {
            return visible;
          },
          set visible(value: boolean) {
            visible = value;
            for (const p of parts) p.visible = value;
          },
          dispose: () => {
            for (const p of parts) p.dispose();
          },
        };
      }
      case 'i3dm':
        if (!this.i3dm)
          throw new MargoError(
            'unsupported',
            "i3dm instanced content needs its drawer: import { i3dm } from '@margoengine/tiles/i3dm' and pass { i3dm } to TilesRenderer.load",
          );
        return this.i3dm((this.host ??= this.contentHost(engine)), content, tile, signal);
    }
  }
  /** Calls `listener` after every selection update (tile visibility set, `last` current); returns the unsubscribe. */
  onUpdate(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  /** Bytes a model counts against the budget (see `budget`). */
  measure(model: TilesModel, fileBytes: number): number {
    return this.budget === 'gpu' ? (modelGpuBytes(model as MeasurableModel) ?? fileBytes) : fileBytes;
  }
  private contentHost(engine: EngineKernel): TilesContentHost {
    return {
      decorate: (context) => this.decorate?.(context),
      budget: this.budget,
      measure: (model, fileBytes) => this.measure(model, fileBytes),
      engine,
      url: this.tileset.url,
      loadModel: (gltf, signal) => this.loadModel(engine, gltf, signal),
      place: (mesh, matrix) => this.place(mesh, matrix),
      forget: (mesh) => this.origin?.forget(mesh),
      contentMatrix: (tile, rtc, gltf) => this.contentMatrix(tile, rtc, gltf),
      fetch: (url, signal) => this.tileset.fetchBytes(url, signal),
      onUpdate: (listener) => this.onUpdate(listener),
      offset: () => {
        const o = this.origin?.origin;
        return o ? [o[0], o[1], o[2]] : [0, 0, 0];
      },
    };
  }
  private async loadPoints(
    engine: EngineKernel,
  ): Promise<{ host: PointsHost; PointCloud: new (options: object) => object }> {
    const points = await import('@margoengine/points');
    const host = points.PointsPlugin.attach(engine, { name: `${this.name}-points`, pointBudget: this.pointBudget });
    return {
      host: host as unknown as PointsHost,
      PointCloud: points.PointCloud as unknown as new (options: object) => object,
    };
  }
  /** Frees every tile, the points plugin it made and detaches from the engine. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.tileset.dispose();
    const engine = this.engine;
    if (!engine) return;
    if (engine.hasPlugin(`${this.name}-points`)) engine.removePlugin(`${this.name}-points`);
    if (engine.hasPlugin(this.name)) engine.removePlugin(this.name);
    this.engine = undefined;
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}
