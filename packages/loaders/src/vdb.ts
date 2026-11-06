// OpenVDB `.vdb` sparse volumes: file versions 222 and later, uncompressed, zlib or Blosc-LZ4 grids, any tree depth.
import { LoaderError } from './types.js';
import { latin1, throwIfAborted, toBytes, type BinaryInput } from './util.js';
import { inflate } from './zip.js';

const F = 'VDB';
const MIN_VERSION = 222;
const COMPRESS_ZIP = 1;
const COMPRESS_ACTIVE_MASK = 2;
const COMPRESS_BLOSC = 4;
const LITTLE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

// What precedes a node's values, saying how its inactive values were left out. Kind 1 has no name here: every inactive
// value is minus the background, which is what any kind without its own values starts from.
const NO_MASK_OR_INACTIVE = 0;
const NO_MASK_ONE_INACTIVE = 2;
const MASK_NO_INACTIVE = 3;
const MASK_ONE_INACTIVE = 4;
const MASK_TWO_INACTIVE = 5;
const NO_MASK_ALL_VALUES = 6;

/** A value type of a grid this reader decodes. `half` grids arrive as `float`, with `half` set on the grid. */
export type VDBValueType = 'float' | 'double' | 'int32' | 'int64' | 'vec3i' | 'vec3s' | 'vec3d';

/** Values in the grid's own precision; 64-bit integers arrive as `Float64Array`, exact up to 2^53. */
export type VDBData = Float32Array<ArrayBuffer> | Float64Array<ArrayBuffer> | Int32Array<ArrayBuffer>;

/** A value of the grid: a number, or `[x, y, z]` for a vector grid. */
export type VDBValue = number | [number, number, number];

/** Options of {@link parseVDB}. */
export interface VDBOptions {
  /** Read only the grids with these names, such as `['density']`. The others go to `skipped`. Default every grid. */
  grids?: readonly string[];
  /** Maximum values kept in all leaves of the file together, counting 512 per leaf and vector component. Default 536,870,912. */
  maxValues?: number;
  signal?: AbortSignal;
}

/** Options of {@link VDBGrid.dense}. */
export interface VDBDenseOptions {
  /** Inclusive index box `[minX, minY, minZ, maxX, maxY, maxZ]` to fill. Default the grid's `box`. */
  box?: readonly [number, number, number, number, number, number];
  /** Maximum values in the array. Default 536,870,912. */
  maxValues?: number;
}

/** One 8 by 8 by 8 block of voxels (in a default tree) with stored values. */
export interface VDBLeaf {
  /** Index of the block's lowest corner. */
  origin: [number, number, number];
  /** Active voxels, one bit each, z fastest then y then x. */
  mask: Uint8Array<ArrayBuffer>;
  /** Every voxel, in the order of `mask`, inactive ones too; vector components sit together. */
  values: VDBData;
}

/** A cube of voxels that all share one value, stored in place of a subtree. Inactive tiles equal to the background are dropped. */
export interface VDBTile {
  origin: [number, number, number];
  /** Edge length in voxels. */
  size: number;
  value: VDBValue;
  active: boolean;
}

/** What {@link VDBGrid.dense} returns. Pass `data`, `dims` and `bounds` to `fig.volume()` of `@margoengine/sciviz`. */
export interface VDBDense {
  /** Every voxel of the box, x fastest, then y, then z; vector components sit together. */
  data: VDBData;
  /** Voxels along each axis. */
  dims: [number, number, number];
  /** Values per voxel: 1, or 3 for a vector grid. */
  components: number;
  /** The inclusive index box that was filled. */
  box: [number, number, number, number, number, number];
  /** `[minX, maxX, minY, maxY, minZ, maxZ]` around the voxel centres in world units. */
  bounds: [number, number, number, number, number, number];
}

/** One grid of a file. */
export interface VDBGrid {
  name: string;
  /** The tree type as written, such as `Tree_float_5_4_3`. */
  type: string;
  valueType: VDBValueType;
  /** True when the file stored 16-bit values. They arrive widened to `valueType`. */
  half: boolean;
  /** 1, or 3 for a vector grid. */
  components: number;
  /** The `class` metadata, such as `fog volume` or `level set`. `unknown` when absent. */
  gridClass: string;
  /** The value of every voxel with nothing stored. */
  background: VDBValue;
  /** Column-major 4x4 from voxel index to world units, from the grid's linear transform. */
  matrix: Float64Array<ArrayBuffer>;
  /** World size of one voxel along each index axis. */
  voxelSize: [number, number, number];
  /** Inclusive index box around every active voxel, or null for a grid with none. */
  box: [number, number, number, number, number, number] | null;
  /** Active voxels, tiles counted by their volume. */
  activeVoxels: number;
  leaves: VDBLeaf[];
  tiles: VDBTile[];
  /** Grid metadata by name. Null prototype. */
  meta: Record<string, unknown>;
  /** The value at a voxel index: its leaf's value, else its tile's, else the background. */
  at(x: number, y: number, z: number): VDBValue;
  /** Whether the voxel at an index is active. */
  isActive(x: number, y: number, z: number): boolean;
  /** Fills a dense array over a box. Voxels with nothing stored hold the background. */
  dense(options?: VDBDenseOptions): VDBDense;
}

