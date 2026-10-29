/// <reference lib="esnext.disposable" preserve="true" />
// BiomeObjects (B6): a placement's stored objects and detail densities drawn through scatter. Each species mesh is a
// `ScatterTiles` (decision D3) fed with the tiles' 8-byte records as they stream around the camera; dead trees draw as
// snags; every detail species (grass, ferns, reeds) is a camera-following `Scatter` whose density map is the
// placement's detail map, so grass is drawn per frame and never stored. Meshes come from `@margoengine/procedural`
// (the `procedural:<name>` keys of the presets). Scatter, its tiles entry, procedural and core are loaded on attach.
import type { EngineKernel, Geometry } from '@margoengine/core';
import type { Scatter } from '@margoengine/scatter';
import type { ScatterTiles } from '@margoengine/scatter/tiles';
import { rangeError, typeError } from '../../shared/errors.js';
import type { BiomePlacement, PlacedTile } from './placement.js';

/** Settings of {@link BiomeObjects.attach}. */
export interface BiomeObjectsOptions {
  /** Height texture over `bounds` (r32float, texel centres on the rectangle's grid), read every frame. */
  readonly heightmap: () => GPUTexture | undefined;
  /** World rectangle the heightmap covers, `[minX, minZ, maxX, maxZ]`. */
  readonly bounds: readonly [number, number, number, number];
  /** Stored objects are drawn within this distance of the camera. Default 1,000 m. */
  readonly radius?: number;
  /** Detail (grass, ferns) is drawn within this distance. Default 120 m. */
  readonly detailRadius?: number;
  /** Metres per detail density texel. Default 2. */
  readonly detailResolution?: number;
}

/** Colours (linear RGB) of the procedural meshes' parts. */
const BARK = [0.16, 0.1, 0.06] as const,
  LEAF = [0.08, 0.2, 0.05] as const,
  NEEDLE = [0.05, 0.14, 0.06] as const,
  STONE = [0.32, 0.31, 0.29] as const,
  DRY = [0.3, 0.24, 0.1] as const;

type Procedural = typeof import('@margoengine/procedural');
type Part = { geometry: Geometry; color: readonly [number, number, number]; blades?: boolean };
type Modules = {
  tiles: typeof import('@margoengine/scatter/tiles');
  scatter: typeof import('@margoengine/scatter');
  procedural: Procedural;
  core: typeof import('@margoengine/core');
};

/** The parts of a mesh key: trees are wood and foliage, the rest one mesh. Unknown keys draw as a shrub. */
function partsOf(
  key: string,
  p: Procedural,
  make: (data: { positions: ArrayLike<number>; normals: ArrayLike<number>; indices: ArrayLike<number> }) => Geometry,
): Part[] {
  const name = key.startsWith('procedural:') ? key.slice(11) : key,
    tree = (
      t: { trunk: Parameters<typeof make>[0]; canopy: Parameters<typeof make>[0] },
      leaf: readonly [number, number, number],
    ) => [
      { geometry: make(t.trunk), color: BARK },
      ...(t.canopy.indices.length ? [{ geometry: make(t.canopy), color: leaf }] : []),
    ];
  switch (name) {
    case 'broadleaf':
      return tree(p.generateTreeMesh('broadleaf'), LEAF);
    case 'conifer':
      return tree(p.generateTreeMesh('conifer'), NEEDLE);
    case 'palm':
      return tree(p.generatePalmMesh(), LEAF);
    case 'birch':
      return tree(p.generateBirchMesh(), LEAF);
    case 'acacia':
      return tree(p.generateAcaciaMesh(), DRY);
    case 'snag':
      return tree(p.generateSnagMesh(), LEAF);
    case 'rock':
      return [{ geometry: make(p.generateRockMesh()), color: STONE }];
    case 'cactus':
      return [{ geometry: make(p.generateCactusMesh()), color: [0.1, 0.22, 0.08] }];
    case 'tundra-shrub':
      return [{ geometry: make(p.generateTundraShrubMesh()), color: [0.18, 0.14, 0.06] }];
    case 'grass':
      return [{ geometry: make(p.generateGrassMesh(3)), color: [0.1, 0.24, 0.05], blades: true }];
    case 'fern':
      return [{ geometry: make(p.generateFernMesh()), color: [0.06, 0.2, 0.05] }];
    case 'reeds':
      return [{ geometry: make(p.generateReedMesh()), color: [0.2, 0.22, 0.08], blades: true }];
    default:
      return [{ geometry: make(p.generateShrubMesh()), color: LEAF }];
  }
}

