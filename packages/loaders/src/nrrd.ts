// NRRD volumes (NRRD0001 to NRRD0005): the header, the raw, ascii, hex and gzip encodings, and detached data files.
import { LoaderError, type AssetResolver } from './types.js';
import { findLineEnd, latin1, resolvePath, throwIfAborted, toBytes, type BinaryInput } from './util.js';
import { inflate } from './zip.js';

const F = 'NRRD';
const MAX_HEADER = 1 << 20;
const MAX_DIMENSION = 16;
const LITTLE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/** A sample type of a NRRD file, with the C spellings folded to one name. */
export type NRRDType =
  | 'int8'
  | 'uint8'
  | 'int16'
  | 'uint16'
  | 'int32'
  | 'uint32'
  | 'int64'
  | 'uint64'
  | 'float32'
  | 'float64';

/** Samples in the file's own type; 64-bit integers arrive as `Float64Array`, exact up to 2^53. */
export type NRRDData =
  | Int8Array<ArrayBuffer>
  | Uint8Array<ArrayBuffer>
  | Int16Array<ArrayBuffer>
  | Uint16Array<ArrayBuffer>
  | Int32Array<ArrayBuffer>
  | Uint32Array<ArrayBuffer>
  | Float32Array<ArrayBuffer>
  | Float64Array<ArrayBuffer>;

/** Options of {@link parseNRRD}. */
export interface NRRDOptions {
  /** Reads a detached `data file`, by the path written in the header. A `.nhdr` file needs this. Default none. */
  resolve?: AssetResolver;
  /** Maximum samples in the whole array. Default 536,870,912. */
  maxSamples?: number;
  signal?: AbortSignal;
}

/** What {@link parseNRRD} returns. Pass `data`, `dims` and `bounds` to `fig.volume()` of `@margoengine/sciviz`. */
export interface NRRDVolume {
  /** Every sample, the first axis fastest. */
  data: NRRDData;
  type: NRRDType;
  /** The size of every axis in the file, the fastest first. */
  sizes: number[];
  /** Grid size `[nx, ny, nz]` of the spatial axes, padded with 1 for a 1D or 2D file. */
  dims: [number, number, number];
  /** Samples per voxel: the product of the leading non-spatial axes, such as an RGB axis. 1 for a scalar volume. */
  components: number;
  /** Volumes in the file: the product of the axes after the spatial ones, such as time. 1 for one volume. */
  frames: number;
  /** Distance between samples along each spatial axis; 1 where the file gives none. */
  spacing: [number, number, number];
  /** `[0, (nx - 1) * sx, 0, (ny - 1) * sy, 0, (nz - 1) * sz]`: the true proportions, in `spacing` units. */
  bounds: [number, number, number, number, number, number];
  /** Column-major 4x4 from voxel index to `space` coordinates, with the file's origin, rotation and flips. */
  matrix: Float64Array<ArrayBuffer>;
  /** The `space` field, such as `left-posterior-superior`, when the file names one. */
  space?: string;
  /** Every header field by lower-case name, as written. Null prototype. */
  fields: Record<string, string>;
  /** `key:=value` pairs with their escapes undone. Null prototype. */
  meta: Record<string, string>;
}

const TYPES: Record<string, NRRDType> = Object.create(null);
for (const [type, names] of [
  ['int8', 'signed char,int8,int8_t'],
  ['uint8', 'uchar,unsigned char,uint8,uint8_t'],
  ['int16', 'short,short int,signed short,signed short int,int16,int16_t'],
  ['uint16', 'ushort,unsigned short,unsigned short int,uint16,uint16_t'],
  ['int32', 'int,signed int,int32,int32_t'],
  ['uint32', 'uint,unsigned int,uint32,uint32_t'],
  ['int64', 'longlong,long long,long long int,signed long long,signed long long int,int64,int64_t'],
  ['uint64', 'ulonglong,unsigned long long,unsigned long long int,uint64,uint64_t'],
  ['float32', 'float'],
  ['float64', 'double'],
] as const)
  for (const name of names.split(',')) TYPES[name] = type;

