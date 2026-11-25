// The whole faces of a chunk's one-cell shell that touch the chunk: the faces the neighbouring chunks mesh along the
// seams, read from the same cells the mesher reads, so a bevel can chamfer a chunk's edges and corners on a seam as one
// mesh of both chunks would, without meshing the neighbours. Shared by VoxelMesher's workers and GpuVoxelMesher.
import type { BlockType } from './blocks.js';
import type { PackedChunk, VoxelChunk } from './chunk.js';
import type { MeshInput } from './mesher.js';
import { slabOctants, stairOctants } from './octants.js';

const SZ = 34,
  SY = 1156,
  // Per face direction (+x, -x, +y, -y, +z, -z): the axis and the index step to the front cell.
  AXIS = [0, 0, 1, 1, 2, 2],
  STEP = [1, -1, SY, -SY, SZ, -SZ],
  // Per face direction: the four octants (bit x 1, y 2, z 4) of a cell's half on the face's side (the face's own
  // quarters) and of the front cell's half that touches the face.
  HALF = [0, 1, 2, 3, 4, 5].map((d) => {
    const bit = [1, 2, 4][AXIS[d]];
    let mask = 0;
    for (let o = 0; o < 8; o++) if ((o & bit) === (d & 1 ? 0 : bit)) mask |= 1 << o;
    return mask;
  }),
  FACING = HALF.map((_, d) => HALF[d ^ 1]);

// Per block id: its render layer + 1 when it shows box faces (a cube, slab or stair that is not invisible), whether it
// is opaque, and its shape (0 a cube, 1 a slab, 2 a stair, 3 no box: liquids, crosses, models, objects, air).
interface Kinds {
  n: number;
  layer: Uint8Array;
  opaque: Uint8Array;
  shape: Uint8Array;
}
const kinds = new WeakMap<readonly BlockType[], Kinds>();
function kindsOf(blocks: readonly BlockType[]): Kinds {
  let k = kinds.get(blocks);
  if (k?.n === blocks.length) return k;
  const n = blocks.length;
  k = { n, layer: new Uint8Array(n), opaque: new Uint8Array(n), shape: new Uint8Array(n) };
  for (let id = 0; id < n; id++) {
    const { layer, shape } = blocks[id],
      s = ['cube', 'slab', 'stair'].indexOf(shape);
    k.shape[id] = s < 0 ? 3 : s;
    k.layer[id] = s < 0 ? 0 : ['opaque', 'cutout', 'translucent'].indexOf(layer) + 1;
    k.opaque[id] = +(layer === 'opaque');
  }
  kinds.set(blocks, k);
  return k;
}
let scratch: Uint32Array | undefined;

/**
 * The shell's whole box faces that touch the chunk, one word each: local cell x + 1 at bits 0-5, y + 1 at 6-11,
 * z + 1 at 12-17 (each 0-33), face 18-20 (0-5: +x, -x, +y, -y, +z, -z), layer 21-22 (opaque, cutout, translucent).
 * A face is listed when the mesher of the shell cell's own chunk meshes it whole (the faces a bevel chamfers; a face
 * partly covered is trimmed, and a slab's or stair's mid-cell face inset): the cell fills all four octants on the
 * face's side, and no opaque octant of the front cell, nor an octant of the same block there, touches the face.
 */
export function meshBorder({ chunk, shell, blocks }: MeshInput): Uint32Array {
  const { layer, opaque, shape } = kindsOf(blocks),
    { palette, bits, words } =
      typeof (chunk as VoxelChunk).pack === 'function' ? (chunk as VoxelChunk).pack() : (chunk as PackedChunk),
    mask = (1 << bits) - 1,
    states = (scratch ??= new Uint32Array(SZ * SY)),
    octants = (state: number): number => {
      const s = shape[state & 0xffff];
      return s === 0 ? 255 : s === 1 ? slabOctants(state >>> 16) : s === 2 ? stairOctants(state >>> 16) : 0;
    };
  // The 34^3 states: the shell in its order (x fastest, then z, then y), then the chunk's cells inside it.
  for (let y = 0, p = 0, k = 0; y < 34; y++)
    for (let z = 0; z < 34; z++, p += SZ)
      if (y === 0 || y === 33 || z === 0 || z === 33) for (let x = 0; x < 34; x++) states[p + x] = shell[k++];
      else {
        states[p] = shell[k++];
        states[p + 33] = shell[k++];
      }
  for (let i = 0; i < 32768; i++) {
    const bit = i * bits;
    states[1 + (i & 31) + (((i >> 5) & 31) + 1) * SZ + ((i >> 10) + 1) * SY] = bits
      ? palette[(words[bit >>> 5] >>> (bit & 31)) & mask]
      : palette[0];
  }
  const out: number[] = [],
    c = [0, 0, 0];
  for (let y = -1; y <= 32; y++)
    for (let z = -1; z <= 32; z++)
      for (let x = -1; x <= 32; x++) {
        // The chunk's own cells: on to the shell cell at its +x end.
        if (x === 0 && y >= 0 && y < 32 && z >= 0 && z < 32) x = 32;
        const p = x + 1 + (z + 1) * SZ + (y + 1) * SY,
          state = states[p],
          id = state & 0xffff;
        if (!layer[id]) continue;
        const own = octants(state);
        c[0] = x;
        c[1] = y;
        c[2] = z;
        for (let d = 0; d < 6; d++) {
          // The face's plane must lie in the box: a cell at 32 shows its -x face on the seam, its +x face beyond it.
          if ((d & 1 ? c[AXIS[d]] < 0 : c[AXIS[d]] > 31) || (own & HALF[d]) !== HALF[d]) continue;
          const q = states[p + STEP[d]],
            front = q & 0xffff,
            cover = (opaque[front] ? octants(q) : 0) | (front === id ? octants(q) : 0);
          if (!(cover & FACING[d]))
            out.push((x + 1) | ((y + 1) << 6) | ((z + 1) << 12) | (d << 18) | ((layer[id] - 1) << 21));
        }
      }
  return Uint32Array.from(out);
}