/**
 * The stored objects and detail of a biome placement, drawn through scatter around the camera. WebGPU only.
 * `BiomeView` attaches one by default; use it directly to draw a placement over your own terrain.
 * @example
 * const objects = await BiomeObjects.attach(engine, placement, { heightmap: () => heights, bounds: world.bounds });
 * await objects.stream([-500, -500, 500, 500]);
 */
export class BiomeObjects implements Disposable {
  readonly #engine: EngineKernel;
  readonly #placement: BiomePlacement;
  readonly #options: Required<Omit<BiomeObjectsOptions, 'heightmap' | 'bounds'>> &
    Pick<BiomeObjectsOptions, 'heightmap' | 'bounds'>;
  readonly #modules: Modules;
  /** Per species key: its ScatterTiles (one per mesh part) and the distance it is drawn within. */
  readonly #species = new Map<string, { tiles: ScatterTiles[]; radius: number }>();
  #snags?: { tiles: ScatterTiles[]; radius: number };
  readonly #details: { id: string; scatter: Scatter; texture?: GPUTexture; data: Uint8Array }[] = [];
  /** Held tiles and their object counts. */
  readonly #held = new Map<string, number>();
  #disposed = false;

  private constructor(engine: EngineKernel, placement: BiomePlacement, options: BiomeObjectsOptions, modules: Modules) {
    this.#engine = engine;
    this.#placement = placement;
    this.#options = { radius: 1000, detailRadius: 120, detailResolution: 2, ...options };
    this.#modules = modules;
  }

  /**
   * Draws a placement's objects. Loads scatter, its tiles entry, procedural and core on first use.
   * @throws TypeError for bad arguments; RangeError for bad options.
   */
  static async attach(
    engine: EngineKernel,
    placement: BiomePlacement,
    options: BiomeObjectsOptions,
  ): Promise<BiomeObjects> {
    if (!engine || !placement || typeof placement.tile !== 'function')
      throw typeError('BiomeObjects.attach takes an engine and a BiomePlacement', 'biomes');
    const b = options?.bounds;
    if (typeof options?.heightmap !== 'function' || !Array.isArray(b) || b.length !== 4 || !b.every(Number.isFinite))
      throw typeError(
        'BiomeObjects needs a heightmap function and the bounds [minX, minZ, maxX, maxZ] it covers',
        'biomes',
      );
    for (const key of ['radius', 'detailRadius', 'detailResolution'] as const)
      if (options[key] !== undefined && !(options[key]! > 0))
        throw rangeError(`BiomeObjects ${key} must be above 0`, 'biomes');
    const [tiles, scatter, procedural, core] = await Promise.all([
      import('@margoengine/scatter/tiles'),
      import('@margoengine/scatter'),
      import('@margoengine/procedural'),
      import('@margoengine/core'),
    ]);
    const objects = new BiomeObjects(engine, placement, options, { tiles, scatter, procedural, core });
    objects.#build();
    return objects;
  }

  /** Records left out because a tile held more than its slot (0 unless a stand is denser than expected). */
  dropped = 0;