/** What {@link parseVDB} returns. */
export interface VDBFile {
  /** The file format version, such as 224. */
  version: number;
  /** The OpenVDB version that wrote the file, `[major, minor]`. */
  library: [number, number];
  uuid: string;
  /** File metadata by name. Null prototype. */
  meta: Record<string, unknown>;
  grids: VDBGrid[];
  /** Grids left out, with why: a value type this reader does not decode, a transform with no matrix, or `options.grids`. */
  skipped: { name: string; type: string; reason: string }[];
}

interface ValueCodec {
  valueType: VDBValueType;
  components: number;
  /** Bytes of one component as stored at full precision. */
  size: number;
  make(length: number): VDBData;
  read(view: DataView, at: number): number;
}

const CODECS: Record<string, ValueCodec> = {
  float: scalar(
    'float',
    4,
    (n) => new Float32Array(n),
    (v, at) => v.getFloat32(at, true),
  ),
  double: scalar(
    'double',
    8,
    (n) => new Float64Array(n),
    (v, at) => v.getFloat64(at, true),
  ),
  int32: scalar(
    'int32',
    4,
    (n) => new Int32Array(n),
    (v, at) => v.getInt32(at, true),
  ),
  int64: scalar(
    'int64',
    8,
    (n) => new Float64Array(n),
    (v, at) => Number(v.getBigInt64(at, true)),
  ),
  vec3i: {
    ...scalar(
      'vec3i',
      4,
      (n) => new Int32Array(n),
      (v, at) => v.getInt32(at, true),
    ),
    components: 3,
  },
  vec3s: {
    ...scalar(
      'vec3s',
      4,
      (n) => new Float32Array(n),
      (v, at) => v.getFloat32(at, true),
    ),
    components: 3,
  },
  vec3d: {
    ...scalar(
      'vec3d',
      8,
      (n) => new Float64Array(n),
      (v, at) => v.getFloat64(at, true),
    ),
    components: 3,
  },
};
const HALF_TYPES = new Set(['float', 'double', 'vec3s', 'vec3d']);

function scalar(valueType: VDBValueType, size: number, make: ValueCodec['make'], read: ValueCodec['read']): ValueCodec {
  return { valueType, components: 1, size, make, read };
}

/** IEEE 754 binary16 bits to a number. */
function halfToNumber(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1,
    exponent = (bits >> 10) & 31,
    fraction = bits & 1023;
  if (exponent === 31) return fraction ? Number.NaN : sign * Number.POSITIVE_INFINITY;
  if (exponent === 0) return sign * fraction * 2 ** -24;
  return sign * (1 + fraction / 1024) * 2 ** (exponent - 15);
}

/** Bounds-checked little-endian reads over the whole file. */
class Reader {
  readonly view: DataView;
  pos = 0;
  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  need(count: number, what: string): void {
    if (!Number.isSafeInteger(count) || count < 0 || this.pos + count > this.bytes.length)
      throw new LoaderError(F, 'truncated', `${what} runs past the end of the file`);
  }
  take(count: number, what: string): Uint8Array {
    this.need(count, what);
    const part = this.bytes.subarray(this.pos, this.pos + count);
    this.pos += count;
    return part;
  }
  u8(what: string): number {
    this.need(1, what);
    return this.bytes[this.pos++]!;
  }
  i8(what: string): number {
    return (this.u8(what) << 24) >> 24;
  }
  u32(what: string): number {
    this.need(4, what);
    this.pos += 4;
    return this.view.getUint32(this.pos - 4, true);
  }
  i32(what: string): number {
    this.need(4, what);
    this.pos += 4;
    return this.view.getInt32(this.pos - 4, true);
  }
  i64(what: string): number {
    this.need(8, what);
    this.pos += 8;
    const value = this.view.getBigInt64(this.pos - 8, true);
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER))
      throw new LoaderError(F, 'range', `${what} is too large`);
    return Number(value);
  }
  f64(what: string): number {
    this.need(8, what);
    this.pos += 8;
    return this.view.getFloat64(this.pos - 8, true);
  }
  text(what: string): string {
    return new TextDecoder().decode(this.take(this.u32(what), what));
  }
  coord(what: string): [number, number, number] {
    return [this.i32(what), this.i32(what), this.i32(what)];
  }
  seek(at: number, what: string): void {
    if (!Number.isSafeInteger(at) || at < 0 || at > this.bytes.length)
      throw new LoaderError(F, 'truncated', `${what} points past the end of the file`);
    this.pos = at;
  }
}

