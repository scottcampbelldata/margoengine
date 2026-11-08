/// <reference lib="esnext.disposable" preserve="true" />
// @margoengine/voxel/smooth: smooth voxel terrain in chunks. A signed density per cell (solid above 0) and a material
// per cell, streamed by chunk like a VoxelWorld, meshed per chunk with Surface Nets (the method of voxel-edit's
// smoothGrid, Gibson 1998) and drawn as core meshes, one per chunk and material, beside block worlds.
import type { Engine, Mesh, PbrMaterial } from '@margoengine/core';
import { Geometry } from '@margoengine/core';
import type { Vec3 } from '@margoengine/math';
import { MargoError } from '@margoengine/math/errors';

const N = 32,
  CELLS = N * N * N,
  // Density is stored in 1/127ths, -127 (air) to 127 (solid); the surface lies at 0.
  SCALE = 127;

const isChunk = (c: number): boolean => (c << 5) >> 5 === c;
const keyOf = (cx: number, cy: number, cz: number): string => `${cx},${cy},${cz}`;

/** One chunk of a {@link SmoothTerrain}: 32 x 32 x 32 densities and materials, index `x + 32 z + 1024 y`. */
export interface SmoothChunk {
  /** Density in 1/127ths: below 0 air, above 0 solid, the surface where it crosses 0. */
  readonly density: Int8Array;
  /** Material index per cell, 0 to 255 (the view's `materials`). */
  readonly material: Uint8Array;
}

/** Options of {@link SmoothTerrain}. */
export interface SmoothTerrainOptions {
  /** Lowest and highest chunk y, inclusive. Default -4 and 7 (y -128 to 255). */
  minChunkY?: number;
  maxChunkY?: number;
}

/**
 * A density field `(x, y, z) => density` for {@link SmoothTerrain.addChunk}: positive inside, negative outside, about
 * the signed distance in blocks near the surface (clamped to -1..1 when stored). A material function picks each cell's
 * material.
 */
export type DensityField = (x: number, y: number, z: number) => number;

/**
 * Smooth voxel terrain: chunks of signed densities and materials, loaded and unloaded by chunk, edited by sculpting.
 * Every change marks the chunks whose mesh it touches in {@link SmoothTerrain.dirty} (a chunk and the neighbours that
 * read its border cells), which {@link SmoothTerrainView} meshes.
 */
export class SmoothTerrain {
  /** Keys (`'cx,cy,cz'`) of chunks to mesh again. A removed chunk's key stays until its mesh is dropped. */
  readonly dirty = new Set<string>();
  readonly minChunkY: number;
  readonly maxChunkY: number;
  #chunks = new Map<string, SmoothChunk>();

  /** @throws RangeError when the chunk y range is not whole numbers with min <= max. */
  constructor(options: SmoothTerrainOptions = {}) {
    if (!options || typeof options !== 'object')
      throw new TypeError('SmoothTerrain options must be an object; pass {} or {minChunkY, maxChunkY}');
    const { minChunkY = -4, maxChunkY = 7 } = options;
    if (!isChunk(minChunkY) || !isChunk(maxChunkY) || minChunkY > maxChunkY)
      throw new RangeError(`SmoothTerrain chunk y range ${minChunkY} to ${maxChunkY}; pass whole numbers, min <= max`);
    this.minChunkY = minChunkY;
    this.maxChunkY = maxChunkY;
  }

  /** Keys of the loaded chunks. */
  keys(): IterableIterator<string> {
    return this.#chunks.keys();
  }

  /** The chunk at chunk coordinates, or undefined when it is not loaded. */
  getChunk(cx: number, cy: number, cz: number): SmoothChunk | undefined {
    return this.#chunks.get(keyOf(cx, cy, cz));
  }

  /**
   * Loads chunk (cx, cy, cz), filled from `density` (and `material`, default 0) sampled at each cell's integer world
   * coordinates, or all air. Replaces a loaded chunk.
   * @throws TypeError when `density` or `material` is not a function.
   * @throws RangeError for coordinates outside the chunk range or a material outside 0 to 255.
   */
  addChunk(cx: number, cy: number, cz: number, density?: DensityField, material?: DensityField): SmoothChunk {
    this.#checkChunk(cx, cy, cz);
    if (density !== undefined && typeof density !== 'function')
      throw new TypeError('SmoothTerrain.addChunk density must be a function (x, y, z) => number');
    if (material !== undefined && typeof material !== 'function')
      throw new TypeError('SmoothTerrain.addChunk material must be a function (x, y, z) => number');
    const chunk: SmoothChunk = { density: new Int8Array(CELLS).fill(-SCALE), material: new Uint8Array(CELLS) };
    if (density || material)
      for (let y = 0, i = 0; y < N; y++)
        for (let z = 0; z < N; z++)
          for (let x = 0; x < N; x++, i++) {
            const wx = cx * N + x,
              wy = cy * N + y,
              wz = cz * N + z;
            if (density) chunk.density[i] = quantize(density(wx, wy, wz));
            if (material) chunk.material[i] = checkMaterial(material(wx, wy, wz));
          }
    this.#chunks.set(keyOf(cx, cy, cz), chunk);
    this.#touch(cx, cy, cz);
    return chunk;
  }

