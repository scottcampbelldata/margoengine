// Voxel files other tools write, read into VoxelGrid + palette: Qubicle .qb and .qef (read and write), binvox, and the
// KVX and VXL slab formats (read), Goxel .gox and VoxEdit .vxm (read and write, in gox.ts and vxm.ts). From the formats'
// public descriptions or a clean-room specification; docs/clean-room.md has the sources.
import type { Vec3 } from '@margoengine/math';
import { Colors, MAX_MODELS, rgba, short, view } from './file-colors.js';
import { cellIndex, cellLimit, checkGrid, sizeCells, type GridLimits, type VoxelGrid } from './grid.js';

export {
  type GOXFile,
  type GOXLayer,
  type GOXMaterial,
  type GOXWriteModel,
  type GOXWriteOptions,
  parseGOX,
  writeGOX,
} from './gox.js';
export { parseVXM, type VXMFile, type VXMModel, type VXMWriteModel, type VXMWriteOptions, writeVXM } from './vxm.js';

/** One model of a voxel file. */
export interface VoxelFileModel {
  /** The matrix name, when the format has one. */
  name?: string;
  /** Where the model's cell (0, 0, 0) sits, in cells, Y up. [0, 0, 0] where the format has no positions. */
  position: Vec3;
  /** The cells; values index {@link VoxelFile.palette}. */
  grid: VoxelGrid;
}

/** What the readers return. */
export interface VoxelFile {
  /** Models in file order. */
  models: VoxelFileModel[];
  /** 256 RGBA8 colours, index i at `4 * i` as in `parseVox`; index 0 is air and stays 0. */
  palette: Uint8Array;
  /** True when a true-colour file held over 255 colours, so each channel lost low bits until 255 were left. */
  colorsReduced: boolean;
}

/** A binvox file: one model, with the placement its header records. */
export interface BinvoxFile extends VoxelFile {
  /** Header `translate`: where the voxel cube starts in the source mesh's space. */
  translate: Vec3;
  /** Header `scale`: the voxel cube's side in the source mesh's space. */
  scale: number;
}

/** A KVX file: one model (the largest mip), with its pivot. */
export interface KVXFile extends VoxelFile {
  /** The pivot in grid cells, Y up; fractional cells are kept. */
  pivot: Vec3;
}

/** Options of {@link parseVXL}. */
export interface VXLOptions extends GridLimits {
  /** Cells along x, y and z (z pointing down in the file) of a VXL without a header. Default [512, 512, 64]. */
  size?: Vec3;
}

/** Options of {@link writeQB}. */
export interface QBWriteOptions {
  /** Byte order of each colour. Default 'rgba'. */
  colorFormat?: 'rgba' | 'bgra';
  /** How the file's z runs. 'right' keeps z as the grid has it; 'left' mirrors it. Default 'right'. */
  zAxis?: 'left' | 'right';
  /** Run-length encode the cells. Default false. */
  compressed?: boolean;
}

const decoder = new TextDecoder(),
  NEXT_SLICE = 6,
  CODE = 2,
  VXL_ID = 0x09072000,
  VXL_HEADER = 112;

/**
 * Reads a Qubicle `.qb`: every matrix, RGBA or BGRA, compressed or not, in either z orientation, with the file's
 * mirror undone so the grids are right-handed. A cell with alpha 0 is air.
 *
 * @throws RangeError on a cut-off or malformed file, or past `maxCells` across all matrices.
 */
