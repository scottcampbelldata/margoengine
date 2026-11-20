/// <reference lib="esnext.disposable" preserve="true" />
// @margoengine/voxel/smooth-lod: far levels of detail for smooth terrain, the smooth form of `./lod`. Level L
// (1..levels) samples the density field every 2^L blocks, so one node (32 cubed samples) covers 32 * 2^L blocks and is
// meshed with Surface Nets like a SmoothTerrain chunk. Nodes form the same octree as `VoxelLod` (split when the eye is
// nearer than `radius` child sizes, so neighbouring nodes differ by at most one level), level 1 leaves out the 32-block
// boxes the real terrain has loaded, and a level change keeps the old nodes until the new ones are made. Every node
// mesh is clipped to its box and its faces closed by caps (the solid part of each face plane), so every node mesh
// bounds a closed solid and no ray from the air passes between two levels.
import type { Engine, Mesh, PbrMaterial } from '@margoengine/core';
import { Geometry } from '@margoengine/core';
import type { Vec3 } from '@margoengine/math';
import { MargoError } from '@margoengine/math/errors';
import { checkOrigin, originPoint } from './origin.js';
import type { VoxelOrigin } from './render.js';
import { type ClipBox, G, meshClipped } from './smooth-clip.js';
import { type DensityField, type SmoothChunkMesh, type SmoothMeshPart, SmoothTerrain } from './smooth.js';

/** Options of {@link SmoothLod.attach}. */
export interface SmoothLodOptions {
  /** The real terrain (level 0): level 1 leaves out the 32-block boxes of its loaded chunks. */
  terrain: SmoothTerrain;
  /** The density in world blocks, positive inside: the field the real chunks were filled from. */
  density: DensityField;
  /** Material per world block, 0 to 255. Default 0 everywhere. */
  material?: DensityField;
  /** Core material per material index, as `SmoothTerrainView`. Needed unless `createMesh` is given. */
  materials?: readonly PbrMaterial[];
  /**
   * Makes the mesh of one node part in place of a core mesh, as `SmoothTerrainView` `createMesh`; `part` is in the
   * node's own blocks, `origin` its corner in engine space and `level` its level. Default: a core mesh with
   * `materials[material]` (or `materials[0]`).
   */
  createMesh?: (part: SmoothMeshPart, material: number, origin: Vec3, level: number) => { dispose(): void };
  /** Far levels, an integer in 1..12. Default 4. */
  levels?: number;
  /**
   * Nodes of a level from the eye before the next coarser level takes over, an integer in 2..32, as `VoxelLod`: the
   * view reaches `radius * 32 * 2^levels` blocks. Keep `2 * radius` above the streamed chunk distance + 1. Default 8.
   */
  radius?: number;
  /** Lowest block y the far levels hold. Default -64. */
  minY?: number;
  /** Highest block y the far levels hold. Default 255. */
  maxY?: number;
  /** Most nodes meshed per {@link SmoothLod.update}, an integer >= 1 or Infinity. Default 8. */
  budget?: number;
  /**
   * How far each face's cap reaches from the node's border into the solid, in cells of the node's level, 0 to 32.
   * Default 32: the whole face, so each node mesh bounds a closed solid and every seam is closed whatever the ground does
   * there. A smaller depth draws fewer hidden triangles but can leave a gap where the ground runs nearly parallel to a
   * node face; 0 leaves the faces open.
   */
  skirt?: number;
  /** Origin rebasing, as `SmoothTerrainViewOptions.origin`. Default null. */
  origin?: VoxelOrigin | null;
}

/** What a {@link SmoothLod} holds. */
export interface SmoothLodStats {
  /** Nodes on show per level (index 0 is level 1). */
  readonly nodes: readonly number[];
  /** Wanted nodes not meshed yet, and level-1 nodes waiting to be meshed again for the real terrain. */
  readonly pending: number;
  /** Meshes drawn. */
  readonly meshes: number;
}

