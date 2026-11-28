/// <reference lib="esnext.disposable" preserve="true" />
// Sparse density grids (`@margoengine/environment/density-volume`): a heterogeneous medium on a sparse grid of 8 x 8 x
// 8 voxel bricks, the leaf layout of OpenVDB (K. Museth, "VDB: High-resolution sparse volumes with dynamic topology",
// ACM Transactions on Graphics 32(3), 2013, https://doi.org/10.1145/2487228.2487235: leaves of 8^3 voxels with z
// fastest, tiles holding one value for a whole block), added to VolumetricFog's froxel grid as its `volumes` medium,
// so it takes the fog's sun, shafts, shadows, clustered lights, phase function, reprojection and integration. Spray
// mist from a flood (`floodMist` of @margoengine/water/flood-bake), smoke or steam baked in Blender or Houdini and
// read by @margoengine/loaders/vdb, or any density a program writes.
//
// On the GPU the grid is a page table over the box of occupied bricks (one u32 a brick: empty, a constant tile value,
// or the brick's slot in the voxel store) and the store itself, 512 floats a brick; a sample at a point maps it to
// index space with the inverse of the grid's index-to-world matrix and filters the eight voxel centres around it
// trilinearly, each through the page table (a dense page table instead of VDB's two upper tree levels: one lookup a
// voxel, bounded by `maxPages`). Splats are Gaussians truncated at three standard deviations.
import type { Vec3 } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import { invertMatrix } from '@margoengine/math/mat4';
import type { VolumetricMediumSource } from './volumetric.js';

declare const GPUBufferUsage: { STORAGE: number; COPY_DST: number };

/** A grid as `parseVDB` of @margoengine/loaders/vdb returns it (only the fields read here). */
export interface DensityVDBGrid {
  name?: string;
  components: number;
  gridClass?: string;
  matrix: ArrayLike<number>;
  leaves: readonly { origin: readonly number[]; mask: Uint8Array; values: ArrayLike<number> }[];
  tiles: readonly { origin: readonly number[]; size: number; value: number | readonly number[]; active: boolean }[];
}

/** Options of {@link DensityVolume}. Invalid values throw RangeError. */
export interface DensityVolumeOptions {
  /** World size of a voxel, metres, 1e-4..1e4 (default 0.5); ignored with `matrix`. */
  voxelSize?: number;
  /** World position of voxel index (0, 0, 0)'s centre (default [0, 0, 0]); ignored with `matrix`. */
  origin?: Vec3;
  /** Column-major 4 x 4 affine matrix from voxel index to world, as a VDB grid's `matrix`. Default from `voxelSize` and `origin`. */
  matrix?: ArrayLike<number>;
  /** Extinction per metre of a voxel value of 1, 0..1e4 (default 1). */
  density?: number;
  /** Scattering albedo, linear RGB 0..1 (default [1, 1, 1]: no absorption, as water mist). */
  color?: Vec3;
  /** Most bricks of 512 voxels held, 1..1,048,576 (default 32,768: 64 MiB of voxels). */
  maxBricks?: number;
  /** Most page table entries (the bricks of the box round every occupied brick), 1..67,108,864 (default 16,777,216). */
  maxPages?: number;
}

/** Options of {@link DensityVolume.splat}. */
export interface DensitySplatOptions {
  /** Standard deviation of each Gaussian in metres, one for all or one per point (default 1). */
  radius?: number | ArrayLike<number>;
  /** Value at each Gaussian's centre, one for all or one per point (default 1). */
  weight?: number | ArrayLike<number>;
}

/** Bricks of 8 voxels a side, as an OpenVDB leaf. */
export const DENSITY_BRICK = 8;
const VOXELS = 512,
  EMPTY = 0xffffffff,
  TILE = 0x80000000,
  SPAN = 1 << 16,
  MAX_DENSITY = 1e4,
  DEFAULT_MAX_BRICKS = 32768,
  DEFAULT_MAX_PAGES = 1 << 24,
  identity = (size: number, o: Vec3) => [size, 0, 0, 0, 0, size, 0, 0, 0, 0, size, 0, o[0], o[1], o[2], 1];
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const within = (v: unknown, fallback: number, lo: number, hi: number, name: string): number => {
  const x = v ?? fallback;
  if (!finite(x) || x < lo || x > hi)
    throw new RangeError(`DensityVolume ${name} must be a number from ${lo} to ${hi}`);
  return x;
};
// A brick's map key: brick coordinates within +-2^16 (voxel indices within +-2^19), 17 bits each, 51 bits in all.
const keyOf = (x: number, y: number, z: number) => ((x + SPAN) * 2 * SPAN + (y + SPAN)) * 2 * SPAN + (z + SPAN);
const brickOf = (key: number): [number, number, number] => {
  const z = key % (2 * SPAN),
    rest = (key - z) / (2 * SPAN),
    y = rest % (2 * SPAN);
  return [(rest - y) / (2 * SPAN) - SPAN, y - SPAN, z - SPAN];
};