const countBits = (mask: Uint8Array): number => {
  let count = 0;
  for (let byte of mask) for (; byte; byte &= byte - 1) count++;
  return count;
};
const bit = (mask: Uint8Array, index: number): boolean => (mask[index >> 3]! & (1 << (index & 7))) !== 0;

/** One metadata block: a count, then name, type name, payload size and payload for each. */
function readMeta(reader: Reader): Record<string, unknown> {
  const meta: Record<string, unknown> = Object.create(null),
    count = reader.u32('metadata count');
  reader.need(count * 12, 'metadata');
  for (let i = 0; i < count; i++) {
    const name = reader.text('metadata name'),
      type = reader.text('metadata type'),
      size = reader.u32('metadata size'),
      end = reader.pos + size;
    reader.need(size, `metadata ${name}`);
    meta[name] = metaValue(reader, type, size);
    reader.pos = end;
  }
  return meta;
}

function metaValue(reader: Reader, type: string, size: number): unknown {
  const need = { bool: 1, int32: 4, int64: 8, float: 4, double: 8, vec3i: 12, vec3s: 12, vec3d: 24 }[type];
  if (type === 'string') return new TextDecoder().decode(reader.take(size, 'metadata text'));
  if (need === undefined || size !== need) return reader.bytes.slice(reader.pos, reader.pos + size);
  const { view, pos } = reader;
  switch (type) {
    case 'bool':
      return reader.bytes[pos] !== 0;
    case 'int32':
      return view.getInt32(pos, true);
    case 'int64':
      return Number(view.getBigInt64(pos, true));
    case 'float':
      return view.getFloat32(pos, true);
    case 'double':
      return view.getFloat64(pos, true);
    case 'vec3i':
      return [0, 4, 8].map((at) => view.getInt32(pos + at, true));
    case 'vec3s':
      return [0, 4, 8].map((at) => view.getFloat32(pos + at, true));
    default:
      return [0, 8, 16].map((at) => view.getFloat64(pos + at, true));
  }
}

/** The grid's linear map as a column-major 4x4, or null for a map that has no matrix. */
function readTransform(reader: Reader): Float64Array<ArrayBuffer> | null {
  const type = reader.text('transform type'),
    vector = (): [number, number, number] => [
      reader.f64('transform'),
      reader.f64('transform'),
      reader.f64('transform'),
    ],
    matrix = new Float64Array(16);
  matrix[0] = matrix[5] = matrix[10] = matrix[15] = 1;
  switch (type) {
    case 'AffineMap':
    case 'UnitaryMap':
      // Stored row by row for row vectors, which is the same 16 numbers as column-major for column vectors.
      for (let i = 0; i < 16; i++) matrix[i] = reader.f64('transform');
      return matrix;
    case 'TranslationMap':
      matrix.set(vector(), 12);
      return matrix;
    case 'ScaleTranslateMap':
    case 'UniformScaleTranslateMap':
    case 'ScaleMap':
    case 'UniformScaleMap': {
      if (type.endsWith('TranslateMap')) matrix.set(vector(), 12);
      const scale = vector();
      // Voxel size, inverse scale, inverse square scale and inverse doubled scale all follow from the scale.
      reader.take(4 * 24, 'transform');
      [matrix[0], matrix[5], matrix[10]] = scale;
      return matrix;
    }
    default:
      return null;
  }
}

/** Decodes an LZ4 block into `output`, which it must fill exactly. */
function lz4(input: Uint8Array, output: Uint8Array, subject: string): void {
  const corrupt = (): LoaderError => new LoaderError(F, 'zip', `${subject} has corrupt LZ4 data`);
  let from = 0,
    to = 0;
  while (from < input.length) {
    const token = input[from++]!;
    let literals = token >> 4;
    if (literals === 15)
      for (let more = 255; more === 255; literals += more) {
        if (from >= input.length) throw corrupt();
        more = input[from++]!;
      }
    if (from + literals > input.length || to + literals > output.length) throw corrupt();
    output.set(input.subarray(from, from + literals), to);
    from += literals;
    to += literals;
    if (from === input.length) break;
    if (from + 2 > input.length) throw corrupt();
    const offset = input[from]! | (input[from + 1]! << 8);
    from += 2;
    let length = (token & 15) + 4;
    if ((token & 15) === 15)
      for (let more = 255; more === 255; length += more) {
        if (from >= input.length) throw corrupt();
        more = input[from++]!;
      }
    if (offset === 0 || offset > to || to + length > output.length) throw corrupt();
    // One byte at a time: a match may overlap what it writes.
    for (let i = 0; i < length; i++, to++) output[to] = output[to - offset]!;
  }
  if (to !== output.length) throw corrupt();
}