const ENCODINGS: Record<string, 'raw' | 'ascii' | 'hex' | 'gzip' | 'bzip2'> = Object.assign(Object.create(null), {
  raw: 'raw',
  txt: 'ascii',
  text: 'ascii',
  ascii: 'ascii',
  hex: 'hex',
  gz: 'gzip',
  gzip: 'gzip',
  bz2: 'bzip2',
  bzip2: 'bzip2',
});

/** bzip2 data, which `@margoengine/decoders` undoes, loaded only for a file that needs it. */
async function bunzip(body: Uint8Array, size: number): Promise<Uint8Array> {
  const { decodeBzip2 } = await import('@margoengine/decoders/bzip2');
  try {
    return decodeBzip2(body, { maxBytes: size });
  } catch (error) {
    throw new LoaderError(F, 'zip', (error as Error).message);
  }
}

const SPACES: Record<string, string> = Object.assign(Object.create(null), {
  ras: 'right-anterior-superior',
  las: 'left-anterior-superior',
  lps: 'left-posterior-superior',
  rast: 'right-anterior-superior-time',
  last: 'left-anterior-superior-time',
  lpst: 'left-posterior-superior-time',
});
const spaceSize = (name: string): number => (name.endsWith('time') ? 4 : 3);

const SIZE: Record<NRRDType, number> = {
  int8: 1,
  uint8: 1,
  int16: 2,
  uint16: 2,
  int32: 4,
  uint32: 4,
  int64: 8,
  uint64: 8,
  float32: 4,
  float64: 8,
};

function allocate(type: NRRDType, count: number): NRRDData {
  switch (type) {
    case 'int8':
      return new Int8Array(count);
    case 'uint8':
      return new Uint8Array(count);
    case 'int16':
      return new Int16Array(count);
    case 'uint16':
      return new Uint16Array(count);
    case 'int32':
      return new Int32Array(count);
    case 'uint32':
      return new Uint32Array(count);
    case 'float32':
      return new Float32Array(count);
    default:
      return new Float64Array(count);
  }
}

function integers(value: string, name: string): number[] {
  const parts = value.trim().split(/\s+/).map(Number);
  if (!parts.every(Number.isSafeInteger)) throw new LoaderError(F, 'syntax', `invalid ${name} "${value.slice(0, 64)}"`);
  return parts;
}

function integer(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  const [number, extra] = integers(value, name);
  if (extra !== undefined) throw new LoaderError(F, 'syntax', `invalid ${name} "${value.slice(0, 64)}"`);
  return number;
}

/** Reads `(a,b,c)` vectors and `none` words; `none` comes back as null. */
function vectors(value: string, name: string, size: number): (number[] | null)[] {
  const found: (number[] | null)[] = [];
  for (const [word, body] of value.matchAll(/\(([^)]*)\)|none/g)) {
    if (body === undefined) {
      found.push(null);
      continue;
    }
    const vector = body.split(',').map(Number);
    if (vector.length !== size || !vector.every(Number.isFinite))
      throw new LoaderError(F, 'syntax', `invalid vector "${word.slice(0, 64)}" in ${name}`);
    found.push(vector);
  }
  return found;
}

interface Header {
  fields: Record<string, string>;
  meta: Record<string, string>;
  /** Offset of the first byte after the header's blank line. */
  end: number;
  /** Lines after `data file: LIST`. */
  list: string[];
}