// The medium the froxel pass reads (scattering rgb, extinction a); info rows x, y, z map world to index space, lo is
// the page table's lowest brick, dims its size in bricks, look the albedo and the extinction of a value of 1.
const wgsl = (group: number) => /* wgsl */ `
struct DensityInfo {x:vec4f,y:vec4f,z:vec4f,lo:vec4i,dims:vec4i,look:vec4f}
@group(${group}) @binding(0) var<storage,read> densityInfo:DensityInfo;
@group(${group}) @binding(1) var<storage,read> densityPages:array<u32>;
@group(${group}) @binding(2) var<storage,read> densityVoxels:array<f32>;
fn densityVoxel(v:vec3i)->f32 {
  let b=vec3i(floor(vec3f(v)/8.0))-densityInfo.lo.xyz;
  if(any(b<vec3i(0))||any(b>=densityInfo.dims.xyz)){return 0.0;}
  let page=densityPages[u32((b.z*densityInfo.dims.y+b.y)*densityInfo.dims.x+b.x)];
  if(page==0xffffffffu){return 0.0;}
  if(page>=0x80000000u){return densityVoxels[page-0x80000000u];}
  let l=v-(b+densityInfo.lo.xyz)*8;
  return densityVoxels[page*512u+u32((l.x*8+l.y)*8+l.z)];
}
fn fogMedium(p:vec3f)->vec4f {
  if(densityInfo.dims.w==0){return vec4f(0);}
  let q=vec4f(p,1.0);
  let g=vec3f(dot(densityInfo.x,q),dot(densityInfo.y,q),dot(densityInfo.z,q));
  let f=floor(g);let t=g-f;let c=vec3i(f);
  let x0=mix(densityVoxel(c),densityVoxel(c+vec3i(1,0,0)),t.x);
  let x1=mix(densityVoxel(c+vec3i(0,1,0)),densityVoxel(c+vec3i(1,1,0)),t.x);
  let x2=mix(densityVoxel(c+vec3i(0,0,1)),densityVoxel(c+vec3i(1,0,1)),t.x);
  let x3=mix(densityVoxel(c+vec3i(0,1,1)),densityVoxel(c+vec3i(1,1,1)),t.x);
  let s=densityInfo.look.w*max(0.0,mix(mix(x0,x1,t.y),mix(x2,x3,t.y),t.z));
  return vec4f(s*densityInfo.look.rgb,s);
}
`;

/**
 * A sparse grid of density for `VolumetricFog` (`new VolumetricFog({ volumes: grid })`): mist, smoke and steam with
 * detail anywhere in the world, lit like the fog. Write it with {@link splat}, {@link set} and {@link add}, or read a
 * VDB grid with {@link DensityVolume.fromVDB}; every change shows on the next frame.
 */
export class DensityVolume implements VolumetricMediumSource {
  /** Extinction per metre of a voxel value of 1. Read every frame. */
  density: number;
  /** Scattering albedo, linear RGB 0..1. Read every frame. */
  color: Vec3;
  /** Column-major index-to-world matrix (copied). */
  readonly matrix: Float64Array;
  private readonly inverse: Float64Array;
  private bricks = new Map<number, Float32Array>();
  private tiles = new Map<number, number>();
  private readonly maxBricks: number;
  private readonly maxPages: number;
  private dirty = true;
  private device?: GPUDevice;
  private buffers: GPUBuffer[] = [];
  private entries: GPUBindGroupEntry[] = [];
  private info = new Float32Array(24);
  private packed?: { pages: Uint32Array; voxels: Float32Array; lo: number[]; dims: number[]; any: boolean };
  private disposed = false;