/** Decodes one Blosc 1 chunk of `size` bytes: LZ4 blocks or a stored copy, with byte shuffle undone. */
function blosc(chunk: Uint8Array, size: number, subject: string): Uint8Array {
  const corrupt = (why: string): LoaderError => new LoaderError(F, 'zip', `${subject}: ${why}`);
  if (chunk.length < 16) throw corrupt('Blosc header cut short');
  const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength),
    flags = chunk[2]!,
    typeSize = chunk[3]!,
    bytes = view.getUint32(4, true),
    blockSize = view.getUint32(8, true),
    shuffled = (flags & 1) !== 0,
    stored = (flags & 2) !== 0,
    single = (flags & 16) !== 0;
  if (bytes !== size) throw corrupt(`Blosc chunk holds ${bytes} bytes, expected ${size}`);
  if (flags & 4) throw new LoaderError(F, 'unsupported', `${subject} uses Blosc bit shuffle`);
  if (stored) {
    if (chunk.length < 16 + size) throw corrupt('Blosc copy cut short');
    return chunk.slice(16, 16 + size);
  }
  if (flags >> 5 !== 1) throw new LoaderError(F, 'unsupported', `${subject} uses a Blosc codec other than LZ4`);
  if (blockSize === 0 || typeSize === 0) throw corrupt('Blosc block or type size is zero');
  const blocks = Math.ceil(size / blockSize),
    output = new Uint8Array(size),
    scratch = new Uint8Array(Math.min(blockSize, size));
  if (16 + blocks * 4 > chunk.length) throw corrupt('Blosc offsets cut short');
  for (let block = 0; block < blocks; block++) {
    const length = Math.min(blockSize, size - block * blockSize),
      // A short last block is never split.
      splits = !single && length === blockSize ? typeSize : 1,
      part = length / splits,
      target = shuffled ? scratch : output.subarray(block * blockSize);
    let at = view.getUint32(16 + block * 4, true);
    for (let split = 0; split < splits; split++) {
      if (at + 4 > chunk.length) throw corrupt('Blosc block cut short');
      const packed = view.getUint32(at, true);
      at += 4;
      if (at + packed > chunk.length) throw corrupt('Blosc block cut short');
      const slice = target.subarray(split * part, (split + 1) * part);
      if (packed === part) slice.set(chunk.subarray(at, at + packed));
      else lz4(chunk.subarray(at, at + packed), slice, subject);
      at += packed;
    }
    if (!shuffled) continue;
    const whole = length - (length % typeSize),
      count = whole / typeSize,
      out = output.subarray(block * blockSize);
    for (let i = 0; i < count; i++)
      for (let byte = 0; byte < typeSize; byte++) out[i * typeSize + byte] = scratch[byte * count + i]!;
    out.set(scratch.subarray(whole, length), whole);
  }
  return output;
}

/** Reads the values of one node into `target` at `start`. */
class ValueReader {
  constructor(
    readonly reader: Reader,
    readonly codec: ValueCodec,
    readonly half: boolean,
    readonly compression: number,
    readonly background: number[],
    readonly signal: AbortSignal | undefined,
  ) {}

  /** One full-precision value, as stored for backgrounds, tiles and inactive values. */
  value(what: string): number[] {
    const { reader, codec } = this,
      out: number[] = [];
    reader.need(codec.size * codec.components, what);
    for (let i = 0; i < codec.components; i++, reader.pos += codec.size) out.push(codec.read(reader.view, reader.pos));
    return out;
  }

