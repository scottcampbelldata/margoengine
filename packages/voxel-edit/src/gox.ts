// Goxel `.gox` read and write, written only from the clean-room prose specification of the format (docs/clean-room.md,
// rows VF7 to VF9): an 8-byte header, then PNG-style chunks; each BL16 chunk is one 16^3 block stored as a 64 x 64
// RGBA PNG, and LAYR chunks place blocks by index. The file is Z up; grids here are Y up and right-handed.
import { decodePNG } from '@margoengine/decoders/png';
import type { Vec3 } from '@margoengine/math';
import { invertMatrix } from '@margoengine/math/mat4';
import { pngParts } from '../../shared/png.js';
import { Colors, MAX_MODELS, rgba, short, view } from './file-colors.js';
import type { VoxelFile, VoxelFileModel } from './formats.js';
import { cellIndex, cellLimit, checkGrid, sizeCells, type GridLimits } from './grid.js';

/** One layer of a `.gox` file, as a model. */
export interface GOXLayer extends VoxelFileModel {
  /** The layer's `visible` flag; true when the file leaves it out. */
  visible: boolean;
  /** Blend mode stored in the file: 0 over, 1 and 2 subtract, 3 paint, 4 max, 5 and 6 intersect, 7 multiply, 8 replace. */
  mode: number;
  /** Index into {@link GOXFile.materials}, or -1 when the file names no material that exists. */
  material: number;
}

/** One `MATE` chunk of a `.gox` file. */
export interface GOXMaterial {
  name: string;
  /** Base colour, linear RGBA 0 to 1. */
  color: readonly [number, number, number, number];
  metallic: number;
  roughness: number;
  /** Emitted colour, linear RGB. */
  emission: Vec3;
}

/** What {@link parseGOX} returns. */
export interface GOXFile extends VoxelFile {
  /** Layers in file order, clone and shape layers already built. */
  models: GOXLayer[];
  /** Materials in file order. */
  materials: GOXMaterial[];
  /** The file's version, 1 or 2. */
  version: number;
}

/** A model for {@link writeGOX}: any {@link VoxelFileModel}, with an optional `visible` (default true). */
export interface GOXWriteModel extends VoxelFileModel {
  visible?: boolean;
}

/** Options of {@link writeGOX}. */
export interface GOXWriteOptions {
  /** Stops the write; the promise rejects with the signal's reason. */
  signal?: AbortSignal;
}

// A layer's voxels in file axes: RGBA words over the box from `min`, x fastest, then y, then z.
type V3 = [number, number, number];
interface Box {
  min: V3;
  size: V3;
  cells: Uint32Array;
}

const BLOCK = 16,
  PIXELS = BLOCK * BLOCK * BLOCK,
  MAX_DICT = 255,
  text = new TextDecoder(),
  encoder = new TextEncoder(),
  IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

const damaged = (what: string): never => {
  throw new RangeError(`GOX file ${what}; the file is damaged, save it again from Goxel`);
};

/** Reads a chunk's dictionary: key to value bytes, later keys over earlier ones; a key length of 0 ends it. */
function readDict(data: Uint8Array, dv: DataView, at: number, end: number): Map<string, Uint8Array> {
  const dict = new Map<string, Uint8Array>();
  while (at < end) {
    if (at + 4 > end) damaged('has a dictionary entry cut off');
    const keyLength = dv.getInt32(at, true);
    at += 4;
    if (keyLength === 0) break;
    if (keyLength < 0 || at + keyLength + 4 > end) damaged('has a dictionary key past its chunk');
    const key = text.decode(data.subarray(at, at + keyLength));
    at += keyLength;
    const valueLength = dv.getInt32(at, true);
    at += 4;
    if (valueLength < 0 || at + valueLength > end) damaged(`has the value of ${key} past its chunk`);
    dict.set(key, data.subarray(at, at + valueLength));
    at += valueLength;
  }
  return dict;
}

// Typed dictionary values; an entry of the wrong size is ignored, as Goxel does.
const numbers = (dict: Map<string, Uint8Array>, key: string, count: number, int = false): number[] | undefined => {
  const value = dict.get(key);
  if (value?.length !== count * 4) return undefined;
  const dv = new DataView(value.buffer, value.byteOffset, value.byteLength);
  return Array.from({ length: count }, (_, i) => (int ? dv.getInt32(i * 4, true) : dv.getFloat32(i * 4, true)));
};
const int = (dict: Map<string, Uint8Array>, key: string) => numbers(dict, key, 1, true)?.[0];
const float = (dict: Map<string, Uint8Array>, key: string) => numbers(dict, key, 1)?.[0];
const bool = (dict: Map<string, Uint8Array>, key: string) => {
  const value = dict.get(key);
  return value?.length === 1 ? value[0] !== 0 : undefined;
};
const string = (dict: Map<string, Uint8Array>, key: string) => {
  const value = dict.get(key);
  return value && text.decode(value);
};

