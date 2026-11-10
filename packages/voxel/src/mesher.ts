/// <reference lib="esnext.disposable" preserve="true" />
// @margoengine/voxel/mesher: the pure chunk mesher. One chunk plus the one-cell shell of its neighbours becomes greedy
// quads in the 12-byte vertex-pulling format of packages/voxel/DESIGN.md ("Data formats"); phase 3 runs it in workers.
import type { Vec3 } from '@margoengine/math';
import { MargoError } from '@margoengine/math/errors';
import { JobPool } from '../../shared/worker-pool.js';
import type { BlockType } from './blocks.js';
import { slabOctants, stairOctants, WATERLOGGED } from './octants.js';
import type { PackedChunk, VoxelChunk } from './chunk.js';
import type { VoxelWorld } from './world.js';

/** u32 words per quad in a {@link ChunkMesh} layer array: 3 (12 bytes). Quad `i` is words `3i` to `3i + 2`. */
export const QUAD_WORDS = 3;

/**
 * Input of {@link meshChunk}: one chunk, the cells around it and the block table. {@link meshInput} builds it from a
 * world. Every field is plain data that a worker can receive.
 */
export interface MeshInput {
  /** The chunk to mesh: a {@link VoxelChunk} or its {@link VoxelChunk.pack} output. */
  chunk: PackedChunk | VoxelChunk;
  /**
   * Block states of the 6,536 shell cells: the cells of the 34 x 34 x 34 cube at local coordinates -1..32 outside the
   * chunk's 0..31, in order of `(x + 1) + 34 (z + 1) + 1156 (y + 1)` (x fastest, then z, then y). They decide the
   * faces, ambient occlusion and smooth light at the chunk's borders.
   */
  shell: Uint32Array;
  /** Light bytes (`sky << 4 | block`) of the shell cells, in the same order. */
  light: Uint8Array;
  /** The block types the states refer to: `BlockTypes.table`, or a worker's copy of it. */
  blocks: readonly BlockType[];
}

/**
 * Output of {@link meshChunk}: the quads of each render layer, {@link QUAD_WORDS} u32 each, and which chunk faces see
 * each other. Every array owns its buffer, so it can be transferred. {@link decodeQuad} reads a quad back.
 *
 * Quad bits, low bits first. Word 0: local cell x 0-4, y 5-9, z 10-14; face 15-17 (0-5: +x, -x, +y, -y, +z, -z;
 * 6, 7: the diagonals of a cross block); w - 1 at 18-22 and h - 1 at 23-27 (size in cells along u and v); flip 28;
 * liquidDrop 29-31. Word 1: material 0-11; AO of corners 0-3 at 12-13, 14-15, 16-17, 18-19 (0 darkest, 3 open);
 * wave 20; inset 21; trim 22-25; 26-31 zero. Word 2: corner c's sky light at bits 8c to 8c + 3 and block light at
 * 8c + 4 to 8c + 7.
 *
 * Geometry: (u, v) are (z, y) on x faces, (x, z) on y faces and (x, y) on z faces; the face lies on the cell's side
 * toward its normal (cell + 1 for +x, +y, +z). Face 6 runs from the cell's (x, z) corner to (x + 1, z + 1), face 7 from
 * (x + 1, z) to (x, z + 1), both with v = y. Corner c sits at (u, v) = (0, 0), (w, 0), (w, h), (0, h) from the cell.
 * Triangles are (0, 1, 2) and (0, 2, 3), or (0, 1, 3) and (1, 2, 3) when flip is set. A liquid's top corners (the whole
 * +y face, corners 2 and 3 of a side face) sit liquidDrop eighths of a block below the cell top; wave marks a quad of a
 * liquid's surface (its +y face and the sides of a cell without the same liquid above). Slabs, stairs and the faces
 * they partly cover use the half-block bits: inset moves the face half a block back toward its cell's centre, and trim
 * bits 1, 2, 4, 8 move the quad's start along u, its end along u, its start along v and its end along v half a block
 * inward, so corner 0 sits at (0.5, 0) when bit 1 is set and corner 2 at (w - 0.5, h) when bit 2 is.
 */
export interface ChunkMesh {
  /** Quads of `'opaque'` blocks. */
  opaque: Uint32Array;
  /** Quads of `'cutout'` blocks. */
  cutout: Uint32Array;
  /** Quads of `'translucent'` blocks. */
  translucent: Uint32Array;
  /**
   * Chunk faces (0-5: +x, -x, +y, -y, +z, -z) joined through cells that are not opaque cubes: bit `a * 6 + b` is set
   * when faces `a < b` are connected, so a renderer can skip chunks that no line of sight crosses (cave culling).
   */
  visibility: number;
}

/** One quad's fields, from {@link decodeQuad} (see {@link ChunkMesh} for their meaning). */
export interface DecodedQuad {
  /** Local cell x of the quad's corner 0, 0-31. */
  x: number;
  /** Local cell y, 0-31. */
  y: number;
  /** Local cell z, 0-31. */
  z: number;
  /** 0-5: +x, -x, +y, -y, +z, -z; 6, 7: cross diagonals. */
  face: number;
  /** Width in cells along u, 1-32. */
  w: number;
  /** Height in cells along v, 1-32. */
  h: number;
  /** Triangles split along corners 1-3 instead of 0-2. */
  flip: boolean;
  /** Eighths of a block the liquid surface sits below the cell top, 0-7. */
  liquidDrop: number;
  /** Material id from {@link blockMaterials}, 0-4095. */
  material: number;
  /** Ambient occlusion per corner, 0 (darkest) to 3 (open). */
  ao: [number, number, number, number];
  /** Part of a liquid surface. */
  wave: boolean;
  /** The face lies half a block inside its cell, toward the cell's centre (a slab's top, a stair's step). */
  inset: boolean;
  /**
   * Half-block trims: bit 1 starts the quad half a block later along u, bit 2 ends it half a block earlier along u,
   * bits 4 and 8 the same along v. 0 for whole-cell quads.
   */
  trim: number;
  /** Sky light per corner, 0-15. */
  sky: [number, number, number, number];
  /** Block light per corner, 0-15. */
  block: [number, number, number, number];
}