  constructor(options: DensityVolumeOptions = {}) {
    const o = options ?? {};
    this.density = within(o.density, 1, 0, MAX_DENSITY, 'density');
    const color = o.color ?? [1, 1, 1];
    if (!Array.isArray(color) || color.length !== 3 || !color.every((c) => finite(c) && c >= 0 && c <= 1))
      throw new RangeError('DensityVolume color must be three numbers from 0 to 1');
    this.color = [color[0], color[1], color[2]];
    this.maxBricks = within(o.maxBricks, DEFAULT_MAX_BRICKS, 1, 1 << 20, 'maxBricks');
    this.maxPages = within(o.maxPages, DEFAULT_MAX_PAGES, 1, 1 << 26, 'maxPages');
    if (!Number.isInteger(this.maxBricks) || !Number.isInteger(this.maxPages))
      throw new RangeError('DensityVolume maxBricks and maxPages must be whole numbers');
    let m: ArrayLike<number>;
    if (o.matrix !== undefined) m = o.matrix;
    else {
      const size = within(o.voxelSize, 0.5, 1e-4, 1e4, 'voxelSize'),
        origin = o.origin ?? [0, 0, 0];
      if (!Array.isArray(origin) || origin.length !== 3 || !origin.every(finite))
        throw new RangeError('DensityVolume origin must be three finite numbers');
      m = identity(size, origin);
    }
    const inverse = m && m.length === 16 && Array.from(m).every(finite) ? invertMatrix(m) : null;
    if (!inverse || m[3] !== 0 || m[7] !== 0 || m[11] !== 0 || m[15] !== 1)
      throw new RangeError('DensityVolume matrix must be an invertible affine column-major 4 x 4 matrix');
    this.matrix = Float64Array.from(m);
    this.inverse = inverse;
  }

  /**
   * A volume holding one float grid of a VDB file (`parseVDB` of @margoengine/loaders/vdb): its active leaf voxels
   * and active tiles, placed by the grid's matrix. Inactive voxels read 0, as a fog volume's background.
   * @throws RangeError for a vector grid or a level set, or a grid over `maxBricks`.
   */
  static fromVDB(grid: DensityVDBGrid, options: Omit<DensityVolumeOptions, 'matrix' | 'voxelSize' | 'origin'> = {}) {
    if (!grid || grid.components !== 1)
      throw new RangeError('DensityVolume.fromVDB needs a scalar grid (components 1)');
    if (grid.gridClass === 'level set')
      throw new RangeError(`VDB grid ${grid.name ?? ''} is a level set, not a density; convert it to a fog volume`);
    const volume = new DensityVolume({ ...options, matrix: grid.matrix });
    for (const leaf of grid.leaves) {
      const [ox, oy, oz] = leaf.origin;
      if (ox % 8 || oy % 8 || oz % 8) throw new RangeError('DensityVolume.fromVDB needs 8^3 leaves on 8 voxel bounds');
      const out = volume.brick(ox / 8, oy / 8, oz / 8);
      for (let i = 0; i < VOXELS; i++) out[i] = leaf.mask[i >> 3] & (1 << (i & 7)) ? leaf.values[i] : 0;
    }
    for (const tile of grid.tiles) {
      if (!tile.active || typeof tile.value !== 'number' || tile.value === 0) continue;
      const n = Math.max(1, tile.size / 8),
        [bx, by, bz] = tile.origin.map((v) => Math.floor(v / 8));
      for (let x = 0; x < n; x++)
        for (let y = 0; y < n; y++) for (let z = 0; z < n; z++) volume.setTile(bx + x, by + y, bz + z, tile.value);
    }
    return volume;
  }

  /** Bricks of 512 voxels held, tiles included. */
  get brickCount(): number {
    return this.bricks.size + this.tiles.size;
  }

  private check(x: number, y: number, z: number) {
    if (![x, y, z].every((v) => Number.isInteger(v) && v >= -SPAN * 8 && v < SPAN * 8))
      throw new RangeError(`DensityVolume voxel indices must be whole numbers within +-${SPAN * 8}`);
  }
  private brick(bx: number, by: number, bz: number): Float32Array {
    const key = keyOf(bx, by, bz);
    let b = this.bricks.get(key);
    if (!b) {
      if (this.brickCount >= this.maxBricks && !this.tiles.has(key))
        throw new RangeError(`DensityVolume is full: ${this.maxBricks} bricks; raise maxBricks`);
      b = new Float32Array(VOXELS);
      const tile = this.tiles.get(key);
      if (tile !== undefined) {
        b.fill(tile);
        this.tiles.delete(key);
      }
      this.bricks.set(key, b);
    }
    this.dirty = true;
    return b;
  }
  private setTile(bx: number, by: number, bz: number, value: number) {
    const key = keyOf(bx, by, bz);
    if (this.bricks.has(key)) this.bricks.get(key)!.fill(value);
    else {
      if (!this.tiles.has(key) && this.brickCount >= this.maxBricks)
        throw new RangeError(`DensityVolume is full: ${this.maxBricks} bricks; raise maxBricks`);
      this.tiles.set(key, value);
    }
    this.dirty = true;
  }