  /** Unloads chunk (cx, cy, cz); its key and its neighbours' go to `dirty`. Returns the chunk, if it was loaded. */
  removeChunk(cx: number, cy: number, cz: number): SmoothChunk | undefined {
    this.#checkChunk(cx, cy, cz);
    const key = keyOf(cx, cy, cz),
      chunk = this.#chunks.get(key);
    if (!chunk) return undefined;
    this.#chunks.delete(key);
    this.#touch(cx, cy, cz);
    return chunk;
  }

  /** The density at a world cell, -1 to 1, or undefined in an unloaded chunk. */
  getDensity(x: number, y: number, z: number): number | undefined {
    const chunk = this.#chunks.get(keyOf(x >> 5, y >> 5, z >> 5));
    return chunk && chunk.density[(x & 31) + ((z & 31) << 5) + ((y & 31) << 10)] / SCALE;
  }

  /** The material at a world cell, or undefined in an unloaded chunk. */
  getMaterial(x: number, y: number, z: number): number | undefined {
    const chunk = this.#chunks.get(keyOf(x >> 5, y >> 5, z >> 5));
    return chunk?.material[(x & 31) + ((z & 31) << 5) + ((y & 31) << 10)];
  }

  /**
   * Adds (`strength` > 0) or carves (`strength` < 0) a smooth ball: each cell within `radius` of `center` moves toward
   * solid or air by `strength` times its closeness (1 at the centre, 0 at the radius), clamped to -1..1. Added solid
   * takes `material` where a cell turns solid. Cells in unloaded chunks are skipped. Returns the cells changed.
   * @throws RangeError for a non-finite centre, a radius outside 0 to 64, a strength outside -2 to 2 or a bad material.
   */
  sculpt(center: Vec3, radius: number, strength: number, material = 0): number {
    if (!center || center.length !== 3 || ![0, 1, 2].every((i) => Number.isFinite(center[i])))
      throw new RangeError('SmoothTerrain.sculpt center must be three finite numbers; pass [x, y, z]');
    if (!(radius > 0 && radius <= 64)) throw new RangeError(`SmoothTerrain.sculpt radius is ${radius}; pass 0 to 64`);
    if (!(strength >= -2 && strength <= 2))
      throw new RangeError(`SmoothTerrain.sculpt strength is ${strength}; pass -2 to 2`);
    checkMaterial(material);
    let changed = 0;
    const [ox, oy, oz] = center;
    for (let y = Math.ceil(oy - radius); y <= Math.floor(oy + radius); y++)
      for (let z = Math.ceil(oz - radius); z <= Math.floor(oz + radius); z++)
        for (let x = Math.ceil(ox - radius); x <= Math.floor(ox + radius); x++) {
          const d = Math.hypot(x - ox, y - oy, z - oz);
          if (d >= radius) continue;
          const cx = x >> 5,
            cy = y >> 5,
            cz = z >> 5,
            chunk = this.#chunks.get(keyOf(cx, cy, cz));
          if (!chunk) continue;
          const i = (x & 31) + ((z & 31) << 5) + ((y & 31) << 10),
            before = chunk.density[i],
            after = Math.max(-SCALE, Math.min(SCALE, Math.round(before + strength * (1 - d / radius) * SCALE)));
          if (after === before) continue;
          chunk.density[i] = after;
          if (strength > 0 && before <= 0 && after > 0) chunk.material[i] = material;
          changed++;
          this.#touchCell(x, y, z);
        }
    return changed;
  }