const CELLS = 32768,
  SHELL = 6536,
  VOLUME = 39304, // 34^3, index (x + 1) + 34 (z + 1) + 1156 (y + 1) for local x, y, z in -1..32
  SZ = 34,
  SY = 1156,
  BASE = 1191, // index of local cell (0, 0, 0)
  // Per block id: layer in bits 0-1 (opaque, cutout, translucent, invisible), shape in 2-3, opaque cube in 4, no cube
  // faces (invisible or cross) in 5, slab or stair in 6 (with shape bits 12).
  INVISIBLE = 3,
  SHAPE = 12,
  CROSS = 4,
  LIQUID = 8,
  OCCLUDES = 16,
  NO_FACES = 32,
  PART = 64,
  TAG = 0x8000, // a bucket entry meshed at half-block resolution
  LAYERS: Record<string, number> = { opaque: 0, cutout: 1, translucent: 2, invisible: 3 },
  SHAPES: Record<string, number> = {
    cube: 0,
    cross: CROSS,
    liquid: LIQUID,
    slab: SHAPE | PART,
    stair: SHAPE | PART,
    model: NO_FACES,
  },
  // Per face direction (+x, -x, +y, -y, +z, -z): index strides of the normal, u and v axes, and the word 0 shifts of
  // the slice, u and v coordinates (x at 0, y at 5, z at 10).
  NORMAL = [1, 1, SY, SY, SZ, SZ],
  U = [SZ, SZ, 1, 1, 1, 1],
  V = [SY, SY, SZ, SZ, SY, SY],
  AT_S = [0, 0, 5, 5, 10, 10],
  AT_U = [10, 10, 0, 0, 0, 0],
  AT_V = [5, 5, 10, 10, 5, 5],
  // Per face direction: the octant bit (x 1, y 2, z 4) of the normal, u and v axes.
  BIT_N = [1, 1, 2, 2, 4, 4],
  BIT_U = [4, 4, 1, 1, 1, 1],
  BIT_V = [2, 2, 4, 4, 2, 2];

// Rectangles covering each 2 x 2 mask of quarter faces (bit u + 2v), as u0 | v0 << 2 | u1 << 4 | v1 << 6 in half
// blocks (0-2): both rows at once when they match, else a full row first and the other row's quarters; at most two.
const RECTS: readonly (readonly number[])[] = Array.from({ length: 16 }, (_, mask) => {
  const out: number[] = [],
    row = (bits: number, v0: number, v1: number) => {
      if (bits === 3) out.push((v0 << 2) | (2 << 4) | (v1 << 6));
      else if (bits) out.push((bits >> 1) | (v0 << 2) | (((bits >> 1) + 1) << 4) | (v1 << 6));
    },
    low = mask & 3,
    high = mask >> 2;
  if (low === high) row(low, 0, 2);
  else if (high === 3) {
    row(3, 1, 2);
    row(low, 0, 1);
  } else {
    row(low, 0, 1);
    row(high, 1, 2);
  }
  return out;
});

// Visibility bits of every pair among the chunk faces set in `faces`.
const pairs = (faces: number): number => {
  let bits = 0;
  for (let a = 0; a < 5; a++)
    if (faces & (1 << a)) for (let b = a + 1; b < 6; b++) if (faces & (1 << b)) bits |= 1 << (a * 6 + b);
  return bits;
};
const ALL = pairs(63);

/**
 * Material ids of a block table: entry `id * 6 + face` (faces +x, -x, +y, -y, +z, -z) is the id that
 * {@link meshChunk} writes for that face; a cross block's two quads use face 0's. Ids count up from 0 in block id
 * order, one per distinct texture layer of each block, so a renderer builds its material table (texture layer plus the
 * block's tint, roughness, metalness, emissive and animation) from the same walk. Invisible blocks get 0xffff.
 * @throws RangeError when the blocks need more than 4,096 materials (share texture layers within blocks).
 */
export function blockMaterials(blocks: readonly BlockType[]): Uint16Array {
  const ids = new Uint16Array(blocks.length * 6).fill(0xffff);
  let next = 0;
  for (let id = 0; id < blocks.length; id++) {
    const { layer, textures } = blocks[id];
    if (layer === 'invisible') continue;
    for (let face = 0; face < 6; face++) {
      const same = textures.indexOf(textures[face]);
      if (same < face) ids[id * 6 + face] = ids[id * 6 + same];
      else if (next === 4096)
        throw new RangeError('Block types need more than 4,096 materials; reuse texture layers or block states');
      else ids[id * 6 + face] = next++;
    }
  }
  return ids;
}

interface Table {
  n: number;
  flags: Uint8Array;
  materials: Uint16Array;
  // Per id: 1 for a stair (else a slab's or no octant table), and the liquid id a waterlogged state holds.
  stairs: Uint8Array;
  waterlogs: Uint16Array;
}
// Derived per-id data, kept per table (BlockTypes.table only grows, so a longer table is rebuilt).
const tables = new WeakMap<readonly BlockType[], Table>();
function prepare(blocks: readonly BlockType[]): Table {
  let table = tables.get(blocks);
  if (table?.n === blocks.length) return table;
  const flags = new Uint8Array(blocks.length),
    stairs = new Uint8Array(blocks.length),
    waterlogs = new Uint16Array(blocks.length);
  for (let id = 0; id < blocks.length; id++) {
    const layer = LAYERS[blocks[id]?.layer] as number | undefined,
      shape = SHAPES[blocks[id]?.shape] as number | undefined;
    if (layer === undefined || shape === undefined)
      throw new TypeError(`MeshInput blocks[${id}] is not a block type; pass blocks.table`);
    flags[id] =
      layer | shape | (layer === 0 && shape === 0 ? OCCLUDES : 0) | (layer === 3 || shape === CROSS ? NO_FACES : 0);
    stairs[id] = +(blocks[id].shape === 'stair');
    waterlogs[id] = blocks[id].waterlog ?? 0;
  }
  table = { n: blocks.length, flags, materials: blockMaterials(blocks), stairs, waterlogs };
  tables.set(blocks, table);
  return table;
}

// Scratch reused by every call: the chunk and its shell as 34^3 states, light bytes, block flags, opaque-cube flags and
// spread light; the candidate faces of each (direction, slice) bucket; the two words of each face in one 32 x 32 slice
// and the slice's faces in scan order; flood-fill state and the growing output per layer. With slabs or stairs in
// reach also: the block flags by id, each cell's octants (cube 255), its opaque octants, its liquid and that liquid's
// octants, whether a slab or stair is within one cell, and the slice's trimmed or inset faces (cell, the two words,
// and the half-block bits) waiting for their own merges.
interface Work {
  states: Uint32Array;
  light: Uint8Array;
  kind: Uint8Array;
  occ: Uint8Array;
  spread: Uint16Array;
  flags: Uint8Array;
  shape: Uint8Array;
  solid: Uint8Array;
  wet: Uint16Array;
  wetMask: Uint8Array;
  near: Uint8Array;
  partM: Uint16Array;
  partK: Uint32Array;
  partL: Uint32Array;
  partN: number;
  bucket: Uint16Array;
  filled: Uint16Array;
  keys: Uint32Array;
  lights: Uint32Array;
  list: Uint16Array;
  stack: Int32Array;
  seen: Uint8Array;
  out: Uint32Array[];
  count: number[];
}
let work: Work | undefined;

function push(w: Work, layer: number, w0: number, w1: number, w2: number): void {
  let a = w.out[layer];
  const n = w.count[layer];
  if (n + 3 > a.length) {
    const grown = new Uint32Array(a.length * 2);
    grown.set(a);
    w.out[layer] = a = grown;
  }
  a[n] = w0;
  a[n + 1] = w1;
  a[n + 2] = w2;
  w.count[layer] = n + 3;
}

// MEAN[n << 6 | sum]: sum / n rounded half up, for 1-4 light levels summing to at most 60.
const MEAN = Uint8Array.from({ length: 320 }, (_, i) =>
  i >> 6 ? Math.floor(((i & 63) * 2 + (i >> 6)) / ((i >> 6) * 2)) : 0,
);

