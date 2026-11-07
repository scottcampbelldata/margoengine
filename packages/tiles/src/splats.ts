// @margoengine/tiles/splats: streams 3D Tiles whose glTF content holds Gaussian splats (KHR_gaussian_splatting, with or
// without the SPZ payload of KHR_gaussian_splatting_compression_spz_2), the way photoreal captures are now published.
// Pass `splats` to `TilesRenderer.load`; tilesets without splats never load this module. gltf-pro reads the splats and
// @margoengine/splats draws them. Every visible tile's splats go into one cloud, rebuilt after an update that changed
// which tiles show, so splats of neighbouring and overlapping tiles sort together instead of tile by tile. Written from
// the 3D Tiles 1.1 specification (glTF content, tile transforms, REPLACE refinement) and the KHR_gaussian_splatting README.
import type { EngineKernel } from '@margoengine/core';
import type { SplatData } from '@margoengine/splats/data';
import type { ModelContent } from './formats.js';
import { type TileMatrix, multiply } from './matrix.js';
import type { TilesContentHost, TilesModelDrawer } from './renderer.js';
import type { TileRenderable, TilesetTile } from './tileset.js';

/** Most splats one @margoengine/splats cloud takes; past it the visible splats start another cloud. */
export const SPLATS_PER_CLOUD = 3_000_000;
/** Band-0 spherical-harmonics constant: colour = 0.5 + C0 x coefficient. */
const C0 = 0.2820947917738781;

/**
 * One tile's splats ready to place: covariances and harmonics already turned by the tile's linear part, positions
 * relative to `anchor`, the float64 world point the tile's matrix carries its origin to.
 */
export interface PlacedSplats {
  readonly data: SplatData;
  readonly anchor: readonly [number, number, number];
}

/**
 * Turns local splats by a column-major float64 `matrix` (all but its translation) and keeps the translation apart, so
 * the float32 positions stay as small as the tile and the world offset is added in float64 when clouds are built.
 */
export async function placeSplats(data: SplatData, matrix: ArrayLike<number>): Promise<PlacedSplats> {
  const { transformSplats } = await import('@margoengine/splats');
  const linear = Float64Array.from(matrix);
  linear[12] = linear[13] = linear[14] = 0;
  return { data: transformSplats(data, linear), anchor: [matrix[12], matrix[13], matrix[14]] };
}

/** Spherical-harmonics coefficients per channel of `data` (0, 4, 9 or 16). */
const coefficients = (data: SplatData): number =>
  data.sphericalHarmonics ? data.sphericalHarmonics.length / (data.positions.length / 3) / 3 : 0;

/**
 * One cloud of `parts`, each moved by its anchor minus `offset` (in float64, rounded once to float32), with harmonics
 * padded to the largest degree present: zeros above a part's own bands, band 0 from its colour when it has none.
 */
export function mergePlaced(parts: readonly PlacedSplats[], offset: ArrayLike<number> = [0, 0, 0]): SplatData {
  let total = 0,
    size = 0;
  for (const { data } of parts) {
    total += data.positions.length / 3;
    size = Math.max(size, coefficients(data));
  }
  const positions = new Float32Array(total * 3),
    covariances = new Float32Array(total * 6),
    colors = new Float32Array(total * 4),
    sh = size ? new Float32Array(total * size * 3) : undefined;
  let at = 0;
  for (const { data, anchor } of parts) {
    const count = data.positions.length / 3,
      dx = anchor[0] - offset[0],
      dy = anchor[1] - offset[1],
      dz = anchor[2] - offset[2];
    for (let i = 0; i < count; i++) {
      positions[(at + i) * 3] = data.positions[i * 3] + dx;
      positions[(at + i) * 3 + 1] = data.positions[i * 3 + 1] + dy;
      positions[(at + i) * 3 + 2] = data.positions[i * 3 + 2] + dz;
    }
    covariances.set(data.covariances, at * 6);
    colors.set(data.colors, at * 4);
    if (sh) {
      const own = coefficients(data),
        src = data.sphericalHarmonics;
      for (let i = 0; i < count; i++) {
        const to = (at + i) * size * 3;
        if (src && own) sh.set(src.subarray(i * own * 3, (i + 1) * own * 3), to);
        else for (let c = 0; c < 3; c++) sh[to + c] = (data.colors[i * 4 + c] - 0.5) / C0;
      }
    }
    at += count;
  }
  return sh ? { positions, covariances, colors, sphericalHarmonics: sh } : { positions, covariances, colors };
}

/** The part of a @margoengine/splats cloud the scene uses. */
interface Cloud {
  readonly count: number;
  dispose(): void;
}
interface Entry {
  placed: PlacedSplats;
  visible: boolean;
}

/**
 * The splats of one renderer's tiles: every visible tile in one cloud (or several of at most `SPLATS_PER_CLOUD`),
 * rebuilt after an update that changed which tiles show, or when the floating origin moved.
 */