  /** Sets the voxel at an index. */
  set(x: number, y: number, z: number, value: number): void {
    this.check(x, y, z);
    if (!finite(value)) throw new RangeError('DensityVolume values must be finite');
    const bx = Math.floor(x / 8),
      by = Math.floor(y / 8),
      bz = Math.floor(z / 8);
    if (value === 0 && !this.bricks.has(keyOf(bx, by, bz)) && !this.tiles.has(keyOf(bx, by, bz))) return;
    this.brick(bx, by, bz)[((x - bx * 8) * 8 + (y - by * 8)) * 8 + (z - bz * 8)] = value;
  }
  /** Adds to the voxel at an index. */
  add(x: number, y: number, z: number, value: number): void {
    this.check(x, y, z);
    if (!finite(value)) throw new RangeError('DensityVolume values must be finite');
    if (value !== 0) this.addAt(x, y, z, value);
  }
  private addAt(x: number, y: number, z: number, value: number): void {
    const bx = Math.floor(x / 8),
      by = Math.floor(y / 8),
      bz = Math.floor(z / 8);
    this.brick(bx, by, bz)[((x - bx * 8) * 8 + (y - by * 8)) * 8 + (z - bz * 8)] += value;
  }
  /** The voxel at an index (0 where nothing is stored). */
  voxel(x: number, y: number, z: number): number {
    const bx = Math.floor(x / 8),
      by = Math.floor(y / 8),
      bz = Math.floor(z / 8),
      key = keyOf(bx, by, bz),
      b = this.bricks.get(key);
    if (b) return b[((x - bx * 8) * 8 + (y - by * 8)) * 8 + (z - bz * 8)];
    return this.tiles.get(key) ?? 0;
  }
  /** Empties the grid (the GPU store shrinks on the next frame). */
  clear(): void {
    this.bricks.clear();
    this.tiles.clear();
    this.dirty = true;
  }

  /**
   * Adds a Gaussian of density at each point: `weight` at its centre, falling off with standard deviation `radius`
   * (world metres, isotropic in world space whatever the matrix), cut at three standard deviations.
   * @param positions x, y, z per point in world metres.
   */
  splat(positions: ArrayLike<number>, options: DensitySplatOptions = {}): void {
    if (!positions || positions.length % 3) throw new RangeError('DensityVolume.splat needs x, y, z per point');
    const count = positions.length / 3,
      pick = (v: number | ArrayLike<number> | undefined, fallback: number, name: string) => {
        if (v === undefined || typeof v === 'number') {
          const x = v ?? fallback;
          if (!finite(x) || x < 0) throw new RangeError(`DensityVolume.splat ${name} must be 0 or more`);
          return () => x;
        }
        if (v.length !== count) throw new RangeError(`DensityVolume.splat ${name} needs one value per point`);
        return (i: number) => v[i];
      },
      radius = pick(options.radius, 1, 'radius'),
      weight = pick(options.weight, 1, 'weight'),
      m = this.matrix,
      inv = this.inverse,
      // Half-widths in index space of a world sphere of radius 1: the norms of the inverse's rows.
      reach = [0, 1, 2].map((r) => Math.hypot(inv[r], inv[4 + r], inv[8 + r]));
    for (let i = 0; i < count; i++) {
      const px = positions[3 * i],
        py = positions[3 * i + 1],
        pz = positions[3 * i + 2],
        s = radius(i),
        w = weight(i);
      if (![px, py, pz, s, w].every(finite) || s < 0 || w < 0)
        throw new RangeError('DensityVolume.splat values must be finite, radius and weight 0 or more');
      if (!(s > 0) || !(w > 0)) continue;
      const c = [0, 1, 2].map((r) => inv[r] * px + inv[4 + r] * py + inv[8 + r] * pz + inv[12 + r]),
        lo = c.map((v, r) => Math.ceil(v - 3 * s * reach[r])),
        hi = c.map((v, r) => Math.floor(v + 3 * s * reach[r])),
        edge = SPAN * 8 - 1;
      if (lo.some((v) => v < -edge) || hi.some((v) => v > edge))
        throw new RangeError(
          `DensityVolume.splat point ${i} reaches past voxel index +-${edge}; move it nearer the origin or use a larger voxelSize`,
        );
      const k = -0.5 / (s * s),
        cut = 9 * s * s;
      for (let x = lo[0]; x <= hi[0]; x++)
        for (let y = lo[1]; y <= hi[1]; y++)
          for (let z = lo[2]; z <= hi[2]; z++) {
            const dx = m[0] * x + m[4] * y + m[8] * z + m[12] - px,
              dy = m[1] * x + m[5] * y + m[9] * z + m[13] - py,
              dz = m[2] * x + m[6] * y + m[10] * z + m[14] - pz,
              d2 = dx * dx + dy * dy + dz * dz;
            if (d2 <= cut) this.addAt(x, y, z, w * Math.exp(k * d2));
          }
    }
  }