// Light of a face vertex as sky | block << 4: the rounded mean of its `n` open cells, whose light sums to `sum` (as
// sky << 8 | block), or the block's own light byte when none is open (a lowered liquid top under a solid block).
const vertexLight = (n: number, sum: number, own: number): number =>
  n ? MEAN[(n << 6) | (sum >> 8)] | (MEAN[(n << 6) | (sum & 255)] << 4) : (own >> 4) | ((own & 15) << 4);

// Greedy merge of the `n` listed faces of slice `s` of face direction `d`, in scan order: each run grows along u, then
// v, over faces with equal words, and only along an axis its corners are equal on, so every merged quad interpolates
// exactly like the unit faces it covers.
function merge(w: Work, d: number, s: number, n: number): void {
  const { keys, lights, list } = w,
    base = (s << AT_S[d]) | (d << 15),
    atU = AT_U[d],
    atV = AT_V[d];
  for (let i = 0; i < n; i++) {
    const m = list[i],
      A = keys[m];
    if (!A) continue; // inside a quad already emitted
    const u = m & 31,
      v = m >> 5,
      B = lights[m],
      o0 = (A >>> 12) & 3,
      o1 = (A >>> 14) & 3,
      o2 = (A >>> 16) & 3,
      o3 = (A >>> 18) & 3,
      l0 = B & 255,
      l1 = (B >>> 8) & 255,
      l2 = (B >>> 16) & 255,
      l3 = B >>> 24;
    let width = 1,
      height = 1;
    // Half-block bits (key bits 26-30: inset, then the trims): a trimmed quad leaves a gap along its trimmed axis, so
    // it only merges across the other one.
    const part = (A >>> 26) & 31;
    if (o0 === o1 && o3 === o2 && l0 === l1 && l3 === l2 && !(part & 6))
      while (u + width < 32 && keys[m + width] === A && lights[m + width] === B) width++;
    if (o0 === o3 && o1 === o2 && l0 === l3 && l1 === l2 && !(part & 24))
      grow: for (; v + height < 32; height++)
        for (let k = m + (height << 5), end = k + width; k < end; k++) if (keys[k] !== A || lights[k] !== B) break grow;
    for (let j = 0; j < height; j++) for (let k = m + (j << 5), end = k + width; k < end; k++) keys[k] = 0;
    // AO picks the diagonal: split along the brighter pair so a lone dark corner stays in one triangle
    // (Mikola Lysenko, 2013, 0fps.net, ambient occlusion for voxel worlds).
    const flip = o1 + o3 > o0 + o2 ? 1 << 28 : 0;
    push(
      w,
      (A >>> 24) & 3,
      (base | (u << atU) | (v << atV) | ((width - 1) << 18) | ((height - 1) << 23) | flip | ((A >>> 21) << 29)) >>> 0,
      (A & 0x1fffff) | (part << 21),
      B,
    );
  }
}

const add = (bucket: Uint16Array, filled: Uint16Array, b: number, m: number): void => {
  bucket[(b << 10) + filled[b]++] = m;
};

// One pass over the chunk's cells: each cube face that no opaque cube covers goes to bucket `direction * 32 + slice`
// as its slice position u | v << 5, already in the order the greedy merge scans (rows of v, then u). Liquids keep every
// face for the checks in `faces`. Cross blocks emit their two diagonal quads, unshaded (AO 3) and lit by their own
// cell. In a uniform chunk only boundary cells can show faces. With slabs or stairs about (`parts`), their six face
// directions and every cube face whose front cell has one within a cell go in tagged (TAG): meshed by `half`.
function candidates(w: Work, materials: Uint16Array, boundaryOnly: boolean, parts: boolean): void {
  const { states, light, kind, occ, near, bucket, filled } = w;
  filled.fill(0);
  for (let y = 0; y < 32; y++)
    for (let z = 0; z < 32; z++)
      for (let x = 0, p = BASE + z * SZ + y * SY; x < 32; x++, p++) {
        const f = kind[p];
        if (f & NO_FACES) {
          if ((f & SHAPE) !== CROSS || (f & 3) === INVISIBLE) continue;
          const cell = x | (y << 5) | (z << 10),
            w1 = materials[(states[p] & 0xffff) * 6] | (0xff << 12),
            w2 = (((light[p] >> 4) | ((light[p] & 15) << 4)) * 0x01010101) >>> 0;
          push(w, f & 3, cell | (6 << 15), w1, w2);
          push(w, f & 3, cell | (7 << 15), w1, w2);
          continue;
        }
        if (boundaryOnly && x && y && z && x < 31 && y < 31 && z < 31) continue;
        if (parts) {
          // Slabs and stairs keep every face for `half`; cubes and liquids send faces near one there too.
          const tag = f & PART ? TAG : 0,
            all = tag || (f & SHAPE) === LIQUID;
          if (all || !occ[p + 1]) add(bucket, filled, x, z | (y << 5) | (tag || (near[p + 1] && TAG)));
          if (all || !occ[p - 1]) add(bucket, filled, 32 + x, z | (y << 5) | (tag || (near[p - 1] && TAG)));
          if (all || !occ[p + SY]) add(bucket, filled, 64 + y, x | (z << 5) | (tag || (near[p + SY] && TAG)));
          if (all || !occ[p - SY]) add(bucket, filled, 96 + y, x | (z << 5) | (tag || (near[p - SY] && TAG)));
          if (all || !occ[p + SZ]) add(bucket, filled, 128 + z, x | (y << 5) | (tag || (near[p + SZ] && TAG)));
          if (all || !occ[p - SZ]) add(bucket, filled, 160 + z, x | (y << 5) | (tag || (near[p - SZ] && TAG)));
          continue;
        }
        const all = f & LIQUID;
        if (all || !occ[p + 1]) add(bucket, filled, x, z | (y << 5));
        if (all || !occ[p - 1]) add(bucket, filled, 32 + x, z | (y << 5));
        if (all || !occ[p + SY]) add(bucket, filled, 64 + y, x | (z << 5));
        if (all || !occ[p - SY]) add(bucket, filled, 96 + y, x | (z << 5));
        if (all || !occ[p + SZ]) add(bucket, filled, 128 + z, x | (y << 5));
        if (all || !occ[p - SZ]) add(bucket, filled, 160 + z, x | (y << 5));
      }
}

