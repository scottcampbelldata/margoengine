// NRRD volumes (NRRD0001 to NRRD0005): the header, the raw, ascii, hex and gzip encodings, and detached data files.
import { LoaderError, type AssetResolver } from './types.js';
import { crc32 } from '../../shared/crc32.js';
import { findLineEnd, latin1, resolvePath, throwIfAborted, toBytes, type BinaryInput } from './util.js';

const F = 'NRRD';
const MAX_HEADER = 1 << 20;
const MAX_DIMENSION = 16;
const LITTLE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
/** Compressed bytes handed to the gzip decoder per step, so decoding can stop once the samples are out. */
const FEED = 1 << 16;

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

/**
 * bzip2 data, which `@margoengine/decoders` undoes, loaded only for a file that needs it. Decoding stops once `size`
 * bytes are out: section 2 says data past what the header needs is ignored, and nothing more is ever inflated.
 */
async function bunzip(body: Uint8Array, size: number): Promise<Uint8Array> {
  const { decodeBzip2 } = await import('@margoengine/decoders/bzip2');
  try {
    return decodeBzip2(body, { maxBytes: size, stopAt: size });
  } catch (error) {
    throw new LoaderError(F, 'zip', (error as Error).message);
  }
}

/** The spaces the format names (section 4), by lower-case spelling, with their dimension. */
const SPACES: Record<string, [name: string, dimension: number]> = Object.create(null);
for (const [name, short] of [
  ['right-anterior-superior', 'ras'],
  ['left-anterior-superior', 'las'],
  ['left-posterior-superior', 'lps'],
  ['scanner-xyz', ''],
  ['3D-right-handed', ''],
  ['3D-left-handed', ''],
] as const)
  for (const time of [false, true]) {
    const full = time ? `${name}-time` : name;
    SPACES[full.toLowerCase()] = [full, time ? 4 : 3];
    if (short) SPACES[time ? `${short}t` : short] = [full, time ? 4 : 3];
  }

/** Kinds of the format (section 6) with the axis size each requires, 0 for none. */
const KINDS: Record<string, number> = Object.assign(Object.create(null), {
  domain: 0,
  space: 0,
  time: 0,
  list: 0,
  point: 0,
  vector: 0,
  'covariant-vector': 0,
  normal: 0,
  stub: 1,
  scalar: 1,
  complex: 2,
  '2-vector': 2,
  '3-color': 3,
  'rgb-color': 3,
  'hsv-color': 3,
  'xyz-color': 3,
  '4-color': 4,
  'rgba-color': 4,
  '3-vector': 3,
  '3-gradient': 3,
  '3-normal': 3,
  '4-vector': 4,
  quaternion: 4,
  '2d-symmetric-matrix': 3,
  '2d-masked-symmetric-matrix': 4,
  '2d-matrix': 4,
  // The spec's table gives 4 here but lists five components (a mask and four), so no size is required of it.
  '2d-masked-matrix': 0,
  '3d-symmetric-matrix': 6,
  '3d-masked-symmetric-matrix': 7,
  '3d-matrix': 9,
  '3d-masked-matrix': 10,
  '???': 0,
  none: 0,
});

/** Second spellings of field identifiers, mapped to the first. */
const ALIASES: Record<string, string> = Object.assign(Object.create(null), {
  blocksize: 'block size',
  oldmin: 'old min',
  oldmax: 'old max',
  datafile: 'data file',
  lineskip: 'line skip',
  byteskip: 'byte skip',
  sampleunits: 'sample units',
  axismins: 'axis mins',
  axismaxs: 'axis maxs',
  centerings: 'centers',
});

/** The first magic version each field exists in (section 1.1). */
const SINCE: Record<string, number> = Object.assign(Object.create(null), {
  kinds: 3,
  thicknesses: 4,
  'sample units': 4,
  space: 4,
  'space dimension': 4,
  'space units': 4,
  'space origin': 4,
  'space directions': 4,
  'measurement frame': 5,
});