  /** Replace the CPU medium on a complete successful rasterization, retaining its GPU buffers. */
  protected replaceSplats(positions: ArrayLike<number>, options: DensitySplatOptions): void {
    const { bricks, tiles, dirty } = this;
    this.bricks = new Map();
    this.tiles = new Map();
    try {
      this.splat(positions, options);
      this.dirty = true;
    } catch (error) {
      this.bricks = bricks;
      this.tiles = tiles;
      this.dirty = dirty;
      throw error;
    }
  }

  /** The extinction per metre at a world point, as the GPU filters it (trilinear over voxel centres). */
  sample(p: Vec3): number {
    const inv = this.inverse,
      g = [0, 1, 2].map((r) => inv[r] * p[0] + inv[4 + r] * p[1] + inv[8 + r] * p[2] + inv[12 + r]),
      f = g.map(Math.floor),
      t = g.map((v, r) => v - f[r]);
    let sum = 0;
    for (let k = 0; k < 8; k++) {
      const a = k & 1,
        b = (k >> 1) & 1,
        c = k >> 2;
      sum +=
        (a ? t[0] : 1 - t[0]) *
        (b ? t[1] : 1 - t[1]) *
        (c ? t[2] : 1 - t[2]) *
        this.voxel(f[0] + a, f[1] + b, f[2] + c);
    }
    return this.density * Math.max(0, sum);
  }

  /** @internal The GPU layout: info (24 floats, ints as their bits), page table and voxel store. */
  pack(): { info: Float32Array; pages: Uint32Array; voxels: Float32Array } {
    const { pages, voxels, lo, dims, any } = this.dirty || !this.packed ? this.layout() : this.packed,
      info = this.info,
      ints = new Int32Array(info.buffer),
      inv = this.inverse;
    for (let r = 0; r < 3; r++) info.set([inv[r], inv[4 + r], inv[8 + r], inv[12 + r]], 4 * r);
    ints.set([lo[0], lo[1], lo[2], 0], 12);
    ints.set([dims[0], dims[1], dims[2], any ? 1 : 0], 16);
    info.set([...this.color, this.density], 20);
    return { info, pages, voxels };
  }
  private layout() {
    const keys = [...this.bricks.keys(), ...this.tiles.keys()].map(brickOf),
      lo = [Infinity, Infinity, Infinity],
      hi = [-Infinity, -Infinity, -Infinity];
    for (const b of keys)
      for (let r = 0; r < 3; r++) {
        lo[r] = Math.min(lo[r], b[r]);
        hi[r] = Math.max(hi[r], b[r]);
      }
    const dims = keys.length ? hi.map((v, r) => v - lo[r] + 1) : [0, 0, 0],
      pagesCount = dims[0] * dims[1] * dims[2];
    if (pagesCount > this.maxPages)
      throw new RangeError(
        `DensityVolume's bricks span ${dims.join(' x ')} bricks, over maxPages ${this.maxPages}; keep the density together or raise maxPages`,
      );
    const pages = new Uint32Array(Math.max(1, pagesCount)).fill(EMPTY),
      voxels = new Float32Array(Math.max(1, this.bricks.size * VOXELS + this.tiles.size)),
      index = (b: [number, number, number]) => ((b[2] - lo[2]) * dims[1] + (b[1] - lo[1])) * dims[0] + (b[0] - lo[0]);
    let slot = 0;
    for (const [key, data] of this.bricks) {
      pages[index(brickOf(key))] = slot;
      voxels.set(data, slot++ * VOXELS);
    }
    let constant = this.bricks.size * VOXELS;
    for (const [key, value] of this.tiles) {
      pages[index(brickOf(key))] = TILE + constant;
      voxels[constant++] = value;
    }
    const any = keys.length > 0;
    this.packed = { pages, voxels, lo: any ? lo : [0, 0, 0], dims, any };
    return this.packed;
  }