// Culls each candidate face, gives it AO and smooth light, and merges each slice's visible faces.
function faces(w: Work, materials: Uint16Array): void {
  const { states, light, kind, occ, spread, bucket, filled, keys, lights, list } = w;
  for (let d = 0; d < 6; d++) {
    const sN = NORMAL[d],
      front = d & 1 ? -sN : sN,
      sU = U[d],
      sV = V[d],
      top = d === 2,
      side = d < 2 || d > 3;
    for (let s = 0; s < 32; s++) {
      const slot = d * 32 + s;
      let n = 0;
      for (let k = slot << 10, end = k + filled[slot]; k < end; k++) {
        const m = bucket[k];
        if (m & TAG) {
          n = half(w, materials, d, s, m & 1023, n);
          continue;
        }
        const p = BASE + s * sN + (m & 31) * sU + (m >> 5) * sV,
          f = kind[p],
          q = p + front,
          state = states[p],
          id = state & 0xffff,
          liquid = (f & SHAPE) === LIQUID,
          // A liquid cell without the same liquid above is a surface: its top and sides drop by its data's low bits.
          surface = liquid && d !== 3 && (states[p + SY] & 0xffff) !== id,
          drop = surface ? (state >>> 16) & 7 : 0;
        if (occ[q]) {
          // An opaque cube hides the face, unless it is a lowered liquid top that does not reach it.
          if (!top || !drop) continue;
        } else if ((states[q] & 0xffff) === id) {
          // Faces between identical blocks are hidden, except a liquid side above a lower surface of the same liquid.
          if (!side || !liquid || drop >= ((states[q + SY] & 0xffff) === id ? 0 : (states[q] >>> 16) & 7)) continue;
        }
        // Per vertex, from its two edge cells and its diagonal cell in the front layer: AO is 0 when both edges are
        // opaque cubes, else 3 minus their count (Mikola Lysenko, 2013, 0fps.net,
        // ambient occlusion for voxel worlds). Smooth light is the mean of the open cells among those and the front
        // cell, the diagonal counting only past an open edge, so the open count is AO + 1 when the front cell is open
        // (AO otherwise).
        // `spread` holds open cells' light as sky << 8 | block and opaque ones as 0: one sum adds both channels.
        const a = occ[q - sU],
          b = occ[q + sU],
          c = occ[q - sV],
          e = occ[q + sV],
          ao0 = a & c ? 0 : 3 - a - c - occ[q - sU - sV],
          ao1 = b & c ? 0 : 3 - b - c - occ[q + sU - sV],
          ao2 = b & e ? 0 : 3 - b - e - occ[q + sU + sV],
          ao3 = a & e ? 0 : 3 - a - e - occ[q - sU + sV],
          open = 1 - occ[q],
          sq = spread[q],
          sa = spread[q - sU],
          sb = spread[q + sU],
          sc = spread[q - sV],
          se = spread[q + sV],
          own = light[p];
        // Word 1 plus drop (21-23), layer (24-25) and a presence bit (31): faces merge only when all of it is equal.
        keys[m] =
          materials[id * 6 + d] |
          (ao0 << 12) |
          (ao1 << 14) |
          (ao2 << 16) |
          (ao3 << 18) |
          (surface ? 1 << 20 : 0) |
          (drop << 21) |
          ((f & 3) << 24) |
          (1 << 31);
        lights[m] =
          vertexLight(ao0 + open, sq + sa + sc + (a & c ? 0 : spread[q - sU - sV]), own) |
          (vertexLight(ao1 + open, sq + sb + sc + (b & c ? 0 : spread[q + sU - sV]), own) << 8) |
          (vertexLight(ao2 + open, sq + sb + se + (b & e ? 0 : spread[q + sU + sV]), own) << 16) |
          (vertexLight(ao3 + open, sq + sa + se + (a & e ? 0 : spread[q - sU + sV]), own) << 24);
        list[n++] = m;
      }
      if (n) merge(w, d, s, n);
      if (w.partN) mergeParts(w, d, s);
    }
  }
}

// Face direction d of the cell at slice position m of slice s, at half-block resolution: the cell is a slab or stair,
// or a cube or liquid whose front cell has one within a cell. A cell may hold a block (its octants) and a liquid (a
// liquid cell's whole cell, a waterlogged slab's or stair's open octants). Each quarter of the block's face on the
// cell's side shows when the block fills the octant behind it and the octant in front is neither opaque nor the same
// block's; a slab or stair also shows the quarters of its mid-cell (inset) face where it fills the octant behind and
// not the one in front. The liquid's quarters follow the liquid rules of `faces` per half block: opaque octants in
// front hide them (not over a lowered top), and so do the same liquid's (except a side above a lower surface); its
// inset quarters face its own block, hidden where that is opaque.
function half(w: Work, materials: Uint16Array, d: number, s: number, m: number, n: number): number {
  const { states, kind, flags, shape, solid, wet, wetMask } = w,
    sN = NORMAL[d],
    bN = BIT_N[d],
    bU = BIT_U[d],
    bV = BIT_V[d],
    plus = !(d & 1),
    p = BASE + s * sN + (m & 31) * U[d] + (m >> 5) * V[d],
    q = p + (plus ? sN : -sN),
    // Octant bit along the normal of the cell's half toward the face direction, and of its other half.
    out = plus ? bN : 0,
    back = plus ? 0 : bN,
    own = shape[p],
    liquid = wet[p];
  if (own) {
    const id = states[p] & 0xffff,
      hide = solid[q] | ((states[q] & 0xffff) === id ? shape[q] : 0);
    let outer = 0,
      inset = 0;
    for (let c = 0; c < 4; c++) {
      const o = (c & 1 ? bU : 0) | (c & 2 ? bV : 0);
      if ((own >> (o | out)) & 1) {
        if (!((hide >> (o | back)) & 1)) outer |= 1 << c;
      } else if ((own >> (o | back)) & 1) inset |= 1 << c;
    }
    n = rects(w, d, s, m, n, p, outer, inset, materials[id * 6 + d] | ((kind[p] & 3) << 24) | (1 << 31));
  }
  if (liquid) {
    const lm = wetMask[p],
      // A liquid cell without the same liquid above is a surface, its top and sides lowered by its data's low bits
      // (a waterlogged block's liquid never is lowered).
      surface = d !== 3 && wet[p + SY] !== liquid,
      drop = surface && !own ? (states[p] >>> 16) & 7 : 0,
      same = wet[q] === liquid,
      // A side above a lower surface of the same liquid stays.
      lower =
        same &&
        (d < 2 || d > 3) &&
        (kind[q] & SHAPE) === LIQUID &&
        drop < (wet[q + SY] === liquid ? 0 : (states[q] >>> 16) & 7),
      hide = (d === 2 && drop ? 0 : solid[q]) | (same && !lower ? wetMask[q] : 0),
      opaque = solid[p];
    let outer = 0,
      inset = 0;
    for (let c = 0; c < 4; c++) {
      const o = (c & 1 ? bU : 0) | (c & 2 ? bV : 0);
      if ((lm >> (o | out)) & 1) {
        if (!((hide >> (o | back)) & 1)) outer |= 1 << c;
      } else if ((lm >> (o | back)) & 1 && !((opaque >> (o | out)) & 1)) inset |= 1 << c;
    }
    // A side lowered by half a block or more has nothing in its upper half (v is y on sides).
    if (drop >= 4 && (d < 2 || d > 3)) outer &= 3;
    n = rects(
      w,
      d,
      s,
      m,
      n,
      p,
      outer,
      inset,
      materials[liquid * 6 + d] | (surface ? 1 << 20 : 0) | (drop << 21) | ((flags[liquid] & 3) << 24) | (1 << 31),
    );
  }
  return n;
}