const at3 = (m: ArrayLike<number>, x: number, y: number, z: number): V3 => [
  m[0] * x + m[4] * y + m[8] * z + m[12],
  m[1] * x + m[5] * y + m[9] * z + m[13],
  m[2] * x + m[6] * y + m[10] * z + m[14],
];

/** An empty box over integer corners `lo` to `hi` (exclusive), checked against `limit`. */
function emptyBox(lo: V3, hi: V3, limit: number, subject: string): Box {
  const size: V3 = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
  return { min: lo, size, cells: new Uint32Array(sizeCells(size, limit, subject)) };
}
const boxIndex = (box: Box, x: number, y: number, z: number) =>
  x - box.min[0] + box.size[0] * (y - box.min[1] + box.size[1] * (z - box.min[2]));

/** Fills a procedural shape layer: every voxel whose centre lies in the shape inside `box` (a unit-cube transform). */
function shapeBox(shape: string, box: number[], color: number, limit: number, subject: string): Box | null {
  const inverse = invertMatrix(box);
  if (!inverse || !['sphere', 'cube', 'cylinder'].includes(shape)) return null;
  const lo: V3 = [Infinity, Infinity, Infinity],
    hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (const sx of [-1, 1])
    for (const sy of [-1, 1])
      for (const sz of [-1, 1]) {
        const p = at3(box, sx, sy, sz);
        for (let a = 0; a < 3; a++) {
          lo[a] = Math.min(lo[a], Math.floor(p[a]));
          hi[a] = Math.max(hi[a], Math.ceil(p[a]));
        }
      }
  if (!(hi[0] > lo[0] && hi[1] > lo[1] && hi[2] > lo[2])) return null;
  const out = emptyBox(lo, hi, limit, subject);
  for (let z = lo[2]; z < hi[2]; z++)
    for (let y = lo[1]; y < hi[1]; y++)
      for (let x = lo[0]; x < hi[0]; x++) {
        const [u, v, w] = at3(inverse, x + 0.5, y + 0.5, z + 0.5),
          inside =
            shape === 'cube'
              ? Math.max(Math.abs(u), Math.abs(v), Math.abs(w)) <= 1
              : shape === 'sphere'
                ? u * u + v * v + w * w <= 1
                : u * u + v * v <= 1 && Math.abs(w) <= 1;
        if (inside) out.cells[boxIndex(out, x, y, z)] = color;
      }
  return out;
}

/** A clone layer: the base layer's voxels moved by `matrix`, each voxel centre to the cell it lands in. */
function cloneBox(base: Box | null, matrix: number[], limit: number, subject: string): Box | null {
  if (!base) return null;
  const moved: [number, number, number, number][] = [],
    lo: V3 = [Infinity, Infinity, Infinity],
    hi: V3 = [-Infinity, -Infinity, -Infinity];
  base.cells.forEach((value, i) => {
    if (!value) return;
    const [nx, ny] = base.size,
      p = at3(
        matrix,
        base.min[0] + (i % nx) + 0.5,
        base.min[1] + (Math.floor(i / nx) % ny) + 0.5,
        base.min[2] + Math.floor(i / (nx * ny)) + 0.5,
      ).map(Math.floor) as unknown as V3;
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a], p[a]);
      hi[a] = Math.max(hi[a], p[a] + 1);
    }
    moved.push([p[0], p[1], p[2], value]);
  });
  if (!moved.length) return null;
  const out = emptyBox(lo, hi, limit, subject);
  for (const [x, y, z, value] of moved) out.cells[boxIndex(out, x, y, z)] = value;
  return out;
}

/**
 * Reads a Goxel `.gox` (version 1 or 2): one model per layer, voxel layers from their BL16 blocks, clone layers moved
 * by their matrix and shape layers (sphere, cube, cylinder) filled. The file's Z up turns to Y up here: file (x, y, z)
 * is cell (x, z, -y), which keeps the model right-handed. Each model is cropped to its solid voxels and `position` is
 * its lowest corner; an empty layer is a 1 x 1 x 1 grid of air at the origin. Any non-zero alpha is solid. Cameras,
 * the light, the preview image and unknown chunks are skipped; chunk CRCs are not checked (Goxel writes 0).
 *
 * @throws TypeError when the bytes are not a `.gox`; RangeError on a cut-off or damaged file, an unknown version or
 * past `maxCells`, which counts each layer's block bounds before cropping. MargoError `failed` on a broken block PNG.
 */