/** Options of {@link meshSmoothLodNode}. */
export interface SmoothLodNodeOptions {
  /** Material per world block. Default 0. */
  material?: DensityField;
  /** Cap depth in cells of the level, 0 to 32, as {@link SmoothLodOptions.skirt}. Default 32 (closed). */
  skirt?: number;
  /**
   * Bit k (0..7) set leaves out octant k (x = bit 0, y = bit 1, z = bit 2), 16 cells per axis: the level-1 boxes the real
   * terrain draws. Default 0.
   */
  mask?: number;
}

const whole = (name: string, value: unknown, min: number, max: number): number => {
  if (typeof value !== 'number') throw new TypeError(`SmoothLod ${name} must be a number`);
  if (!(value === max || (Number.isInteger(value) && value >= min && value <= max)))
    throw new RangeError(`SmoothLod ${name} is ${value}; pass an integer in ${min}..${max}`);
  return value;
};

const skirtOf = (value: unknown): number => {
  if (typeof value !== 'number' || !(value >= 0 && value <= 32))
    throw new RangeError(`SmoothLod skirt is ${value}; pass a depth from 0 to 32 cells`);
  return value;
};

// Chebyshev distance from e to the span [lo, lo + size) (0 inside).
const gap = (e: number, lo: number, size: number): number => Math.max(lo - e, e - (lo + size), 0);

/**
 * Meshes node (x, y, z) of far level `level` (1..12): `density` sampled every 2^level blocks from the node's corner
 * (32 x 2^level, ...), one sample past each face, divided by 2^level and clamped to -1..1 so it stays about the distance
 * in cells; Surface Nets, the triangles clipped to the node's box (or to its octants left in by `mask`), caps on every
 * box face. Positions are in the node's own blocks.
 * @throws TypeError when `density` or `material` is not a function; RangeError for a level outside 1..12, node
 * coordinates that are not whole numbers, a skirt outside 0 to 32, a mask outside 0..255, a NaN density or a material
 * outside 0 to 255.
 */
export function meshSmoothLodNode(
  density: DensityField,
  level: number,
  x: number,
  y: number,
  z: number,
  options: SmoothLodNodeOptions = {},
): SmoothChunkMesh {
  if (typeof density !== 'function') throw new TypeError('meshSmoothLodNode density must be a function (x, y, z)');
  if (!Number.isInteger(level) || level < 1 || level > 12)
    throw new RangeError(`meshSmoothLodNode level is ${level}; pass an integer in 1..12`);
  if (![x, y, z].every(Number.isSafeInteger))
    throw new RangeError(`meshSmoothLodNode node ${x},${y},${z}; pass whole numbers`);
  const { material, skirt = 32, mask = 0 } = options ?? {};
  if (material !== undefined && typeof material !== 'function')
    throw new TypeError('meshSmoothLodNode material must be a function (x, y, z)');
  skirtOf(skirt);
  if (!Number.isInteger(mask) || mask < 0 || mask > 255)
    throw new RangeError(`meshSmoothLodNode mask is ${mask}; pass an integer in 0..255`);
  const s = 2 ** level,
    d = new Float32Array(G * G * G),
    m = new Uint8Array(G * G * G),
    x0 = x * 32 * s,
    y0 = y * 32 * s,
    z0 = z * 32 * s;
  for (let Y = 0, p = 0; Y < G; Y++)
    for (let Z = 0; Z < G; Z++)
      for (let X = 0; X < G; X++, p++) {
        const wx = x0 + (X - 1) * s,
          wy = y0 + (Y - 1) * s,
          wz = z0 + (Z - 1) * s,
          v = density(wx, wy, wz);
        if (typeof v !== 'number' || Number.isNaN(v))
          throw new RangeError(`SmoothLod density is ${v}; return a number (positive inside)`);
        d[p] = Math.max(-1, Math.min(1, v / s));
        if (material) {
          const k = material(wx, wy, wz);
          if (!Number.isInteger(k) || k < 0 || k > 255)
            throw new RangeError(`SmoothLod material is ${k}; return a whole number from 0 to 255`);
          m[p] = k;
        }
      }
  const boxes: ClipBox[] = [];
  if (!mask) boxes.push({ lo: [0, 0, 0], hi: [32, 32, 32], skirts: 63 });
  else
    for (let k = 0; k < 8; k++) {
      if (mask & (1 << k)) continue;
      const lo: [number, number, number] = [(k & 1) * 16, ((k >> 1) & 1) * 16, (k >> 2) * 16];
      // No cap on a face shared with another octant that is drawn: the two meet exactly there.
      let skirts = 0;
      for (let f = 0; f < 6; f++) {
        const a = f >> 1,
          bit = a === 0 ? 1 : a === 1 ? 2 : 4,
          inner = f & 1 ? !(k & bit) : !!(k & bit);
        if (!inner || mask & (1 << (k ^ bit))) skirts |= 1 << f;
      }
      boxes.push({ lo, hi: [lo[0] + 16, lo[1] + 16, lo[2] + 16], skirts });
    }
  return meshClipped(d, m, boxes, skirt, s);
}