export function parseQB(bytes: Uint8Array | ArrayBuffer, limits: GridLimits = {}): VoxelFile {
  const data = view(bytes, 'parseQB'),
    dv = new DataView(data.buffer, data.byteOffset, data.byteLength),
    colors = new Colors(cellLimit(limits));
  let at = 0;
  const u32 = () => {
    if (at + 4 > data.length) short('QB file');
    at += 4;
    return dv.getUint32(at - 4, true);
  };
  u32();
  const bgra = u32() === 1,
    leftHanded = u32() === 0,
    compressed = u32() === 1,
    masked = u32() === 1,
    count = u32(),
    color = () => {
      if (at + 4 > data.length) short('QB file');
      const a = data[at + 3],
        r = data[at + (bgra ? 2 : 0)],
        g = data[at + 1],
        b = data[at + (bgra ? 0 : 2)];
      at += 4;
      // A visibility mask stands where alpha would: 0 is hidden, anything else shows the colour fully.
      return a ? rgba(r, g, b, masked ? 255 : a) : 0;
    };
  if (count > MAX_MODELS) throw new RangeError(`QB file holds ${count} matrices, over ${MAX_MODELS}; split the file`);
  for (let m = 0; m < count; m++) {
    if (at >= data.length) short('QB file');
    const nameLength = data[at++];
    if (at + nameLength > data.length) short('QB file');
    const name = decoder.decode(data.subarray(at, at + nameLength));
    at += nameLength;
    const sx = u32(),
      sy = u32(),
      sz = u32(),
      px = u32() | 0,
      py = u32() | 0,
      pz = u32() | 0,
      position: Vec3 = [px, py, leftHanded ? -(pz + sz) : pz],
      cells = colors.add([sx, sy, sz], position, name, `QB matrix ${name}`),
      put = (index: number, z: number, value: number) => {
        const x = index % sx,
          y = Math.floor(index / sx);
        cells[cellIndex([sx, sy, sz], x, y, leftHanded ? sz - 1 - z : z)] = value;
      };
    for (let z = 0; z < sz; z++) {
      if (!compressed) {
        for (let i = 0; i < sx * sy; i++) put(i, z, color());
        continue;
      }
      for (let i = 0; ; ) {
        if (at + 4 > data.length) short('QB file');
        const word = dv.getUint32(at, true);
        if (word === NEXT_SLICE) {
          at += 4;
          break;
        }
        let run = 1;
        if (word === CODE) {
          at += 4;
          run = u32();
        }
        const value = color();
        if (i + run > sx * sy)
          throw new RangeError(`QB matrix ${name} runs past its slice; the file is damaged, export it again`);
        for (let k = 0; k < run; k++) put(i++, z, value);
      }
    }
  }
  return colors.finish();
}

function modelList(models: VoxelFileModel | readonly VoxelFileModel[]): readonly VoxelFileModel[] {
  return Array.isArray(models) ? models : [models as VoxelFileModel];
}

/**
 * Writes a Qubicle `.qb` of version 1.1 with a plain alpha (no visibility mask): filled cells opaque or at their
 * palette alpha, air 0. Takes the shape {@link parseQB} returns.
 *
 * @throws RangeError when a palette colour has alpha 0 or a name is over 255 bytes.
 */
export function writeQB(
  models: VoxelFileModel | readonly VoxelFileModel[],
  palette: Uint8Array,
  options: QBWriteOptions = {},
): Uint8Array {
  const { colorFormat = 'rgba', zAxis = 'right', compressed = false } = options,
    list = modelList(models),
    bgra = colorFormat === 'bgra',
    left = zAxis === 'left';
  if (palette?.length !== 1024) throw new RangeError('writeQB needs a palette of 1024 bytes; pass 256 RGBA colours');
  const chunks: Uint8Array[] = [],
    head = new Uint32Array([0x00000101, bgra ? 1 : 0, left ? 0 : 1, compressed ? 1 : 0, 0, list.length]),
    encoder = new TextEncoder();
  chunks.push(new Uint8Array(head.buffer));
  for (const { name = '', position, grid } of list) {
    checkGrid(grid, Number.MAX_SAFE_INTEGER);
    const label = encoder.encode(name),
      [sx, sy, sz] = grid.size;
    if (label.length > 255) throw new RangeError(`QB matrix name ${name} is over 255 bytes; shorten it`);
    chunks.push(Uint8Array.of(label.length), label);
    const pz = left ? -(position[2] + sz) : position[2],
      sizes = new Int32Array([sx, sy, sz, position[0], position[1], pz]);
    chunks.push(new Uint8Array(sizes.buffer));
    const color = (index: number) => {
        if (!index) return 0;
        const r = palette[index * 4],
          g = palette[index * 4 + 1],
          b = palette[index * 4 + 2],
          a = palette[index * 4 + 3];
        if (!a) throw new RangeError(`Palette index ${index} has alpha 0, which QB reads as air; give it an alpha`);
        return bgra ? rgba(b, g, r, a) : rgba(r, g, b, a);
      },
      out: number[] = [];
    for (let z = 0; z < sz; z++) {
      const fileZ = left ? sz - 1 - z : z,
        slice = new Uint32Array(sx * sy);
      for (let y = 0; y < sy; y++)
        for (let x = 0; x < sx; x++) slice[x + y * sx] = color(grid.voxels[cellIndex(grid.size, x, y, fileZ)]);
      if (!compressed) {
        for (const value of slice) out.push(value);
        continue;
      }
      for (let i = 0; i < slice.length; ) {
        let run = 1;
        while (i + run < slice.length && slice[i + run] === slice[i]) run++;
        if (run > 2 || slice[i] === CODE || slice[i] === NEXT_SLICE) out.push(CODE, run, slice[i]);
        else for (let k = 0; k < run; k++) out.push(slice[i]);
        i += run;
      }
      out.push(NEXT_SLICE);
    }
    const body = Uint32Array.from(out);
    chunks.push(new Uint8Array(body.buffer));
  }
  const file = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    file.set(chunk, at);
    at += chunk.length;
  }
  return file;
}