/** Per-axis fields, which only come after `dimension` (section 1.3). */
const PER_AXIS = new Set([
  'sizes',
  'spacings',
  'thicknesses',
  'axis mins',
  'axis maxs',
  'centers',
  'labels',
  'units',
  'kinds',
  'space directions',
]);

/** Orientation fields, which only come after `space` or `space dimension` (section 4). */
const ORIENTATION = new Set(['space units', 'space origin', 'space directions', 'measurement frame']);

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

/**
 * Reads `(a,b,c)` vectors and `none` words, separated by spaces or tabs; `none` comes back as null. Anything else in
 * the descriptor, between or inside the words, is a syntax error.
 */
function vectors(value: string, name: string, size: number): (number[] | null)[] {
  const found: (number[] | null)[] = [],
    word = /[ \t]*(?:\(([^()]*)\)|(none))(?=[ \t]|$)/iy;
  let at = 0;
  for (let match = word.exec(value); match; match = word.exec(value)) {
    at = word.lastIndex;
    if (match[1] === undefined) {
      found.push(null);
      continue;
    }
    const vector = match[1].split(',').map((part) => (part.trim() === '' ? NaN : Number(part)));
    if (vector.length !== size || !vector.every(Number.isFinite))
      throw new LoaderError(F, 'syntax', `invalid vector "(${match[1].slice(0, 64)})" in ${name}`);
    found.push(vector);
  }
  const rest = value.slice(at).trim();
  if (rest) throw new LoaderError(F, 'syntax', `unexpected "${rest.slice(0, 32)}" in ${name}`);
  return found;
}

/** A floating point value by the rules of section 2: "nan" anywhere is NaN, then "-inf", then "inf". */
function float(word: string): number {
  if (/nan/i.test(word)) return NaN;
  if (/-inf/i.test(word)) return -Infinity;
  if (/inf/i.test(word)) return Infinity;
  const value = Number(word);
  if (word.trim() === '' || Number.isNaN(value))
    throw new LoaderError(F, 'syntax', `invalid number "${word.slice(0, 32)}"`);
  return value;
}

/** A per-axis list of doubles; infinite entries are refused (spacings, axis mins and axis maxs never hold one). */
function doubles(value: string, name: string, dimension: number): number[] {
  const parts = value.trim().split(/[ \t]+/).map(float);
  if (parts.length !== dimension)
    throw new LoaderError(F, 'syntax', `${name} has ${parts.length} entries for ${dimension} axes`);
  if (parts.some((part) => part === Infinity || part === -Infinity))
    throw new LoaderError(F, 'range', `${name} holds an infinite value`);
  return parts;
}

interface Header {
  /** The magic's version, 1 to 5. */
  version: number;
  /** Fields by lower-case identifier, as written. */
  fields: Record<string, string>;
  /** The same fields by their first spelling (`line skip` for `lineskip`). */
  known: Record<string, string>;
  meta: Record<string, string>;
  /** Offset of the first byte after the header's blank line. */
  end: number;
  /** Lines after `data file: LIST`. */
  list: string[];
}

/** `\n` and `\\` are the only escapes of a key or value (section 1.2); any other backslash stays as written. */
const unescape = (text: string): string => text.replace(/\\([n\\])/g, (_, c: string) => (c === 'n' ? '\n' : '\\'));