export function parseGOX(bytes: Uint8Array | ArrayBuffer, limits: GridLimits = {}): GOXFile {
  const data = view(bytes, 'parseGOX'),
    dv = new DataView(data.buffer, data.byteOffset, data.byteLength),
    limit = cellLimit(limits);
  if (data.length < 8 || text.decode(data.subarray(0, 4)) !== 'GOX ')
    throw new TypeError('parseGOX needs a Goxel file; these bytes do not start with "GOX "');
  const version = dv.getInt32(4, true);
  if (version !== 1 && version !== 2)
    throw new RangeError(`GOX version ${version} is not supported; save it from a Goxel of version 1 or 2 format`);
  const blocks: Uint8Array[] = [],
    materials: GOXMaterial[] = [],
    layers: { dict: Map<string, Uint8Array>; box: Box | null }[] = [];
  for (let at = 8; at < data.length; ) {
    if (at + 8 > data.length) short('GOX file');
    const type = text.decode(data.subarray(at, at + 4)),
      length = dv.getInt32(at + 4, true),
      start = at + 8,
      end = start + length;
    if (length < 0 || end + 4 > data.length) short('GOX file');
    at = end + 4; // the CRC is never computed by any writer, so it is skipped unread
    if (type === 'BL16') {
      const image = decodePNG(data.subarray(start, end), { maxPixels: PIXELS });
      if (image.width !== 64 || image.height !== 64)
        damaged(`block ${blocks.length} is ${image.width} x ${image.height}, not 64 x 64`);
      blocks.push(image.data);
    } else if (type === 'MATE') {
      const dict = readDict(data, dv, start, end),
        color = numbers(dict, 'color', 4) ?? [1, 1, 1, 1];
      materials.push({
        name: string(dict, 'name') ?? '',
        color: [color[0], color[1], color[2], color[3]],
        metallic: float(dict, 'metallic') ?? 0,
        roughness: float(dict, 'roughness') ?? 1,
        emission: (numbers(dict, 'emission', 3) ?? [0, 0, 0]) as unknown as Vec3,
      });
    } else if (type === 'LAYR') {
      if (layers.length >= MAX_MODELS) throw new RangeError(`GOX file holds over ${MAX_MODELS} layers; split the file`);
      if (length < 4) damaged('has a layer chunk cut off');
      const count = dv.getInt32(start, true),
        records = start + 4;
      if (count < 0 || records + count * 20 > end) damaged('has a layer whose block list runs past its chunk');
      const shift = version === 1 ? 8 : 0,
        corners: [number, number, number, number][] = [],
        lo: V3 = [Infinity, Infinity, Infinity],
        hi: V3 = [-Infinity, -Infinity, -Infinity];
      for (let r = 0; r < count; r++) {
        const p = records + r * 20,
          index = dv.getInt32(p, true),
          corner: V3 = [
            dv.getInt32(p + 4, true) - shift,
            dv.getInt32(p + 8, true) - shift,
            dv.getInt32(p + 12, true) - shift,
          ];
        if (index < 0 || index >= blocks.length)
          damaged(`has layer ${layers.length} naming block ${index}, but only ${blocks.length} come before it`);
        for (let a = 0; a < 3; a++) {
          lo[a] = Math.min(lo[a], corner[a]);
          hi[a] = Math.max(hi[a], corner[a] + BLOCK);
        }
        corners.push([index, ...corner]);
      }
      let box: Box | null = null;
      if (count) {
        box = emptyBox(lo, hi, limit, `GOX layer ${layers.length} block bounds`);
        // Goxel copies every voxel of a block, air included, so a later block overwrites an earlier one.
        for (const [index, cx, cy, cz] of corners) {
          const image = blocks[index];
          for (let i = 0; i < PIXELS; i++) {
            const a = image[i * 4 + 3];
            box.cells[boxIndex(box, cx + (i & 15), cy + ((i >> 4) & 15), cz + (i >> 8))] = a
              ? rgba(image[i * 4], image[i * 4 + 1], image[i * 4 + 2], a)
              : 0;
          }
        }
      }
      layers.push({ dict: readDict(data, dv, records + count * 20, end), box });
    }
  }
  // Shape layers first, then clones (in passes, so a clone of a clone resolves); a missing base or a loop stays empty.
  const pending = new Set<number>(),
    ids = new Map<number, number>();
  layers.forEach((layer, i) => {
    const id = int(layer.dict, 'id');
    if (id) ids.set(id, i);
    const shape = string(layer.dict, 'shape'),
      matrix = numbers(layer.dict, 'mat', 16);
    if (shape !== undefined && matrix) {
      const c = layer.dict.get('color'),
        color = c?.length === 4 ? rgba(c[0], c[1], c[2], c[3]) : rgba(255, 255, 255, 255);
      layer.box = shapeBox(shape, matrix, color, limit, `GOX shape layer ${i}`);
    } else if (int(layer.dict, 'base_id')) pending.add(i);
  });
  for (let progress = true; progress && pending.size; ) {
    progress = false;
    for (const i of pending) {
      const base = ids.get(int(layers[i].dict, 'base_id') ?? 0);
      if (base === undefined || pending.has(base)) continue;
      layers[i].box = cloneBox(
        layers[base].box,
        numbers(layers[i].dict, 'mat', 16) ?? IDENTITY,
        limit,
        `GOX clone layer ${i}`,
      );
      pending.delete(i);
      progress = true;
    }
  }
  const colors = new Colors(limit),
    extras: Omit<GOXLayer, keyof VoxelFileModel>[] = [];
  layers.forEach(({ dict, box }, i) => {
    const name = string(dict, 'name') ?? `layer ${i}`,
      material = int(dict, 'material') ?? 0;
    extras.push({
      visible: bool(dict, 'visible') ?? true,
      mode: int(dict, 'mode') ?? 0,
      material: material >= 0 && material < materials.length ? material : -1,
    });
    // Crop to the solid voxels, then turn file (x, y, z) into cell (x, z, -y).
    const lo: V3 = [Infinity, Infinity, Infinity],
      hi: V3 = [-Infinity, -Infinity, -Infinity];
    box?.cells.forEach((value, k) => {
      if (!value) return;
      const p = [
        box.min[0] + (k % box.size[0]),
        box.min[1] + (Math.floor(k / box.size[0]) % box.size[1]),
        box.min[2] + Math.floor(k / (box.size[0] * box.size[1])),
      ];
      for (let a = 0; a < 3; a++) {
        lo[a] = Math.min(lo[a], p[a]);
        hi[a] = Math.max(hi[a], p[a] + 1);
      }
    });
    if (!box || lo[0] === Infinity) {
      colors.add([1, 1, 1], [0, 0, 0], name, `GOX layer ${name}`);
      return;
    }
    const size: V3 = [hi[0] - lo[0], hi[2] - lo[2], hi[1] - lo[1]],
      top = hi[1] - 1,
      cells = colors.add(size, [lo[0], lo[2], 0 - top], name, `GOX layer ${name}`);
    for (let z = 0; z < size[2]; z++)
      for (let y = 0; y < size[1]; y++)
        for (let x = 0; x < size[0]; x++)
          cells[cellIndex(size, x, y, z)] = box.cells[boxIndex(box, lo[0] + x, top - z, lo[2] + y)];
  });
  const file = colors.finish();
  return {
    ...file,
    models: file.models.map((model, i) => ({ ...model, ...extras[i] })),
    materials,
    version,
  };
}