/**
 * Reads a Qubicle Exchange `.qef` text file: one model; a voxel with mask 0 is hidden and left out.
 *
 * @throws RangeError on a damaged file or past `maxCells`; TypeError when it is not a QEF.
 */
export function parseQEF(input: string | Uint8Array | ArrayBuffer, limits: GridLimits = {}): VoxelFile {
  const text = typeof input === 'string' ? input : decoder.decode(view(input, 'parseQEF')),
    lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== 'Qubicle Exchange Format')
    throw new TypeError('parseQEF needs a Qubicle Exchange Format file; its first line says otherwise');
  const numbers = (line: string | undefined, count: number, what: string) => {
    const values = (line ?? '').trim().split(/\s+/).map(Number);
    if (values.length < count || values.slice(0, count).some((v) => !Number.isFinite(v)))
      throw new RangeError(`QEF ${what} line is damaged; export the file again`);
    return values;
  };
  const [sx, sy, sz] = numbers(lines[3], 3, 'size'),
    [colorCount] = numbers(lines[4], 1, 'colour count');
  const colors = new Colors(cellLimit(limits)),
    size: Vec3 = [sx, sy, sz],
    cells = colors.add(size, [0, 0, 0], undefined, 'QEF model'),
    table: number[] = [];
  if (!Number.isSafeInteger(colorCount) || colorCount < 0 || colorCount > lines.length)
    throw new RangeError(`QEF colour count ${colorCount} does not fit the file; export it again`);
  for (let i = 0; i < colorCount; i++) {
    const [r, g, b] = numbers(lines[5 + i], 3, 'colour');
    table.push(rgba(Math.round(r * 255) & 255, Math.round(g * 255) & 255, Math.round(b * 255) & 255, 255));
  }
  for (let i = 5 + colorCount; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const [x, y, z, index, mask = 1] = numbers(lines[i], 4, 'voxel');
    if (!mask) continue;
    if (!(x >= 0 && x < sx && y >= 0 && y < sy && z >= 0 && z < sz) || !(index in table))
      throw new RangeError(`QEF voxel ${x} ${y} ${z} is outside the model or its colours; export the file again`);
    cells[cellIndex(size, x, y, z)] = table[index];
  }
  return colors.finish();
}

/**
 * Writes one grid as a Qubicle Exchange `.qef`: the colours the grid uses and one line per filled cell, every side
 * marked visible. The format holds no alpha.
 */
export function writeQEF(grid: VoxelGrid, palette: Uint8Array): string {
  checkGrid(grid, Number.MAX_SAFE_INTEGER);
  if (palette?.length !== 1024) throw new RangeError('writeQEF needs a palette of 1024 bytes; pass 256 RGBA colours');
  const [sx, sy, sz] = grid.size,
    table = new Map<number, number>(),
    colors: string[] = [],
    voxels: string[] = [];
  for (let y = 0; y < sy; y++)
    for (let z = 0; z < sz; z++)
      for (let x = 0; x < sx; x++) {
        const value = grid.voxels[cellIndex(grid.size, x, y, z)];
        if (!value) continue;
        let index = table.get(value);
        if (index === undefined) {
          index = table.size;
          table.set(value, index);
          colors.push([0, 1, 2].map((k) => (palette[value * 4 + k] / 255).toFixed(6)).join(' '));
        }
        voxels.push(`${x} ${y} ${z} ${index} 127`);
      }
  return [
    'Qubicle Exchange Format',
    'Version 0.2',
    'www.minddesk.com',
    `${sx} ${sy} ${sz}`,
    String(colors.length),
    ...colors,
    ...voxels,
    '',
  ].join('\n');
}

