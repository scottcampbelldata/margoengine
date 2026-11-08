/// <reference lib="esnext.disposable" preserve="true" />
// @margoengine/voxel/gpu-mesher: chunks meshed in WebGPU compute shaders, quad for quad the output of meshChunk. Each
// batch unpacks its chunks and shells into 34^3 volumes, finds every face of every (direction, slice) in parallel with
// its AO and smooth light, merges each slice greedily in its own workgroup, and packs the quads per layer in meshChunk's
// order. Chunks with slabs or stairs within a cell are meshed on this thread by meshChunk.
import type { Vec3 } from '@margoengine/math';
import { MargoError } from '@margoengine/math/errors';
import type { BlockType } from './blocks.js';
import type { PackedChunk } from './chunk.js';
import { type ChunkMesh, blockMaterials, meshChunk, meshInput, sortQuads } from './mesher.js';
import type { VoxelWorld } from './world.js';

declare const GPUBufferUsage: { STORAGE: number; COPY_DST: number; COPY_SRC: number; MAP_READ: number };
declare const GPUMapMode: { READ: number };

const VOLUME = 39304,
  CELLS = 32768,
  SLOTS = 192,
  // Block flags, as meshChunk derives them: layer 0-1, shape 2-3 (cross 4, liquid 8, slab or stair 12), opaque cube 16,
  // no cube faces 32, slab or stair 64.
  OCCLUDES = 16,
  PART = 64,
  INVISIBLE = 3,
  LAYERS: Record<string, number> = { opaque: 0, cutout: 1, translucent: 2, invisible: 3 },
  SHAPES: Record<string, number> = { cube: 0, cross: 4, liquid: 8, slab: 76, stair: 76 };

// Visibility bits of every pair among the chunk faces set in `faces` (bit a * 6 + b for a < b).
const pairs = (faces: number): number => {
  let bits = 0;
  for (let a = 0; a < 5; a++)
    if (faces & (1 << a)) for (let b = a + 1; b < 6; b++) if (faces & (1 << b)) bits |= 1 << (a * 6 + b);
  return bits;
};
const ALL = pairs(63);

