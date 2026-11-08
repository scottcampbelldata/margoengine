// VoxEdit `.vxm` read (versions 3 to 13) and write (version 12), written only from the clean-room prose specification
// of the format (docs/clean-room.md, rows VF10 to VF12): a fixed field sequence with no chunks, a baked mesh this
// reader skips, BGRA materials and run-length palette indices, Z fastest, then Y, then X.
import type { Vec3 } from '@margoengine/math';
import { short, view } from './file-colors.js';
import type { VoxelFile, VoxelFileModel } from './formats.js';
import { cellIndex, cellLimit, checkGrid, sizeCells, type GridLimits } from './grid.js';

/** One model of a `.vxm` file. */
export interface VXMModel extends VoxelFileModel {
  /** The model's `visible` flag (version 12 on); true before. */
  visible: boolean;
}

/** What {@link parseVXM} returns. */
export interface VXMFile extends VoxelFile {
  /** Models in file order (one before version 12), all of one size, each at [0, 0, 0]. */
  models: VXMModel[];
  /** The file's version, 3 to 13. */
  version: number;
  /** The pivot as the file stores it: a fraction of the size on each axis. [0.5, 0, 0.5] before version 5. */
  pivot: Vec3;
  /** 256 flags, 1 where that palette index is an emissive material (version 4 on). */
  emissive: Uint8Array;
}

/** A model for {@link writeVXM}: any {@link VoxelFileModel}, with an optional `visible` (default true). */
export interface VXMWriteModel extends VoxelFileModel {
  visible?: boolean;
}

/** Options of {@link writeVXM}. */
export interface VXMWriteOptions {
  /** The pivot as a fraction of the size on each axis. Default [0.5, 0, 0.5]: centred in x and z, at the bottom. */
  pivot?: Vec3;
  /** Palette indices whose material emits light (any non-zero entry of a 256-entry array). Default none. */
  emissive?: ArrayLike<number>;
}

const EMPTY = 255,
  MAX_QUADS = 262_144,
  MAX_STRING = 1024,
  MAX_TEXTURE = 2048,
  text = new TextDecoder(),
  encoder = new TextEncoder();

const damaged = (what: string): never => {
  throw new RangeError(`VXM file ${what}; the file is damaged, save it again from VoxEdit`);
};

class Cursor {
  at = 0;
  private readonly dv: DataView;
  constructor(readonly data: Uint8Array) {
    this.dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }
  need(n: number) {
    if (this.at + n > this.data.length) short('VXM file');
  }
  u8() {
    this.need(1);
    return this.data[this.at++];
  }
  u32() {
    this.need(4);
    this.at += 4;
    return this.dv.getUint32(this.at - 4, true);
  }
  f32() {
    this.need(4);
    this.at += 4;
    return this.dv.getFloat32(this.at - 4, true);
  }
  skip(n: number) {
    this.need(n);
    this.at += n;
  }
  string() {
    const end = this.data.indexOf(0, this.at);
    if (end < 0) short('VXM file');
    if (end - this.at >= MAX_STRING) damaged(`has a name over ${MAX_STRING - 1} bytes`);
    const value = text.decode(this.data.subarray(this.at, end));
    this.at = end + 1;
    return value;
  }
  /** A run-length RGB texture: (count, R, G, B) runs ended by a count of 0. */
  rgbRuns() {
    while (this.u8()) this.skip(3);
  }
}

/** Skips one baked mesh record (one level of detail): its textures and six face lists. */
function skipMesh(c: Cursor, version: number) {
  const w = c.u32(),
    h = c.u32();
  if (w > MAX_TEXTURE || h > MAX_TEXTURE) damaged(`has a ${w} x ${h} texture, over ${MAX_TEXTURE}`);
  if (version === 3) c.rgbRuns();
  else if (version <= 10) {
    const count = c.u32();
    for (let t = 0; t < count; t++) {
      c.string();
      if (version <= 5) c.rgbRuns();
      else c.skip(c.u32());
    }
  } else c.skip(c.u32());
  for (let face = 0; face < 6; face++) {
    const quads = c.u32();
    if (quads > MAX_QUADS) damaged(`has a face list of ${quads} quads, over ${MAX_QUADS}`);
    c.skip(quads * 80);
  }
}