/**
 * Reads a `binvox` file (Patrick Min's format): one model of palette index 1, white, with its header placement. The
 * file's y is vertical, as the grid's.
 *
 * @throws TypeError when it is not a binvox; RangeError on a damaged file or past `maxCells`.
 */
export function parseBinvox(bytes: Uint8Array | ArrayBuffer, limits: GridLimits = {}): BinvoxFile {
  const data = view(bytes, 'parseBinvox');
  let at = 0;
  const line = () => {
    const end = data.indexOf(10, at);
    if (end < 0) short('binvox header');
    const text = decoder.decode(data.subarray(at, end)).trim();
    at = end + 1;
    return text;
  };
  if (!line().startsWith('#binvox'))
    throw new TypeError('parseBinvox needs a binvox file; its first line says otherwise');
  let size: Vec3 | undefined,
    translate: Vec3 = [0, 0, 0],
    scale = 1;
  for (let text = line(); text !== 'data'; text = line()) {
    const [key, ...values] = text.split(/\s+/),
      numbers = values.map(Number);
    if (numbers.some((v) => !Number.isFinite(v)))
      throw new RangeError(`binvox header line ${text} is damaged; export the file again`);
    if (key === 'dim') size = [numbers[0], numbers[1], numbers[2]];
    else if (key === 'translate') translate = [numbers[0], numbers[1], numbers[2]];
    else if (key === 'scale') scale = numbers[0];
  }
  if (!size) throw new RangeError('binvox header has no dim line; export the file again');
  const cells = sizeCells(size, cellLimit(limits), 'binvox size'),
    voxels = new Uint8Array(cells),
    // The file counts x slowest, then z, with y running fastest.
    [sx, sy, sz] = size;
  let done = 0;
  while (done < cells) {
    if (at + 2 > data.length) short('binvox data');
    const value = data[at],
      run = data[at + 1];
    at += 2;
    if (value > 1 || !run || done + run > cells)
      throw new RangeError('binvox data has a run outside the model; the file is damaged, export it again');
    if (value)
      for (let i = done; i < done + run; i++) {
        const x = Math.floor(i / (sz * sy)),
          z = Math.floor(i / sy) % sz,
          y = i % sy;
        voxels[cellIndex(size, x, y, z)] = 1;
      }
    done += run;
  }
  const palette = new Uint8Array(1024);
  palette.fill(255, 4, 8);
  return {
    models: [{ position: [0, 0, 0], grid: { size: [sx, sy, sz], voxels } }],
    palette,
    colorsReduced: false,
    translate,
    scale,
  };
}

/**
 * Reads a KVX (Ken Silverman's slab format; the first, largest mip): x stays x, the file's y becomes z, and its
 * downward z becomes Y up. File colour k is grid index k + 1; colour 255, the format's transparent one, is air.
 *
 * @throws RangeError on a damaged file or past `maxCells`.
 */