const SHADER = /* wgsl */ `
override CAP: u32 = 8u;
const V = 39304u; const SZ = 34u; const SY = 1156u; const BASE = 1191u;
@group(0) @binding(0) var<storage, read> src: array<u32>;
@group(0) @binding(1) var<storage, read> hdr: array<u32>;
@group(0) @binding(2) var<storage, read_write> vol: array<u32>;
@group(0) @binding(3) var<storage, read> tbl: array<u32>;
@group(0) @binding(4) var<storage, read_write> slotq: array<u32>;
@group(0) @binding(5) var<storage, read_write> aux: array<u32>;
@group(0) @binding(6) var<storage, read_write> outq: array<u32>;
// aux: per chunk and slot the quad count per layer and in all (4 each), per chunk and thread the cross quads per layer
// (4 each), their output offsets, the slots' output offsets, then per chunk the layer totals and the layer bases.
fn slotCount(b: u32, slot: u32) -> u32 { return (b * 192u + slot) * 4u; }
fn crossCount(b: u32, t: u32) -> u32 { return CAP * 768u + (b * 256u + t) * 4u; }
fn crossOffset(b: u32, t: u32) -> u32 { return CAP * 1792u + (b * 256u + t) * 4u; }
fn slotOffset(b: u32, slot: u32) -> u32 { return CAP * 2816u + (b * 192u + slot) * 4u; }
fn totals(b: u32) -> u32 { return CAP * 3584u + b * 4u; }
fn bases(b: u32) -> u32 { return CAP * 3588u + b * 4u; }

// Per cell: the state, then light | block flags << 8.
fn state(b: u32, p: u32) -> u32 { return vol[b * 2u * V + p]; }
fn info(b: u32, p: u32) -> u32 { return vol[b * 2u * V + V + p]; }
fn occ(b: u32, p: u32) -> u32 { return (info(b, p) >> 12u) & 1u; }
// Open cells' light as sky << 8 | block, opaque cubes 0.
fn spread(b: u32, p: u32) -> u32 {
  let i = info(b, p);
  if (((i >> 12u) & 1u) != 0u) { return 0u; }
  return (((i >> 4u) & 15u) << 8u) | (i & 15u);
}
fn srcByte(at: u32, i: u32) -> u32 { return (src[at + (i >> 2u)] >> ((i & 3u) * 8u)) & 255u; }

@compute @workgroup_size(256)
fn unpack(@builtin(global_invocation_id) g: vec3u, @builtin(workgroup_id) w: vec3u) {
  let p = g.x; let b = w.y;
  if (p >= V) { return; }
  let m = b * 8u;
  let X = p % SZ; let Z = (p / SZ) % SZ; let Y = p / SY;
  var s: u32; var l: u32;
  if (X >= 1u && X <= 32u && Y >= 1u && Y <= 32u && Z >= 1u && Z <= 32u) {
    let i = (X - 1u) + (Z - 1u) * 32u + (Y - 1u) * 1024u;
    let bits = hdr[m];
    var slot = 0u;
    if (bits != 0u) {
      let bit = i * bits;
      slot = (src[hdr[m + 2u] + (bit >> 5u)] >> (bit & 31u)) & ((1u << bits) - 1u);
    }
    s = src[hdr[m + 1u] + slot];
    if (hdr[m + 6u] != 0u) { l = hdr[m + 7u]; } else { l = srcByte(hdr[m + 3u], i); }
  } else {
    // Shell order: rows of z within layers of y; whole rows on the y and z borders, else the two x ends.
    var k: u32;
    if (Y == 0u || Y == 33u) {
      k = select(0u, 5380u, Y == 33u) + Z * 34u + X;
    } else {
      let lay0 = 1156u + (Y - 1u) * 132u;
      if (Z == 0u || Z == 33u) { k = lay0 + select(0u, 98u, Z == 33u) + X; }
      else { k = lay0 + 34u + (Z - 1u) * 2u + select(0u, 1u, X == 33u); }
    }
    s = src[hdr[m + 4u] + k];
    l = srcByte(hdr[m + 5u], k);
  }
  vol[b * 2u * V + p] = s;
  vol[b * 2u * V + V + p] = l | (tbl[(s & 0xffffu) * 8u] << 8u);
}

var<workgroup> keys: array<u32, 1024>;
var<workgroup> lights: array<u32, 1024>;

// Rounded-half-up mean of n light levels summing to sum.
fn mean(n: u32, sum: u32) -> u32 { return (sum * 2u + n) / (n * 2u); }
// A face vertex's light as sky | block << 4 from its n open cells (light sum as sky << 8 | block), or the cell's own.
fn vertexLight(n: u32, sum: u32, own: u32) -> u32 {
  if (n == 0u) { return (own >> 4u) | ((own & 15u) << 4u); }
  return mean(n, sum >> 8u) | (mean(n, sum & 255u) << 4u);
}

@compute @workgroup_size(256)
fn faces(@builtin(local_invocation_index) t: u32, @builtin(workgroup_id) w: vec3u) {
  let slot = w.x; let b = w.y; let d = slot / 32u; let s = slot % 32u;
  var NS = array<u32, 6>(1u, 1u, SY, SY, SZ, SZ);
  var US = array<u32, 6>(SZ, SZ, 1u, 1u, 1u, 1u);
  var VS = array<u32, 6>(SY, SY, SZ, SZ, SY, SY);
  let sN = NS[d]; let sU = US[d]; let sV = VS[d];
  let top = d == 2u; let side = d < 2u || d > 3u;
  for (var j = 0u; j < 4u; j++) {
    let m = t + j * 256u;
    keys[m] = 0u;
    let p = BASE + s * sN + (m & 31u) * sU + (m >> 5u) * sV;
    let f = info(b, p) >> 8u;
    if ((f & 32u) != 0u) { continue; }
    var q = p + sN;
    if ((d & 1u) != 0u) { q = p - sN; }
    let liquid = (f & 12u) == 8u;
    if (!liquid && occ(b, q) != 0u) { continue; }
    let st = state(b, p); let id = st & 0xffffu;
    let surface = liquid && d != 3u && (state(b, p + SY) & 0xffffu) != id;
    var drop = 0u;
    if (surface) { drop = (st >> 16u) & 7u; }
    if (occ(b, q) != 0u) {
      if (!top || drop == 0u) { continue; }
    } else if ((state(b, q) & 0xffffu) == id) {
      var below = (state(b, q) >> 16u) & 7u;
      if ((state(b, q + SY) & 0xffffu) == id) { below = 0u; }
      if (!side || !liquid || drop >= below) { continue; }
    }
    let a = occ(b, q - sU); let bb = occ(b, q + sU); let c = occ(b, q - sV); let e = occ(b, q + sV);
    var ao0 = 0u; var ao1 = 0u; var ao2 = 0u; var ao3 = 0u;
    var d0 = 0u; var d1 = 0u; var d2 = 0u; var d3 = 0u;
    if ((a & c) == 0u) { ao0 = 3u - a - c - occ(b, q - sU - sV); d0 = spread(b, q - sU - sV); }
    if ((bb & c) == 0u) { ao1 = 3u - bb - c - occ(b, q + sU - sV); d1 = spread(b, q + sU - sV); }
    if ((bb & e) == 0u) { ao2 = 3u - bb - e - occ(b, q + sU + sV); d2 = spread(b, q + sU + sV); }
    if ((a & e) == 0u) { ao3 = 3u - a - e - occ(b, q - sU + sV); d3 = spread(b, q - sU + sV); }
    let open = 1u - occ(b, q);
    let sq = spread(b, q); let sa = spread(b, q - sU); let sb = spread(b, q + sU);
    let sc = spread(b, q - sV); let se = spread(b, q + sV);
    let own = info(b, p) & 255u;
    keys[m] = tbl[id * 8u + 1u + d] | (ao0 << 12u) | (ao1 << 14u) | (ao2 << 16u) | (ao3 << 18u) |
      select(0u, 1u << 20u, surface) | (drop << 21u) | ((f & 3u) << 24u) | (1u << 31u);
    lights[m] = vertexLight(ao0 + open, sq + sa + sc + d0, own) |
      (vertexLight(ao1 + open, sq + sb + sc + d1, own) << 8u) |
      (vertexLight(ao2 + open, sq + sb + se + d2, own) << 16u) |
      (vertexLight(ao3 + open, sq + sa + se + d3, own) << 24u);
  }
  workgroupBarrier();
  if (t != 0u) { return; }
  // Greedy merge in scan order, exactly as meshChunk: grow along u, then v, over equal words, only along an axis the
  // corners are equal on; the AO picks the diagonal.
  var ATS = array<u32, 6>(0u, 0u, 5u, 5u, 10u, 10u);
  var ATU = array<u32, 6>(10u, 10u, 0u, 0u, 0u, 0u);
  var ATV = array<u32, 6>(5u, 5u, 10u, 10u, 5u, 5u);
  let base = (s << ATS[d]) | (d << 15u); let atU = ATU[d]; let atV = ATV[d];
  var count = array<u32, 3>(0u, 0u, 0u);
  var n = 0u;
  let region = (b * 192u + slot) * 4096u;
  for (var m = 0u; m < 1024u; m++) {
    let A = keys[m];
    if (A == 0u) { continue; }
    let u = m & 31u; let v = m >> 5u; let B = lights[m];
    let o0 = (A >> 12u) & 3u; let o1 = (A >> 14u) & 3u; let o2 = (A >> 16u) & 3u; let o3 = (A >> 18u) & 3u;
    let l0 = B & 255u; let l1 = (B >> 8u) & 255u; let l2 = (B >> 16u) & 255u; let l3 = B >> 24u;
    var width = 1u; var height = 1u;
    if (o0 == o1 && o3 == o2 && l0 == l1 && l3 == l2) {
      loop {
        if (u + width >= 32u || keys[m + width] != A || lights[m + width] != B) { break; }
        width++;
      }
    }
    if (o0 == o3 && o1 == o2 && l0 == l3 && l1 == l2) {
      loop {
        if (v + height >= 32u) { break; }
        var same = true;
        for (var k = m + (height << 5u); k < m + (height << 5u) + width; k++) {
          if (keys[k] != A || lights[k] != B) { same = false; break; }
        }
        if (!same) { break; }
        height++;
      }
    }
    for (var y = 0u; y < height; y++) {
      for (var k = m + (y << 5u); k < m + (y << 5u) + width; k++) { keys[k] = 0u; }
    }
    let flip = select(0u, 1u << 28u, o1 + o3 > o0 + o2);
    let lay = (A >> 24u) & 3u;
    let at = region + n * 4u;
    slotq[at] = base | (u << atU) | (v << atV) | ((width - 1u) << 18u) | ((height - 1u) << 23u) | flip |
      ((A >> 21u) << 29u);
    slotq[at + 1u] = A & 0x1fffffu;
    slotq[at + 2u] = B;
    slotq[at + 3u] = count[lay] | (lay << 30u);
    count[lay]++;
    n++;
  }
  let c = slotCount(b, slot);
  aux[c] = count[0]; aux[c + 1u] = count[1]; aux[c + 2u] = count[2]; aux[c + 3u] = n;
}

// A cross block: not invisible, cross shape (its flags have the no-faces bit).
fn isCross(f: u32) -> bool { return (f & 32u) != 0u && (f & 12u) == 4u && (f & 3u) != 3u; }

@compute @workgroup_size(256)
fn crosses(@builtin(local_invocation_index) t: u32, @builtin(workgroup_id) w: vec3u) {
  let b = w.y;
  var count = array<u32, 3>(0u, 0u, 0u);
  for (var i = t * 128u; i < t * 128u + 128u; i++) {
    let f = info(b, BASE + (i & 31u) + ((i >> 5u) & 31u) * SZ + (i >> 10u) * SY) >> 8u;
    if (isCross(f)) { count[f & 3u] += 2u; }
  }
  let c = crossCount(b, t);
  aux[c] = count[0]; aux[c + 1u] = count[1]; aux[c + 2u] = count[2];
}

// Output offsets within each layer: the cross quads first in cell order, then the slices in order.
@compute @workgroup_size(1)
fn offsets(@builtin(workgroup_id) w: vec3u) {
  let b = w.y;
  for (var l = 0u; l < 3u; l++) {
    var run = 0u;
    for (var t = 0u; t < 256u; t++) { aux[crossOffset(b, t) + l] = run; run += aux[crossCount(b, t) + l]; }
    for (var s = 0u; s < 192u; s++) { aux[slotOffset(b, s) + l] = run; run += aux[slotCount(b, s) + l]; }
    aux[totals(b) + l] = run;
  }
}

@compute @workgroup_size(256)
fn place(@builtin(local_invocation_index) t: u32, @builtin(workgroup_id) w: vec3u) {
  let slot = w.x; let b = w.y;
  if (slot < 192u) {
    let region = (b * 192u + slot) * 4096u;
    for (var j = t; j < aux[slotCount(b, slot) + 3u]; j += 256u) {
      let at = region + j * 4u;
      let tag = slotq[at + 3u]; let lay = tag >> 30u;
      let o = (aux[bases(b) + lay] + aux[slotOffset(b, slot) + lay] + (tag & 0x3fffffffu)) * 3u;
      outq[o] = slotq[at]; outq[o + 1u] = slotq[at + 1u]; outq[o + 2u] = slotq[at + 2u];
    }
    return;
  }
  // Cross blocks: two diagonal quads each, unshaded and lit by their own cell.
  let c = crossOffset(b, t);
  var run = array<u32, 3>(aux[c], aux[c + 1u], aux[c + 2u]);
  for (var i = t * 128u; i < t * 128u + 128u; i++) {
    let p = BASE + (i & 31u) + ((i >> 5u) & 31u) * SZ + (i >> 10u) * SY;
    let f = info(b, p) >> 8u;
    if (!isCross(f)) { continue; }
    let lay = f & 3u; let l = info(b, p) & 255u;
    let cell = (i & 31u) | ((i >> 10u) << 5u) | (((i >> 5u) & 31u) << 10u);
    let w1 = tbl[(state(b, p) & 0xffffu) * 8u + 1u] | (0xffu << 12u);
    let w2 = ((l >> 4u) | ((l & 15u) << 4u)) * 0x01010101u;
    let o = (aux[bases(b) + lay] + run[lay]) * 3u;
    outq[o] = cell | (6u << 15u); outq[o + 1u] = w1; outq[o + 2u] = w2;
    outq[o + 3u] = cell | (7u << 15u); outq[o + 4u] = w1; outq[o + 5u] = w2;
    run[lay] += 2u;
  }
}
`;