// Quads for the visible quarters `outer` (on the cell's side) and `inset` (mid-cell) of face direction d of cell p, as
// at most two rectangles per plane (RECTS), with `base` (material, wave, drop, layer, presence) in their keys. AO and
// smooth light follow `faces` with half blocks for cells: per corner, the four half blocks of the front layer around
// it, opaque octants occluding. A whole face joins the slice's main merge (the new count is returned); trimmed and
// inset ones wait in part* for `mergeParts`.
function rects(
  w: Work,
  d: number,
  s: number,
  m: number,
  n: number,
  p: number,
  outer: number,
  inset: number,
  base: number,
): number {
  const { light, solid, spread, keys, lights, list } = w,
    sN = NORMAL[d],
    sU = U[d],
    sV = V[d],
    bN = BIT_N[d],
    bU = BIT_U[d],
    bV = BIT_V[d],
    plus = !(d & 1);
  for (let plane = 0; plane < 2; plane++) {
    const mask = plane ? inset : outer;
    if (!mask) continue;
    // Half-block index of the front layer along the normal, from the cell's low side.
    const hn = plane ? (plus ? 1 : 0) : plus ? 2 : -1,
      layer = p + (hn >> 1) * sN,
      layerBit = hn & 1 ? bN : 0;
    for (const r of RECTS[mask]) {
      const u0 = r & 3,
        v0 = (r >> 2) & 3,
        u1 = (r >> 4) & 3,
        v1 = r >> 6;
      let key = base | ((plane | ((u0 & 1) << 1) | ((u1 & 1) << 2) | ((v0 & 1) << 3) | ((v1 & 1) << 4)) << 26),
        lit = 0;
      for (let c = 0; c < 4; c++) {
        // Corner c at half-block (cu, cv); the half block on the face is (cu + du, cv + dv), du and dv 0 or -1.
        const right = c === 1 || c === 2,
          cu = right ? u1 : u0,
          cv = c >= 2 ? v1 : v0,
          du = right ? -1 : 0,
          dv = c >= 2 ? -1 : 0,
          // The half blocks across u, across v and diagonal from the one on the face.
          au = cu - 1 - du,
          av = cv - 1 - dv,
          iu = cu + du,
          iv = cv + dv,
          cI = layer + (iu >> 1) * sU + (iv >> 1) * sV,
          cA = layer + (au >> 1) * sU + (iv >> 1) * sV,
          cB = layer + (iu >> 1) * sU + (av >> 1) * sV,
          cG = layer + (au >> 1) * sU + (av >> 1) * sV,
          ou = iu & 1 ? bU : 0,
          ov = iv & 1 ? bV : 0,
          xu = au & 1 ? bU : 0,
          xv = av & 1 ? bV : 0,
          a = (solid[cA] >> (layerBit | xu | ov)) & 1,
          b = (solid[cB] >> (layerBit | ou | xv)) & 1,
          g = a & b ? 1 : (solid[cG] >> (layerBit | xu | xv)) & 1,
          ao = a & b ? 0 : 3 - a - b - g;
        key |= ao << (12 + 2 * c);
        lit |=
          vertexLight(
            ao + 1,
            spread[cI] + (a ? 0 : spread[cA]) + (b ? 0 : spread[cB]) + (g ? 0 : spread[cG]),
            light[p],
          ) <<
          (8 * c);
      }
      if (key >>> 26 === 0x20) {
        keys[m] = key;
        lights[m] = lit;
        list[n++] = m;
      } else {
        const i = w.partN++;
        w.partM[i] = m;
        w.partK[i] = key;
        w.partL[i] = lit >>> 0;
      }
    }
  }
  return n;
}

// Merges the slice's trimmed and inset faces, one half-block kind at a time (equal kinds never share a cell: a cell's
// block and liquid quarters are disjoint, and equal trims cover the same quarters).
function mergeParts(w: Work, d: number, s: number): void {
  const { keys, lights, list, partM, partK, partL } = w,
    count = w.partN;
  let kinds = 0;
  for (let i = 0; i < count; i++) kinds |= 1 << ((partK[i] >>> 26) & 31);
  for (let kind = 1; kind < 32; kind++) {
    if (!((kinds >>> kind) & 1)) continue;
    let n = 0;
    for (let i = 0; i < count; i++)
      if (((partK[i] >>> 26) & 31) === kind) {
        const m = partM[i];
        keys[m] = partK[i];
        lights[m] = partL[i];
        list[n++] = m;
      }
    merge(w, d, s, n);
  }
  w.partN = 0;
}

// With slabs or stairs about: each cell's octants (cube 255, slab or stair its mask, else 0) and opaque octants, the
// liquid it holds and that liquid's octants (a liquid cell all 8, a waterlogged slab or stair the ones it leaves
// open), and which cells have a slab or stair within one cell (their faces are meshed by `half`).
function halfBlocks(w: Work, t: Table): void {
  const { states, kind, shape, solid, wet, wetMask, near } = w,
    { stairs, waterlogs } = t;
  near.fill(0);
  for (let p = 0; p < VOLUME; p++) {
    const f = kind[p],
      state = states[p],
      id = state & 0xffff;
    let o = f & SHAPE ? 0 : 255,
      liquid = 0,
      lm = 0;
    if (f & PART) {
      const data = state >>> 16;
      o = stairs[id] ? stairOctants(data) : slabOctants(data);
      if (data & WATERLOGGED && waterlogs[id] && o !== 255) {
        liquid = waterlogs[id];
        lm = ~o & 255;
      }
    } else if ((f & SHAPE) === LIQUID) {
      liquid = id;
      lm = 255;
    }
    shape[p] = o;
    solid[p] = (f & 3) === 0 ? o : 0;
    wet[p] = liquid;
    wetMask[p] = lm;
    if (!(f & PART)) continue;
    const x = p % SZ,
      z = ((p / SZ) | 0) % SZ,
      y = (p / SY) | 0;
    for (let ny = Math.max(y - 1, 0); ny <= Math.min(y + 1, 33); ny++)
      for (let nz = Math.max(z - 1, 0); nz <= Math.min(z + 1, 33); nz++)
        for (let nx = Math.max(x - 1, 0); nx <= Math.min(x + 1, 33); nx++) near[nx + nz * SZ + ny * SY] = 1;
  }
}

// Flood fill over the chunk's open cells (not opaque cubes): the chunk faces each region reaches see each other.
function visibility(w: Work): number {
  const { occ, stack, seen } = w;
  for (let i = 0; i < CELLS; i++) seen[i] = occ[BASE + (i & 31) + ((i >> 5) & 31) * SZ + (i >> 10) * SY];
  let bits = 0;
  for (let start = 0; start < CELLS && bits !== ALL; start++) {
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
    bits |= pairs(reached);
  }
  return bits;
}