function readHeader(bytes: Uint8Array): Header {
  if (bytes.length < 8 || latin1(bytes, 0, 4) !== 'NRRD' || !/^\d{4}$/.test(latin1(bytes, 4, 8)))
    throw new LoaderError(F, 'header', 'missing the NRRD000x magic line');
  const fields: Record<string, string> = Object.create(null),
    meta: Record<string, string> = Object.create(null),
    list: string[] = [];
  let pos = findLineEnd(bytes, 0, MAX_HEADER) + 1,
    listing = false;
  if (pos === 0) throw new LoaderError(F, 'truncated', 'the file ends after the magic line');
  while (pos < bytes.length) {
    const lineEnd = findLineEnd(bytes, pos, MAX_HEADER + 1),
      end = lineEnd < 0 ? bytes.length : lineEnd;
    if (end > MAX_HEADER) throw new LoaderError(F, 'limit', `the header is longer than ${MAX_HEADER} bytes`);
    const line = latin1(bytes, pos, end).replace(/\r$/, '');
    pos = end + 1;
    if (line === '') break;
    if (listing) {
      list.push(line.trim());
      continue;
    }
    if (line[0] === '#') continue;
    const pair = line.indexOf(':='),
      colon = line.indexOf(': ');
    if (pair > 0 && (colon < 0 || pair < colon)) {
      meta[line.slice(0, pair)] = line.slice(pair + 2).replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c));
      continue;
    }
    if (colon <= 0) throw new LoaderError(F, 'syntax', `bad header line "${line.slice(0, 64)}"`);
    const name = line.slice(0, colon).toLowerCase(),
      value = line.slice(colon + 2).trim();
    if (name in fields) throw new LoaderError(F, 'syntax', `the field "${name.slice(0, 32)}" appears twice`);
    fields[name] = value;
    listing = (name === 'data file' || name === 'datafile') && /^LIST\b/.test(value);
  }
  return { fields, meta, end: Math.min(pos, bytes.length), list };
}

/** The data files of a detached header, or an empty list for attached data. */
function dataFiles(header: Header): string[] {
  const value = header.fields['data file'] ?? header.fields.datafile;
  if (value === undefined) return [];
  if (/^LIST\b/.test(value)) {
    if (!header.list.length) throw new LoaderError(F, 'syntax', 'data file: LIST names no files');
    return header.list;
  }
  const parts = value.split(/\s+/);
  if (parts.length === 1) return parts;
  const [format, ...numbers] = parts,
    [min, max, step] = numbers.map(Number),
    pattern = /%(0?)(\d*)d/.exec(format);
  if (!pattern || !Number.isSafeInteger(min) || !Number.isSafeInteger(max) || !Number.isSafeInteger(step) || !step)
    throw new LoaderError(F, 'syntax', `bad data file pattern "${value.slice(0, 64)}"`);
  if ((max - min) / step < 0 || (max - min) / step > 1_000_000)
    throw new LoaderError(F, 'range', `data file pattern "${value.slice(0, 64)}" names no files or too many`);
  const files: string[] = [];
  for (let i = min; step > 0 ? i <= max : i >= max; i += step)
    files.push(format.replace(pattern[0], String(i).padStart(Number(pattern[2]), pattern[1] ? '0' : ' ')));
  return files;
}

function skipLines(bytes: Uint8Array, lines: number): number {
  let pos = 0;
  for (let i = 0; i < lines; i++) {
    const end = findLineEnd(bytes, pos, bytes.length);
    if (end < 0) throw new LoaderError(F, 'truncated', `the data has fewer than ${lines} lines to skip`);
    pos = end + 1;
  }
  return pos;
}

function swap(bytes: Uint8Array, size: number): void {
  for (let i = 0; i + size <= bytes.length; i += size)
    for (let a = i, b = i + size - 1; a < b; a++, b--) {
      const t = bytes[a];
      bytes[a] = bytes[b];
      bytes[b] = t;
    }
}

/** Writes `count` samples from native-order `bytes`, which own their buffer, into `out` at `offset`. */
function store(out: NRRDData, offset: number, bytes: Uint8Array<ArrayBuffer>, type: NRRDType, count: number): void {
  if (type === 'int64' || type === 'uint64') {
    const wide =
      type === 'int64' ? new BigInt64Array(bytes.buffer, 0, count) : new BigUint64Array(bytes.buffer, 0, count);
    for (let i = 0; i < count; i++) out[offset + i] = Number(wide[i]);
    return;
  }
  const View = out.constructor as new (buffer: ArrayBuffer, offset: number, length: number) => NRRDData;
  out.set(new View(bytes.buffer, 0, count) as never, offset);
}