/** A chunk mesher a {@link VoxelRenderer} can use instead of its worker pool: `VoxelRendererOptions.mesher`. */
export interface GpuVoxelMesherOptions {
  /** Most chunks meshed in one dispatch. Each takes about 3.5 MB of GPU scratch. Default 8, from 1 to 32. */
  batch?: number;
}

/** Counts of chunks meshed, from {@link GpuVoxelMesher.stats}. */
export interface GpuVoxelMesherStats {
  /** Chunks meshed in compute shaders. */
  gpu: number;
  /** Chunks meshed on this thread by meshChunk: slabs or stairs within a cell of them. */
  cpu: number;
  /** Chunks with nothing to draw, answered without the GPU. */
  empty: number;
  /** Dispatches run. */
  batches: number;
}

interface Job {
  world: VoxelWorld;
  key: string;
  priority: number;
  order: number;
  eye?: Vec3;
  resolve(mesh: ChunkMesh | null): void;
  reject(error: unknown): void;
  cancelled: boolean;
}

interface Table {
  blocks: readonly BlockType[];
  n: number;
  flags: Uint8Array;
  data: Uint32Array;
  buffer?: GPUBuffer;
}

const keyPattern = /^(-?\d+),(-?\d+),(-?\d+)$/;
const isChunk = (c: number): boolean => (c << 5) >> 5 === c;