/** Builds one chunk: type, data length, data, and a CRC of 0 as every Goxel writes. */
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length + 12),
    dv = new DataView(out.buffer);
  out.set(encoder.encode(type), 0);
  dv.setInt32(4, data.length, true);
  out.set(data, 8);
  return out;
}

/** Builds a dictionary from key and value pairs; both stay within Goxel's 255-byte buffers. */
function dict(entries: [string, Uint8Array][]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const [key, value] of entries) {
    const k = encoder.encode(key);
    if (value.length > MAX_DICT) throw new RangeError(`GOX value ${key} is over ${MAX_DICT} bytes; shorten it`);
    parts.push(
      new Uint8Array(new Int32Array([k.length]).buffer),
      k,
      new Uint8Array(new Int32Array([value.length]).buffer),
      value,
    );
  }
  return join(parts);
}
const i32 = (v: number) => new Uint8Array(new Int32Array([v]).buffer);
const f32s = (...v: number[]) => new Uint8Array(new Float32Array(v).buffer);

function join(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** A 64 x 64 RGBA PNG of one block, rows unfiltered, zlib by the platform's CompressionStream. */
async function blockPNG(pixels: Uint8Array): Promise<Uint8Array> {
  const raw = new Uint8Array(64 * 257);
  for (let row = 0; row < 64; row++) raw.set(pixels.subarray(row * 256, row * 256 + 256), row * 257 + 1);
  const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate')),
    zlib = new Uint8Array(await new Response(stream).arrayBuffer());
  return join(pngParts(64, 64, 6, zlib) as Uint8Array[]);
}

/**
 * Writes a Goxel `.gox` of version 2: one layer per model, its voxels in 16^3 blocks at multiples of 16 (identical
 * blocks stored once), one default material, identity layer matrices and no camera, light or preview. Cell (x, y, z)
 * of a model at `position` p becomes file voxel (p.x + x, -(p.z + z), p.y + y), the inverse of {@link parseGOX}, so a
 * round trip gives back the same cells, positions and colours. Takes the shape {@link parseGOX} returns.
 *
 * @throws RangeError when the palette is not 1,024 bytes, a used colour has alpha 0 or a name is over 255 bytes.
 */
export async function writeGOX(
  models: GOXWriteModel | readonly GOXWriteModel[],
  palette: Uint8Array,
  options: GOXWriteOptions = {},
): Promise<Uint8Array> {
  const { signal } = options,
    list = (Array.isArray(models) ? models : [models]) as readonly GOXWriteModel[];
  signal?.throwIfAborted();
  if (palette?.length !== 1024) throw new RangeError('writeGOX needs a palette of 1024 bytes; pass 256 RGBA colours');
  const blocks: Uint8Array[] = [],
    byHash = new Map<number, number[]>(),
    layers: Uint8Array[] = [];
  list.forEach(({ name = `layer ${layers.length}`, position, grid, visible = true }, n) => {
    checkGrid(grid, Number.MAX_SAFE_INTEGER, `GOX model ${name}`);
    const label = encoder.encode(name);
    if (label.length > MAX_DICT) throw new RangeError(`GOX layer name ${name} is over ${MAX_DICT} bytes; shorten it`);
    const [sx, sy, sz] = grid.size,
      own = new Map<string, { corner: V3; pixels: Uint8Array }>();
    for (let y = 0; y < sy; y++)
      for (let z = 0; z < sz; z++)
        for (let x = 0; x < sx; x++) {
          const index = grid.voxels[cellIndex(grid.size, x, y, z)];
          if (!index) continue;
          const alpha = palette[index * 4 + 3];
          if (!alpha)
            throw new RangeError(`Palette index ${index} has alpha 0, which GOX reads as air; give it an alpha`);
          const g: V3 = [position[0] + x, -(position[2] + z), position[1] + y],
            corner = g.map((v) => Math.floor(v / BLOCK) * BLOCK) as unknown as V3,
            key = corner.join(',');
          let block = own.get(key);
          if (!block) own.set(key, (block = { corner, pixels: new Uint8Array(PIXELS * 4) }));
          const i = (g[0] - corner[0] + BLOCK * (g[1] - corner[1]) + BLOCK * BLOCK * (g[2] - corner[2])) * 4;
          block.pixels.set(palette.subarray(index * 4, index * 4 + 4), i);
        }
    const records: number[] = [];
    for (const { corner, pixels } of own.values()) {
      let hash = 2166136261;
      for (let i = 0; i < pixels.length; i++) hash = Math.imul(hash ^ pixels[i], 16777619);
      const same = byHash.get(hash) ?? [];
      let index = same.find((k) => blocks[k].every((v, i) => v === pixels[i]));
      if (index === undefined) {
        index = blocks.length;
        blocks.push(pixels);
        same.push(index);
        byHash.set(hash, same);
      }
      records.push(index, corner[0], corner[1], corner[2], 0);
    }
    layers.push(
      join([
        i32(own.size),
        new Uint8Array(new Int32Array(records).buffer),
        dict([
          ['name', label],
          ['mat', f32s(...IDENTITY)],
          ['id', i32(n + 1)],
          ['base_id', i32(0)],
          ['material', i32(0)],
          ['mode', i32(0)],
          ['visible', Uint8Array.of(visible ? 1 : 0)],
        ]),
      ]),
    );
  });
  const pngs = await Promise.all(blocks.map(blockPNG));
  signal?.throwIfAborted();
  const material = dict([
    ['name', encoder.encode('default')],
    ['color', f32s(1, 1, 1, 1)],
    ['metallic', f32s(0.2)],
    ['roughness', f32s(0.5)],
    ['emission', f32s(0, 0, 0)],
  ]);
  return join([
    encoder.encode('GOX '),
    i32(2),
    ...pngs.map((png) => chunk('BL16', png)),
    chunk('MATE', material),
    ...layers.map((layer) => chunk('LAYR', layer)),
  ]);
}