  #checkChunk(cx: number, cy: number, cz: number): void {
    if (![cx, cy, cz].every(isChunk) || cy < this.minChunkY || cy > this.maxChunkY)
      throw new RangeError(
        `SmoothTerrain chunk ${cx},${cy},${cz} is out of range; pass whole numbers, y from ${this.minChunkY} to ${this.maxChunkY}`,
      );
  }

  // A chunk and its 26 neighbours read each other's border cells.
  #touch(cx: number, cy: number, cz: number): void {
    for (let dy = -1; dy <= 1; dy++)
      for (let dz = -1; dz <= 1; dz++)
        for (let dx = -1; dx <= 1; dx++) {
          const key = keyOf(cx + dx, cy + dy, cz + dz);
          if ((dx || dy || dz) && !this.#chunks.has(key)) continue;
          this.dirty.add(key);
        }
  }

  // The chunks whose mesh reads cell (x, y, z): its own, and the lower neighbours when it is on their border.
  #touchCell(x: number, y: number, z: number): void {
    const lx = x & 31,
      ly = y & 31,
      lz = z & 31;
    for (let dy = ly === 0 ? -1 : 0; dy <= (ly === 31 ? 1 : 0); dy++)
      for (let dz = lz === 0 ? -1 : 0; dz <= (lz === 31 ? 1 : 0); dz++)
        for (let dx = lx === 0 ? -1 : 0; dx <= (lx === 31 ? 1 : 0); dx++) {
          const key = keyOf((x >> 5) + dx, (y >> 5) + dy, (z >> 5) + dz);
          if (this.#chunks.has(key)) this.dirty.add(key);
        }
  }
}

function quantize(value: number): number {
  if (typeof value !== 'number' || Number.isNaN(value))
    throw new RangeError(`SmoothTerrain density is ${value}; return a number (positive inside)`);
  return Math.round(Math.max(-1, Math.min(1, value)) * SCALE);
}

function checkMaterial(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 255)
    throw new RangeError(`SmoothTerrain material is ${value}; pass a whole number from 0 to 255`);
  return value;
}

/**
 * Output of {@link meshSmoothChunk}: triangles in chunk-local blocks (the chunk's corner at the origin), grouped by
 * material. Surface points sit at the mean of their net cell's edge crossings; normals follow the density gradient.
 */
export interface SmoothChunkMesh {
  /** Per material index present: xyz positions, xyz normals and triangle indices. */
  parts: Map<number, { positions: Float32Array; normals: Float32Array; indices: Uint32Array }>;
  /** Triangles in all parts. */
  triangles: number;
}

// Corner offsets of a net cell in the 34^3 sample volume (x 1, z 34, y 1156), bit order x = 1, y = 2, z = 4.
const SZ = 34,
  SY = 1156;

/**
 * Meshes chunk `key` of `terrain` with Surface Nets: one point per net cell the surface crosses (the cell between eight
 * samples), placed at the mean of its edge crossings, and one quad per pair of neighbouring samples across the surface
 * whose lower sample lies in the chunk, joining the four net cells around that edge, split into two triangles. Samples
 * one cell past the chunk come from the loaded neighbours, so neighbouring chunks share their border points exactly and
 * the surface has no seams; past an unloaded neighbour the chunk's own border samples repeat (no wall there). Each
 * quad takes the material of its solid sample. Undefined when the chunk is not loaded.
 * @throws RangeError when `key` is not three chunk coordinates.
 */