/**
 * Meshes chunks in WebGPU compute shaders: the same quads, in the same order, as {@link meshChunk} on the CPU (see
 * `ChunkMesh` for the format), for chunks of cubes, cross blocks and liquids. Calls made together go out in batches of
 * up to `batch` chunks per dispatch, nearest first, so a large edit remeshes in a few GPU passes instead of a worker
 * job per chunk. A chunk with a slab or stair within a cell of it is meshed by meshChunk on this thread. The page still
 * packs each chunk and its shell (as for the worker mesher) and finds which chunk faces see each other.
 *
 * ```ts
 * const mesher = new GpuVoxelMesher(engine.gpu!);
 * const voxels = VoxelRenderer.attach(engine, { world, textures, mesher });
 * ```
 */
export class GpuVoxelMesher {
  /** Most chunks per dispatch. */
  readonly batch: number;
  /** Chunks meshed so far, by path. */
  readonly stats: GpuVoxelMesherStats = { gpu: 0, cpu: 0, empty: 0, batches: 0 };
  #device: GPUDevice;
  #pipelines?: Record<'unpack' | 'faces' | 'crosses' | 'offsets' | 'place', GPUComputePipeline>;
  #table?: Table;
  #buffers: GPUBuffer[] = [];
  #vol!: GPUBuffer;
  #slots!: GPUBuffer;
  #aux!: GPUBuffer;
  #meta!: GPUBuffer;
  #src?: GPUBuffer;
  #out?: GPUBuffer;
  #queue = new Map<string, Job>();
  #running = new Set<Job>();
  #busy = false;
  #scheduled = false;
  #order = 0;
  #disposed = false;