  /** `count` values through the grid's compression: the bytes, as stored, of half or full precision. */
  private async raw(count: number): Promise<{ view: DataView; base: number }> {
    const { reader, codec, compression, half } = this,
      size = count * codec.components * (half ? 2 : codec.size);
    let bytes: Uint8Array;
    if (compression & (COMPRESS_BLOSC | COMPRESS_ZIP)) {
      const packed = reader.i64('compressed size');
      if (packed <= 0) {
        if (-packed !== size) throw new LoaderError(F, 'range', `stored block of ${-packed} bytes, expected ${size}`);
        bytes = reader.take(size, 'stored block');
      } else if (compression & COMPRESS_BLOSC) bytes = blosc(reader.take(packed, 'Blosc chunk'), size, 'a node');
      else bytes = await inflate(reader.take(packed, 'zlib block'), size, 'a node', this.signal, 'deflate', F);
    } else bytes = reader.take(size, 'values');
    return { view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), base: 0 };
  }

  /** Reads `length` values, active ones per `mask`, restoring the inactive ones the file left out. */
  async node(target: VDBData, start: number, length: number, mask: Uint8Array): Promise<void> {
    const { reader, codec, half, compression, background } = this,
      { components } = codec,
      kind = reader.i8('value kind');
    if (kind < NO_MASK_OR_INACTIVE || kind > NO_MASK_ALL_VALUES)
      throw new LoaderError(F, 'syntax', `unknown value kind ${kind}`);
    let inactive0 = kind === NO_MASK_OR_INACTIVE ? background : background.map((v) => -v),
      inactive1 = background;
    if (kind === NO_MASK_ONE_INACTIVE || kind === MASK_ONE_INACTIVE || kind === MASK_TWO_INACTIVE) {
      inactive0 = this.value('inactive value');
      if (kind === MASK_TWO_INACTIVE) inactive1 = this.value('inactive value');
    }
    let selection: Uint8Array | null = null;
    if (kind === MASK_NO_INACTIVE || kind === MASK_ONE_INACTIVE || kind === MASK_TWO_INACTIVE)
      selection = reader.take(length >> 3, 'selection mask');
    const packed = (compression & COMPRESS_ACTIVE_MASK) !== 0 && kind !== NO_MASK_ALL_VALUES,
      count = packed ? countBits(mask) : length,
      { view } = await this.raw(count),
      step = half ? 2 : codec.size,
      read = half ? (at: number) => halfToNumber(view.getUint16(at, true)) : (at: number) => codec.read(view, at);
    let from = 0;
    for (let i = 0; i < length; i++) {
      const at = start + i * components;
      if (!packed || bit(mask, i)) {
        for (let c = 0; c < components; c++, from += step) target[at + c] = read(from);
        continue;
      }
      const fill = selection && bit(selection, i) ? inactive1 : inactive0;
      for (let c = 0; c < components; c++) target[at + c] = fill[c]!;
    }
  }
}

interface PendingLeaf {
  origin: [number, number, number];
  mask: Uint8Array<ArrayBuffer>;
}

/** Reads a tree's topology, then its leaf values, into a grid's leaves and tiles. */
class TreeReader {
  readonly leaves: PendingLeaf[] = [];
  readonly tiles: VDBTile[] = [];
  private readonly spans: number[];

  constructor(
    readonly values: ValueReader,
    readonly dims: readonly number[],
    readonly signal: AbortSignal | undefined,
  ) {
    // Log2 of a node's edge in voxels, for the root's children downward.
    this.spans = dims.map((_, level) => dims.slice(level).reduce((sum, dim) => sum + dim, 0));
  }

  private tile(origin: [number, number, number], size: number, value: number[], active: boolean): void {
    const { background } = this.values;
    if (!active && value.every((v, i) => Object.is(v, background[i]))) return;
    this.tiles.push({
      origin,
      size,
      value: value.length === 1 ? value[0]! : (value as [number, number, number]),
      active,
    });
  }

  async topology(): Promise<void> {
    const { values } = this,
      { reader } = values,
      tiles = reader.u32('root tile count'),
      children = reader.u32('root child count'),
      span = 2 ** this.spans[0]!;
    reader.need(tiles * 12 + children * 12, 'root node');
    for (let i = 0; i < tiles; i++) {
      const origin = reader.coord('root tile'),
        value = values.value('root tile'),
        active = reader.u8('root tile') !== 0;
      this.tile(origin, span, value, active);
    }
    for (let i = 0; i < children; i++) await this.child(reader.coord('root child'), 0);
  }

  private async child(origin: [number, number, number], level: number): Promise<void> {
    const { reader } = this.values,
      dim = this.dims[level]!,
      total = 2 ** (dim * 3);
    if (level === this.dims.length - 1) {
      this.leaves.push({ origin, mask: reader.take(total >> 3, 'leaf mask').slice() });
      return;
    }
    throwIfAborted(this.signal, F);
    const children = reader.take(total >> 3, 'child mask'),
      active = reader.take(total >> 3, 'tile mask'),
      { codec, background } = this.values,
      tileValues = codec.make(total * codec.components);
    await this.values.node(tileValues, 0, total, active);
    const shift = this.spans[level + 1]!,
      size = 2 ** shift,
      low = 2 ** dim - 1,
      at = (i: number): [number, number, number] => [
        origin[0] + (i >> (2 * dim)) * size,
        origin[1] + ((i >> dim) & low) * size,
        origin[2] + (i & low) * size,
      ];
    for (let i = 0; i < total; i++) {
      if (bit(children, i)) continue;
      const value = background.map((_, c) => tileValues[i * codec.components + c]!);
      this.tile(at(i), size, value, bit(active, i));
    }
    for (let i = 0; i < total; i++) if (bit(children, i)) await this.child(at(i), level + 1);
  }