export function meshSmoothChunk(terrain: SmoothTerrain, key: string): SmoothChunkMesh | undefined {
  if (!(terrain instanceof SmoothTerrain))
    throw new TypeError('meshSmoothChunk expects a SmoothTerrain and a key; pass (terrain, "cx,cy,cz")');
  const c = /^(-?\d+),(-?\d+),(-?\d+)$/.exec(String(key))?.slice(1).map(Number);
  if (!c?.every(isChunk))
    throw new RangeError(`Chunk key "${key}" is not three chunk coordinates; pass 'cx,cy,cz' as terrain.keys() gives`);
  const [cx, cy, cz] = c,
    own = terrain.getChunk(cx, cy, cz);
  if (!own) return undefined;
  // Samples -1..32 in each axis.
  const density = new Float32Array(SZ * SZ * SZ),
    material = new Uint8Array(SZ * SZ * SZ);
  for (let Y = 0; Y < SZ; Y++)
    for (let Z = 0; Z < SZ; Z++)
      for (let X = 0; X < SZ; X++) {
        let x = X - 1,
          y = Y - 1,
          z = Z - 1,
          chunk = own;
        if (x < 0 || x > 31 || y < 0 || y > 31 || z < 0 || z > 31) {
          const near = terrain.getChunk(cx + (x >> 5), cy + (y >> 5), cz + (z >> 5));
          if (near) chunk = near;
          else {
            x = Math.max(0, Math.min(31, x));
            y = Math.max(0, Math.min(31, y));
            z = Math.max(0, Math.min(31, z));
          }
        }
        const i = (x & 31) + ((z & 31) << 5) + ((y & 31) << 10),
          p = X + Z * SZ + Y * SY;
        density[p] = chunk.density[i] / SCALE;
        material[p] = chunk.material[i];
      }
  const corner = [0, 1, SY, SY + 1, SZ, SZ + 1, SZ + SY, SZ + SY + 1],
    // Net cell (i, j, k), i from -1 to 31, has samples i..i + 1: id (i + 1) + 33 (k + 1) + 1089 (j + 1).
    ids = new Int32Array(33 * 33 * 33).fill(-1),
    points: number[] = [],
    normals: number[] = [];
  for (let j = -1; j < 32; j++)
    for (let k = -1; k < 32; k++)
      for (let i = -1; i < 32; i++) {
        const base = i + 1 + (k + 1) * SZ + (j + 1) * SY;
        let mask = 0;
        for (let n = 0; n < 8; n++) if (density[base + corner[n]] > 0) mask |= 1 << n;
        if (mask === 0 || mask === 255) continue;
        let sx = 0,
          sy = 0,
          sz = 0,
          crossings = 0;
        const g = [0, 0, 0];
        for (let n = 0; n < 8; n++) {
          const a = density[base + corner[n]];
          g[0] += n & 1 ? a : -a;
          g[1] += n & 2 ? a : -a;
          g[2] += n & 4 ? a : -a;
          for (let axis = 1; axis <= 4; axis <<= 1) {
            if (n & axis) continue;
            const b = density[base + corner[n | axis]];
            if (a > 0 === b > 0) continue;
            const t = a / (a - b);
            crossings++;
            sx += (n & 1 ? 1 : 0) + (axis === 1 ? t : 0);
            sy += (n & 2 ? 1 : 0) + (axis === 2 ? t : 0);
            sz += (n & 4 ? 1 : 0) + (axis === 4 ? t : 0);
          }
        }
        ids[i + 1 + (k + 1) * 33 + (j + 1) * 1089] = points.length / 3;
        points.push(i + sx / crossings, j + sy / crossings, k + sz / crossings);
        const len = Math.hypot(g[0], g[1], g[2]) || 1;
        normals.push(-g[0] / len, -g[1] / len, -g[2] / len);
      }
  const net = (i: number, j: number, k: number) => ids[i + 1 + (k + 1) * 33 + (j + 1) * 1089],
    quads = new Map<number, number[]>();
  for (let y = 0; y < 32; y++)
    for (let z = 0; z < 32; z++)
      for (let x = 0; x < 32; x++) {
        const p = x + 1 + (z + 1) * SZ + (y + 1) * SY,
          inside = density[p] > 0;
        // Axis 0 (x), 1 (y), 2 (z): the edge to the next sample; its four net cells lie at -1 and 0 along u and v.
        for (let a = 0; a < 3; a++) {
          const q = p + (a === 0 ? 1 : a === 1 ? SY : SZ);
          if (inside === density[q] > 0) continue;
          const at = [x, y, z],
            u = (a + 1) % 3,
            v = (a + 2) % 3,
            cell = (du: number, dv: number) => {
              const n = [at[0], at[1], at[2]];
              n[u] += du - 1;
              n[v] += dv - 1;
              return net(n[0], n[1], n[2]);
            },
            ring = [cell(0, 0), cell(1, 0), cell(1, 1), cell(0, 1)];
          // Counterclockwise seen from the air side.
          if (!inside) ring.reverse();
          const m = material[inside ? p : q];
          let list = quads.get(m);
          if (!list) quads.set(m, (list = []));
          list.push(...ring);
        }
      }
  const parts: SmoothChunkMesh['parts'] = new Map();
  let triangles = 0;
  for (const [m, list] of [...quads].sort((a, b) => a[0] - b[0])) {
    const remap = new Map<number, number>(),
      pos: number[] = [],
      nor: number[] = [],
      indices = new Uint32Array((list.length / 4) * 6);
    const local = (id: number) => {
      let at = remap.get(id);
      if (at === undefined) {
        remap.set(id, (at = pos.length / 3));
        pos.push(points[id * 3], points[id * 3 + 1], points[id * 3 + 2]);
        nor.push(normals[id * 3], normals[id * 3 + 1], normals[id * 3 + 2]);
      }
      return at;
    };
    for (let q = 0, o = 0; q < list.length; q += 4) {
      const [a, b, c2, d] = [list[q], list[q + 1], list[q + 2], list[q + 3]].map(local);
      indices.set([a, b, c2, a, c2, d], o);
      o += 6;
    }
    triangles += indices.length / 3;
    parts.set(m, { positions: Float32Array.from(pos), normals: Float32Array.from(nor), indices });
  }
  return { parts, triangles };
}