  /**
   * @param device The WebGPU device: `engine.gpu`.
   * @throws TypeError when `device` is not a GPUDevice.
   * @throws RangeError when `batch` is not a whole number from 1 to 32, or the device cannot bind its scratch.
   */
  constructor(device: GPUDevice, options: GpuVoxelMesherOptions = {}) {
    if (typeof device?.createComputePipeline !== 'function')
      throw new TypeError('GpuVoxelMesher expects a GPUDevice; pass engine.gpu of a WebGPU engine');
    const { batch = 8 } = options;
    if (!Number.isInteger(batch) || batch < 1 || batch > 32)
      throw new RangeError(`GpuVoxelMesher batch is ${batch}; pass a whole number from 1 to 32`);
    const slotBytes = batch * SLOTS * 4096 * 4;
    if (slotBytes > device.limits.maxStorageBufferBindingSize)
      throw new RangeError(
        `GpuVoxelMesher batch ${batch} needs ${slotBytes} bytes in one binding, over this device's limit; pass a smaller batch`,
      );
    this.#device = device;
    this.batch = batch;
  }

  // Pipelines and the fixed scratch, made on first use.
  #setup(): void {
    if (this.#pipelines) return;
    const device = this.#device,
      module = device.createShaderModule({ label: 'margoengine voxel gpu-mesher', code: SHADER }),
      make = (entryPoint: string) =>
        device.createComputePipeline({
          label: `margoengine voxel gpu-mesher ${entryPoint}`,
          layout: 'auto',
          compute: { module, entryPoint, constants: { CAP: this.batch } },
        });
    this.#pipelines = {
      unpack: make('unpack'),
      faces: make('faces'),
      crosses: make('crosses'),
      offsets: make('offsets'),
      place: make('place'),
    };
    const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    this.#vol = this.#buffer(this.batch * 2 * VOLUME * 4, storage);
    this.#slots = this.#buffer(this.batch * SLOTS * 4096 * 4, storage);
    this.#aux = this.#buffer(this.batch * 3592 * 4, storage);
    this.#meta = this.#buffer(this.batch * 32, storage);
  }

  #buffer(size: number, usage: number): GPUBuffer {
    const buffer = this.#device.createBuffer({ label: 'margoengine voxel gpu-mesher', size, usage });
    this.#buffers.push(buffer);
    return buffer;
  }

  #drop(buffer: GPUBuffer | undefined): void {
    if (!buffer) return;
    this.#buffers.splice(this.#buffers.indexOf(buffer), 1);
    buffer.destroy();
  }

  /** Compiles the shaders and makes the scratch now rather than with the first chunks. */
  warm(): void {
    this.#check();
    this.#setup();
  }

  /**
   * Meshes chunk `key` of `world` with the next batch, as `VoxelMesher.mesh` does in a worker: resolves the chunk's
   * {@link ChunkMesh}, or null when the job was cancelled ({@link GpuVoxelMesher.cancel}, dispose) or superseded by a
   * newer call for the key, and when the chunk is not loaded once its batch starts. Rejects when the GPU work fails.
   * @param priority Lower is meshed sooner, such as the chunk's distance to the camera. Default 0.
   * @param eye The camera's world position: the translucent quads come back sorted from it (`sortQuads`).
   * @throws TypeError when `world` is not a VoxelWorld, `key` is not a string or `eye` is not three numbers.
   * @throws RangeError when `key` is not three chunk coordinates, or `priority` or `eye` is not finite.
   * @throws MargoError `disposed` after {@link GpuVoxelMesher.dispose}.
   */
  mesh(world: VoxelWorld, key: string, priority = 0, eye?: Vec3): Promise<ChunkMesh | null> {
    this.#check();
    if (typeof world?.getChunk !== 'function')
      throw new TypeError('GpuVoxelMesher.mesh expects a VoxelWorld and a key');
    if (typeof key !== 'string') throw new TypeError('Chunk key must be a string; build it with chunkKey(cx, cy, cz)');
    const c = keyPattern.exec(key)?.slice(1).map(Number);
    if (!c?.every(isChunk))
      throw new RangeError(`Chunk key "${key}" is not three chunk coordinates; build it with chunkKey(cx, cy, cz)`);
    if (typeof priority !== 'number' || !Number.isFinite(priority))
      throw new RangeError(`GpuVoxelMesher.mesh priority is ${priority}; pass a finite number`);
    if (eye !== undefined) {
      if (!Array.isArray(eye) && !ArrayBuffer.isView(eye))
        throw new TypeError('GpuVoxelMesher.mesh eye must be [x, y, z]');
      if (eye.length !== 3 || ![0, 1, 2].every((i) => Number.isFinite(eye[i])))
        throw new RangeError('GpuVoxelMesher.mesh eye must be three finite numbers');
    }
    const local: Vec3 | undefined = eye && [eye[0] - c[0] * 32, eye[1] - c[1] * 32, eye[2] - c[2] * 32];
    this.cancel(key);
    return new Promise<ChunkMesh | null>((resolve, reject) => {
      this.#queue.set(key, {
        world,
        key,
        priority,
        order: this.#order++,
        eye: local,
        resolve,
        reject,
        cancelled: false,
      });
      this.#schedule();
    });
  }

  /** Drops the pending job of chunk `key`, if any: its `mesh` promise resolves null. */
  cancel(key: string): void {
    const job = this.#queue.get(key);
    if (job) {
      this.#queue.delete(key);
      job.resolve(null);
    }
    for (const running of this.#running) if (running.key === key) running.cancelled = true;
  }

  #check(): void {
    if (this.#disposed) throw new MargoError('disposed', 'GpuVoxelMesher is disposed; create a new GpuVoxelMesher');
  }

  #schedule(): void {
    if (this.#busy || this.#scheduled || !this.#queue.size || this.#disposed) return;
    this.#scheduled = true;
    queueMicrotask(() => {
      this.#scheduled = false;
      if (!this.#busy && this.#queue.size && !this.#disposed) void this.#run();
    });
  }

  // Takes the nearest jobs, answers the empty and part-block chunks here and meshes the rest in one GPU batch.
  async #run(): Promise<void> {
    this.#busy = true;
    const gpu: { job: Job; chunk: PackedChunk; shell: Uint32Array; light: Uint8Array; visibility: number }[] = [];
    try {
      const picked = [...this.#queue.values()].sort((a, b) => a.priority - b.priority || a.order - b.order);
      for (const job of picked) {
        if (gpu.length === this.batch) break;
        this.#queue.delete(job.key);
        const input = meshInput(job.world, job.key);
        if (!input) {
          job.resolve(null);
          continue;
        }
        if (gpu.length && input.blocks !== this.#table?.blocks) {
          // Another world's block table: its own batch.
          this.#queue.set(job.key, job);
          break;
        }
        const chunk = input.chunk as PackedChunk,
          flags = this.#flags(input.blocks);
        let seen = 0;
        for (const s of chunk.palette) seen |= flags[s & 0xffff];
        for (const s of input.shell) seen |= flags[s & 0xffff];
        const first = flags[chunk.palette[0] & 0xffff];
        if (!chunk.bits && (first & 3) === INVISIBLE) {
          this.stats.empty++;
          job.resolve({ ...EMPTY(), visibility: ALL });
        } else if (seen & PART) {
          this.stats.cpu++;
          const mesh = meshChunk(input);
          if (job.eye) sortQuads(mesh.translucent, job.eye);
          job.resolve(mesh);
        } else {
          gpu.push({ job, chunk, shell: input.shell, light: input.light, visibility: visibility(chunk, flags) });
          this.#running.add(job);
        }
      }
      if (gpu.length) {
        const meshes = await this.#dispatch(gpu);
        this.stats.gpu += gpu.length;
        this.stats.batches++;
        gpu.forEach(({ job }, i) => {
          if (job.cancelled || this.#disposed) return job.resolve(null);
          const mesh = meshes[i];
          if (job.eye) sortQuads(mesh.translucent, job.eye);
          job.resolve(mesh);
        });
      }
    } catch (error) {
      for (const { job } of gpu) job.reject(error);
    } finally {
      for (const { job } of gpu) this.#running.delete(job);
      this.#busy = false;
      this.#schedule();
    }
  }

  // Block flags of a block table, and its GPU copy: per id the flags, then the six face materials.
  #flags(blocks: readonly BlockType[]): Uint8Array {
    let table = this.#table;
    if (table?.blocks === blocks && table.n === blocks.length) return table.flags;
    const flags = new Uint8Array(blocks.length),
      materials = blockMaterials(blocks),
      data = new Uint32Array(blocks.length * 8);
    for (let id = 0; id < blocks.length; id++) {
      const layer = LAYERS[blocks[id]?.layer] as number | undefined,
        shape = SHAPES[blocks[id]?.shape] as number | undefined;
      if (layer === undefined || shape === undefined)
        throw new TypeError(`GpuVoxelMesher block type ${id} is not a block type; use the world's BlockTypes`);
      flags[id] = layer | shape | (layer === 0 && shape === 0 ? OCCLUDES : 0) | (layer === 3 || shape === 4 ? 32 : 0);
      data[id * 8] = flags[id];
      for (let f = 0; f < 6; f++) data[id * 8 + 1 + f] = materials[id * 6 + f];
    }
    this.#drop(table?.buffer);
    this.#table = table = { blocks, n: blocks.length, flags, data };
    return flags;
  }

  async #dispatch(
    list: { chunk: PackedChunk; shell: Uint32Array; light: Uint8Array; visibility: number }[],
  ): Promise<ChunkMesh[]> {
    this.#setup();
    const device = this.#device,
      pipes = this.#pipelines!,
      table = this.#table!,
      n = list.length,
      meta = new Uint32Array(this.batch * 8),
      parts: Uint32Array[] = [];
    if (!table.buffer) {
      table.buffer = this.#buffer(table.data.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
      device.queue.writeBuffer(table.buffer, 0, table.data);
    }
    let words = 0;
    const put = (data: Uint32Array) => {
      parts.push(data);
      const at = words;
      words += data.length;
      return at;
    };
    const bytes = (data: Uint8Array) => {
      const padded = new Uint8Array((data.length + 3) & ~3);
      padded.set(data);
      return new Uint32Array(padded.buffer);
    };
    list.forEach(({ chunk, shell, light }, b) => {
      const m = b * 8;
      meta[m] = chunk.bits;
      meta[m + 1] = put(chunk.palette);
      meta[m + 2] = put(chunk.words);
      if (typeof chunk.light === 'number') (meta[m + 6] = 1), (meta[m + 7] = chunk.light);
      else meta[m + 3] = put(bytes(chunk.light));
      meta[m + 4] = put(shell);
      meta[m + 5] = put(bytes(light));
    });
    const src = new Uint32Array(Math.max(words, 1));
    let at = 0;
    for (const part of parts) src.set(part, (at += part.length) - part.length);
    if (!this.#src || this.#src.size < src.byteLength) {
      this.#drop(this.#src);
      this.#src = this.#buffer(Math.max(src.byteLength, 1 << 20), GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    }
    device.pushErrorScope('validation');
    device.queue.writeBuffer(this.#src, 0, src);
    device.queue.writeBuffer(this.#meta, 0, meta);
    const BINDINGS = {
        unpack: [0, 1, 2, 3],
        faces: [2, 3, 4, 5],
        crosses: [2, 5],
        offsets: [5],
        place: [2, 3, 4, 5, 6],
      },
      pass = (encoder: GPUCommandEncoder, name: keyof typeof BINDINGS, x: number, out?: GPUBuffer) => {
        const buffers: GPUBuffer[] = [this.#src!, this.#meta, this.#vol, table.buffer!, this.#slots, this.#aux, out!],
          pipe = pipes[name],
          p = encoder.beginComputePass();
        p.setPipeline(pipe);
        p.setBindGroup(
          0,
          device.createBindGroup({
            layout: pipe.getBindGroupLayout(0),
            entries: BINDINGS[name].map((i) => ({ binding: i, resource: { buffer: buffers[i] } })),
          }),
        );
        p.dispatchWorkgroups(x, n);
        p.end();
      };
    // First submit: unpack, faces and merges, cross counts, offsets; read back the layer totals.
    const totalsAt = this.batch * 3584 * 4,
      read = device.createBuffer({ size: n * 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    let encoder = device.createCommandEncoder();
    pass(encoder, 'unpack', Math.ceil(VOLUME / 256));
    pass(encoder, 'faces', SLOTS);
    pass(encoder, 'crosses', 1);
    pass(encoder, 'offsets', 1);
    encoder.copyBufferToBuffer(this.#aux, totalsAt, read, 0, n * 16);
    device.queue.submit([encoder.finish()]);
    let totals: Uint32Array;
    try {
      const [error] = await Promise.all([device.popErrorScope(), read.mapAsync(GPUMapMode.READ)]);
      if (error)
        throw new MargoError(
          'failed',
          `GpuVoxelMesher GPU work failed (${error.message}); mesh the chunk with meshChunk or VoxelMesher instead`,
        );
      totals = new Uint32Array(read.getMappedRange().slice(0));
    } finally {
      read.destroy();
    }
    // Layer bases in one output array: chunk by chunk, each chunk's opaque, cutout and translucent quads.
    const bases = new Uint32Array(n * 4);
    let quads = 0;
    for (let b = 0; b < n; b++)
      for (let l = 0; l < 3; l++) {
        bases[b * 4 + l] = quads;
        quads += totals[b * 4 + l];
      }
    const size = Math.max(quads * 12, 16);
    if (!this.#out || this.#out.size < size) {
      this.#drop(this.#out);
      this.#out = this.#buffer(
        Math.max(size, 1 << 20),
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
      );
    }
    device.queue.writeBuffer(this.#aux, this.batch * 3588 * 4, bases);
    const back = device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    encoder = device.createCommandEncoder();
    pass(encoder, 'place', SLOTS + 1, this.#out);
    encoder.copyBufferToBuffer(this.#out, 0, back, 0, size);
    device.queue.submit([encoder.finish()]);
    let all: Uint32Array;
    try {
      await back.mapAsync(GPUMapMode.READ);
      all = new Uint32Array(back.getMappedRange().slice(0));
    } finally {
      back.destroy();
    }
    return list.map(({ visibility }, b) => {
      const layer = (l: number) => all.slice(bases[b * 4 + l] * 3, (bases[b * 4 + l] + totals[b * 4 + l]) * 3);
      return { opaque: layer(0), cutout: layer(1), translucent: layer(2), visibility };
    });
  }

  /** Cancels every pending job and frees the GPU scratch. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const job of this.#queue.values()) job.resolve(null);
    this.#queue.clear();
    for (const job of this.#running) job.cancelled = true;
    for (const buffer of this.#buffers.splice(0)) buffer.destroy();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}

const EMPTY = () => ({ opaque: new Uint32Array(0), cutout: new Uint32Array(0), translucent: new Uint32Array(0) });

// Which chunk faces see each other through cells that are not opaque cubes, as meshChunk reports it: a flood fill of
// the open cells from each unseen one, every pair of chunk faces it reaches joined.
function visibility(chunk: PackedChunk, flags: Uint8Array): number {
  const { palette, bits, words } = chunk;
  if (!bits) return flags[palette[0] & 0xffff] & OCCLUDES ? 0 : ALL;
  const seen = new Uint8Array(CELLS),
    stack = new Int32Array(CELLS),
    mask = (1 << bits) - 1;
  for (let i = 0; i < CELLS; i++) {
    const bit = i * bits;
    seen[i] = (flags[palette[(words[bit >>> 5] >>> (bit & 31)) & mask] & 0xffff] >> 4) & 1;
  }
  let result = 0;
  for (let start = 0; start < CELLS && result !== ALL; start++) {
    if (seen[start]) continue;
    let top = 0,
      reached = 0;
    seen[start] = 1;
    stack[top++] = start;
    while (top) {
      const i = stack[--top],
        x = i & 31,
        z = (i >> 5) & 31,
        y = i >> 10;
      if (x === 31) reached |= 1;
      else if (!seen[i + 1]) (seen[i + 1] = 1), (stack[top++] = i + 1);
      if (x === 0) reached |= 2;
      else if (!seen[i - 1]) (seen[i - 1] = 1), (stack[top++] = i - 1);
      if (y === 31) reached |= 4;
      else if (!seen[i + 1024]) (seen[i + 1024] = 1), (stack[top++] = i + 1024);
      if (y === 0) reached |= 8;
      else if (!seen[i - 1024]) (seen[i - 1024] = 1), (stack[top++] = i - 1024);
      if (z === 31) reached |= 16;
      else if (!seen[i + 32]) (seen[i + 32] = 1), (stack[top++] = i + 32);
      if (z === 0) reached |= 32;
      else if (!seen[i - 32]) (seen[i - 32] = 1), (stack[top++] = i - 32);
    }
    result |= pairs(reached);
  }
  return result;
}