/**
 * Reads a VoxEdit `.vxm` of version 3 to 13: every model with its name, the materials as the palette (material i is
 * palette index i + 1, BGRA in the file) and the pivot. The baked mesh and the full palettes are skipped. Cells run Z
 * fastest, then Y, then X; file cell (x, y, z) lands in grid cell (size x - 1 - x, y, z), the mirror existing files
 * need, with Y up. A run naming a material the file lacks is air. Bytes after the models are not read.
 *
 * Only versions 4 and 12 were checked against real files; the others follow the specification alone.
 *
 * @throws TypeError when the bytes are not a `.vxm`; RangeError on a cut-off or damaged file, an unknown version or
 * past `maxCells` across all models.
 */
export function parseVXM(bytes: Uint8Array | ArrayBuffer, limits: GridLimits = {}): VXMFile {
  const c = new Cursor(view(bytes, 'parseVXM'));
  if (c.data.length < 4 || text.decode(c.data.subarray(0, 3)) !== 'VXM')
    throw new TypeError('parseVXM needs a VoxEdit file; these bytes do not start with "VXM"');
  const mark = c.data[3],
    version = mark >= 0x33 && mark <= 0x39 ? mark - 0x30 : mark >= 0x41 && mark <= 0x44 ? mark - 0x41 + 10 : 0;
  if (!version)
    throw new RangeError(`VXM version "${String.fromCharCode(mark)}" is not supported; 3 to 9 and A to D are read`);
  c.at = 4;
  const vec = (): Vec3 => [c.u32(), c.u32(), c.u32()];
  let size: Vec3 = [0, 0, 0],
    pivot: Vec3 = [0.5, 0, 0.5];
  if (version >= 6) size = vec();
  if (version >= 5) pivot = [c.f32(), c.f32(), c.f32()];
  if (version >= 9 && c.u8()) {
    const [x0, y0, z0, x1, y1, z1] = [c.u32(), c.u32(), c.u32(), c.u32(), c.u32(), c.u32()],
      normal = c.u32();
    let w: number, h: number;
    if (version >= 10) [w, h] = [c.u32(), c.u32()];
    else if (normal <= 1) [w, h] = [z1 - z0, y1 - y0];
    else if (normal <= 3) [w, h] = [x1 - x0, z1 - z0];
    else [w, h] = [x1 - x0, y1 - y0];
    // The surface bytes have no known meaning; they are skipped.
    c.skip((w >>> 0) * (h >>> 0));
  }
  if (version >= 8 && version <= 12) c.skip(16);
  const lods = version >= 7 && version <= 12 ? c.u32() : 1;
  for (let l = 0; l < lods; l++) skipMesh(c, version);
  if (version <= 5) size = vec();
  if (version >= 11) {
    c.skip(2048);
    const chunks = c.u8();
    for (let k = 0; k < chunks; k++) {
      c.string();
      c.skip(2);
    }
  }
  const materials = c.u8(),
    palette = new Uint8Array(1024),
    emissive = new Uint8Array(256);
  for (let m = 0; m < materials; m++) {
    const [b, g, r, a] = [c.u8(), c.u8(), c.u8(), c.u8()];
    palette.set([r, g, b, a], (m + 1) * 4);
    if (version >= 4) emissive[m + 1] = c.u8() ? 1 : 0;
  }
  const count = version >= 12 ? c.u8() : 1,
    cells = sizeCells(size, Math.floor(cellLimit(limits) / Math.max(count, 1)), 'VXM size'),
    [sx, sy, sz] = size,
    models: VXMModel[] = [];
  for (let n = 0; n < count; n++) {
    const name = version >= 12 ? c.string() : 'Model 0',
      visible = version >= 12 ? c.u8() !== 0 : true,
      voxels = new Uint8Array(cells);
    for (let cell = 0; ; ) {
      const length = c.u8();
      if (!length) break;
      const index = c.u8();
      if (cell + length > cells) damaged(`model ${name} runs past its ${sx} x ${sy} x ${sz} cells`);
      const value = index !== EMPTY && index < materials ? index + 1 : 0;
      for (const end = cell + length; cell < end; cell++)
        if (value) {
          const fx = Math.floor(cell / (sy * sz)),
            fy = Math.floor(cell / sz) % sy;
          voxels[cellIndex(size, sx - 1 - fx, fy, cell % sz)] = value;
        }
    }
    models.push({ name, position: [0, 0, 0], grid: { size, voxels }, visible });
  }
  return { models, palette, colorsReduced: false, version, pivot, emissive };
}