interface Held {
  x: number;
  y: number;
  z: number;
  mask: number;
  meshes: { dispose(): void }[];
}
interface Want {
  level: number;
  x: number;
  y: number;
  z: number;
  key: string;
  d: number;
}

/**
 * Far levels of detail for a {@link SmoothTerrain}: coarse Surface Nets meshes of the same density field around the
 * eye, each level's cells twice the size of the one before, drawn as core meshes (or by `createMesh`). Call
 * {@link SmoothLod.update} every frame. Draw the real terrain with `SmoothTerrainView` option `skirt` so its border
 * with level 1 is closed too.
 */
export class SmoothLod {
  /** Far levels, coarsest last: `scale` is blocks per cell, 2^level. */
  readonly levels: readonly { readonly level: number; readonly scale: number }[];
  readonly terrain: SmoothTerrain;
  /** Live {@link SmoothLodOptions.origin}; null for none. */
  origin: VoxelOrigin | null;
  /** Most nodes meshed per update. Live. */
  budget: number;
  #engine: Engine;
  #density: DensityField;
  #material: DensityField | undefined;
  #materials: readonly PbrMaterial[];
  #create: SmoothLodOptions['createMesh'];
  #radius: number;
  #minY: number;
  #maxY: number;
  #skirt: number;
  #held: Map<string, Held>[];
  #pending = 0;
  #placed: [number, number, number] = [0, 0, 0];
  #disposed = false;

  private constructor(engine: Engine, options: SmoothLodOptions) {
    const { levels = 4, radius = 8, minY = -64, maxY = 255, budget = 8, skirt = 32 } = options;
    whole('levels', levels, 1, 12);
    this.#radius = whole('radius', radius, 2, 32);
    this.#minY = whole('minY', minY, -32768, 32767);
    this.#maxY = whole('maxY', maxY, -32768, 32767);
    if (minY > maxY) throw new RangeError(`SmoothLod minY ${minY} is above maxY ${maxY}; pass minY <= maxY`);
    this.budget = whole('budget', budget, 1, Infinity);
    this.#skirt = skirtOf(skirt);
    this.#engine = engine;
    this.terrain = options.terrain;
    this.#density = options.density;
    this.#material = options.material;
    this.#materials = options.materials ?? [];
    this.#create = options.createMesh;
    this.origin = checkOrigin(options.origin, 'SmoothLod');
    this.levels = Array.from({ length: levels }, (_, i) => ({ level: i + 1, scale: 2 ** (i + 1) }));
    this.#held = this.levels.map(() => new Map());
  }