function packed(chunk: unknown): PackedChunk {
  const fix = 'pass a VoxelChunk or chunk.pack()';
  if (chunk && typeof (chunk as VoxelChunk).pack === 'function') return (chunk as VoxelChunk).pack();
  const c = chunk as PackedChunk;
  if (!c || !(c.palette instanceof Uint32Array) || !(c.words instanceof Uint32Array))
    throw new TypeError(`MeshInput chunk must be a VoxelChunk or a PackedChunk; ${fix}`);
  if (typeof c.light !== 'number' && !(c.light instanceof Uint8Array))
    throw new TypeError(`MeshInput chunk light must be a byte or a Uint8Array; ${fix}`);
  const { palette, bits, words, light } = c,
    cap = bits ? Math.min(2 ** bits, CELLS) : 1;
  if (![0, 1, 2, 4, 8, 16].includes(bits) || words.length !== 1024 * bits || !palette.length || palette.length > cap)
    throw new RangeError(
      `MeshInput chunk has ${bits}-bit indices, ${words.length} words and ${palette.length} palette entries; ${fix}`,
    );
  if (typeof light === 'number' ? (light & 255) !== light : light.length !== CELLS)
    throw new RangeError(`MeshInput chunk light must be a byte or 32,768 bytes; ${fix}`);
  return c;
}

/**
 * Meshes one chunk into greedy quads per render layer (see {@link ChunkMesh} for the quad format). Faces: an opaque
 * cube hides every face against it; faces between two blocks of the same id are hidden; every other face is kept (so
 * an opaque face behind glass stays and the glass face against it goes). Each face vertex gets ambient occlusion from
 * the opaque cubes around it and smooth light averaged from the open cells around it, and the AO picks the triangle
 * diagonal. Faces merge only when all their words are equal and their corners equal along the merge axis, so the
 * merged mesh shades exactly like one quad per block face. Cross blocks emit two diagonal quads; liquid blocks lower
 * their surface by their state data's low 3 bits (eighths of a block) and mark it to wave. Invisible blocks emit
 * nothing. Synchronous; it reuses about 1 MB of scratch between calls, so a call allocates little beyond its result.
 * @throws TypeError when `input` or one of its fields has the wrong type.
 * @throws RangeError for wrong array lengths, a cell index past the palette, a block id outside `blocks`, or more than
 * 4,096 materials.
 */
export function meshChunk(input: MeshInput): ChunkMesh {
  if (!input || typeof input !== 'object')
    throw new TypeError('meshChunk expects {chunk, shell, light, blocks}; build it with meshInput(world, key)');
  const { shell, light: around, blocks } = input,
    chunk = packed(input.chunk);
  if (!Array.isArray(blocks) || !blocks.length)
    throw new TypeError('MeshInput blocks must be the block table; pass blocks.table');
  if (!(shell instanceof Uint32Array) || !(around instanceof Uint8Array))
    throw new TypeError('MeshInput shell must be a Uint32Array and light a Uint8Array; build them with meshInput()');
  if (shell.length !== SHELL || around.length !== SHELL)
    throw new RangeError(
      `MeshInput shell and light have ${shell.length} and ${around.length} cells, not 6,536; build them with meshInput()`,
    );
  const prepared = prepare(blocks),
    { flags, materials } = prepared,
    w = (work ??= {
      states: new Uint32Array(VOLUME),
      light: new Uint8Array(VOLUME),
      kind: new Uint8Array(VOLUME),
      occ: new Uint8Array(VOLUME),
      spread: new Uint16Array(VOLUME),
      flags: new Uint8Array(0),
      shape: new Uint8Array(VOLUME),
      solid: new Uint8Array(VOLUME),
      wet: new Uint16Array(VOLUME),
      wetMask: new Uint8Array(VOLUME),
      near: new Uint8Array(VOLUME),
      partM: new Uint16Array(8192),
      partK: new Uint32Array(8192),
      partL: new Uint32Array(8192),
      partN: 0,
      bucket: new Uint16Array(192 * 1024),
      filled: new Uint16Array(192),
      keys: new Uint32Array(1024),
      lights: new Uint32Array(1024),
      list: new Uint16Array(1024),
      stack: new Int32Array(CELLS),
      seen: new Uint8Array(CELLS),
      out: [new Uint32Array(12288), new Uint32Array(12288), new Uint32Array(12288)],
      count: [0, 0, 0],
    }),
    { states, light, kind, occ, spread } = w,
    { palette, bits, words } = chunk,
    lightBytes = chunk.light,
    mask = (1 << bits) - 1;
  w.count.fill(0);
  w.keys.fill(0);
  // The chunk's cells row by row, then the shell rows: whole rows on the y and z borders, else the two x ends.
  for (let y = 0, i = 0; y < 32; y++)
    for (let z = 0; z < 32; z++, i += 32) {
      const p = BASE + z * SZ + y * SY;
      if (typeof lightBytes === 'number') light.fill(lightBytes, p, p + 32);
      else for (let x = 0; x < 32; x++) light[p + x] = lightBytes[i + x];
      if (!bits) states.fill(palette[0], p, p + 32);
      else
        for (let x = 0; x < 32; x++) {
          const bit = (i + x) * bits,
            slot = (words[bit >>> 5] >>> (bit & 31)) & mask;
          if (slot >= palette.length)
            throw new RangeError(
              `MeshInput chunk cell ${i + x} uses palette entry ${slot} of ${palette.length}; keep every cell index below the palette length`,
            );
          states[p + x] = palette[slot];
        }
    }
  for (let y = 0, p = 0, k = 0; y < 34; y++)
    for (let z = 0; z < 34; z++, p += SZ)
      if (y === 0 || y === 33 || z === 0 || z === 33)
        for (let x = 0; x < 34; x++, k++) {
          states[p + x] = shell[k];
          light[p + x] = around[k];
        }
      else {
        states[p] = shell[k];
        light[p] = around[k++];
        states[p + 33] = shell[k];
        light[p + 33] = around[k++];
      }
  let seen = 0;
  for (let p = 0; p < VOLUME; p++) {
    const f = flags[states[p] & 0xffff];
    if (f === undefined)
      throw new RangeError(
        `MeshInput block id ${states[p] & 0xffff} is not in the ${flags.length}-type table; pass the table the states use`,
      );
    kind[p] = f;
    occ[p] = (f >> 4) & 1;
    spread[p] = f & OCCLUDES ? 0 : ((light[p] >> 4) << 8) | (light[p] & 15);
    seen |= f;
  }
  const first = flags[palette[0] & 0xffff];
  // A uniform chunk (other than a liquid, whose surface steps inside) has faces only on its boundary slices.
  if (!bits && (first & 3) === INVISIBLE) return empty(ALL);
  w.flags = flags;
  if (seen & PART) halfBlocks(w, prepared);
  candidates(w, materials, !bits && !(first & LIQUID), (seen & PART) !== 0);
  faces(w, materials);
  const { out, count } = w;
  return {
    opaque: out[0].slice(0, count[0]),
    cutout: out[1].slice(0, count[1]),
    translucent: out[2].slice(0, count[2]),
    visibility: bits ? visibility(w) : first & OCCLUDES ? 0 : ALL,
  };
}

const empty = (visibility: number): ChunkMesh => ({
  opaque: new Uint32Array(0),
  cutout: new Uint32Array(0),
  translucent: new Uint32Array(0),
  visibility,
});

