/// <reference lib="esnext.disposable" preserve="true" />
// Draws a streaming 3D Tiles tileset with the engine: glTF / GLB / b3dm content becomes @margoengine/gltf-pro models,
// pnts content becomes @margoengine/points clouds; both are optional peers loaded with import() on the first tile
// that needs them. Tileset coordinates (ECEF, z-up, float64) map to the engine's y-up float32 world through a
// float64 frame matrix; see the README's "Coordinates and precision".
import type { EngineKernel, Mesh, Vec3 } from '@margoengine/core';
import type { EnginePlugin } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import type { TileContent } from './formats.js';
import {
  type Matrix4,
  Y_UP_TO_Z_UP,
  Z_UP_TO_Y_UP,
  decompose,
  invert,
  multiply,
  transformPoint,
  translation,
} from './matrix.js';
import { type Tile, type TileRenderable, Tileset, type TilesetOptions, type TilesFrame } from './tileset.js';
import { cartographicToEcef, eastNorthUpToEcef } from './wgs84.js';

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

/** Options of `TilesRenderer.load`. */
export interface TilesRendererOptions extends Omit<TilesetOptions, 'content'> {
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
  /** Point budget of the points plugin made for pnts tiles. Default 2,000,000. */
  pointBudget?: number;
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
  readonly frame: Matrix4;
  /** World to tileset. */
  readonly inverseFrame: Matrix4;
  /** The last update's selection. */
  last: TilesFrame = { selected: [], pending: 0 };
  /** Set false to freeze the selection (tiles stay as they are while the camera moves). */
  enabled = true;
  disposed = false;
  private engine?: EngineKernel;
  private readonly origin?: TilesOrigin;
  private readonly loadModel: NonNullable<TilesRendererOptions['loadModel']>;
  private readonly pointBudget: number;
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
    this.last = this.tileset.update({
      position: this.toTileset(world),
      planes,
      screenHeight: engine.canvas.height || 1,
      fov: camera.fov,
    });
    return this.last;
  }
  /** World matrix (float64) of a tile's glTF content: frame x tile transform x RTC x y-up to z-up. */
  contentMatrix(tile: Tile, rtc?: readonly number[], gltf = true): Matrix4 {
    let m = multiply(this.frame, tile.transform);
    if (rtc) m = multiply(m, translation(rtc[0], rtc[1], rtc[2]));
    return gltf ? multiply(m, Y_UP_TO_Z_UP) : m;
  }
  private place(mesh: Mesh, matrix: Matrix4): void {
    const { translation: t, rotation, scale } = decompose(matrix);
    mesh.setQuaternion(rotation);
    mesh.setScale(scale);
    if (this.origin) this.origin.place(mesh, t);
    else mesh.setPosition(t);
  }
  /** @internal The content factory: models for glTF and b3dm, clouds for pnts, groups for cmpt. */
  async createContent(content: TileContent, tile: Tile, signal: AbortSignal): Promise<TileRenderable> {
    const engine = this.engine;
    if (!engine)
      throw new MargoError('state', 'TilesRenderer is not attached; create it with TilesRenderer.load(engine, url)');
    switch (content.type) {
      case 'glb':
      case 'gltf':
      case 'b3dm': {
        const model = await this.loadModel(engine, content.gltf, signal);
        if (signal.aborted) {
          model.dispose();
          signal.throwIfAborted();
        }
        this.place(model.root, this.contentMatrix(tile, content.type === 'b3dm' ? content.rtcCenter : undefined));
        model.root.visible = false;
        return {
          bytes: content.byteLength,
          get visible() {
            return model.root.visible;
          },
          set visible(value: boolean) {
            model.root.visible = value;
          },
          dispose: () => {
            this.origin?.forget(model.root);
            model.dispose();
          },
        };
      }
      case 'pnts': {
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
        return {
          bytes: content.byteLength,
          get visible() {
            return cloud.visible;
          },
          set visible(value: boolean) {
            cloud.visible = value;
          },
          dispose: () => {
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
          bytes: parts.reduce((sum, p) => sum + p.bytes, 0),
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
      default:
        throw new MargoError(
          'unsupported',
          'i3dm instanced content is parsed but not drawn yet; convert it to glTF with EXT_mesh_gpu_instancing',
        );
    }
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