function readHeader(bytes: Uint8Array): Header {
  if (bytes.length < 4 || latin1(bytes, 0, 4) !== 'NRRD')
    throw new LoaderError(F, 'header', 'missing the NRRD000x magic line');
  const magicEnd = findLineEnd(bytes, 0, MAX_HEADER);
  if (magicEnd < 0) throw new LoaderError(F, 'truncated', 'the file ends after the magic line');
  const magic = latin1(bytes, 0, magicEnd).replace(/\r$/, ''),
    numbered = /^NRRD000([1-5])$/.exec(magic);
  if (!numbered && magic !== 'NRRD00.01')
    throw new LoaderError(F, 'header', `the magic line "${magic.slice(0, 32)}" is not NRRD0001 to NRRD0005`);
  const version = numbered ? Number(numbered[1]) : 1,
    fields: Record<string, string> = Object.create(null),
    known: Record<string, string> = Object.create(null),
    meta: Record<string, string> = Object.create(null),
    list: string[] = [];
  let pos = magicEnd + 1,
    listing = false;
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
      if (version < 2) throw new LoaderError(F, 'header', 'key/value pairs need NRRD0002 or later');
      meta[unescape(line.slice(0, pair))] = unescape(line.slice(pair + 2));
      continue;
    }
    if (colon <= 0) throw new LoaderError(F, 'syntax', `bad header line "${line.slice(0, 64)}"`);
    const name = line.slice(0, colon).toLowerCase(),
      first = ALIASES[name] ?? name,
      value = line.slice(colon + 2).trim();
    if (first in known) throw new LoaderError(F, 'syntax', `the field "${first.slice(0, 32)}" appears twice`);
    if ((SINCE[first] ?? 1) > version)
      throw new LoaderError(F, 'header', `the field "${first}" needs NRRD000${SINCE[first]} or later`);
    if (PER_AXIS.has(first) && !('dimension' in known))
      throw new LoaderError(F, 'syntax', `the field "${first}" comes before dimension`);
    if (ORIENTATION.has(first) && !('space' in known) && !('space dimension' in known))
      throw new LoaderError(F, 'syntax', `the field "${first}" comes before space or space dimension`);
    fields[name] = value;
    known[first] = value;
    listing = first === 'data file' && value.split(/\s+/)[0] === 'LIST';
  }
  return { version, fields, known, meta, end: Math.min(pos, bytes.length), list };
}

/** One printf conversion of an int (C99 7.19.6.1): flags `-+ 0#`, a width, a precision, and `d i o u x X`. */
function printf(spec: RegExpExecArray, value: number): string {
  const [, flags, widthText, precisionText, conversion] = spec,
    width = Number(widthText || 0),
    precision = precisionText === undefined ? undefined : Number(precisionText || 0),
    signed = conversion === 'd' || conversion === 'i',
    magnitude = signed ? Math.abs(value) : value >>> 0,
    hex = conversion === 'x' || conversion === 'X';
  let digits = magnitude.toString(conversion === 'o' ? 8 : hex ? 16 : 10);
  if (conversion === 'X') digits = digits.toUpperCase();
  if (precision !== undefined) digits = precision === 0 && value === 0 ? '' : digits.padStart(precision, '0');
  if (flags.includes('#') && conversion === 'o' && !digits.startsWith('0')) digits = `0${digits}`;
  const sign = !signed ? '' : value < 0 ? '-' : flags.includes('+') ? '+' : flags.includes(' ') ? ' ' : '',
    prefix = hex && flags.includes('#') && magnitude !== 0 ? `0${conversion}` : '',
    body = sign + prefix + digits;
  if (body.length >= width) return body;
  if (flags.includes('-')) return body.padEnd(width);
  if (flags.includes('0') && precision === undefined)
    return sign + prefix + digits.padStart(width - sign.length - prefix.length, '0');
  return body.padStart(width);
}