function sample(word: string, float: boolean): number {
  const value = Number(word);
  if (float) {
    if (!Number.isNaN(value) || /^[+-]?nan$/i.test(word)) return value;
    if (/^[+-]?inf(inity)?$/i.test(word)) return word[0] === '-' ? -Infinity : Infinity;
  } else if (Number.isSafeInteger(value)) return value;
  throw new LoaderError(F, 'syntax', `invalid sample "${word.slice(0, 32)}"`);
}

function readText(text: string, out: NRRDData, offset: number, count: number, float: boolean): void {
  const token = /[^\s,]+/g;
  let i = 0;
  for (let match = token.exec(text); match && i < count; match = token.exec(text), i++)
    out[offset + i] = sample(match[0], float);
  if (i < count) throw new LoaderError(F, 'truncated', `found ${i} samples, expected ${count}`);
}

function readHex(text: string, length: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(length);
  let filled = 0,
    high = -1;
  for (let i = 0; i < text.length && filled < length; i++) {
    const code = text.charCodeAt(i);
    if (code === 32 || (code >= 9 && code <= 13)) continue;
    const lower = code | 32,
      digit = code >= 48 && code <= 57 ? code - 48 : lower >= 97 && lower <= 102 ? lower - 87 : -1;
    if (digit < 0) throw new LoaderError(F, 'syntax', `invalid hex digit at character ${i}`);
    if (high < 0) high = digit;
    else {
      out[filled++] = high * 16 + digit;
      high = -1;
    }
  }
  if (filled < length) throw new LoaderError(F, 'truncated', `found ${filled} bytes of hex, expected ${length}`);
  return out;
}

interface Encoded {
  type: NRRDType;
  encoding: 'raw' | 'ascii' | 'hex' | 'gzip' | 'bzip2';
  swapped: boolean;
  lineSkip: number;
  byteSkip: number;
  signal?: AbortSignal;
}

async function decode(file: Uint8Array, out: NRRDData, offset: number, count: number, how: Encoded): Promise<void> {
  const { type, encoding, byteSkip } = how,
    size = SIZE[type],
    length = count * size;
  let body = file.subarray(skipLines(file, how.lineSkip));
  if (encoding === 'ascii') {
    readText(latin1(body, byteSkip), out, offset, count, type === 'float32' || type === 'float64');
    return;
  }
  let raw: Uint8Array<ArrayBuffer>;
  if (encoding === 'hex') raw = readHex(latin1(body, byteSkip), length);
  else {
    if (encoding === 'gzip') body = await inflate(body, length + byteSkip, 'the data', how.signal, 'gzip', F);
    else if (encoding === 'bzip2') body = await bunzip(body, length + Math.max(byteSkip, 0));
    const start = byteSkip < 0 ? body.length - length : byteSkip;
    if (start < 0 || start + length > body.length)
      throw new LoaderError(F, 'truncated', `the data has ${body.length} bytes, expected ${length}`);
    // A copy, never `slice`: on a Node Buffer that is a view of a shared pool, and `store` reads the buffer from 0.
    raw = new Uint8Array(length);
    raw.set(body.subarray(start, start + length));
  }
  if (how.swapped) swap(raw, size);
  store(out, offset, raw, type, count);
}

