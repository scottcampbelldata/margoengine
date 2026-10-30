/// <reference lib="esnext.disposable" preserve="true" />
// BiomeObjects (B6): a placement's stored objects and detail densities drawn through scatter. Each species mesh is a
// `ScatterTiles` (decision D3) fed with the tiles' 8-byte records as they stream around the camera; dead trees draw as
// snags; every detail species (grass, ferns, reeds) is a camera-following `Scatter` whose density map is the
// placement's detail map, so grass is drawn per frame and never stored. Meshes come from `@margoengine/procedural`
// (the `procedural:<name>` keys of the presets). Scatter, its tiles entry, procedural and core are loaded on attach.
import type { EngineKernel, Geometry } from '@margoengine/core';
import type { Scatter } from '@margoengine/scatter';
import type { ScatterTiles } from '@margoengine/scatter/tiles';
import { fault, rangeError, typeError } from '../../shared/errors.js';
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
  /**
   * Most bytes the detail density maps may take over all detail species (each map is one byte per texel over `bounds`,
   * kept on this thread and as a GPU texture). Default 128 MiB.
   */
  readonly detailBudget?: number;
}

/** Default {@link BiomeObjectsOptions.detailBudget}: 128 MiB of detail maps. */
export const DETAIL_BUDGET = 134_217_728;

/**
 * Whether the detail maps of `species` detail species over `bounds`, one texel every `resolution` metres, fit `budget`
 * bytes and textures of at most `limit` texels a side (the device's largest 2D texture).
 */
export function detailFits(
  bounds: readonly [number, number, number, number],
  resolution: number,
  species: number,
  limit: number,
  budget = DETAIL_BUDGET,
): boolean {
  const width = Math.ceil((bounds[2] - bounds[0]) / resolution), // float division: view only
    depth = Math.ceil((bounds[3] - bounds[1]) / resolution); // float division: view only
  return width <= limit && depth <= limit && width * depth * species <= budget;
}