  /** WGSL for VolumetricFog's froxel pass: `fogMedium(p)`, the grid's scattering (rgb) and extinction (a) at `p`. */
  medium(group: number): string {
    return wgsl(group);
  }

  /** Uploads what changed and returns the bind group entries (the same array until a buffer is replaced). */
  bindings(device: GPUDevice): GPUBindGroupEntry[] {
    if (this.disposed) throw new RangeError('DensityVolume is disposed; create a new DensityVolume');
    const upload = this.dirty || !this.packed,
      { info, pages, voxels } = this.pack(),
      data = [info, pages, voxels];
    const replace =
      this.device !== device || this.buffers.length !== 3 || data.some((d, i) => this.buffers[i].size < d.byteLength);
    if (replace) {
      for (const b of this.buffers) b.destroy();
      this.device = device;
      this.buffers = data.map((d) =>
        device.createBuffer({ size: d.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }),
      );
      this.entries = this.buffers.map((buffer, binding) => ({ binding, resource: { buffer } }));
    }
    device.queue.writeBuffer(this.buffers[0], 0, info as Float32Array<ArrayBuffer>);
    if (upload || replace) {
      device.queue.writeBuffer(this.buffers[1], 0, pages as Uint32Array<ArrayBuffer>);
      device.queue.writeBuffer(this.buffers[2], 0, voxels as Float32Array<ArrayBuffer>);
      this.dirty = false;
    }
    return this.entries;
  }

  /** Frees the GPU buffers; a VolumetricFog still using the grid must drop its `volumes` first. */
  dispose(): void {
    this.disposed = true;
    for (const b of this.buffers) b.destroy();
    this.buffers = [];
    this.device = undefined;
    this.entries = [];
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}

/** A warm-cloud source such as `CloudSolver`, with a fixed grid in renderer-local metres. */
export interface CloudDensitySource {
  readonly grid: {
    readonly cells: readonly [number, number, number];
    readonly cellSize: number;
    /** Corner of the first cell, at half a cell from its sample. */
    readonly origin: Vec3;
  };
  /** Accepted liquid-water mixing ratios (kg/kg), X fastest, then Y and Z. */
  cloudWater(): Float32Array;
}

/**
 * Options for a cloud density volume: the uniform air density in kg/m³ (default 1.2) and the effective droplet
 * radius in metres (default 10 µm).
 */
export interface CloudDensityVolumeOptions {
  /** Uniform air density, kg/m³ (default 1.2). */
  airDensity?: number;
  /** Effective water-droplet radius in metres (default 10 µm). */
  effectiveRadius?: number;
}

/**
 * Renders accepted warm-cloud water as a trilinear world-space volume. Pass the instance as
 * `VolumetricFog`'s `volumes` and call `update()` after advancing or restoring the cloud source.
 * Visible extinction is 3 ρ_air q_c / (2 ρ_water r_e), using the large-drop limit Q_ext = 2
 * (Hansen and Travis 1974; Slingo 1989). Air density and effective radius are uniform.
 */
export class CloudDensityVolume extends DensityVolume {
  private readonly grid: CloudDensitySource['grid'];
  private closed = false;