  /** The values of every leaf, in the order the topology listed them. */
  async buffers(pool: VDBData, perLeaf: number): Promise<void> {
    const { values } = this,
      { reader } = values,
      length = 2 ** (this.dims[this.dims.length - 1]! * 3);
    for (const [index, leaf] of this.leaves.entries()) {
      if (index % 256 === 0) throwIfAborted(this.signal, F);
      reader.take(length >> 3, 'leaf mask');
      await values.node(pool, index * perLeaf, length, leaf.mask);
    }
  }
}

const key = (x: number, y: number, z: number): string => `${x},${y},${z}`;

function makeGrid(
  fields: Pick<
    VDBGrid,
    | 'name'
    | 'type'
    | 'valueType'
    | 'half'
    | 'components'
    | 'gridClass'
    | 'background'
    | 'matrix'
    | 'leaves'
    | 'tiles'
    | 'meta'
  >,
  codec: ValueCodec,
  dims: readonly number[],
): VDBGrid {
  const { leaves, tiles, matrix, components, background } = fields,
    leafDim = dims[dims.length - 1]!,
    leafEdge = 2 ** leafDim,
    tileSizes = [...new Set(tiles.map((tile) => tile.size))].sort((a, b) => a - b);
  let leafAt: Map<string, VDBLeaf> | undefined, tileAt: Map<string, VDBTile> | undefined;
  const lookup = (x: number, y: number, z: number): VDBLeaf | VDBTile | undefined => {
    leafAt ??= new Map(leaves.map((leaf) => [key(...leaf.origin), leaf]));
    tileAt ??= new Map(tiles.map((tile) => [`${tile.size}:${key(...tile.origin)}`, tile]));
    const down = (v: number, size: number): number => Math.floor(v / size) * size,
      leaf = leafAt.get(key(down(x, leafEdge), down(y, leafEdge), down(z, leafEdge)));
    if (leaf) return leaf;
    for (const size of tileSizes) {
      const tile = tileAt.get(`${size}:${key(down(x, size), down(y, size), down(z, size))}`);
      if (tile) return tile;
    }
    return undefined;
  };
  const leafIndex = (leaf: VDBLeaf, x: number, y: number, z: number): number =>
    (((x - leaf.origin[0]) << leafDim) | (y - leaf.origin[1])) * leafEdge + (z - leaf.origin[2]);

  let box: VDBGrid['box'] = null,
    activeVoxels = 0;
  const grow = (lo: readonly number[], hi: readonly number[]): void => {
    box ??= [lo[0]!, lo[1]!, lo[2]!, hi[0]!, hi[1]!, hi[2]!];
    for (let axis = 0; axis < 3; axis++) {
      box[axis] = Math.min(box[axis]!, lo[axis]!);
      box[axis + 3] = Math.max(box[axis + 3]!, hi[axis]!);
    }
  };
  for (const tile of tiles)
    if (tile.active) {
      activeVoxels += tile.size ** 3;
      grow(
        tile.origin,
        tile.origin.map((v) => v + tile.size - 1),
      );
    }
  for (const leaf of leaves) {
    const { origin, mask } = leaf;
    for (let i = 0; i < leafEdge ** 3; i++) {
      if (!bit(mask, i)) continue;
      activeVoxels++;
      const voxel = [
        origin[0] + (i >> (2 * leafDim)),
        origin[1] + ((i >> leafDim) & (leafEdge - 1)),
        origin[2] + (i & (leafEdge - 1)),
      ];
      grow(voxel, voxel);
    }
  }

  const toWorld = (x: number, y: number, z: number): [number, number, number] => [
    matrix[0]! * x + matrix[4]! * y + matrix[8]! * z + matrix[12]!,
    matrix[1]! * x + matrix[5]! * y + matrix[9]! * z + matrix[13]!,
    matrix[2]! * x + matrix[6]! * y + matrix[10]! * z + matrix[14]!,
  ];
  const column = (at: number): number => Math.hypot(matrix[at]!, matrix[at + 1]!, matrix[at + 2]!);

  return {
    ...fields,
    voxelSize: [column(0), column(4), column(8)],
    box,
    activeVoxels,
    at(x, y, z) {
      const found = lookup(x, y, z);
      if (!found) return background;
      if ('size' in found) return found.value;
      const at = leafIndex(found, x, y, z) * components;
      return components === 1 ? found.values[at]! : [found.values[at]!, found.values[at + 1]!, found.values[at + 2]!];
    },
    isActive(x, y, z) {
      const found = lookup(x, y, z);
      if (!found) return false;
      return 'size' in found ? found.active : bit(found.mask, leafIndex(found, x, y, z));
    },
    dense(options = {}) {
      const area = options.box ?? box;
      if (!area) throw new LoaderError(F, 'range', `grid ${fields.name} has no active voxels; pass a box`);
      if (area.length !== 6 || !area.every(Number.isInteger) || [0, 1, 2].some((a) => area[a]! > area[a + 3]!))
        throw new LoaderError(F, 'range', 'box must be six integers, each minimum no more than its maximum');
      const dimsOut: [number, number, number] = [area[3] - area[0] + 1, area[4] - area[1] + 1, area[5] - area[2] + 1],
        total = dimsOut[0] * dimsOut[1] * dimsOut[2] * components;
      if (total > (options.maxValues ?? 536_870_912))
        throw new LoaderError(F, 'limit', `a box of ${total} values is over the limit`);
      const data = codec.make(total),
        fill = typeof background === 'number' ? [background] : background;
      for (let i = 0; i < total; i += components) for (let c = 0; c < components; c++) data[i + c] = fill[c]!;
      const put = (x: number, y: number, z: number, read: (c: number) => number): void => {
        const at = ((z - area[2]) * dimsOut[1] + (y - area[1])) * dimsOut[0] + (x - area[0]);
        for (let c = 0; c < components; c++) data[at * components + c] = read(c);
      };
      // Leaves after tiles, though the two never overlap in a valid file.
      for (const tile of tiles) {
        const value = typeof tile.value === 'number' ? [tile.value] : tile.value,
          read = (c: number): number => value[c]!;
        for (let z = Math.max(area[2], tile.origin[2]); z <= Math.min(area[5], tile.origin[2] + tile.size - 1); z++)
          for (let y = Math.max(area[1], tile.origin[1]); y <= Math.min(area[4], tile.origin[1] + tile.size - 1); y++)
            for (let x = Math.max(area[0], tile.origin[0]); x <= Math.min(area[3], tile.origin[0] + tile.size - 1); x++)
              put(x, y, z, read);
      }
      for (const leaf of leaves) {
        const [ox, oy, oz] = leaf.origin;
        for (let z = Math.max(area[2], oz); z <= Math.min(area[5], oz + leafEdge - 1); z++)
          for (let y = Math.max(area[1], oy); y <= Math.min(area[4], oy + leafEdge - 1); y++)
            for (let x = Math.max(area[0], ox); x <= Math.min(area[3], ox + leafEdge - 1); x++) {
              const at = leafIndex(leaf, x, y, z) * components;
              put(x, y, z, (c) => leaf.values[at + c]!);
            }
      }
      const bounds: VDBDense['bounds'] = [
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
      ];
      for (let corner = 0; corner < 8; corner++) {
        const point = toWorld(area[corner & 1 ? 3 : 0], area[corner & 2 ? 4 : 1], area[corner & 4 ? 5 : 2]);
        for (let axis = 0; axis < 3; axis++) {
          bounds[axis * 2] = Math.min(bounds[axis * 2]!, point[axis]!);
          bounds[axis * 2 + 1] = Math.max(bounds[axis * 2 + 1]!, point[axis]!);
        }
      }
      return { data, dims: dimsOut, components, box: [...area], bounds };
    },
  };
}