/** Splits a `data file` pattern at its one integer conversion; `%%` is a literal percent sign. */
function pattern(format: string, value: string): { before: string; spec: RegExpExecArray; after: string } {
  const bad = () => new LoaderError(F, 'syntax', `bad data file pattern "${value.slice(0, 64)}"`),
    conversion = /%([-+ 0#]*)(\d{0,3})(?:\.(\d{0,3}))?([diouxX])/y;
  let before = '',
    after = '',
    spec: RegExpExecArray | null = null;
  for (let i = 0; i < format.length; i++) {
    if (format[i] === '%') {
      if (format[i + 1] === '%') i++;
      else {
        conversion.lastIndex = i;
        const found = conversion.exec(format);
        if (!found || spec) throw bad();
        spec = found;
        i = conversion.lastIndex - 1;
        continue;
      }
    }
    if (spec) after += format[i];
    else before += format[i];
  }
  if (!spec) throw bad();
  return { before, spec, after };
}

/** The data files of a detached header, empty for attached data, and the dimension of the data in each file. */
function dataFiles(header: Header, dimension: number): { files: string[]; subdim: number } {
  const value = header.known['data file'],
    int32 = (n: number) => Number.isInteger(n) && n >= -(2 ** 31) && n < 2 ** 31;
  if (value === undefined) return { files: [], subdim: dimension };
  const parts = value.split(/\s+/);
  if (parts.length === 1 && parts[0] !== 'LIST') return { files: parts, subdim: dimension };
  if (header.version < 4) throw new LoaderError(F, 'header', 'several data files need NRRD0004 or later');
  const listed = parts[0] === 'LIST';
  if (listed ? parts.length > 2 : parts.length !== 4 && parts.length !== 5)
    throw new LoaderError(F, 'syntax', `bad data file pattern "${value.slice(0, 64)}"`);
  const last = listed ? parts[1] : parts[4],
    subdim = last === undefined ? dimension - 1 : Number(last);
  if (last !== undefined && !(Number.isInteger(subdim) && subdim >= 1 && subdim <= dimension))
    throw new LoaderError(F, 'range', `data file subdim ${last.slice(0, 16)} is outside 1..${dimension}`);
  if (listed) {
    if (!header.list.length) throw new LoaderError(F, 'syntax', 'data file: LIST names no files');
    return { files: header.list, subdim };
  }
  const [format, ...numbers] = parts,
    [min, max, step] = numbers.map(Number),
    { before, spec, after } = pattern(format, value);
  if (!int32(min) || !int32(max) || !int32(step) || !step)
    throw new LoaderError(F, 'syntax', `bad data file pattern "${value.slice(0, 64)}"`);
  if ((max - min) / step < 0 || (max - min) / step > 1_000_000)
    throw new LoaderError(F, 'range', `data file pattern "${value.slice(0, 64)}" names no files or too many`);
  const files: string[] = [];
  for (let i = min; step > 0 ? i <= max : i >= max; i += step) files.push(before + printf(spec, i) + after);
  return { files, subdim };
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

function sample(word: string, floating: boolean): number {
  if (floating) return float(word);
  const value = Number(word);
  if (Number.isSafeInteger(value)) return value;
  throw new LoaderError(F, 'syntax', `invalid sample "${word.slice(0, 32)}"`);
}

function readText(text: string, out: NRRDData, offset: number, count: number, floating: boolean): void {
  const token = /[^\s,]+/g;
  let i = 0;
  for (let match = token.exec(text); match && i < count; match = token.exec(text), i++)
    out[offset + i] = sample(match[0], floating);
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

const u32le = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/**
 * The first `size` bytes of gzip data. Each member (RFC 1952 2.2) is framed here and its DEFLATE data inflated a step
 * at a time, stopping once `size` bytes are out: the rest of the stream, and anything after the last member, is ignored
 * (section 5, "Data file contents remaining after all data has been read should be ignored"), and a small file cannot
 * inflate to more than it needs. The runtime's 'gzip' decoder is not used: it refuses bytes after the last member and
 * can drop the output of the step that holds them, so a valid stream followed by other data would not read.
 */
async function gunzip(body: Uint8Array, size: number, signal?: AbortSignal): Promise<Uint8Array> {
  if (typeof DecompressionStream !== 'function')
    throw new LoaderError(F, 'unsupported', 'DecompressionStream is not available in this runtime');
  const out = new Uint8Array(size),
    corrupt = (detail: string) => new LoaderError(F, 'zip', `the data has corrupt gzip data (${detail})`);
  let at = 0,
    length = 0;
  while (length < size) {
    // After the first member, anything that is not another member is data past the stream, ignored.
    if (at > 0 && (at + 1 >= body.length || body[at] !== 0x1f || body[at + 1] !== 0x8b)) break;
    if (body[at] !== 0x1f || body[at + 1] !== 0x8b) throw corrupt('no gzip header');
    const flags = body[at + 3];
    if (body[at + 2] !== 8 || flags & 0xe0) throw corrupt('the method is not deflate or reserved flags are set');
    let p = at + 10;
    // FEXTRA (its length, then the field), FNAME and FCOMMENT (each up to a NUL), then FHCRC.
    if (flags & 4) p += 2 + (body[p] | (body[p + 1] << 8));
    for (const flag of [8, 16]) {
      if (!(flags & flag)) continue;
      while (p < body.length && body[p] !== 0) p++;
      p++;
    }
    if (flags & 2) {
      if ((crc32(body.subarray(at, p)) & 0xffff) !== (body[p] | (body[p + 1] << 8))) throw corrupt('the header fails its CRC-16');
      p += 2;
    }
    if (p >= body.length) throw corrupt('the stream ends early');
    const from = length;
    length = await inflateMember(body.subarray(p), out, length, signal);
    if (length >= size) break;
    // The member ended before the samples did: find its trailer, the CRC-32 and size of what it gave.
    const crc = crc32(out.subarray(from, length)),
      isize = (length - from) % 2 ** 32;
    let end = p;
    while (end + 8 <= body.length && !(u32le(body, end) === crc && u32le(body, end + 4) === isize)) end++;
    if (end + 8 > body.length) throw corrupt('a member has no matching CRC-32 and size trailer');
    at = end + 8;
  }
  return out.subarray(0, length);
}

/**
 * Inflates the DEFLATE data at the start of `data` into `out` from `length`, until `out` is full or the stream ends,
 * and returns the new length. Bytes after the end of the stream (the gzip trailer, what follows) make the decoder
 * fail once its output is given; the caller's trailer check tells that apart from damaged data.
 */
async function inflateMember(data: Uint8Array, out: Uint8Array, length: number, signal?: AbortSignal): Promise<number> {
  let fed = 0;
  const input = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (fed >= data.length) controller.close();
        else controller.enqueue(data.subarray(fed, (fed += FEED)));
      },
    },
    { highWaterMark: 0 },
  );
  const reader = input
    .pipeThrough(new DecompressionStream('deflate-raw') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>)
    .getReader();
  try {
    while (length < out.length) {
      throwIfAborted(signal, F);
      const { done, value } = await reader.read();
      if (done) break;
      const take = Math.min(value.length, out.length - length);
      out.set(value.subarray(0, take), length);
      length += take;
    }
  } catch (error) {
    if (error instanceof LoaderError) throw error;
  } finally {
    void reader.cancel().catch(() => {});
  }
  return length;
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
  // With byte skip -1 the data is found from the end of the file, so line skip is moot (section 5).
  let body = file.subarray(byteSkip === -1 ? 0 : skipLines(file, how.lineSkip));
  if (encoding === 'ascii') {
    readText(latin1(body, byteSkip), out, offset, count, type === 'float32' || type === 'float64');
    return;
  }
  let raw: Uint8Array<ArrayBuffer>;
  if (encoding === 'hex') raw = readHex(latin1(body, byteSkip), length);
  else {
    if (encoding === 'gzip') body = await gunzip(body, length + byteSkip, how.signal);
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
    named = fields.space === undefined ? undefined : SPACES[fields.space.toLowerCase()];
  if (fields.space !== undefined && !named)
    throw new LoaderError(F, 'header', `unknown space "${fields.space.slice(0, 32)}"`);
  const space = named?.[0];
  if (space && fields['space dimension'] !== undefined)
    throw new LoaderError(F, 'syntax', 'a file gives space or space dimension, never both');
  const spaceDimension = integer(fields['space dimension'], 'space dimension', named ? named[1] : 0);
  if (spaceDimension < 0 || spaceDimension > MAX_DIMENSION)
    throw new LoaderError(F, 'range', `space dimension ${spaceDimension} is out of range`);
  let directions: (number[] | null)[] | undefined;
  if (fields['space directions'] !== undefined) {
    if (!spaceDimension) throw new LoaderError(F, 'syntax', 'space directions need a space');
    directions = vectors(fields['space directions'], 'space directions', spaceDimension);
    if (directions.length !== dimension)
      throw new LoaderError(F, 'syntax', `space directions has ${directions.length} entries for ${dimension} axes`);
  }
  const kinds = fields.kinds?.trim().toLowerCase().split(/[ \t]+/);
  if (kinds && kinds.length !== dimension)
    throw new LoaderError(F, 'syntax', `kinds has ${kinds.length} entries for ${dimension} axes`);
  kinds?.forEach((kind, axis) => {
    const size = KINDS[kind];
    if (size === undefined) throw new LoaderError(F, 'syntax', `unknown kind "${kind.slice(0, 32)}"`);
    if (size && sizes[axis] !== size)
      throw new LoaderError(F, 'range', `axis ${axis} of kind ${kind} has size ${sizes[axis]}, not ${size}`);
  });
  // A space direction and a known spacing, axis min or axis max on the same axis exclude each other (section 4).
  const spacings = fields.spacings === undefined ? undefined : doubles(fields.spacings, 'spacings', dimension);
  if (spacings?.includes(0)) throw new LoaderError(F, 'range', 'spacings holds a zero');
  for (const name of ['spacings', 'axis mins', 'axis maxs']) {
    const values =
      name === 'spacings' ? spacings : fields[name] === undefined ? undefined : doubles(fields[name], name, dimension);
    const axis = values?.findIndex((value, i) => !Number.isNaN(value) && directions?.[i]) ?? -1;
    if (axis >= 0) throw new LoaderError(F, 'syntax', `axis ${axis} has both a space direction and ${name}`);
  }
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

  let origin: number[] | null = null;
  if (fields['space origin'] !== undefined) {
    const found = vectors(fields['space origin'], 'space origin', spaceDimension);
    if (found.length !== 1 || !found[0]) throw new LoaderError(F, 'syntax', 'space origin must be one vector');
    origin = found[0];
  }
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
      usable = step !== undefined && !Number.isNaN(step);
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
 * raw, ascii, hex, gzip and bzip2, with either byte order, `line skip` and `byte skip` (-1 for the end of a raw file)
 * and one or many data files (a printf pattern or a `LIST`, with `subdim`). Data past what the header needs is
 * ignored, and gzip decoding stops there. `space directions`, `space origin`, `spacings` and `kinds` set `dims`, `spacing`, `bounds` and
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
    { fields, known, meta } = header;
  const missing = ['type', 'dimension', 'sizes', 'encoding'].find((name) => !(name in known));
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
  const lineSkip = integer(known['line skip'], 'line skip', 0),
    byteSkip = integer(known['byte skip'], 'byte skip', 0);
  if (lineSkip < 0) throw new LoaderError(F, 'range', `line skip ${lineSkip} is negative`);
  if (byteSkip < -1 || (byteSkip === -1 && encoding !== 'raw'))
    throw new LoaderError(F, 'range', `byte skip ${byteSkip} is not allowed with ${encoding} data`);
  const placed = layout(known, sizes);

  const data = allocate(type, total),
    how: Encoded = {
      type,
      encoding,
      swapped: endian !== undefined && (endian === 'little') !== LITTLE,
      lineSkip,
      byteSkip,
      signal,
    },
    { files, subdim } = dataFiles(header, dimension);
  if (!files.length) await decode(bytes.subarray(header.end), data, 0, total, how);
  else {
    if (!resolve)
      throw new LoaderError(F, 'unsupported', `the data is in "${files[0].slice(0, 64)}"; pass a resolve option`);
    // Each file holds the first `subdim` axes and the axes after them count the files; with subdim equal to the
    // dimension the files are equal slabs cut along the slowest axis (section 3).
    let expected = 1;
    for (let axis = subdim; axis < dimension; axis++) expected *= sizes[axis];
    const fits = subdim === dimension ? sizes[dimension - 1] % files.length === 0 : files.length === expected;
    if (!fits)
      throw new LoaderError(
        F,
        'range',
        `${files.length} data files do not fit sizes ${sizes.join(' ')} with subdim ${subdim}`,
      );
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