  /**
   * @throws TypeError when `engine` is not an Engine, `terrain` is not a SmoothTerrain, `density`, `material` or
   *   `createMesh` is not a function, `materials` is empty without `createMesh`, or `origin` is not null or an object
   *   with `origin`.
   * @throws RangeError for an option out of range, or `minY` above `maxY`.
   */
  static attach(engine: Engine, options: SmoothLodOptions): SmoothLod {
    if (typeof engine?.createMesh !== 'function') throw new TypeError('SmoothLod.attach expects an Engine');
    if (!options || typeof options !== 'object') throw new TypeError('SmoothLod expects {terrain, density, materials}');
    if (!(options.terrain instanceof SmoothTerrain)) throw new TypeError('SmoothLod terrain must be a SmoothTerrain');
    if (typeof options.density !== 'function')
      throw new TypeError('SmoothLod density must be a function (x, y, z) => number, the field of the real terrain');
    if (options.material !== undefined && typeof options.material !== 'function')
      throw new TypeError('SmoothLod material must be a function (x, y, z) => material');
    if (options.createMesh !== undefined && typeof options.createMesh !== 'function')
      throw new TypeError('SmoothLod createMesh must be a function (part, material, origin, level) => mesh');
    if (!options.createMesh && (!Array.isArray(options.materials) || !options.materials.length))
      throw new TypeError('SmoothLod materials must be a non-empty array of PbrMaterial, or pass createMesh');
    return new SmoothLod(engine, options);
  }