interface Descriptor {
  name: string;
  type: string;
  parent: string;
  gridAt: number;
  blockAt: number;
}

/** The tree type's value type, node sizes and whether it stored halves, or the reason it cannot be read. */
function treeType(type: string): { codec: ValueCodec; dims: number[]; half: boolean } | string {
  const match = /^Tree_([a-z0-9]+)((?:_\d+)+)(_HalfFloat)?$/.exec(type);
  if (!match) return `tree type ${type} is not one this reader knows`;
  const codec = CODECS[match[1]!];
  if (!codec) return `value type ${match[1]} is not decoded`;
  const dims = match[2]!.slice(1).split('_').map(Number);
  if (dims.length < 2 || dims.some((dim) => dim < 1 || dim > 10)) return `node sizes of ${type} are out of range`;
  if (match[3] && !HALF_TYPES.has(match[1]!)) return `half storage of ${match[1]} is not a float type`;
  return { codec, dims, half: match[3] !== undefined };
}

/**
 * Reads an OpenVDB `.vdb` file into sparse grids: leaves and tiles as stored, with `at()` for lookups and `dense()` for
 * the arrays a volume renderer takes. Reads file versions 222 and later (OpenVDB 2.0 onward).
 *
 * @throws LoaderError code `header` when the bytes are not a VDB file, `unsupported` for an older version or a Blosc
 * codec other than LZ4, `truncated`, `range` or `syntax` for a damaged file, `limit` over `maxValues`, `zip` for bad
 * compressed data, `aborted` when `signal` fires.
 */