/** Options of {@link SmoothTerrainView.attach}. */
export interface SmoothTerrainViewOptions {
  /** The terrain to draw. The view meshes the chunks in `terrain.dirty` and removes their keys. */
  terrain: SmoothTerrain;
  /** Core material per material index; an index without one draws with `materials[0]`. */
  materials: readonly PbrMaterial[];
  /** Most chunks meshed per {@link SmoothTerrainView.update}, nearest the camera first. Default 4. */
  budget?: number;
}

/**
 * Draws a {@link SmoothTerrain} as core meshes: one mesh per chunk and material, placed at the chunk's corner. Call
 * {@link SmoothTerrainView.update} each frame (it meshes up to `budget` dirty chunks, nearest the camera first, on this
 * thread); a block world's `VoxelRenderer` draws beside it in the same scene.
 */
export class SmoothTerrainView {
  readonly terrain: SmoothTerrain;
  #engine: Engine;
  #materials: readonly PbrMaterial[];
  #budget: number;
  #meshes = new Map<string, Mesh[]>();
  #disposed = false;

  private constructor(engine: Engine, options: SmoothTerrainViewOptions) {
    this.#engine = engine;
    this.terrain = options.terrain;
    this.#materials = options.materials;
    this.#budget = options.budget ?? 4;
  }

  /**
   * @throws TypeError when `engine` is not an Engine, `terrain` is not a SmoothTerrain or `materials` is empty.
   * @throws RangeError when `budget` is not a whole number of 1 or more.
   */
  static attach(engine: Engine, options: SmoothTerrainViewOptions): SmoothTerrainView {
    if (typeof engine?.createMesh !== 'function') throw new TypeError('SmoothTerrainView.attach expects an Engine');
    if (!(options?.terrain instanceof SmoothTerrain))
      throw new TypeError('SmoothTerrainView terrain must be a SmoothTerrain');
    if (!Array.isArray(options.materials) || !options.materials.length)
      throw new TypeError('SmoothTerrainView materials must be a non-empty array of PbrMaterial');
    const { budget = 4 } = options;
    if (!Number.isInteger(budget) || budget < 1)
      throw new RangeError(`SmoothTerrainView budget is ${budget}; pass a whole number of 1 or more`);
    return new SmoothTerrainView(engine, options);
  }

  /** Chunks drawn, and dirty chunks waiting. */
  get stats(): { chunks: number; meshes: number; pending: number } {
    let meshes = 0;
    for (const list of this.#meshes.values()) meshes += list.length;
    return { chunks: this.#meshes.size, meshes, pending: this.terrain.dirty.size };
  }

  /**
   * Meshes up to `budget` dirty chunks, nearest the camera first, and swaps their core meshes. Returns the chunks done.
   * @throws MargoError `disposed` after dispose().
   */
  update(): number {
    if (this.#disposed) throw new MargoError('disposed', 'SmoothTerrainView is disposed; attach a new one');
    const { dirty } = this.terrain;
    if (!dirty.size) return 0;
    const eye = this.#engine.camera.position,
      distance = (key: string) => {
        const [x, y, z] = key.split(',').map(Number);
        return Math.hypot(x * N + 16 - eye[0], y * N + 16 - eye[1], z * N + 16 - eye[2]);
      },
      keys = [...dirty].sort((a, b) => distance(a) - distance(b)).slice(0, this.#budget);
    for (const key of keys) {
      dirty.delete(key);
      this.#drop(key);
      const mesh = meshSmoothChunk(this.terrain, key);
      if (!mesh) continue;
      const [cx, cy, cz] = key.split(',').map(Number),
        list: Mesh[] = [];
      for (const [m, part] of mesh.parts) {
        if (part.positions.length < 9) continue;
        const core = this.#engine
          .createMesh()
          .setGeometry(new Geometry(part.positions, part.normals, part.indices))
          .setMaterial(this.#materials[m] ?? this.#materials[0]);
        core.position.set(cx * N, cy * N, cz * N);
        list.push(core);
      }
      if (list.length) this.#meshes.set(key, list);
    }
    return keys.length;
  }

  #drop(key: string): void {
    for (const mesh of this.#meshes.get(key) ?? []) mesh.dispose();
    this.#meshes.delete(key);
  }

  /** Removes every chunk mesh from the engine. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const key of [...this.#meshes.keys()]) this.#drop(key);
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}