function layout(
  fields: Record<string, string>,
  sizes: number[],
): Pick<NRRDVolume, 'dims' | 'components' | 'frames' | 'spacing' | 'bounds' | 'matrix' | 'space'> {
  const dimension = sizes.length,
    named = fields.space?.toLowerCase(),
    space = named === undefined ? undefined : (SPACES[named] ?? named);
  if (space && fields['space dimension'] !== undefined)
    throw new LoaderError(F, 'syntax', 'a file gives space or space dimension, never both');
  const spaceDimension = integer(fields['space dimension'], 'space dimension', space ? spaceSize(space) : 0);
  if (spaceDimension < 0 || spaceDimension > MAX_DIMENSION)
    throw new LoaderError(F, 'range', `space dimension ${spaceDimension} is out of range`);
  let directions: (number[] | null)[] | undefined;
  if (fields['space directions'] !== undefined) {
    if (!spaceDimension) throw new LoaderError(F, 'syntax', 'space directions need a space');
    directions = vectors(fields['space directions'], 'space directions', spaceDimension);
    if (directions.length !== dimension)
      throw new LoaderError(F, 'syntax', `space directions has ${directions.length} entries for ${dimension} axes`);
  }
  const kinds = fields.kinds?.trim().split(/\s+/);
  if (kinds && kinds.length !== dimension)
    throw new LoaderError(F, 'syntax', `kinds has ${kinds.length} entries for ${dimension} axes`);
  const spatial = (axis: number): boolean => {
    const kind = kinds?.[axis];
    if (directions) return directions[axis] !== null && kind !== 'time';
    return kind === undefined || kind === 'domain' || kind === 'space' || kind === 'none' || kind === '???';
  };
  let first = 0,
    components = 1;
  while (first < dimension && !spatial(first)) components *= sizes[first++];
  const axes: number[] = [];
  for (let axis = first; axis < dimension && axes.length < 3 && spatial(axis); axis++) axes.push(axis);
  let frames = 1;
  for (let axis = first + axes.length; axis < dimension; axis++) frames *= sizes[axis];

  const spacings = fields.spacings?.trim().split(/\s+/).map(Number);
  if (spacings && spacings.length !== dimension)
    throw new LoaderError(F, 'syntax', `spacings has ${spacings.length} entries for ${dimension} axes`);
  const origin =
    fields['space origin'] === undefined ? null : vectors(fields['space origin'], 'space origin', spaceDimension)[0];
  const dims: [number, number, number] = [1, 1, 1],
    spacing: [number, number, number] = [1, 1, 1],
    matrix = new Float64Array(16);
  matrix[15] = 1;
  for (let k = 0; k < 3; k++) {
    const axis = axes[k],
      direction = axis === undefined ? undefined : directions?.[axis];
    if (axis !== undefined) dims[k] = sizes[axis];
    if (direction) {
      const length = Math.hypot(...direction);
      if (!(length > 0)) throw new LoaderError(F, 'range', `space direction of axis ${axis} has no length`);
      spacing[k] = length;
      for (let row = 0; row < 3; row++) matrix[k * 4 + row] = direction[row] ?? 0;
      continue;
    }
    const step = axis === undefined ? undefined : spacings?.[axis],
      usable = step !== undefined && step !== 0 && Number.isFinite(step);
    if (usable) spacing[k] = Math.abs(step);
    matrix[k * 5] = usable ? step : 1;
  }
  for (let row = 0; row < 3; row++) matrix[12 + row] = origin?.[row] ?? 0;
  const result: ReturnType<typeof layout> = {
    dims,
    components,
    frames,
    spacing,
    bounds: [0, (dims[0] - 1) * spacing[0], 0, (dims[1] - 1) * spacing[1], 0, (dims[2] - 1) * spacing[2]],
    matrix,
  };
  if (space) result.space = space;
  return result;
}

/**
 * Reads a NRRD volume from a `.nrrd` file, or a `.nhdr` header with its detached data through `resolve`. Encodings are
 * raw, ascii, hex and gzip, with either byte order, `line skip` and `byte skip` (-1 for the end of a raw file) and one
 * or many data files. `space directions`, `space origin`, `spacings` and `kinds` set `dims`, `spacing`, `bounds` and
 * `matrix`; a leading non-spatial axis is `components` and trailing ones are `frames`.
 *
 * @param input The file's bytes.
 * @param options A resolver for detached data, the sample limit and an AbortSignal.
 * @returns The samples in the file's own type and where they sit.
 * @throws LoaderError with code `header`, `syntax`, `truncated`, `range`, `limit`, `aborted`, `zip` or `unsupported` (
 * the block type, or detached data without `resolve`).
 *
 * @example
 * ```ts
 * import { parseNRRD } from '@margoengine/loaders/nrrd';
 *
 * const header = 'NRRD0004\ntype: uint8\ndimension: 3\nsizes: 2 1 1\nspacings: 2 1 1\nencoding: ascii\n\n';
 * const { data, dims, bounds } = await parseNRRD(new TextEncoder().encode(`${header}10 20\n`));
 * console.log(data, dims, bounds);
 * ```
 */