export async function parseVDB(input: BinaryInput, options: VDBOptions = {}): Promise<VDBFile> {
  const { signal } = options;
  throwIfAborted(signal, F);
  const bytes = toBytes(input, F),
    reader = new Reader(bytes),
    maxValues = options.maxValues ?? 536_870_912;
  if (!LITTLE) throw new LoaderError(F, 'unsupported', 'a big-endian host is not supported');
  if (bytes.length < 8 || latin1(bytes, 0, 8) !== ' BDV\0\0\0\0')
    throw new LoaderError(F, 'header', 'not an OpenVDB file');
  reader.pos = 8;
  const version = reader.u32('version');
  if (version < MIN_VERSION)
    throw new LoaderError(F, 'unsupported', `file version ${version} is before ${MIN_VERSION}`);
  const library: [number, number] = [reader.u32('library version'), reader.u32('library version')],
    offsets = reader.u8('grid offset flag') !== 0,
    uuid = latin1(reader.take(36, 'uuid')),
    meta = readMeta(reader);
  if (!offsets) throw new LoaderError(F, 'unsupported', 'a stream with no grid offsets is not supported');
  const gridCount = reader.u32('grid count');
  reader.need(gridCount * 36, 'grid descriptors');
  const descriptors: Descriptor[] = [];
  for (let i = 0; i < gridCount; i++) {
    const name = reader.text('grid name').split('\x1e')[0]!,
      type = reader.text('grid type'),
      parent = reader.text('grid parent').split('\x1e')[0]!,
      gridAt = reader.i64('grid offset'),
      blockAt = reader.i64('block offset');
    reader.i64('end offset');
    descriptors.push({ name, type, parent, gridAt, blockAt });
  }

  const grids: VDBGrid[] = [],
    skipped: VDBFile['skipped'] = [],
    wanted = options.grids && new Set(options.grids);
  let used = 0;
  for (const { name, type, parent, gridAt, blockAt } of descriptors) {
    throwIfAborted(signal, F);
    const skip = (reason: string): void => void skipped.push({ name, type, reason });
    if (wanted && !wanted.has(name)) {
      skip('not in options.grids');
      continue;
    }
    const tree = treeType(type);
    if (typeof tree === 'string') {
      skip(tree);
      continue;
    }
    reader.seek(gridAt, `grid ${name}`);
    const { codec, dims, half } = tree,
      compression = reader.u32('compression'),
      gridMeta = readMeta(reader),
      matrix = readTransform(reader);
    if (!matrix) {
      skip('its transform has no matrix');
      continue;
    }
    const gridClass = typeof gridMeta.class === 'string' ? gridMeta.class : 'unknown';
    if (parent) {
      const source = grids.find((grid) => grid.name === parent);
      if (!source) {
        skip(`its parent grid ${parent} was not read`);
        continue;
      }
      const { leaves, tiles, background } = source;
      grids.push(
        makeGrid(
          {
            name,
            type,
            valueType: codec.valueType,
            half,
            components: codec.components,
            gridClass,
            background,
            matrix,
            leaves,
            tiles,
            meta: gridMeta,
          },
          codec,
          dims,
        ),
      );
      continue;
    }
    if (reader.i32('buffer count') !== 1) throw new LoaderError(F, 'unsupported', `grid ${name} holds several buffers`);
    const probe = new ValueReader(reader, codec, half, compression, [], signal),
      background = probe.value('background'),
      values = new ValueReader(reader, codec, half, compression, background, signal),
      walker = new TreeReader(values, dims, signal);
    await walker.topology();
    const perLeaf = 2 ** (dims[dims.length - 1]! * 3) * codec.components;
    used += walker.leaves.length * perLeaf;
    if (used > maxValues) throw new LoaderError(F, 'limit', `${used} leaf values are over the limit of ${maxValues}`);
    const pool = codec.make(walker.leaves.length * perLeaf);
    reader.seek(blockAt, `grid ${name} values`);
    await walker.buffers(pool, perLeaf);
    const leaves = walker.leaves.map(({ origin, mask }, index) => ({
      origin,
      mask,
      values: pool.subarray(index * perLeaf, (index + 1) * perLeaf) as VDBData,
    }));
    grids.push(
      makeGrid(
        {
          name,
          type,
          valueType: codec.valueType,
          half,
          components: codec.components,
          gridClass,
          background: background.length === 1 ? background[0]! : (background as [number, number, number]),
          matrix,
          leaves,
          tiles: walker.tiles,
          meta: gridMeta,
        },
        codec,
        dims,
      ),
    );
  }
  return { version, library, uuid, meta, grids, skipped };
}