/** Colours (linear RGB) of the procedural meshes' parts. */
const BARK = [0.22, 0.14, 0.08] as const,
  LEAF = [0.14, 0.3, 0.05] as const,
  BIRCH = [0.26, 0.36, 0.07] as const,
  PALM = [0.1, 0.32, 0.07] as const,
  NEEDLE = [0.04, 0.17, 0.07] as const,
  STONE = [0.4, 0.37, 0.33] as const,
  DRY = [0.45, 0.33, 0.11] as const;

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
      return tree(p.generatePalmMesh(), PALM);
    case 'birch':
      return tree(p.generateBirchMesh(), BIRCH);
    case 'acacia':
      return tree(p.generateAcaciaMesh(), DRY);
    case 'snag':
      return tree(p.generateSnagMesh(), LEAF);
    case 'rock':
      return [{ geometry: make(p.generateRockMesh()), color: STONE }];
    case 'cactus':
      return [{ geometry: make(p.generateCactusMesh()), color: [0.13, 0.3, 0.1] }];
    case 'tundra-shrub':
      return [{ geometry: make(p.generateTundraShrubMesh()), color: [0.3, 0.17, 0.07] }];
    case 'grass':
      return [{ geometry: make(p.generateGrassMesh(3)), color: [0.2, 0.4, 0.06], blades: true }];
    case 'fern':
      return [{ geometry: make(p.generateFernMesh()), color: [0.08, 0.28, 0.07] }];
    case 'reeds':
      return [{ geometry: make(p.generateReedMesh()), color: [0.36, 0.34, 0.11], blades: true }];
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
    this.#options = { radius: 1000, detailRadius: 120, detailResolution: 2, detailBudget: DETAIL_BUDGET, ...options };
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
    for (const key of ['radius', 'detailRadius', 'detailResolution', 'detailBudget'] as const)
      if (options[key] !== undefined && !(options[key]! > 0))
        throw rangeError(`BiomeObjects ${key} must be above 0`, 'biomes');
    if (!(b[2] > b[0] && b[3] > b[1]))
      throw rangeError('BiomeObjects bounds must be [minX, minZ, maxX, maxZ] with max above min', 'biomes');
    // Checked before anything is allocated: a huge world or a fine resolution must not ask for gigabytes of maps.
    const limit = (engine as unknown as { gpu?: GPUDevice }).gpu?.limits.maxTextureDimension2D ?? 8192;
    if (!detailFits(b, options.detailResolution ?? 2, placement.details.length, limit, options.detailBudget))
      throw fault(
        'unsupported',
        "BiomeObjects detail maps exceed detailBudget or the device's largest texture; raise detailResolution or detailBudget, or shrink bounds",
        'biomes',
      );
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
          // Room for every tile within the draw distance plus a tile: a view keeps a tile's objects until it is a whole
          // tile beyond (sized for the distance alone, a view with tiles queued ran out of slots in a frame).
          slots = (Math.ceil((2 * (r + side)) / side) + 2) ** 2, // float division: view only
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
              // Lit by the engine's sun and sky and shadowed by an attached Shadows, like the terrain under it.
              material: this.#material(part.color),
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
        material: this.#material(parts[0].color),
        maxSlope: 60,
        wind: [1, 0, 0.5],
        ...(parts[0].blades ? { blades: {} } : {}),
      });
      this.#details.push(entry);
    }
  }

  /** A rough, double-sided PBR material of a part's colour (linear RGB). */
  #material(color: readonly [number, number, number]) {
    return new this.#modules.core.PbrMaterial({ color, roughness: 0.85 });
  }

  /**
   * Every stored-object mesh: each species' parts (trunk and canopy) and the snags. `BiomeView`'s `shadows` option adds
   * them to a `Shadows` as casters; detail (grass, ferns) receives shadows but does not cast.
   */
  get casters(): readonly ScatterTiles[] {
    return [...this.#species.values(), ...(this.#snags ? [this.#snags] : [])].flatMap((entry) => entry.tiles);
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
   * distance of the tile's nearest point, `distance`) and, within 300 m or a tile beyond the detail radius, its detail
   * densities.
   */
  add(tile: PlacedTile, distance = 0): void {
    const key = `${tile.x},${tile.z}`,
      bySpecies = new Map<number, number[]>(),
      dead: number[] = [];
    if (tile.groups) {
      for (const step of this.steps(tile, distance)) step();
      return;
    }
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
    if (distance <= this.#detailReach) for (const d of tile.density) this.#density(tile, d);
  }

  /** Tiles within this distance of the camera write their detail densities (detail is drawn much closer). */
  get #detailReach(): number {
    return Math.max(Math.min(this.#options.radius, 300), this.#options.detailRadius + this.#placement.tileSize);
  }

  /**
   * The work of `add` as small steps (one species' records, one detail map, each well under a tenth of a millisecond),
   * for a caller that spreads a tile over frames: run them in order. Each species is replaced in one step, so the
   * tile's old objects stay drawn until their new ones are in. Detail densities are written for tiles within 300 m
   * (or a tile beyond the detail radius); add the tile again when it comes closer.
   */
  steps(tile: PlacedTile, distance = 0): (() => void)[] {
    if (!tile.groups) return [() => this.add(tile, distance)];
    const key = `${tile.x},${tile.z}`,
      records = new Map<ScatterTiles, Uint8Array>(),
      out: (() => void)[] = [];
    for (const g of tile.groups) {
      const entry = g.dead ? this.#snags : this.#species.get(tile.species[g.species]);
      if (!entry || distance > entry.radius) continue;
      const t = entry.tiles[0],
        n = g.records.length >> 3;
      if (n > t.slotSize) this.dropped += n - t.slotSize;
      records.set(t, n > t.slotSize ? g.records.subarray(0, t.slotSize * 8) : g.records);
    }
    const held = this.#held.has(key);
    for (const entry of [...this.#species.values(), ...(this.#snags ? [this.#snags] : [])]) {
      const t = entry.tiles[0],
        r = records.get(t);
      if (r) out.push(() => t.setTile(key, tile.origin, tile.size, r));
      else if (held) out.push(() => t.removeTile(key));
    }
    out.push(() => this.#held.set(key, tile.count));
    if (distance <= this.#detailReach) for (const d of tile.density) out.push(() => this.#density(tile, d));
    return out;
  }

  /** One detail density map of a tile into its world-wide texture (one texel every detailResolution metres). */
  #density(tile: PlacedTile, d: PlacedTile['density'][number]): void {
    const entry = this.#details.find((e) => e.id === d.id);
    if (!entry) return;
    const res = this.#options.detailResolution,
      [x0, z0, x1] = this.#options.bounds,
      width = Math.ceil((x1 - x0) / res), // float division: view only
      depth = entry.data.length / width, // float division: exact
      cells = Math.round(Math.sqrt(d.data.length)),
      step = tile.size / cells, // float division: metres per cell
      every = Math.max(1, Math.round(res / step)), // float division: view only
      n = Math.ceil(cells / every), // float division: view only
      us = new Int32Array(n),
      vs = new Int32Array(n);
    // The texel of every sampled column and row, once.
    for (let i = 0; i < n; i++) {
      us[i] = Math.floor((tile.origin[0] + i * every * step - x0) / res); // float division: view only
      vs[i] = Math.floor((tile.origin[1] + i * every * step - z0) / res); // float division: view only
    }
    const device = (this.#engine as unknown as { gpu?: GPUDevice }).gpu,
      s = d.sampled;
    if (
      s?.every === every &&
      us[0] >= 0 &&
      vs[0] >= 0 &&
      us[n - 1] === us[0] + n - 1 &&
      vs[n - 1] === vs[0] + n - 1 &&
      us[n - 1] < width &&
      vs[n - 1] < depth
    ) {
      // Sampled by the worker for this texel grid and inside the texture: rows in, and the upload straight from it.
      for (let j = 0; j < n; j++) entry.data.set(s.data.subarray(j * n, (j + 1) * n), (vs[0] + j) * width + us[0]);
      if (entry.texture && device)
        device.queue.writeTexture(
          { texture: entry.texture, origin: [us[0], vs[0]] },
          s.data as Uint8Array<ArrayBuffer>,
          { bytesPerRow: n },
          [n, n],
        );
      return;
    }
    let u0 = Infinity,
      u1 = -1,
      v0 = Infinity,
      v1 = -1;
    for (let j = 0; j < n; j++) {
      const v = vs[j];
      if (v < 0 || v >= depth) continue;
      for (let i = 0; i < n; i++) {
        const u = us[i];
        if (u < 0 || u >= width) continue;
        entry.data[v * width + u] = d.data[j * every * cells + i * every];
        if (u < u0) u0 = u;
        if (u > u1) u1 = u;
      }
      if (v < v0) v0 = v;
      if (v > v1) v1 = v;
    }
    // Upload the texels the tile covers from a compact copy (the texture is made on the first frame that reads it).
    if (!entry.texture || !device || u1 < u0 || v1 < v0) return;
    const w = u1 - u0 + 1,
      h = v1 - v0 + 1,
      block = new Uint8Array(w * h);
    for (let v = 0; v < h; v++) block.set(entry.data.subarray((v0 + v) * width + u0, (v0 + v) * width + u0 + w), v * w);
    device.queue.writeTexture({ texture: entry.texture, origin: [u0, v0] }, block, { bytesPerRow: w }, [w, h]);
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