export function parseKVX(bytes: Uint8Array | ArrayBuffer, limits: GridLimits = {}): KVXFile {
  const data = view(bytes, 'parseKVX'),
    dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length < 28 + 768) short('KVX file');
  const [length, sx, sy, sz, px, py, pz] = [0, 1, 2, 3, 4, 5, 6].map((i) => dv.getInt32(i * 4, true));
  if (sx < 1 || sy < 1 || sz < 1 || length < 24 || 4 + length > data.length - 768)
    throw new RangeError('KVX header is damaged; export the file again');
  const size: Vec3 = [sx, sz, sy],
    voxels = new Uint8Array(sizeCells(size, cellLimit(limits), 'KVX size')),
    offsets = 28,
    columns = offsets + (sx + 1) * 4;
  if (columns + sx * (sy + 1) * 2 > 4 + length) short('KVX file');
  for (let x = 0; x < sx; x++) {
    const slab = offsets + dv.getInt32(offsets + x * 4, true);
    for (let y = 0; y < sy; y++) {
      const row = columns + x * (sy + 1) * 2 + y * 2,
        end = slab + dv.getUint16(row + 2, true);
      let at = slab + dv.getUint16(row, true);
      if (end > 4 + length) short('KVX column');
      while (at < end) {
        if (at + 3 > end) short('KVX slab');
        const top = data[at],
          count = data[at + 1];
        at += 3;
        if (at + count > end || top + count > sz)
          throw new RangeError('KVX slab is outside its column; the file is damaged, export it again');
        for (let k = 0; k < count; k++) {
          const color = data[at + k];
          if (color !== 255) voxels[cellIndex(size, x, sz - 1 - (top + k), y)] = color + 1;
        }
        at += count;
      }
    }
  }
  const palette = new Uint8Array(1024),
    table = data.length - 768;
  for (let i = 0; i < 255; i++) {
    for (let k = 0; k < 3; k++) palette[(i + 1) * 4 + k] = Math.round((data[table + i * 3 + k] * 255) / 63);
    palette[(i + 1) * 4 + 3] = 255;
  }
  return {
    models: [{ position: [0, 0, 0], grid: { size, voxels } }],
    palette,
    colorsReduced: false,
    pivot: [px / 256, sz - pz / 256, py / 256],
  };
}

/**
 * Reads a VXL map (the Voxlap slab format, with its header or as a bare 512 x 512 x 64 column list): x stays x, the
 * file's y becomes z, and its downward z becomes Y up. Solid cells the file gives no colour, deep inside, take the
 * last colour above them in their column.
 *
 * @throws RangeError on a damaged file, on data that does not fit `size`, or past `maxCells`.
 */
export function parseVXL(bytes: Uint8Array | ArrayBuffer, options: VXLOptions = {}): VoxelFile {
  const data = view(bytes, 'parseVXL'),
    dv = new DataView(data.buffer, data.byteOffset, data.byteLength),
    headed = data.length >= VXL_HEADER && dv.getUint32(0, true) === VXL_ID,
    [sx, sy, sz] = headed
      ? [dv.getInt32(4, true), dv.getInt32(8, true), dv.getInt32(12, true)]
      : (options.size ?? [512, 512, 64]),
    size: Vec3 = [sx, sz, sy],
    colors = new Colors(cellLimit(options)),
    cells = colors.add(size, [0, 0, 0], undefined, 'VXL model');
  let at = headed ? VXL_HEADER : 0;
  for (let y = 0; y < sy; y++)
    for (let x = 0; x < sx; x++) {
      let last = rgba(128, 128, 128, 255);
      const set = (z: number, color: number) => {
          if (z < 0 || z >= sz)
            throw new RangeError(`VXL column ${x} ${y} is outside the model; pass its real size, or export it again`);
          cells[cellIndex(size, x, sz - 1 - z, y)] = color;
          last = color;
        },
        read = (from: number, count: number, first: number) => {
          for (let i = 0; i < count; i++) {
            const c = from + i * 4;
            set(first + i, rgba(data[c + 2], data[c + 1], data[c], 255));
          }
        };
      for (;;) {
        if (at + 4 > data.length) short('VXL file');
        const span = data[at],
          start = data[at + 1],
          end = data[at + 2],
          count = end - start + 1;
        if (count < 0) throw new RangeError('VXL span ends before it starts; the file is damaged, export it again');
        const top = at + 4;
        if (top + count * 4 > data.length) short('VXL file');
        read(top, count, start);
        if (!span) {
          for (let z = end + 1; z < sz; z++) set(z, last);
          at = top + count * 4;
          break;
        }
        const next = at + span * 4,
          bottom = span - 1 - count;
        if (next + 4 > data.length || bottom < 0) short('VXL file');
        const air = data[next + 3];
        for (let z = end + 1; z < air - bottom; z++) set(z, last);
        read(top + count * 4, bottom, air - bottom);
        at = next;
      }
    }
  if (!headed && at !== data.length)
    throw new RangeError(`VXL data does not fit ${sx} x ${sy} x ${sz}; pass the map's real size`);
  return colors.finish();
}