/**
 * Reads quad `i` of a {@link ChunkMesh} layer array.
 * @throws TypeError when `words` is not a Uint32Array.
 * @throws RangeError when `i` is not the index of a whole quad in `words`.
 */
export function decodeQuad(words: Uint32Array, i: number): DecodedQuad {
  if (!(words instanceof Uint32Array))
    throw new TypeError('decodeQuad expects a Uint32Array of quad words, such as mesh.opaque');
  if (!Number.isInteger(i) || i < 0 || (i + 1) * QUAD_WORDS > words.length)
    throw new RangeError(
      `Quad ${i} is not in this array of ${Math.floor(words.length / QUAD_WORDS)} quads; pass an index below the quad count`,
    );
  const w0 = words[i * 3],
    w1 = words[i * 3 + 1],
    w2 = words[i * 3 + 2],
    nibbles = (from: number): [number, number, number, number] => [
      (w2 >>> from) & 15,
      (w2 >>> (from + 8)) & 15,
      (w2 >>> (from + 16)) & 15,
      (w2 >>> (from + 24)) & 15,
    ];
  return {
    x: w0 & 31,
    y: (w0 >>> 5) & 31,
    z: (w0 >>> 10) & 31,
    face: (w0 >>> 15) & 7,
    w: ((w0 >>> 18) & 31) + 1,
    h: ((w0 >>> 23) & 31) + 1,
    flip: ((w0 >>> 28) & 1) === 1,
    liquidDrop: w0 >>> 29,
    material: w1 & 4095,
    ao: [(w1 >>> 12) & 3, (w1 >>> 14) & 3, (w1 >>> 16) & 3, (w1 >>> 18) & 3],
    wave: ((w1 >>> 20) & 1) === 1,
    inset: ((w1 >>> 21) & 1) === 1,
    trim: (w1 >>> 22) & 15,
    sky: nibbles(0),
    block: nibbles(4),
  };
}

// Chunk coordinates are cell >> 5 of a 32-bit cell coordinate: 27-bit signed integers.
const isChunk = (c: number): boolean => (c << 5) >> 5 === c;

// The chunk coordinates of a 'cx,cy,cz' key.
function chunkCoordinates(key: string): number[] {
  if (typeof key !== 'string') throw new TypeError('Chunk key must be a string; build it with chunkKey(cx, cy, cz)');
  const c = /^(-?\d+),(-?\d+),(-?\d+)$/.exec(key)?.slice(1).map(Number);
  if (!c || !c.every(isChunk))
    throw new RangeError(`Chunk key "${key}" is not three chunk coordinates; build it with chunkKey(cx, cy, cz)`);
  return c;
}

/**
 * The {@link MeshInput} of chunk `key` (`'cx,cy,cz'`, from `chunkKey`) of `world`: the chunk packed, the states and
 * light bytes of its shell from the loaded neighbours (unloaded cells are air with light 0) and `world.blocks.table`.
 * Undefined when that chunk is not loaded (a removed key in `world.dirty`: drop its mesh).
 * @throws TypeError when `world` is not a VoxelWorld or `key` is not a string.
 * @throws RangeError when `key` is not three chunk coordinates.
 */
export function meshInput(world: VoxelWorld, key: string): MeshInput | undefined {
  if (typeof world?.getChunk !== 'function') throw new TypeError('meshInput expects a VoxelWorld and a chunk key');
  const [cx, cy, cz] = chunkCoordinates(key),
    chunk = world.getChunk(cx, cy, cz);
  if (!chunk) return undefined;
  const near: (VoxelChunk | undefined)[] = [];
  for (let dy = -1; dy <= 1; dy++)
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++)
        near.push(
          isChunk(cx + dx) && isChunk(cy + dy) && isChunk(cz + dz)
            ? world.getChunk(cx + dx, cy + dy, cz + dz)
            : undefined,
        );
  const shell = new Uint32Array(SHELL),
    light = new Uint8Array(SHELL);
  let k = 0;
  for (let y = -1; y <= 32; y++)
    for (let z = -1; z <= 32; z++) {
      const row = y < 0 || y > 31 || z < 0 || z > 31;
      for (let x = -1; x <= 32; x += row ? 1 : 33, k++) {
        const n = near[(x >> 5) + 1 + 3 * ((z >> 5) + 1) + 9 * ((y >> 5) + 1)];
        if (!n) continue;
        shell[k] = n.get(x & 31, y & 31, z & 31);
        light[k] = n.getLight(x & 31, y & 31, z & 31);
      }
    }
  return { chunk: chunk.pack(), shell, light, blocks: world.blocks.table };
}

/**
 * Centre of every quad of a layer array, three numbers per quad in the chunk's local blocks: the point
 * {@link sortQuads} measures from. Cross quads (faces 6 and 7) use their cell's centre.
 */
export function quadCenters(words: Uint32Array): Float32Array {
  const out = new Float32Array((words.length / QUAD_WORDS) * 3);
  for (let i = 0; i < out.length; i += 3) {
    const w0 = words[i],
      part = words[i + 1] >>> 21,
      face = (w0 >>> 15) & 7,
      // Half the size along u and v, less half a cell, plus a quarter per half-block trim at the start (less at the end).
      u = ((w0 >>> 18) & 31) / 2 + ((part >> 1) & 1) / 4 - ((part >> 2) & 1) / 4,
      v = ((w0 >>> 23) & 31) / 2 + ((part >> 3) & 1) / 4 - ((part >> 4) & 1) / 4,
      side = part & 1 ? 0 : 0.5; // an inset face lies in the cell's middle
    // The cell centre moved half a cell toward the normal and spread over the quad (see ChunkMesh).
    let x = (w0 & 31) + 0.5,
      y = ((w0 >>> 5) & 31) + 0.5,
      z = ((w0 >>> 10) & 31) + 0.5;
    if (face < 2) (x += face ? -side : side), (z += u), (y += v);
    else if (face < 4) (y += face === 2 ? side : -side), (x += u), (z += v);
    else if (face < 6) (z += face === 4 ? side : -side), (x += u), (y += v);
    out[i] = x;
    out[i + 1] = y;
    out[i + 2] = z;
  }
  return out;
}

/**
 * Sorts the quads of a layer array back to front from `eye`, in place: farthest quad centre first, equal distances in
 * their current order. The translucent pass draws a chunk's quads in this order; {@link VoxelMesher.mesh} sorts in its
 * worker when given an eye, and a renderer can re-sort a near chunk's quads after the camera moves.
 * @param eye The camera position in the chunk's local block units: world position minus 32 times the chunk coordinates.
 * @returns `words`.
 * @throws TypeError when `words` is not a Uint32Array or `eye` is not three numbers.
 * @throws RangeError when `words` is not whole quads or `eye` is not finite.
 */