export class TileSplats {
  /** The clouds drawn now. */
  clouds: readonly Cloud[] = [];
  /** Times the clouds were rebuilt. */
  builds = 0;
  private readonly entries = new Set<Entry>();
  private dirty = false;
  private built: readonly number[] = [0, 0, 0];
  private readonly stop: () => void;
  constructor(
    private readonly host: TilesContentHost,
    private readonly attach: (engine: EngineKernel, data: SplatData) => Cloud,
    /** Most splats per cloud. */
    private readonly limit = SPLATS_PER_CLOUD,
  ) {
    this.stop = host.onUpdate(() => this.flush());
  }
  /** Splats now visible. */
  get count(): number {
    let n = 0;
    for (const cloud of this.clouds) n += cloud.count;
    return n;
  }
  add(placed: PlacedSplats): Entry {
    const entry: Entry = { placed, visible: false };
    this.entries.add(entry);
    return entry;
  }
  show(entry: Entry, visible: boolean): void {
    if (entry.visible === visible) return;
    entry.visible = visible;
    this.dirty = true;
  }
  remove(entry: Entry): void {
    if (!this.entries.delete(entry)) return;
    if (entry.visible) this.dirty = true;
    // Nothing left (the renderer is being disposed, or the last tile went): free the GPU clouds now.
    if (!this.entries.size) {
      this.release();
      this.stop();
      scenes.delete(this.host);
    }
  }
  /** Rebuilds the clouds if the visible tiles or the floating origin changed since the last build. */
  flush(): void {
    const offset = this.host.offset();
    if (!this.dirty && offset[0] === this.built[0] && offset[1] === this.built[1] && offset[2] === this.built[2])
      return;
    this.dirty = false;
    this.built = [offset[0], offset[1], offset[2]];
    this.release();
    const shown: PlacedSplats[][] = [[]];
    let size = 0;
    for (const entry of this.entries) {
      if (!entry.visible) continue;
      const count = entry.placed.data.positions.length / 3;
      if (size && size + count > this.limit) {
        shown.push([]);
        size = 0;
      }
      shown[shown.length - 1].push(entry.placed);
      size += count;
    }
    if (!shown[0].length) return;
    this.clouds = shown.map((parts) => this.attach(this.host.engine, mergePlaced(parts, offset)));
    this.builds++;
  }
  private release(): void {
    for (const cloud of this.clouds) cloud.dispose();
    this.clouds = [];
  }
}

const scenes = new Map<TilesContentHost, Promise<TileSplats>>();

/** The splat scene of a renderer (its content host), made on its first splat tile. */
export function tileSplats(host: TilesContentHost): Promise<TileSplats> | undefined {
  return scenes.get(host);
}

async function scene(host: TilesContentHost): Promise<TileSplats> {
  let made = scenes.get(host);
  if (!made) {
    made = import('@margoengine/splats').then(
      ({ Splats }) => new TileSplats(host, (engine, data) => Splats.attach(engine, data)),
    );
    scenes.set(host, made);
  }
  return made;
}

/** The part of a gltf-pro model the drawer uses. */
interface SplatModel {
  readonly root: Parameters<TilesContentHost['place']>[0];
  dispose(): void;
}

/**
 * Draws glTF tile content that holds Gaussian splats: its meshes as gltf-pro models, its splats in the renderer's one
 * splat cloud, placed by `frame x tile transform x RTC x y-up to z-up x node`. Pass it as `splats` to
 * `TilesRenderer.load`. The renderer's `loadModel` is not used for these tiles: gltf-pro reads them.
 */
export const splats: TilesModelDrawer = async (
  host: TilesContentHost,
  content: ModelContent,
  tile: TilesetTile,
  signal: AbortSignal,
): Promise<TileRenderable> => {
  const [{ parseGLTFAsync }, { readGaussianSplats }] = await Promise.all([
    import('@margoengine/gltf-pro'),
    import('@margoengine/gltf-pro/splats'),
  ]);
  const matrix: TileMatrix = host.contentMatrix(tile, content.type === 'b3dm' ? content.rtcCenter : undefined, true);
  const read: Promise<PlacedSplats>[] = [];
  const model: SplatModel = await parseGLTFAsync(host.engine, content.gltf, {
    signal,
    decoders: {
      // gltf-pro hands each splat primitive with its node's matrix in the model; the tile's float64 matrix goes first.
      splats: {
        async attach(_engine, asset, primitives, readSignal) {
          for (const { primitive, matrix: node } of primitives)
            read.push(
              readGaussianSplats(asset, primitive, { signal: readSignal }).then((data) =>
                placeSplats(data, multiply(matrix, node)),
              ),
            );
          await Promise.all(read);
          return [];
        },
      },
    },
  });
  let placed: PlacedSplats[];
  try {
    placed = await Promise.all(read);
    signal.throwIfAborted();
  } catch (error) {
    model.dispose();
    throw error;
  }
  host.place(model.root, matrix);
  model.root.visible = false;
  const splatScene = placed.length ? await scene(host) : undefined;
  const entries = splatScene ? placed.map((p) => splatScene.add(p)) : [];
  let bytes = content.byteLength;
  // The splats' own arrays, kept to rebuild the cloud; the GPU copy is counted by the cloud, not here.
  for (const { data } of placed)
    bytes +=
      data.positions.byteLength +
      data.covariances.byteLength +
      data.colors.byteLength +
      (data.sphericalHarmonics?.byteLength ?? 0);
  return {
    bytes,
    get visible() {
      return model.root.visible;
    },
    set visible(value: boolean) {
      model.root.visible = value;
      for (const entry of entries) splatScene!.show(entry, value);
    },
    dispose: () => {
      for (const entry of entries) splatScene!.remove(entry);
      host.forget(model.root);
      model.dispose();
    },
  };
};