  /**
   * GPU bytes held for stored objects (goal G2): per species, its held records (8 bytes each) and its LOD rings (32
   * bytes per instance they can draw), both sized from the held tiles with headroom; a tree's canopy shares its trunk's.
   */
  get gpuBytes(): number {
    let n = 0;
    for (const entry of [...this.#species.values(), ...(this.#snags ? [this.#snags] : [])])
      for (const t of entry.tiles) n += t.gpuBytes;
    return n;
  }

  /** Objects drawn now (stored records held on the GPU). */
  get count(): number {
    let n = 0;
    for (const c of this.#held.values()) n += c;
    return n;
  }

  #make = (d: { positions: ArrayLike<number>; normals: ArrayLike<number>; indices: ArrayLike<number> }): Geometry =>
    new this.#modules.core.Geometry(d.positions, d.normals, d.indices);

  #build(): void {
    const { radius, detailRadius, detailResolution, bounds, heightmap } = this.#options,
      side = this.#placement.tileSize,
      // Canopy trees are drawn within the full radius, smaller plants, rocks and props within 300 m.
      tiles = (key: string, near: boolean) => {
        const r = near ? Math.min(radius, 300) : radius,
          slots = (Math.ceil((2 * r) / side) + 2) ** 2, // float division: view only
          // Memory follows the held records, so a tile may hold up to scatter's per-tile limit (no stand is dropped).
          slotSize = Math.min(65536, Math.floor(16777216 / slots)), // float division: view only
          list: ScatterTiles[] = [];
        for (const part of partsOf(key, this.#modules.procedural, this.#make))
          list.push(
            this.#modules.tiles.ScatterTiles.attach(this.#engine, part.geometry, {
              bounds,
              heightmap,
              slots,
              slotSize,
              lod: [r * 0.15, r * 0.4, r],
              lodFade: 0,
              color: part.color,
              maxSlope: 90,
              // Plants sway with a light breeze; stone does not.
              ...(part.color === STONE ? {} : { wind: [1, 0, 0.25] as const }),
              // A tree's canopy draws the trunk's objects: one set of records, culling and rings for both.
              ...(list.length ? { share: list[0] } : {}),
            }),
          );
        return { radius: r, tiles: list };
      };
    for (const s of this.#placement.species) this.#species.set(s.key, tiles(s.mesh, s.layer !== 1));
    this.#snags = tiles('procedural:snag', false);
    const [x0, z0, x1, z1] = bounds,
      width = Math.ceil((x1 - x0) / detailResolution), // float division: view only
      depth = Math.ceil((z1 - z0) / detailResolution); // float division
    for (const d of this.#placement.details) {
      const parts = partsOf(d.mesh, this.#modules.procedural, this.#make),
        area = 2 * detailRadius,
        entry = {
          id: d.id,
          data: new Uint8Array(width * depth),
          texture: undefined as GPUTexture | undefined,
          scatter: undefined as unknown as Scatter,
        };
      entry.scatter = this.#modules.scatter.Scatter.attach(this.#engine, parts[0].geometry, {
        count: Math.min(400000, Math.max(1000, Math.round(d.density * area * area * 0.25))),
        area: [area, area],
        follow: true,
        bounds,
        heightmap,
        densityMap: () => (entry.texture ??= this.#detailTexture(entry.data, width, depth)),
        lod: [detailRadius * 0.3, detailRadius * 0.6, detailRadius],
        lodFade: 0,
        edgeShrink: detailRadius * 0.2,
        color: parts[0].color,
        maxSlope: 60,
        wind: [1, 0, 0.5],
        ...(parts[0].blades ? { blades: {} } : {}),
      });
      this.#details.push(entry);
    }
  }

  #detailTexture(data: Uint8Array, width: number, depth: number): GPUTexture | undefined {
    const device = (this.#engine as unknown as { gpu?: GPUDevice }).gpu;
    if (!device) return undefined;
    const texture = device.createTexture({ size: [width, depth], format: 'r8unorm', usage: 4 | 2 }); // TEXTURE_BINDING | COPY_DST
    device.queue.writeTexture({ texture }, data as Uint8Array<ArrayBuffer>, { bytesPerRow: width }, [width, depth]);
    return texture;
  }

  /** Streams the tiles of a world rectangle (metres) in, nearest the camera first, and drops held tiles beyond the radius. */
  async stream(
    rect: readonly [number, number, number, number],
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<void> {
    const eye = this.#engine.camera.position,
      r = this.#options.radius;
    for await (const tile of this.#placement.tiles(rect, { focus: [eye[0], eye[2]], signal: options.signal })) {
      if (this.#disposed) return;
      const dx = Math.max(0, Math.abs(tile.origin[0] + tile.size / 2 - eye[0]) - tile.size / 2),
        dz = Math.max(0, Math.abs(tile.origin[1] + tile.size / 2 - eye[2]) - tile.size / 2);
      if (Math.hypot(dx, dz) <= r) this.add(tile, Math.hypot(dx, dz));
      await new Promise((done) => setTimeout(done, 0));
    }
    // Free the slots of tiles now out of range.
    for (const key of [...this.#held.keys()]) {
      const [x, z] = key.split(',').map(Number),
        side = this.#placement.tileSize,
        cx = this.#options.bounds[0] + (x + 0.5) * side,
        cz = this.#options.bounds[1] + (z + 0.5) * side;
      if (Math.hypot(cx - eye[0], cz - eye[2]) > r + side) this.remove(key);
    }
  }

  /**
   * Puts one placed tile on the GPU (its objects by species, dead trees as snags, each species only within its draw
   * distance of the tile's nearest point, `distance`) and its detail densities.
   */
  add(tile: PlacedTile, distance = 0): void {
    const key = `${tile.x},${tile.z}`,
      bySpecies = new Map<number, number[]>(),
      dead: number[] = [];
    for (let k = 0; k < tile.count; k++) {
      const age = tile.instances[k * 8 + 7] >> 4;
      if (age >= 2) dead.push(k);
      else {
        const s = tile.instances[k * 8 + 4];
        let list = bySpecies.get(s);
        if (!list) bySpecies.set(s, (list = []));
        list.push(k);
      }
    }
    const pick = (list: number[], cap: number) => {
      // A tile denser than its slot keeps the first records (recorded in `dropped`).
      if (list.length > cap) {
        this.dropped += list.length - cap;
        list = list.slice(0, cap);
      }
      const out = new Uint8Array(list.length * 8);
      list.forEach((k, i) => out.set(tile.instances.subarray(k * 8, k * 8 + 8), i * 8));
      return out;
    };
    this.remove(key);
    for (const [s, list] of bySpecies) {
      const entry = this.#species.get(tile.species[s]);
      // The first part holds the records; the others share them.
      if (entry && distance <= entry.radius)
        entry.tiles[0].setTile(key, tile.origin, tile.size, pick(list, entry.tiles[0].slotSize));
    }
    if (this.#snags && distance <= this.#snags.radius)
      this.#snags.tiles[0].setTile(key, tile.origin, tile.size, pick(dead, this.#snags.tiles[0].slotSize));
    this.#held.set(key, tile.count);
    // Detail densities into the world-wide textures (every detailResolution metres).
    const res = this.#options.detailResolution,
      [x0, z0, x1] = this.#options.bounds,
      width = Math.ceil((x1 - x0) / res), // float division: view only
      cells = tile.density[0]?.data.length ? Math.round(Math.sqrt(tile.density[0].data.length)) : 0,
      step = tile.size / cells; // float division: metres per cell
    const every = Math.max(1, Math.round(res / step)); // float division: view only
    for (const d of tile.density) {
      const entry = this.#details.find((e) => e.id === d.id);
      if (!entry) continue;
      for (let j = 0; j < cells; j += every)
        for (let i = 0; i < cells; i += every) {
          // float division
          const u = Math.floor((tile.origin[0] + i * step - x0) / res), // float division
            v = Math.floor((tile.origin[1] + j * step - z0) / res); // float division
          if (u >= 0 && v >= 0 && u < width && v * width + u < entry.data.length)
            entry.data[v * width + u] = d.data[j * cells + i];
        }
      // Upload the rows the tile covers (the texture is made on the first frame that reads it).
      const device = (this.#engine as unknown as { gpu?: GPUDevice }).gpu;
      if (entry.texture && device) {
        const depth = entry.data.length / width, // float division: exact
          u0 = Math.max(0, Math.floor((tile.origin[0] - x0) / res)), // float division
          v0 = Math.max(0, Math.floor((tile.origin[1] - z0) / res)), // float division
          w = Math.min(width - u0, Math.ceil(tile.size / res)), // float division
          h = Math.min(depth - v0, Math.ceil(tile.size / res)); // float division
        if (w > 0 && h > 0)
          device.queue.writeTexture(
            { texture: entry.texture, origin: [u0, v0] },
            entry.data as Uint8Array<ArrayBuffer>,
            { offset: v0 * width + u0, bytesPerRow: width },
            [w, h],
          );
      }
    }
  }

  /** Takes one tile's objects off the GPU. */
  remove(key: string): void {
    if (!this.#held.delete(key)) return;
    for (const entry of [...this.#species.values(), ...(this.#snags ? [this.#snags] : [])])
      entry.tiles[0].removeTile(key);
  }

  /** Frees every scatter and texture. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    // Sharing parts first, then the part whose buffers they read.
    for (const entry of [...this.#species.values(), ...(this.#snags ? [this.#snags] : [])])
      for (const t of [...entry.tiles].reverse()) t.dispose();
    for (const d of this.#details) {
      d.scatter.dispose();
      d.texture?.destroy();
    }
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}