export function sortQuads(words: Uint32Array, eye: Vec3): Uint32Array {
  if (!(words instanceof Uint32Array))
    throw new TypeError('sortQuads expects a Uint32Array of quads, such as mesh.translucent');
  checkEye(eye, 'sortQuads eye');
  if (words.length % QUAD_WORDS)
    throw new RangeError(
      `sortQuads got ${words.length} words, not whole quads of ${QUAD_WORDS}; pass a ChunkMesh layer`,
    );
  const n = words.length / QUAD_WORDS,
    centers = quadCenters(words),
    distance = new Float64Array(n),
    order = new Uint32Array(n),
    [ex, ey, ez] = eye;
  for (let i = 0; i < n; i++) {
    distance[i] = (centers[i * 3] - ex) ** 2 + (centers[i * 3 + 1] - ey) ** 2 + (centers[i * 3 + 2] - ez) ** 2;
    order[i] = i;
  }
  // ponytail: centre distance can misorder a large merged quad against a small one beside it; a
  // topological sort of the quads if that shows.
  order.sort((a, b) => distance[b] - distance[a] || a - b);
  const copy = words.slice();
  for (let i = 0; i < n; i++) words.set(copy.subarray(order[i] * 3, order[i] * 3 + 3), i * 3);
  return words;
}

function checkEye(eye: Vec3, name: string): void {
  if (!Array.isArray(eye) || eye.length !== 3 || !eye.every((c) => typeof c === 'number'))
    throw new TypeError(`${name} must be [x, y, z] in blocks`);
  if (!eye.every(Number.isFinite)) throw new RangeError(`${name} is [${eye.join(', ')}]; pass finite coordinates`);
}

/** Options of {@link VoxelMesher}. */
export interface VoxelMesherOptions {
  /**
   * Number of workers, started as jobs arrive. Default: half the logical cores (`navigator.hardwareConcurrency`, 4
   * when unknown) minus one, from 1 to 4: 3 on an 8-thread laptop, leaving the main thread and the world generation
   * workers their share.
   */
  workers?: number;
}

/**
 * Meshes chunks off the main thread: each job runs {@link meshChunk} in one of a pool of workers, lowest priority
 * number first (equal priorities in call order). The {@link MeshInput} is built with {@link meshInput} on this thread
 * when a worker takes the job, so it holds the world's latest blocks and a queued job holds no copy; its buffers and
 * the mesh's move between the threads without copies. A newer `mesh` call for a key supersedes the older pending one,
 * so only the newest edit's mesh is delivered.
 *
 * ```ts
 * const mesher = new VoxelMesher();
 * for (const key of world.dirty) {
 *   mesher.mesh(world, key, distanceToCamera(key)).then((mesh) => mesh && upload(key, mesh));
 *   world.dirty.delete(key);
 * }
 * ```
 */
export class VoxelMesher {
  /** Number of workers in the pool. */
  readonly workers: number;
  #pool: JobPool;
  #jobs = new Map<string, AbortController>();
  #warm: Worker[] = []; // started, not yet taken by the pool
  #disposed = false;

  /**
   * @throws RangeError when `workers` is not a whole number of 1 or more.
   * @throws MargoError `unsupported` when this context has no Web Workers.
   */
  constructor(options: VoxelMesherOptions = {}) {
    const cores = globalThis.navigator?.hardwareConcurrency || 4,
      { workers = Math.min(4, Math.max(1, (cores >> 1) - 1)) } = options;
    if (!Number.isInteger(workers) || workers < 1)
      throw new RangeError(`VoxelMesher workers is ${workers}; pass a whole number of 1 or more`);
    if (typeof Worker !== 'function')
      throw new MargoError(
        'unsupported',
        'VoxelMesher needs Web Workers; mesh on this thread with meshChunk(meshInput(world, key))',
      );
    this.workers = workers;
    this.#pool = new JobPool(() => this.#warm.pop() ?? this.#startWorker(), workers);
  }

  #startWorker(): Worker {
    return new Worker(new URL(/* @vite-ignore */ './workers/mesher.js?no-inline', import.meta.url), {
      name: 'margoengine-mesher',
    });
  }

  /**
   * Starts the workers now rather than with the first jobs, so their code downloads before the chunks arrive to compete
   * with it and the first mesh does not wait for it. Meshing is otherwise the same. A worker that fails to start is
   * dropped here: the first job starts another and reports its failure.
   */
  warm(): void {
    if (this.#disposed) throw new MargoError('disposed', 'VoxelMesher is disposed; create a new VoxelMesher');
    while (this.#warm.length < this.workers) {
      const worker = this.#startWorker(),
        failed = () => {
          const at = this.#warm.indexOf(worker);
          if (at < 0) return; // the pool has it now, and its own handler hears
          this.#warm.splice(at, 1);
          worker.terminate();
        };
      worker.addEventListener?.('error', failed, { once: true });
      this.#warm.push(worker);
    }
  }

  /**
   * Meshes chunk `key` of `world` in a worker. Resolves null when the job was cancelled ({@link VoxelMesher.cancel},
   * dispose) or superseded by a newer `mesh` call for the key (keep the current mesh until that one arrives), and when
   * the chunk is not loaded once a worker takes the job (drop its mesh). Rejects when the worker fails.
   * @param priority Lower is meshed sooner, such as the chunk's distance to the camera. Default 0.
   * @param eye The camera's world position: the translucent quads come back sorted from it ({@link sortQuads}).
   * @throws TypeError when `world` is not a VoxelWorld, `key` is not a string or `eye` is not three numbers.
   * @throws RangeError when `key` is not three chunk coordinates, or `priority` or `eye` is not finite.
   * @throws MargoError `disposed` after {@link VoxelMesher.dispose}.
   */
  mesh(world: VoxelWorld, key: string, priority = 0, eye?: Vec3): Promise<ChunkMesh | null> {
    if (this.#disposed) throw new MargoError('disposed', 'VoxelMesher is disposed; create a new VoxelMesher');
    if (typeof world?.getChunk !== 'function') throw new TypeError('VoxelMesher.mesh expects a VoxelWorld and a key');
    const [cx, cy, cz] = chunkCoordinates(key);
    if (typeof priority !== 'number' || !Number.isFinite(priority))
      throw new RangeError(`VoxelMesher.mesh priority is ${priority}; pass a finite number`);
    if (eye !== undefined) checkEye(eye, 'VoxelMesher.mesh eye');
    const local = eye && [eye[0] - cx * 32, eye[1] - cy * 32, eye[2] - cz * 32];
    this.cancel(key);
    const job = new AbortController(),
      done = () => this.#jobs.get(key) === job && this.#jobs.delete(key);
    this.#jobs.set(key, job);
    return this.#pool
      .run<ChunkMesh | undefined>(
        () => {
          const input = meshInput(world, key);
          return input && { input, eye: local };
        },
        { priority, signal: job.signal },
      )
      .then(
        (mesh) => {
          done();
          return mesh ?? null;
        },
        (error) => {
          done();
          if (job.signal.aborted) return null;
          throw error;
        },
      );
  }

  /** Drops the pending job of chunk `key`, if any: its `mesh` promise resolves null. */
  cancel(key: string): void {
    const job = this.#jobs.get(key);
    this.#jobs.delete(key);
    job?.abort();
  }

  /** Cancels every pending job and terminates the workers. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const job of this.#jobs.values()) job.abort();
    this.#jobs.clear();
    this.#pool.dispose();
    for (const worker of this.#warm.splice(0)) worker.terminate();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}