  /** Nodes on show per level, wanted nodes still to mesh, and meshes drawn. */
  get stats(): SmoothLodStats {
    let meshes = 0;
    const nodes = this.#held.map((held) => {
      for (const node of held.values()) meshes += node.meshes.length;
      return held.size;
    });
    return { nodes, pending: this.#pending, meshes };
  }

  /**
   * Chooses the nodes for `eye` (world blocks; default the engine camera plus the origin), meshes up to `budget` of the
   * missing ones nearest first (level-1 nodes whose real chunks loaded or unloaded count too), and drops a node no
   * longer wanted once no missing node overlaps it, so a level change never opens a hole. Moves the meshes when the
   * origin moved. Returns the nodes meshed: 0 once everything is current.
   * @throws MargoError `disposed` after dispose(); TypeError when `eye` is not three finite numbers; errors of the
   * fields propagate.
   */
  update(eye?: Vec3): number {
    if (this.#disposed) throw new MargoError('disposed', 'SmoothLod is disposed; attach a new one');
    const shift = originPoint(this.origin, 'SmoothLod');
    if (shift.some((v, a) => v !== this.#placed[a])) {
      this.#placed = shift;
      for (let l = 0; l < this.#held.length; l++)
        for (const held of this.#held[l].values()) {
          const size = 32 << (l + 1),
            moved = held.meshes.every((mesh) => {
              const position = (mesh as { position?: { set?(x: number, y: number, z: number): unknown } }).position;
              if (typeof position?.set !== 'function') return false;
              position.set(held.x * size - shift[0], held.y * size - shift[1], held.z * size - shift[2]);
              return true;
            });
          if (!moved) held.mask = -1; // made again below
        }
    }
    const camera = this.#engine.camera.position,
      e = eye ?? [camera[0] + shift[0], camera[1] + shift[1], camera[2] + shift[2]],
      ex = Number(e[0]),
      ey = Number(e[1]),
      ez = Number(e[2]);
    if (![ex, ey, ez].every(Number.isFinite)) throw new TypeError('SmoothLod.update expects the eye as [x, y, z]');
    const wanted = this.levels.map(() => new Map<string, Want>()),
      r = this.#radius,
      top = this.levels.length,
      visit = (level: number, x: number, y: number, z: number): void => {
        const size = 32 << level,
          d = Math.max(gap(ex, x * size, size), gap(ey, y * size, size), gap(ez, z * size, size));
        if (level >= 2 && d < (r * size) / 2) {
          for (let k = 0; k < 8; k++) visit(level - 1, 2 * x + (k & 1), 2 * y + ((k >> 1) & 1), 2 * z + (k >> 2));
          return;
        }
        if ((y + 1) * size <= this.#minY || y * size > this.#maxY) return;
        const key = `${x},${y},${z}`;
        wanted[level - 1].set(key, { level, x, y, z, key, d });
      };
    const size = 32 << top,
      reach = r * size,
      lo = (v: number) => Math.floor((v - reach) / size),
      hi = (v: number) => Math.floor((v + reach) / size),
      ylo = Math.max(lo(ey), Math.floor(this.#minY / size)),
      yhi = Math.min(hi(ey), Math.floor(this.#maxY / size));
    for (let x = lo(ex); x <= hi(ex); x++)
      for (let z = lo(ez); z <= hi(ez); z++)
        for (let y = ylo; y <= yhi; y++) {
          const d = Math.max(gap(ex, x * size, size), gap(ey, y * size, size), gap(ez, z * size, size));
          if (d < reach) visit(top, x, y, z);
        }
    // Missing nodes and level-1 nodes whose real-terrain mask changed (or that must be made again), nearest first.
    const missing: Want[] = [];
    for (let l = 0; l < top; l++)
      for (const want of wanted[l].values()) {
        const held = this.#held[l].get(want.key);
        if (!held || held.mask !== (l === 0 ? this.#mask(want.x, want.y, want.z) : 0)) missing.push(want);
      }
    missing.sort((a, b) => a.d - b.d);
    let done = 0;
    for (const want of missing) {
      if (done >= this.budget) break;
      this.#make(want, shift);
      done++;
    }
    const left = missing.filter((want) => {
      const held = this.#held[want.level - 1].get(want.key);
      return !held;
    });
    this.#pending = missing.length - done;
    for (let l = 0; l < top; l++) {
      const scale = 32 << (l + 1);
      for (const [key, held] of this.#held[l]) {
        if (wanted[l].has(key)) continue;
        const x0 = held.x * scale,
          y0 = held.y * scale,
          z0 = held.z * scale,
          covered = left.some((w) => {
            const s = 32 << w.level;
            return (
              w.x * s < x0 + scale &&
              x0 < (w.x + 1) * s &&
              w.y * s < y0 + scale &&
              y0 < (w.y + 1) * s &&
              w.z * s < z0 + scale &&
              z0 < (w.z + 1) * s
            );
          });
        if (covered) continue;
        this.#drop(l, key);
      }
    }
    return done;
  }

  // Octants of level-1 node (x, y, z) over loaded real chunks.
  #mask(x: number, y: number, z: number): number {
    let mask = 0;
    for (let k = 0; k < 8; k++)
      if (this.terrain.getChunk(2 * x + (k & 1), 2 * y + ((k >> 1) & 1), 2 * z + (k >> 2))) mask |= 1 << k;
    return mask;
  }

  #make({ level, x, y, z, key }: Want, shift: number[]): void {
    const mask = level === 1 ? this.#mask(x, y, z) : 0;
    this.#drop(level - 1, key);
    const held: Held = { x, y, z, mask, meshes: [] };
    this.#held[level - 1].set(key, held);
    if (mask === 255) return;
    const mesh = meshSmoothLodNode(this.#density, level, x, y, z, {
        material: this.#material,
        skirt: this.#skirt,
        mask,
      }),
      size = 32 << level,
      origin: Vec3 = [x * size - shift[0], y * size - shift[1], z * size - shift[2]];
    for (const [m, part] of mesh.parts) {
      if (part.positions.length < 9) continue;
      if (this.#create) {
        const made = this.#create(part, m, origin, level);
        if (typeof made?.dispose !== 'function')
          throw new TypeError('SmoothLod createMesh must return an object with dispose()');
        held.meshes.push(made);
        continue;
      }
      const core: Mesh = this.#engine
        .createMesh()
        .setGeometry(new Geometry(part.positions, part.normals, part.indices))
        .setMaterial(this.#materials[m] ?? this.#materials[0]);
      core.position.set(origin[0], origin[1], origin[2]);
      held.meshes.push(core);
    }
  }

  #drop(l: number, key: string): void {
    const held = this.#held[l].get(key);
    if (!held) return;
    for (const mesh of held.meshes) mesh.dispose();
    this.#held[l].delete(key);
  }

  /** Removes every node mesh. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (let l = 0; l < this.#held.length; l++) for (const key of [...this.#held[l].keys()]) this.#drop(l, key);
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}