  constructor(
    private readonly source: CloudDensitySource,
    options: CloudDensityVolumeOptions = {},
  ) {
    const grid = source?.grid;
    if (
      !grid ||
      typeof source.cloudWater !== 'function' ||
      !Array.isArray(grid.cells) ||
      grid.cells.length !== 3 ||
      !Array.from(grid.cells).every((n) => Number.isInteger(n) && n > 0 && n <= SPAN * DENSITY_BRICK) ||
      !Array.isArray(grid.origin) ||
      grid.origin.length !== 3 ||
      !Array.from(grid.origin).every(finite) ||
      !finite(grid.cellSize) ||
      !(grid.cellSize >= 1e-4 && grid.cellSize <= 1e4)
    )
      throw new MargoError(
        'state',
        'Invalid cloud grid. Pass three positive cell counts, a finite corner and a valid cell size.',
      );
    const bricks = grid.cells.reduce((total, cells) => total * Math.ceil(cells / DENSITY_BRICK), 1);
    if (bricks > DEFAULT_MAX_BRICKS)
      throw new MargoError('state', 'Cloud grid exceeds the density volume capacity. Use a smaller cloud grid.');
    const { airDensity = 1.2, effectiveRadius = 10e-6 } = options ?? {};
    const density = (3 * airDensity) / (2000 * effectiveRadius);
    if (
      !finite(airDensity) ||
      !finite(effectiveRadius) ||
      !(airDensity > 0 && effectiveRadius > 0 && density > 0 && density <= MAX_DENSITY)
    )
      throw new MargoError(
        'state',
        'Invalid cloud optics. Use positive air density and droplet radius such as 1.2 kg/m³ and 10 μm.',
      );
    const { cells, cellSize, origin } = grid;
    const centre: Vec3 = [origin[0] + cellSize / 2, origin[1] + cellSize / 2, origin[2] + cellSize / 2];
    if (centre.some((value) => !finite(Math.fround(value)) || !finite(Math.fround(value / cellSize))))
      throw new MargoError(
        'state',
        'Cloud grid origin exceeds shader coordinates. You must move the grid to a local render origin.',
      );
    super({ voxelSize: cellSize, origin: centre, density });
    this.grid = {
      cells: [cells[0], cells[1], cells[2]],
      cellSize,
      origin: [origin[0], origin[1], origin[2]],
    };
    this.update();
  }

  /** Replaces every voxel with the current accepted cloud water, including newly clear voxels. */
  update(): void {
    if (this.closed) throw new MargoError('disposed', 'Cloud density volume is disposed. Create a new cloud volume.');
    const {
      cells: [nx, ny, nz],
      cellSize,
      origin,
    } = this.grid;
    const current = this.source.grid;
    if (
      current?.cellSize !== cellSize ||
      !Array.isArray(current.cells) ||
      current.cells.length !== 3 ||
      current.cells[0] !== nx ||
      current.cells[1] !== ny ||
      current.cells[2] !== nz ||
      !Array.isArray(current.origin) ||
      current.origin.length !== 3 ||
      origin.some((value, i) => value !== current.origin[i])
    )
      throw new MargoError('state', 'Cloud grid geometry changed. Create a cloud volume for the new grid.');
    const water = this.source.cloudWater();
    if (
      !(water instanceof Float32Array) ||
      water.length !== nx * ny * nz ||
      !water.every((value) => value >= 0 && finite(Math.fround(value * this.density)))
    )
      throw new MargoError(
        'state',
        'Invalid cloud water. You must supply one finite nonnegative Float32 ratio per grid cell with representable extinction.',
      );
    this.clear();
    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        const row = nx * (y + ny * z);
        for (let x = 0; x < nx; x++) {
          const value = water[row + x]!;
          if (value > 0) this.set(x, y, z, value);
        }
      }
    }
  }

  override dispose(): void {
    this.closed = true;
    super.dispose();
  }
}

/** The accepted sea-spray properties of an airborne parcel in its source cell. */
export interface SeaSprayParcel {
  readonly kind: string;
  readonly position: Vec3;
  /** Combined parcel mass in kilograms. */
  readonly mass: number;
  /** Current droplet diameter in metres. */
  readonly diameter: number;
  /** Current droplet material density in kg/m³, including residual sea salt. Required for sea spray. */
  readonly materialDensity?: number;
}

/** The subset of `AirborneParticles` needed to render its sea spray. */
export interface SeaSpraySource {
  readonly cell: Vec3;
  readParticles(): readonly SeaSprayParcel[];
}

/**
 * Options for a sea-spray density volume: voxel spacing in metres (default 0.1) and the floating-origin cell
 * width in metres (default 4096).
 */
export interface SeaSprayDensityVolumeOptions {
  /** Voxel spacing in metres, default 0.1. Each parcel is spread with a standard deviation of two voxels. */
  voxelSize?: number;
  /** Width of a large-world origin cell in metres, default 4096. Use the PhysicsWorld's cell size. */
  cellSize?: number;
}

// The integral of a unit-centred isotropic Gaussian inside radius three σ
// is (2π)^(3/2) σ³ [erf(3/√2) - 3√(2/π) exp(-9/2)].
const TRUNCATED_GAUSSIAN_VOLUME = Math.pow(2 * Math.PI, 1.5) * 0.9707091134651118;