export async function parseNRRD(input: BinaryInput, options: NRRDOptions = {}): Promise<NRRDVolume> {
  const bytes = toBytes(input, F),
    { resolve, signal } = options,
    maxSamples = options.maxSamples ?? 2 ** 29;
  throwIfAborted(signal, F);
  if (!Number.isSafeInteger(maxSamples) || maxSamples < 0)
    throw new LoaderError(F, 'range', 'maxSamples must be a non-negative integer');
  const header = readHeader(bytes),
    { fields, meta } = header;
  const missing = ['type', 'dimension', 'sizes', 'encoding'].find((name) => !(name in fields));
  if (missing) throw new LoaderError(F, 'header', `the required field "${missing}" is missing`);
  if (fields.type.toLowerCase() === 'block') throw new LoaderError(F, 'unsupported', 'the block type has no array form');
  const type = TYPES[fields.type.toLowerCase()];
  if (!type) throw new LoaderError(F, 'header', `unknown type "${fields.type.slice(0, 32)}"`);
  const named = fields.encoding.toLowerCase();
  const encoding = ENCODINGS[named];
  if (!encoding) throw new LoaderError(F, 'header', `unknown encoding "${fields.encoding.slice(0, 32)}"`);
  const dimension = integer(fields.dimension, 'dimension', 0);
  if (dimension < 1 || dimension > MAX_DIMENSION)
    throw new LoaderError(F, 'range', `dimension ${dimension} is outside 1..${MAX_DIMENSION}`);
  const sizes = integers(fields.sizes, 'sizes');
  if (sizes.length !== dimension)
    throw new LoaderError(F, 'syntax', `sizes has ${sizes.length} entries for ${dimension} axes`);
  let total = 1;
  for (const size of sizes) {
    if (size < 1) throw new LoaderError(F, 'range', `axis size ${size} is below 1`);
    total *= size;
    if (total > maxSamples) throw new LoaderError(F, 'limit', `the array exceeds the limit of ${maxSamples} samples`);
  }
  const endian = fields.endian?.toLowerCase();
  if (endian !== undefined && endian !== 'little' && endian !== 'big')
    throw new LoaderError(F, 'header', `unknown endian "${endian.slice(0, 32)}"`);
  if (endian === undefined && SIZE[type] > 1 && encoding !== 'ascii')
    throw new LoaderError(F, 'header', 'the required field "endian" is missing');
  const lineSkip = integer(fields['line skip'] ?? fields.lineskip, 'line skip', 0),
    byteSkip = integer(fields['byte skip'] ?? fields.byteskip, 'byte skip', 0);
  if (lineSkip < 0) throw new LoaderError(F, 'range', `line skip ${lineSkip} is negative`);
  if (byteSkip < -1 || (byteSkip === -1 && encoding !== 'raw'))
    throw new LoaderError(F, 'range', `byte skip ${byteSkip} is not allowed with ${encoding} data`);
  const placed = layout(fields, sizes);

  const data = allocate(type, total),
    how: Encoded = {
      type,
      encoding,
      swapped: endian !== undefined && (endian === 'little') !== LITTLE,
      lineSkip,
      byteSkip,
      signal,
    },
    files = dataFiles(header);
  if (!files.length) await decode(bytes.subarray(header.end), data, 0, total, how);
  else {
    if (!resolve)
      throw new LoaderError(F, 'unsupported', `the data is in "${files[0].slice(0, 64)}"; pass a resolve option`);
    if (total % files.length)
      throw new LoaderError(F, 'range', `${total} samples do not divide over ${files.length} data files`);
    const each = total / files.length;
    for (let i = 0; i < files.length; i++) {
      throwIfAborted(signal, F);
      const content = await resolve(resolvePath('', files[i]));
      const file = typeof content === 'string' ? new TextEncoder().encode(content) : content;
      await decode(file, data, i * each, each, how);
    }
  }
  return { data, type, sizes, ...placed, fields, meta };
}