/**
 * Writes a VoxEdit `.vxm` of version 12 (`VXMC`): every model (at most 255, all of one size; `position` is not stored),
 * palette index i as material i - 1 up to the highest index used, no baked mesh, and the full palettes VoxEdit keeps
 * (unused entries magenta). Cells are written in the order and mirror {@link parseVXM} reads, so a round trip gives
 * back the same grids and colours.
 *
 * Whether VoxEdit itself opens a file without a baked mesh is not known; other tools that read `.vxm` do.
 *
 * @throws RangeError when the palette is not 1,024 bytes, the models differ in size or number over 255, or a name
 * holds a NUL byte or is over 1,023 bytes.
 */
export function writeVXM(
  models: VXMWriteModel | readonly VXMWriteModel[],
  palette: Uint8Array,
  options: VXMWriteOptions = {},
): Uint8Array {
  const list = (Array.isArray(models) ? models : [models]) as readonly VXMWriteModel[],
    { pivot = [0.5, 0, 0.5], emissive } = options;
  if (palette?.length !== 1024) throw new RangeError('writeVXM needs a palette of 1024 bytes; pass 256 RGBA colours');
  if (!list.length || list.length > 255)
    throw new RangeError(`writeVXM takes 1 to 255 models, not ${list.length}; split or merge them`);
  const size = list[0].grid.size,
    [sx, sy, sz] = size;
  let used = 0;
  for (const { name, grid } of list) {
    checkGrid(grid, Number.MAX_SAFE_INTEGER, `VXM model ${name ?? ''}`);
    if (grid.size.some((v, a) => v !== size[a]))
      throw new RangeError(`VXM models share one size; ${grid.size.join(' x ')} is not ${size.join(' x ')}`);
    for (const v of grid.voxels) used = Math.max(used, v);
  }
  const out: number[] = [],
    u8 = (...v: number[]) => out.push(...v),
    bytes = (b: Uint8Array) => {
      for (const v of b) out.push(v);
    },
    u32 = (...v: number[]) => bytes(new Uint8Array(new Uint32Array(v).buffer)),
    f32 = (...v: number[]) => bytes(new Uint8Array(new Float32Array(v).buffer)),
    glows = (i: number) => Boolean(emissive?.[i]);
  bytes(encoder.encode('VXMC'));
  u32(sx, sy, sz);
  f32(pivot[0], pivot[1], pivot[2]);
  u8(0); // no header surface
  f32(0, 0, 0, 0); // level-of-detail scale and pivot
  u32(1); // one mesh record: no texture, no quads
  u32(0, 0, 0, 0, 0, 0, 0, 0, 0);
  for (let m = 0; m < 256; m++)
    if (m < used) bytes(palette.subarray((m + 1) * 4, (m + 2) * 4));
    else u8(255, 0, 255, 255);
  for (let m = 0; m < 256; m++)
    if (m >= used) u8(255, 0, 255, 255);
    else if (glows(m + 1)) bytes(palette.subarray((m + 1) * 4, (m + 2) * 4));
    else u8(0, 0, 0, 255);
  u8(0, used);
  for (let m = 1; m <= used; m++)
    u8(palette[m * 4 + 2], palette[m * 4 + 1], palette[m * 4], palette[m * 4 + 3], glows(m) ? 1 : 0);
  u8(list.length);
  for (const { name = '', grid, visible = true } of list) {
    const label = encoder.encode(name);
    if (label.includes(0) || label.length >= MAX_STRING)
      throw new RangeError(`VXM model name ${name} holds a NUL byte or is over ${MAX_STRING - 1} bytes; rename it`);
    bytes(label);
    u8(0, visible ? 1 : 0);
    let run = 0,
      last = -1;
    for (let fx = 0; fx < sx; fx++)
      for (let fy = 0; fy < sy; fy++)
        for (let fz = 0; fz < sz; fz++) {
          const v = grid.voxels[cellIndex(size, sx - 1 - fx, fy, fz)],
            index = v ? v - 1 : EMPTY;
          if (index === last && run < 255) run++;
          else {
            if (run) u8(run, last);
            run = 1;
            last = index;
          }
        }
    u8(run, last, 0);
  }
  u8(0); // trailer: no surface
  return Uint8Array.from(out);
}