/**
 * Turns accepted marine droplets into a depth-tested volumetric medium for `VolumetricFog`.
 * Each parcel's visible-light extinction area is 3m/(ρd) in the large-drop limit Q_ext = 2,
 * spread with a normalized three-sigma Gaussian and sampled at the voxel centres.
 */
export class SeaSprayDensityVolume extends DensityVolume {
  private readonly spacing: number;
  private readonly worldCellSize: number;
  private closed = false;

  constructor(
    private readonly source: SeaSpraySource,
    options: SeaSprayDensityVolumeOptions = {},
  ) {
    const { voxelSize = 0.1, cellSize = 4096 } = options ?? {};
    if (
      typeof source?.readParticles !== 'function' ||
      !finite(voxelSize) ||
      !(voxelSize >= 1e-4 && voxelSize <= 1e4) ||
      !finite(cellSize) ||
      !(cellSize > 0)
    )
      throw new MargoError(
        'state',
        'Invalid sea spray source or grid. Pass airborne particles and positive metre sizes.',
      );
    super({ voxelSize });
    this.spacing = voxelSize;
    this.worldCellSize = cellSize;
    this.update();
  }

  /** Upload the current sea-spray parcels in the supplied renderer cell, defaulting to the source's live cell. */
  update(renderCell?: Vec3): void {
    if (this.closed) throw new MargoError('disposed', 'Sea spray volume is disposed. Create a new spray volume.');
    const sourceCell = this.source.cell;
    const targetCell = renderCell ?? sourceCell;
    const offset = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      if (!Number.isSafeInteger(targetCell?.[i]) || !Number.isSafeInteger(sourceCell?.[i]))
        throw new MargoError('state', 'Invalid sea spray origin cell. Pass three signed integer cell coordinates.');
      offset[i] = (sourceCell[i]! - targetCell[i]!) * this.worldCellSize;
    }
    const parcels = this.source.readParticles();
    if (!Array.isArray(parcels))
      throw new MargoError(
        'state',
        'Invalid sea spray frame. You must return the accepted airborne parcels as an array.',
      );

    const positions: number[] = [];
    const weights: number[] = [];
    const spread = 2 * this.spacing;
    const gaussianVolume = TRUNCATED_GAUSSIAN_VOLUME * spread * spread * spread;
    const extentMin = [Infinity, Infinity, Infinity];
    const extentMax = [-Infinity, -Infinity, -Infinity];
    let peakBound = 0;
    for (const parcel of parcels) {
      if (parcel?.kind !== 'sea-spray') continue;
      const { position, diameter, mass, materialDensity } = parcel;
      if (
        !finite(diameter) ||
        !finite(mass) ||
        !finite(materialDensity) ||
        !(diameter > 0 && mass >= 0 && materialDensity > 0)
      )
        throw new MargoError(
          'state',
          'Invalid spray droplet. Use a nonnegative mass and positive diameter and density.',
        );
      if (mass === 0) continue;
      const weight = ((mass / diameter) * (3 / materialDensity)) / gaussianVolume;
      peakBound += weight;
      if (!finite(Math.fround(peakBound)) || !finite(Math.fround(peakBound * this.density)))
        throw new MargoError('state', 'Spray extinction exceeds Float32 range. Check parcel mass, size and density.');
      for (let i = 0; i < 3; i++) {
        const world = position?.[i]! + offset[i]!;
        const grid = world / this.spacing;
        if (!finite(world) || Math.abs(grid) + 6 > SPAN * DENSITY_BRICK - 1)
          throw new MargoError(
            'state',
            'Spray lies outside the density grid. Use a nearby render cell or larger voxels.',
          );
        positions.push(world);
        extentMin[i] = Math.min(extentMin[i]!, Math.floor((grid - 6) / DENSITY_BRICK));
        extentMax[i] = Math.max(extentMax[i]!, Math.floor((grid + 6) / DENSITY_BRICK));
      }
      weights.push(weight);
    }
    if (weights.length && extentMax.reduce((pages, max, i) => pages * (max - extentMin[i]! + 1), 1) > DEFAULT_MAX_PAGES)
      throw new MargoError('state', 'Spray spans too many density pages. Use larger voxels or a smaller shot region.');
    try {
      this.replaceSplats(positions, { radius: spread, weight: weights });
    } catch (error) {
      if (error instanceof RangeError)
        throw new MargoError(
          'state',
          'Spray exceeds density volume capacity. Use larger voxels or a smaller shot region.',
        );
      throw error;
    }
  }

  override dispose(): void {
    this.closed = true;
    super.dispose();
  }
}
