// Medical and array volume formats read into the grid `fig.volume()` takes:
// - NIfTI-1 and NIfTI-2 (`.nii`, `.nii.gz`, and `.hdr` with `.img`): the NIfTI Data Format Working Group's header
//   definitions (nifti1.h and nifti2.h documentation): dims, datatype, pixdim, vox_offset, scaling, qform and sform.
// - DICOM (PS3.10 files, PS3.5 data encoding): implicit and explicit VR little endian, explicit VR big endian and
//   deflated explicit VR little endian, uncompressed pixel data (integer, float and double float), Bits Stored and High
//   Bit, the Modality LUT (PS3.3 C.11.1), and series stacked by position along the slice normal (PS3.3 C.7.6.2, Image
//   Plane Module) or by time (Frame Increment Pointer, C.7.6.6). Compressed pixel data (JPEG, JPEG 2000, RLE and the
//   rest) is refused.
// - Zarr v2 and v3 arrays over HTTP or any key store: regular chunks, C and F order, the bytes, gzip, zlib, crc32c and
//   transpose codecs, and missing chunks as the fill value (Zarr storage specification 2 and 3.1).
// gzip (RFC 1952, every member), zlib (RFC 1950) and raw DEFLATE (RFC 1951) go through the shared inflater's raw entry,
// which reports where a stream ends: the pad byte after a deflated DICOM data set and the next member of a gzip file.
import { crc32 } from '../../shared/crc32.js';
import { inflateRaw } from '../../shared/inflate.js';
import { fault, rangeError, typeError } from '../../shared/errors.js';
import type { Bounds } from './layer.js';
import type { Figure } from './figure.js';
import type { VolumeLayer, VolumeLayerOptions } from './volume.js';

/** Samples of a grid, in the file's own type where one exists. */
export type GridData =
  | Int8Array
  | Uint8Array
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | Float32Array
  | Float64Array;

/** One scalar grid, in the shape `fig.volume()`, `fig.isosurface()` and slices take. */
export interface VolumeGrid {
  /** `nx * ny * nz` samples, x fastest. */
  readonly data: GridData;
  readonly dims: [number, number, number];
  /** Box in the file's true proportions, from 0. */
  readonly bounds: Bounds;
  /** Smallest and largest finite sample; `[0, 0]` when no sample is finite. */
  readonly range: [number, number];
}

/** A volume read from a file: the grid plus where it sits. */
export interface FormatVolume extends VolumeGrid {
  /** Samples of every frame and component, `((t * nz + z) * ny + y) * nx + x) * components + c`. */
  readonly all: GridData;
  /** Samples per voxel (3 for RGB). */
  readonly components: number;
  /** Volumes in the file (time steps). */
  readonly frames: number;
  /** Distance between samples along x, y and z, in the file's units (millimetres for NIfTI and DICOM). */
  readonly spacing: [number, number, number];
  /** Column-major 4x4 from voxel index (i, j, k) to world or patient coordinates. */
  readonly matrix: Float64Array;
}

const DEFAULT_MAX = 2 ** 29;

// ------------------------------------------------------------------------------------------------------------ inflate

const damaged = (what: string, detail: string) => rangeError(`damaged ${what} data: ${detail}`, 'sciviz');

const u32le = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/** Every member of a gzip file (RFC 1952 2.2: members follow each other with nothing before, between or after). */
function gunzip(input: Uint8Array, max: number): Uint8Array {
  const members: Uint8Array[] = [];
  let at = 0,
    total = 0;
  do {
    if (input[at] !== 0x1f || input[at + 1] !== 0x8b)
      throw damaged('gzip', at ? 'bytes follow the last member' : 'no gzip header');
    if (input.length - at < 18) throw damaged('gzip', 'a member is shorter than its header and trailer');
    const flags = input[at + 3];
    if (input[at + 2] !== 8 || flags & 0xe0)
      throw damaged('gzip', 'the method is not deflate or reserved flags are set');
    let p = at + 10;
    // FEXTRA (its length, then the field), FNAME and FCOMMENT (each up to a NUL), then FHCRC.
    if (flags & 4) p += 2 + (input[p] | (input[p + 1] << 8));
    for (const flag of [8, 16]) {
      if (!(flags & flag)) continue;
      while (p < input.length && input[p] !== 0) p++;
      p++;
    }
    if (flags & 2) {
      if ((crc32(input.subarray(at, p)) & 0xffff) !== (input[p] | (input[p + 1] << 8)))
        throw damaged('gzip', 'the header fails its CRC-16');
      p += 2;
    }
    if (p >= input.length) throw damaged('gzip', 'the stream ends early');
    const { output, end } = inflateRaw(input, p, { limit: max - total });
    if (end + 8 > input.length) throw damaged('gzip', 'the stream ends early');
    if (crc32(output) !== u32le(input, end)) throw damaged('gzip', 'a member fails its CRC-32 check');
    if (output.length % 2 ** 32 !== u32le(input, end + 4))
      throw damaged('gzip', 'a member inflates to another size than its trailer gives');
    members.push(output);
    total += output.length;
    at = end + 8;
  } while (at < input.length);
  if (members.length === 1) return members[0];
  const joined = new Uint8Array(total);
  for (let i = 0, o = 0; i < members.length; o += members[i++].length) joined.set(members[i], o);
  return joined;
}

/** A zlib stream (RFC 1950): header, DEFLATE data, Adler-32 of the output, and nothing after. */
function unzlib(input: Uint8Array, max: number): Uint8Array {
  const method = input[0],
    flags = input[1];
  if (input.length < 6 || (method & 15) !== 8 || method >> 4 > 7 || ((method << 8) | flags) % 31 || flags & 0x20)
    throw damaged('zlib', 'the header is not deflate without a preset dictionary');
  const { output: bytes, end: p } = inflateRaw(input, 2, { limit: max });
  if (p + 4 !== input.length) throw damaged('zlib', 'the stream does not end at its Adler-32');
  let a = 1,
    b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  if ((b * 65536 + a) >>> 0 !== ((input[p] << 24) | (input[p + 1] << 16) | (input[p + 2] << 8) | input[p + 3]) >>> 0)
    throw damaged('zlib', 'the stream fails its Adler-32 check');
  return bytes;
}

const bytesOf = (input: ArrayBuffer | ArrayBufferView, what: string): Uint8Array => {
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw typeError(`${what} takes an ArrayBuffer or a typed array`, 'sciviz');
};

const isGzip = (b: Uint8Array) => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;

type Kind = 'int8' | 'uint8' | 'int16' | 'uint16' | 'int32' | 'uint32' | 'int64' | 'uint64' | 'float32' | 'float64';
const SIZE: Record<Kind, number> = {
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

/** Reads `count` samples of `kind` at `offset` in either byte order into a new array of the matching type. */
function samples(bytes: Uint8Array, offset: number, count: number, kind: Kind, little: boolean): GridData {
  const size = SIZE[kind];
  if (offset < 0 || offset + count * size > bytes.byteLength)
    throw rangeError(
      `the data holds ${Math.max(0, bytes.byteLength - offset)} bytes, the header declares ${count * size}`,
      'sciviz',
    );
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, count * size);
  switch (kind) {
    case 'int8':
      return new Int8Array(bytes.buffer.slice(bytes.byteOffset + offset, bytes.byteOffset + offset + count));
    case 'uint8':
      return bytes.slice(offset, offset + count);
    case 'int16': {
      const out = new Int16Array(count);
      for (let i = 0; i < count; i++) out[i] = view.getInt16(i * 2, little);
      return out;
    }
    case 'uint16': {
      const out = new Uint16Array(count);
      for (let i = 0; i < count; i++) out[i] = view.getUint16(i * 2, little);
      return out;
    }
    case 'int32': {
      const out = new Int32Array(count);
      for (let i = 0; i < count; i++) out[i] = view.getInt32(i * 4, little);
      return out;
    }
    case 'uint32': {
      const out = new Uint32Array(count);
      for (let i = 0; i < count; i++) out[i] = view.getUint32(i * 4, little);
      return out;
    }
    case 'int64': {
      const out = new Float64Array(count);
      for (let i = 0; i < count; i++) out[i] = Number(view.getBigInt64(i * 8, little));
      return out;
    }
    case 'uint64': {
      const out = new Float64Array(count);
      for (let i = 0; i < count; i++) out[i] = Number(view.getBigUint64(i * 8, little));
      return out;
    }
    case 'float32': {
      const out = new Float32Array(count);
      for (let i = 0; i < count; i++) out[i] = view.getFloat32(i * 4, little);
      return out;
    }
    case 'float64': {
      const out = new Float64Array(count);
      for (let i = 0; i < count; i++) out[i] = view.getFloat64(i * 8, little);
      return out;
    }
  }
}

function rangeOf(data: ArrayLike<number>): [number, number] {
  let min = Infinity,
    max = -Infinity;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    // NaN and the infinities are not finite samples; they would stretch or poison the colour range.
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return min <= max ? [min, max] : [0, 0];
}

/** Applies `value * slope + intercept` when it changes anything, into a `Float32Array` (`Float64Array` for doubles). */
function rescale(data: GridData, slope: number, intercept: number): GridData {
  if (!Number.isFinite(slope) || slope === 0 || (slope === 1 && intercept === 0) || !Number.isFinite(intercept))
    return data;
  const out = data instanceof Float64Array ? new Float64Array(data.length) : new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] * slope + intercept;
  return out;
}

function build(
  all: GridData,
  dims: [number, number, number],
  components: number,
  frames: number,
  spacing: [number, number, number],
  matrix: Float64Array,
): FormatVolume {
  const voxels = dims[0] * dims[1] * dims[2];
  let data: GridData = all;
  if (components > 1) {
    const out = new Float32Array(voxels);
    for (let v = 0; v < voxels; v++) out[v] = all[v * components];
    data = out;
  } else if (frames > 1) data = all.subarray(0, voxels) as GridData;
  const bounds: Bounds = [0, (dims[0] - 1) * spacing[0], 0, (dims[1] - 1) * spacing[1], 0, (dims[2] - 1) * spacing[2]];
  return { all, data, dims, bounds, range: rangeOf(data), components, frames, spacing, matrix };
}

/** Options shared by the readers. */
export interface FormatOptions {
  /** Maximum samples in one file. Default 536,870,912. */
  readonly maxSamples?: number;
  readonly signal?: AbortSignal;
}

// ---------------------------------------------------------------------------------------------------------------- NIfTI

// Datatype code: sample kind, samples per voxel and the bitpix the code requires (nifti1.h DT_* definitions).
const NIFTI_TYPES: Record<number, [Kind, number, number]> = {
  2: ['uint8', 1, 8],
  4: ['int16', 1, 16],
  8: ['int32', 1, 32],
  16: ['float32', 1, 32],
  64: ['float64', 1, 64],
  128: ['uint8', 3, 24],
  256: ['int8', 1, 8],
  512: ['uint16', 1, 16],
  768: ['uint32', 1, 32],
  1024: ['int64', 1, 64],
  1280: ['uint64', 1, 64],
  2304: ['uint8', 4, 32],
};

/** Options of {@link parseNIfTI}. */
export interface NIfTIOptions extends FormatOptions {
  /** Reads the `.img` of a `.hdr` pair, by the header's file name with `.img`. Default none. */
  readonly resolve?: (path: string) => Promise<Uint8Array>;
  /** The header's file name, for `resolve`. Default `'image.hdr'`. */
  readonly name?: string;
}

/** What {@link parseNIfTI} returns. */
export interface NIfTIVolume extends FormatVolume {
  readonly version: 1 | 2;
  /** NIfTI datatype code. */
  readonly datatype: number;
  /** `'sform'`, `'qform'` or `'pixdim'`: where `matrix` came from. */
  readonly transform: 'sform' | 'qform' | 'pixdim';
  /** The 80-character description. */
  readonly description: string;
  /** Spatial and time units, from `xyzt_units`. */
  readonly units: { readonly space: string; readonly time: string };
}

const SPACE_UNITS: Record<number, string> = { 0: 'unknown', 1: 'm', 2: 'mm', 3: 'um' };
const TIME_UNITS: Record<number, string> = {
  0: 'unknown',
  8: 's',
  16: 'ms',
  24: 'us',
  32: 'Hz',
  40: 'ppm',
  48: 'rad/s',
};

const text = (bytes: Uint8Array, start: number, length: number): string => {
  let s = '';
  for (let i = start; i < start + length && bytes[i]; i++) s += String.fromCharCode(bytes[i]);
  return s.trim();
};

/**
 * Reads a NIfTI-1 or NIfTI-2 image, gzipped or not, in either byte order. Scaled data (`scl_slope`) comes back as
 * `Float32Array` (RGB24 and RGBA32 are never scaled); `matrix` is the sform when set, else the qform, else the voxel
 * sizes. The magic must match the header size (`n+1` or `ni1` for 348 bytes, `n+2` or `ni2` for 540), end in NUL, and
 * for NIfTI-2 be followed by `0D 0A 1A 0A`; `bitpix` must match the datatype.
 */
export async function parseNIfTI(
  input: ArrayBuffer | ArrayBufferView,
  options: NIfTIOptions = {},
): Promise<NIfTIVolume> {
  options.signal?.throwIfAborted();
  const max = options.maxSamples ?? DEFAULT_MAX;
  let bytes = bytesOf(input, 'parseNIfTI');
  if (isGzip(bytes)) bytes = gunzip(bytes, max * 8 + (1 << 20));
  if (bytes.byteLength < 348) throw rangeError('NIfTI: shorter than a header', 'sciviz');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let little = true,
    size = view.getInt32(0, true);
  if (size !== 348 && size !== 540) {
    little = false;
    size = view.getInt32(0, false);
  }
  if (size !== 348 && size !== 540) throw rangeError('NIfTI: sizeof_hdr is neither 348 nor 540', 'sciviz');
  const v2 = size === 540;
  if (v2 && bytes.byteLength < 540) throw rangeError('NIfTI-2: shorter than a header', 'sciviz');
  const i16 = (o: number) => view.getInt16(o, little),
    i32 = (o: number) => view.getInt32(o, little),
    f32 = (o: number) => view.getFloat32(o, little),
    f64 = (o: number) => view.getFloat64(o, little),
    i64 = (o: number) => Number(view.getBigInt64(o, little));
  // nifti1.h: magic is "ni1\0" or "n+1\0" at byte 344; the NIfTI-2 documentation: "ni2\0" or "n+2\0" at byte 4,
  // then the signature 0D 0A 1A 0A that catches newline conversion in transfer.
  const at = v2 ? 4 : 344,
    magic = String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2]),
    allowed = v2 ? ['n+2', 'ni2'] : ['n+1', 'ni1'];
  if (!allowed.includes(magic) || bytes[at + 3] !== 0)
    throw rangeError(
      `NIfTI: magic ${JSON.stringify(String.fromCharCode(...bytes.subarray(at, at + 4)))} is not ${allowed.join(' or ')} with a NUL for a ${size} byte header`,
      'sciviz',
    );
  if (v2 && (bytes[8] !== 0x0d || bytes[9] !== 0x0a || bytes[10] !== 0x1a || bytes[11] !== 0x0a))
    throw rangeError(
      'NIfTI-2: the signature after the magic is not 0D 0A 1A 0A (the file went through a newline conversion)',
      'sciviz',
    );
  const dim: number[] = [],
    pixdim: number[] = [];
  for (let k = 0; k < 8; k++) {
    dim.push(v2 ? i64(16 + k * 8) : i16(40 + k * 2));
    pixdim.push(v2 ? f64(104 + k * 8) : f32(76 + k * 4));
  }
  const datatype = v2 ? i16(12) : i16(70);
  const type = NIFTI_TYPES[datatype];
  if (!type)
    throw fault('unsupported', `NIfTI: datatype ${datatype} is not read (complex and 128-bit types)`, 'sciviz');
  const bitpix = v2 ? i16(14) : i16(72);
  if (bitpix !== type[2])
    throw rangeError(`NIfTI: bitpix ${bitpix} does not match datatype ${datatype} (${type[2]} bits)`, 'sciviz');
  const rank = dim[0];
  if (!(rank >= 1 && rank <= 7)) throw rangeError(`NIfTI: dim[0] ${rank} is outside 1 to 7`, 'sciviz');
  const sizes = dim.slice(1, rank + 1);
  if (sizes.some((n) => !Number.isInteger(n) || n < 1)) throw rangeError(`NIfTI: dims ${sizes.join(' x ')}`, 'sciviz');
  const dims: [number, number, number] = [sizes[0] ?? 1, sizes[1] ?? 1, sizes[2] ?? 1];
  const frames = sizes.slice(3).reduce((a, b) => a * b, 1),
    [kind, components] = type,
    count = dims[0] * dims[1] * dims[2] * frames * components;
  if (count > max) throw rangeError(`NIfTI: ${count} samples is past maxSamples ${max}`, 'sciviz');
  const voxOffset = v2 ? i64(168) : f32(108),
    slope = v2 ? f64(176) : f32(112),
    intercept = v2 ? f64(184) : f32(116);
  if (!Number.isFinite(voxOffset)) throw rangeError('NIfTI: vox_offset is not a finite number', 'sciviz');
  let body = bytes,
    offset = Math.floor(voxOffset);
  if (magic === 'ni1' || magic === 'ni2') {
    if (!options.resolve) throw typeError('NIfTI: a .hdr header needs resolve to read its .img', 'sciviz');
    const name = (options.name ?? 'image.hdr').replace(/\.hdr(\.gz)?$/i, '.img$1');
    body = await options.resolve(name);
    offset = Math.max(0, offset);
    // The .img holds `offset` bytes before the image, so the inflated size is the two together.
    if (isGzip(body)) body = gunzip(body, offset + count * SIZE[kind]);
  } else offset = Math.max(offset, size + 4); // nifti1.h: a vox_offset below 352 (544 for NIfTI-2) means 352 (544)
  options.signal?.throwIfAborted();
  const raw = samples(body, offset, count, kind, little);
  // nifti1.h: "the scaling is to be ignored if datatype is DT_RGB24"; RGBA32 is colour bytes the same way.
  const all = datatype === 128 || datatype === 2304 ? raw : rescale(raw, slope, intercept);
  const spacing: [number, number, number] = [
    Math.abs(pixdim[1]) || 1,
    Math.abs(pixdim[2]) || 1,
    Math.abs(pixdim[3]) || 1,
  ];
  const qformCode = v2 ? i32(344) : i16(252),
    sformCode = v2 ? i32(348) : i16(254);
  const matrix = new Float64Array(16);
  let transform: NIfTIVolume['transform'] = 'pixdim';
  if (sformCode > 0) {
    transform = 'sform';
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 4; c++) matrix[c * 4 + r] = v2 ? f64(400 + r * 32 + c * 8) : f32(280 + r * 16 + c * 4);
    matrix[15] = 1;
  } else if (qformCode > 0) {
    transform = 'qform';
    const [b, c, d] = v2 ? [f64(352), f64(360), f64(368)] : [f32(256), f32(260), f32(264)];
    const offsetXYZ = v2 ? [f64(376), f64(384), f64(392)] : [f32(268), f32(272), f32(276)];
    const a = Math.sqrt(Math.max(0, 1 - (b * b + c * c + d * d)));
    const R = [
      [a * a + b * b - c * c - d * d, 2 * (b * c - a * d), 2 * (b * d + a * c)],
      [2 * (b * c + a * d), a * a + c * c - b * b - d * d, 2 * (c * d - a * b)],
      [2 * (b * d - a * c), 2 * (c * d + a * b), a * a + d * d - c * c - b * b],
    ];
    const qfac = pixdim[0] < 0 ? -1 : 1,
      steps = [spacing[0], spacing[1], spacing[2] * qfac];
    for (let r = 0; r < 3; r++) {
      for (let col = 0; col < 3; col++) matrix[col * 4 + r] = R[r][col] * steps[col];
      matrix[12 + r] = offsetXYZ[r];
    }
    matrix[15] = 1;
  } else {
    matrix[0] = spacing[0];
    matrix[5] = spacing[1];
    matrix[10] = spacing[2];
    matrix[15] = 1;
  }
  const units = v2 ? i32(500) : bytes[123];
  const volume = build(all, dims, components, frames, spacing, matrix);
  return {
    ...volume,
    version: v2 ? 2 : 1,
    datatype,
    transform,
    description: text(bytes, v2 ? 240 : 148, 80),
    units: { space: SPACE_UNITS[units & 7] ?? 'unknown', time: TIME_UNITS[units & 56] ?? 'unknown' },
  };
}

// ---------------------------------------------------------------------------------------------------------------- DICOM

/** One DICOM image (a slice, or a multi-frame stack). */
export interface DICOMImage {
  readonly rows: number;
  readonly columns: number;
  readonly frames: number;
  /** Samples per pixel in `data` (3 for colour; a YBR_FULL_422 image is expanded to 3 per pixel). */
  readonly samplesPerPixel: number;
  /**
   * Samples, frames after each other, rows of `columns`: the stored values (Bits Stored, sign-extended from High Bit
   * when signed) through the Modality LUT or `RescaleSlope` and `RescaleIntercept`. Float and double float pixel data
   * come back as `Float32Array` and `Float64Array`.
   */
  readonly data: GridData;
  /** Row spacing then column spacing in mm (`PixelSpacing`), `[1, 1]` when absent. */
  readonly pixelSpacing: [number, number];
  /** `ImagePositionPatient`, or undefined. */
  readonly position: [number, number, number] | undefined;
  /** `ImageOrientationPatient`: row then column direction cosines, or undefined. */
  readonly orientation: [number, number, number, number, number, number] | undefined;
  readonly sliceThickness: number | undefined;
  /** `SpacingBetweenSlices` (0018,0088), or undefined. */
  readonly spacingBetweenSlices: number | undefined;
  readonly instanceNumber: number | undefined;
  readonly seriesUID: string | undefined;
  readonly modality: string | undefined;
  readonly photometric: string;
  readonly transferSyntax: string;
  /** The tags `FrameIncrementPointer` (0028,0009) names, `ggggeeee`; empty when absent. */
  readonly frameIncrementPointer: readonly string[];
  /** Every top-level element read as text or numbers, keyed `ggggeeee` in upper-case hex. */
  readonly elements: Readonly<Record<string, string | number[]>>;
}

// Explicit VR elements with these VRs have a 16-bit length; every other VR, one a later edition adds included, has two
// reserved bytes and a 32-bit length (PS3.5 7.1.2).
const SHORT_VR = new Set([
  'AE',
  'AS',
  'AT',
  'CS',
  'DA',
  'DS',
  'DT',
  'FL',
  'FD',
  'IS',
  'LO',
  'LT',
  'PN',
  'SH',
  'SL',
  'SS',
  'ST',
  'TM',
  'UI',
  'UL',
  'US',
]);
// The VRs of the elements this reader uses, for implicit VR data and elements sent as UN (PS3.6 data dictionary).
const IMPLICIT: Record<string, string> = {
  '00020000': 'UL',
  '00020010': 'UI',
  '00080060': 'CS',
  '00180050': 'DS',
  '00180088': 'DS',
  '00181063': 'DS',
  '00181065': 'DS',
  '0020000E': 'UI',
  '00200013': 'IS',
  '00200032': 'DS',
  '00200037': 'DS',
  '00280002': 'US',
  '00280004': 'CS',
  '00280006': 'US',
  '00280008': 'IS',
  '00280009': 'AT',
  '00280010': 'US',
  '00280011': 'US',
  '00280030': 'DS',
  '00280100': 'US',
  '00280101': 'US',
  '00280102': 'US',
  '00280103': 'US',
  '00281050': 'DS',
  '00281051': 'DS',
  '00281052': 'DS',
  '00281053': 'DS',
  '00283000': 'SQ',
  '00283002': 'US',
  '00283004': 'LO',
  '00283006': 'US',
  '7FE00008': 'OF',
  '7FE00009': 'OD',
  '7FE00010': 'OW',
};
const TEXT_VR = new Set([
  'AE',
  'AS',
  'CS',
  'DA',
  'DS',
  'DT',
  'IS',
  'LO',
  'LT',
  'PN',
  'SH',
  'ST',
  'TM',
  'UC',
  'UI',
  'UR',
  'UT',
]);
const NUMERIC_TEXT = new Set(['DS', 'IS']);
const PIXEL_TAGS = new Set(['7FE00010', '7FE00008', '7FE00009']);
const UNDEFINED = 0xffffffff;

type Elements = Record<string, string | number[]>;

interface Cursor {
  view: DataView;
  bytes: Uint8Array;
  at: number;
  little: boolean;
  explicit: boolean;
}

interface Pixels {
  tag: string;
  at: number;
  length: number;
  vr: string;
  little: boolean;
}

/** Where {@link readElement} puts what it reads. */
interface Into {
  readonly elements?: Elements;
  readonly pixels?: Pixels;
  /** Items of the Modality LUT Sequence. */
  readonly items?: Record<string, Elements[]>;
}

const hex = (g: number, e: number) =>
  g.toString(16).toUpperCase().padStart(4, '0') + e.toString(16).toUpperCase().padStart(4, '0');

/** Runs `step` on `c`, or on an implicit VR little endian copy of it when `implicit` (PS3.5 6.2.2, UN values). */
function inMode<T>(c: Cursor, implicit: boolean, step: (c: Cursor) => T): T {
  if (!implicit || !c.explicit) return step(c);
  const inner = { ...c, little: true, explicit: false },
    result = step(inner);
  c.at = inner.at;
  return result;
}

/** Skips one item or a sequence's items of undefined length, up to its delimiter. */
function skipUndefined(c: Cursor, delimiter: number): void {
  while (c.at + 8 <= c.bytes.byteLength) {
    const g = c.view.getUint16(c.at, c.little),
      e = c.view.getUint16(c.at + 2, c.little);
    if (g === 0xfffe) {
      const length = c.view.getUint32(c.at + 4, c.little);
      c.at += 8;
      if (e === delimiter) return;
      if (e === 0xe000) {
        if (length === UNDEFINED) skipUndefined(c, 0xe00d);
        else c.at += length;
      }
      continue;
    }
    readElement(c, {});
  }
  throw rangeError('DICOM: a sequence or item has no delimiter', 'sciviz');
}

/** The items of a sequence whose value starts at the cursor, each read as elements. */
function readItems(c: Cursor, length: number): Elements[] {
  const end = length === UNDEFINED ? Infinity : c.at + length,
    items: Elements[] = [];
  if (end > c.bytes.byteLength && end !== Infinity) throw rangeError('DICOM: a sequence runs past the end', 'sciviz');
  while (c.at < end) {
    if (c.at + 8 > c.bytes.byteLength) throw rangeError('DICOM: a sequence or item has no delimiter', 'sciviz');
    const g = c.view.getUint16(c.at, c.little),
      e = c.view.getUint16(c.at + 2, c.little),
      itemLength = c.view.getUint32(c.at + 4, c.little);
    c.at += 8;
    if (g === 0xfffe && e === 0xe0dd) break;
    if (g !== 0xfffe || e !== 0xe000) throw rangeError('DICOM: a sequence holds something other than items', 'sciviz');
    const item: Elements = Object.create(null),
      itemEnd = itemLength === UNDEFINED ? Infinity : c.at + itemLength;
    items.push(item);
    while (c.at < itemEnd) {
      if (
        itemEnd === Infinity &&
        c.at + 8 <= c.bytes.byteLength &&
        c.view.getUint16(c.at, c.little) === 0xfffe &&
        c.view.getUint16(c.at + 2, c.little) === 0xe00d
      ) {
        c.at += 8;
        break;
      }
      readElement(c, { elements: item });
    }
    if (itemEnd !== Infinity && c.at !== itemEnd)
      throw rangeError('DICOM: the elements of an item overrun its length', 'sciviz');
  }
  return items;
}

const numbersOf = (s: string): number[] =>
  s === '' ? [] : s.split('\\').map((v) => (v.trim() === '' ? NaN : Number(v)));

/** Reads one element at the cursor into `into`. Returns its tag. */
function readElement(c: Cursor, into: Into): string {
  const { view } = c;
  if (c.at + 8 > c.bytes.byteLength) throw rangeError('DICOM: an element runs past the end', 'sciviz');
  const g = view.getUint16(c.at, c.little),
    e = view.getUint16(c.at + 2, c.little),
    tag = hex(g, e);
  let vr: string,
    length: number,
    little = c.little,
    implicit = !c.explicit;
  // Items and delimiters have no VR.
  if (c.explicit && g !== 0xfffe) {
    vr = String.fromCharCode(c.bytes[c.at + 4], c.bytes[c.at + 5]);
    if (SHORT_VR.has(vr)) {
      length = view.getUint16(c.at + 6, c.little);
      c.at += 8;
    } else {
      if (c.at + 12 > c.bytes.byteLength) throw rangeError('DICOM: an element runs past the end', 'sciviz');
      length = view.getUint32(c.at + 8, c.little);
      c.at += 12;
    }
    if (vr === 'UN') {
      // PS3.5 6.2.2: a UN value is implicit VR little endian whatever the transfer syntax, so a known tag sent as UN
      // reads as its dictionary VR, little endian.
      vr = IMPLICIT[tag] ?? 'UN';
      little = true;
      implicit = true;
    }
  } else {
    vr = IMPLICIT[tag] ?? (g === 0xfffe ? '' : 'UN');
    length = view.getUint32(c.at + 4, c.little);
    c.at += 8;
  }
  if (PIXEL_TAGS.has(tag) && into.pixels) {
    Object.assign(into.pixels, { tag, at: c.at, length, vr, little });
    if (length === UNDEFINED) inMode(c, implicit, (inner) => skipUndefined(inner, 0xe0dd));
    else c.at += length;
    return tag;
  }
  if (vr === 'SQ' && tag === '00283000' && into.items) {
    into.items[tag] = inMode(c, implicit, (inner) => readItems(inner, length));
    return tag;
  }
  if (length === UNDEFINED) {
    // A sequence, or an element of unknown VR, of undefined length.
    inMode(c, implicit, (inner) => skipUndefined(inner, 0xe0dd));
    return tag;
  }
  if (c.at + length > c.bytes.byteLength) throw rangeError(`DICOM: element ${tag} runs past the end`, 'sciviz');
  const elements = into.elements;
  if (elements && vr !== 'SQ') {
    if (TEXT_VR.has(vr)) {
      let s = '';
      for (let i = 0; i < length; i++) s += String.fromCharCode(c.bytes[c.at + i]);
      s = s.replace(/[\0 ]+$/, '').trim();
      // An empty DS or IS is no value, and an empty entry of a list is not 0.
      elements[tag] = NUMERIC_TEXT.has(vr) ? numbersOf(s) : s;
    } else if (['US', 'SS', 'UL', 'SL', 'FL', 'FD', 'AT'].includes(vr) || (vr === 'OW' && tag === '00283006')) {
      const size = vr === 'US' || vr === 'SS' || vr === 'OW' ? 2 : vr === 'FD' ? 8 : 4,
        values: number[] = [];
      for (let i = 0; i + size <= length; i += size) {
        const o = c.at + i;
        values.push(
          vr === 'US' || vr === 'OW'
            ? view.getUint16(o, little)
            : vr === 'SS'
              ? view.getInt16(o, little)
              : vr === 'UL'
                ? view.getUint32(o, little)
                : vr === 'SL'
                  ? view.getInt32(o, little)
                  : vr === 'FL'
                    ? view.getFloat32(o, little)
                    : vr === 'FD'
                      ? view.getFloat64(o, little)
                      : view.getUint16(o, little) * 65536 + view.getUint16(o + 2, little),
        );
      }
      elements[tag] = values;
    }
  }
  c.at += length;
  return tag;
}

/** The File Meta Information (PS3.10 7.1): explicit VR little endian, as long as (0002,0000) says. */
function readMeta(c: Cursor, elements: Elements): void {
  const { view, bytes } = c;
  if (c.at + 12 <= bytes.byteLength && view.getUint16(c.at, true) === 0x0002 && view.getUint16(c.at + 2, true) === 0) {
    readElement(c, { elements });
    const length = (elements['00020000'] as number[] | undefined)?.[0] ?? NaN,
      end = c.at + length;
    if (!Number.isInteger(length) || end > bytes.byteLength)
      throw rangeError('DICOM: the File Meta Information Group Length (0002,0000) runs past the end', 'sciviz');
    while (c.at < end) readElement(c, { elements });
    if (c.at !== end)
      throw rangeError('DICOM: the file meta elements overrun the File Meta Information Group Length', 'sciviz');
  } else {
    // Without (0002,0000), a Type 1 element some writers leave out, the group ends where the group number changes.
    while (c.at + 4 <= bytes.byteLength && view.getUint16(c.at, true) === 0x0002) readElement(c, { elements });
  }
}

/** Keeps the Bits Stored bits ending at High Bit, sign-extended when signed (PS3.5 8.1.1). */
function storedValues(data: GridData, allocated: number, stored: number, shift: number, signed: boolean): GridData {
  const out = new (data.constructor as new (n: number) => GridData)(data.length),
    cell = 2 ** allocated,
    range = 2 ** stored,
    step = 2 ** shift;
  for (let i = 0; i < data.length; i++) {
    let v = data[i];
    if (v < 0) v += cell;
    v = Math.floor(v / step) % range;
    out[i] = signed && v >= range / 2 ? v - range : v;
  }
  return out;
}

/** Maps stored values through the one item of a Modality LUT Sequence (PS3.3 C.11.1.1.1). */
function modalityLUT(items: Elements[], data: GridData, signed: boolean): GridData {
  if (items.length !== 1) throw rangeError('DICOM: a Modality LUT Sequence needs exactly one item', 'sciviz');
  const descriptor = items[0]['00283002'],
    table = items[0]['00283006'];
  if (!Array.isArray(descriptor) || descriptor.length !== 3 || !Array.isArray(table))
    throw rangeError('DICOM: the Modality LUT needs a LUT Descriptor of three values and LUT Data', 'sciviz');
  // The first and third values are unsigned whatever the VR; the second takes the sign of Pixel Representation.
  const entries = descriptor[0] & 0xffff || 65536,
    bits = descriptor[2] & 0xffff;
  let first = descriptor[1] & 0xffff;
  if (signed && first >= 32768) first -= 65536;
  if (bits !== 8 && bits !== 16)
    throw rangeError(`DICOM: LUT Descriptor gives ${bits} bits per entry, not 8 or 16`, 'sciviz');
  let lut: ArrayLike<number> = table;
  if (bits === 8 && table.length !== entries) {
    // Eight-bit entries are packed two to a 16-bit word, low byte first (some writers put one in each word instead).
    if (table.length !== Math.ceil(entries / 2))
      throw rangeError('DICOM: LUT Data does not hold the entries its descriptor gives', 'sciviz');
    lut = Array.from({ length: entries }, (_, k) => (table[k >> 1] >> ((k & 1) * 8)) & 0xff);
  } else if (table.length !== entries)
    throw rangeError('DICOM: LUT Data does not hold the entries its descriptor gives', 'sciviz');
  const out = bits === 8 ? new Uint8Array(data.length) : new Uint16Array(data.length);
  for (let i = 0; i < data.length; i++) {
    // Values below the first mapped take the first entry; values past the last take the last.
    const k = data[i] - first;
    out[i] = lut[k <= 0 ? 0 : k >= entries ? entries - 1 : k] & (bits === 8 ? 0xff : 0xffff);
  }
  return out;
}

const SYNTAX = {
  implicit: '1.2.840.10008.1.2',
  explicit: '1.2.840.10008.1.2.1',
  deflated: '1.2.840.10008.1.2.1.99',
  big: '1.2.840.10008.1.2.2',
};

const isVR = (a: number, b: number) => a >= 65 && a <= 90 && b >= 65 && b <= 90;

/**
 * Reads one DICOM Part 10 file holding uncompressed pixel data: with the 128-byte preamble and `DICM`, with `DICM`
 * only, or starting at its File Meta Information. A bare data set with none of these has no transfer syntax, so it is
 * read as explicit VR little endian when its first element carries two capital letters where a VR goes, else as
 * implicit VR little endian. Rejects with code `unsupported` for a compressed transfer syntax, naming it.
 */
export async function parseDICOM(
  input: ArrayBuffer | ArrayBufferView,
  options: FormatOptions = {},
): Promise<DICOMImage> {
  options.signal?.throwIfAborted();
  let bytes = bytesOf(input, 'parseDICOM');
  const max = options.maxSamples ?? DEFAULT_MAX;
  let at = 0;
  const magic = (o: number) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  if (bytes.byteLength >= 132 && magic(128) === 'DICM') at = 132;
  else if (bytes.byteLength >= 4 && magic(0) === 'DICM') at = 4;
  const elements: Elements = Object.create(null);
  let c: Cursor = {
    view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    bytes,
    at,
    little: true,
    explicit: true,
  };
  let syntax: string;
  if (at > 0 || (bytes.byteLength >= 8 && c.view.getUint16(0, true) === 0x0002 && isVR(bytes[4], bytes[5]))) {
    readMeta(c, elements);
    const named = elements['00020010'];
    syntax = typeof named === 'string' && named ? named : SYNTAX.implicit;
  } else {
    c.explicit = isVR(bytes[4], bytes[5]);
    syntax = c.explicit ? SYNTAX.explicit : SYNTAX.implicit;
  }
  if (syntax === SYNTAX.deflated) {
    const start = c.at,
      { output, end } = inflateRaw(bytes, start, { limit: max * 8 + (1 << 20) }),
      rest = bytes.byteLength - end;
    // PS3.5 A.5: a deflate stream of odd length is followed by one NUL byte; nothing else may follow it.
    if (rest && !(rest === 1 && bytes[end] === 0 && (end - start) % 2 === 1))
      throw rangeError('DICOM: bytes follow the end of the deflated data set', 'sciviz');
    bytes = output;
    c = {
      view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      bytes,
      at: 0,
      little: true,
      explicit: true,
    };
  } else if (syntax === SYNTAX.implicit) c.explicit = false;
  else if (syntax === SYNTAX.explicit) c.explicit = true;
  else if (syntax === SYNTAX.big) {
    c.explicit = true;
    c.little = false;
  } else throw fault('unsupported', `DICOM: transfer syntax ${syntax} (compressed pixel data) is not read`, 'sciviz');
  const pixels: Pixels = { tag: '', at: -1, length: 0, vr: '', little: true },
    items: Record<string, Elements[]> = Object.create(null);
  while (c.at + 8 <= c.bytes.byteLength && pixels.at < 0) {
    options.signal?.throwIfAborted();
    readElement(c, { elements, pixels, items });
  }
  if (pixels.at < 0) throw rangeError('DICOM: the file has no pixel data', 'sciviz');
  if (pixels.length === UNDEFINED)
    throw rangeError('DICOM: encapsulated pixel data in an uncompressed syntax', 'sciviz');
  const num = (tag: string, fallback?: number): number | undefined => {
    const v = elements[tag];
    return Array.isArray(v) && Number.isFinite(v[0]) ? v[0] : fallback;
  };
  const list = (tag: string, n: number): number[] | undefined => {
    const v = elements[tag];
    return Array.isArray(v) && v.length >= n && v.slice(0, n).every(Number.isFinite) ? v.slice(0, n) : undefined;
  };
  const str = (tag: string) => (typeof elements[tag] === 'string' ? (elements[tag] as string) : undefined);
  const rows = num('00280010'),
    columns = num('00280011');
  if (!rows || !columns) throw rangeError('DICOM: Rows and Columns are missing', 'sciviz');
  const samplesPerPixel = num('00280002', 1)!,
    signed = num('00280103', 0) === 1,
    frames = num('00280008', 1)!,
    planar = num('00280006', 0)!,
    photometric = str('00280004') ?? 'MONOCHROME2';
  if (!Number.isInteger(frames) || frames < 1)
    throw rangeError(`DICOM: NumberOfFrames ${frames} is not a count`, 'sciviz');
  const floating = pixels.tag !== '7FE00010',
    bits = num('00280100', pixels.tag === '7FE00009' ? 64 : pixels.tag === '7FE00008' ? 32 : 16)!;
  let kind: Kind;
  if (pixels.tag === '7FE00008') {
    if (bits !== 32) throw rangeError('DICOM: Float Pixel Data needs BitsAllocated 32', 'sciviz');
    kind = 'float32';
  } else if (pixels.tag === '7FE00009') {
    if (bits !== 64) throw rangeError('DICOM: Double Float Pixel Data needs BitsAllocated 64', 'sciviz');
    kind = 'float64';
  } else if (bits === 8 || bits === 16 || bits === 32)
    kind =
      bits === 8
        ? signed
          ? 'int8'
          : 'uint8'
        : bits === 16
          ? signed
            ? 'int16'
            : 'uint16'
          : signed
            ? 'int32'
            : 'uint32';
  else throw fault('unsupported', `DICOM: BitsAllocated ${bits} is not read`, 'sciviz');
  const swapped = !pixels.little && pixels.vr === 'OW';
  // PS3.5 A.3 (2016b) has OW pixel data of more than 8 bits "encoded in Big Endian" but does not say whether a 32-bit
  // sample is one big endian value or two big endian 16-bit words, so such data is not guessed at.
  if (swapped && bits === 32)
    throw fault(
      'unsupported',
      'DICOM: 32-bit OW pixel data in explicit VR big endian is not read (PS3.5 A.3 leaves its word order open)',
      'sciviz',
    );
  if (photometric === 'YBR_PARTIAL_422' || photometric === 'YBR_PARTIAL_420')
    throw fault(
      'unsupported',
      `DICOM: photometric interpretation ${photometric} is not read in native pixel data`,
      'sciviz',
    );
  // PS3.3 C.7.6.3.1.2: YBR_FULL_422 stores two Y values then one CB and one CR, sited at the first of the two.
  const subsampled = photometric === 'YBR_FULL_422';
  if (subsampled && (samplesPerPixel !== 3 || planar !== 0))
    throw rangeError('DICOM: YBR_FULL_422 needs SamplesPerPixel 3 and PlanarConfiguration 0', 'sciviz');
  if (subsampled && columns % 2)
    throw fault('unsupported', 'DICOM: YBR_FULL_422 with an odd number of columns is not read', 'sciviz');
  const count = rows * columns * frames * samplesPerPixel,
    stored = subsampled ? rows * columns * frames * 2 : count;
  if (count > max) throw rangeError(`DICOM: ${count} samples is past maxSamples ${max}`, 'sciviz');
  let source = c.bytes,
    offset = pixels.at;
  if (swapped && bits === 8) {
    // PS3.5 A.3: 8-bit samples in OW are 16-bit words written big endian, so each pair of bytes is swapped.
    const n = stored + (stored & 1);
    if (offset + n > source.byteLength)
      throw rangeError(`the data holds ${source.byteLength - offset} bytes, the header declares ${n}`, 'sciviz');
    const words = new Uint8Array(n);
    for (let i = 0; i < n; i++) words[i] = source[offset + (i ^ 1)];
    source = words;
    offset = 0;
  }
  let data = samples(source, offset, stored, kind, pixels.little);
  if (!floating) {
    const bitsStored = num('00280101', bits)!,
      highBit = num('00280102', bitsStored - 1)!;
    if (
      !(
        Number.isInteger(bitsStored) &&
        Number.isInteger(highBit) &&
        bitsStored >= 1 &&
        highBit >= bitsStored - 1 &&
        highBit < bits
      )
    )
      throw rangeError(
        `DICOM: BitsStored ${bitsStored} and HighBit ${highBit} do not fit BitsAllocated ${bits}`,
        'sciviz',
      );
    if (bitsStored < bits) data = storedValues(data, bits, bitsStored, highBit - bitsStored + 1, signed);
  }
  // Planar configuration 1 stores each colour plane in turn; interleave it.
  if (samplesPerPixel > 1 && planar === 1) {
    const out = new (data.constructor as new (n: number) => GridData)(count),
      plane = rows * columns;
    for (let f = 0; f < frames; f++)
      for (let s = 0; s < samplesPerPixel; s++)
        for (let p = 0; p < plane; p++)
          out[(f * plane + p) * samplesPerPixel + s] = data[(f * samplesPerPixel + s) * plane + p];
    data = out;
  }
  if (subsampled) {
    const out = new (data.constructor as new (n: number) => GridData)(count);
    for (let p = 0, q = 0; p < stored; p += 4, q += 6) {
      out[q] = data[p];
      out[q + 3] = data[p + 1];
      out[q + 1] = out[q + 4] = data[p + 2];
      out[q + 2] = out[q + 5] = data[p + 3];
    }
    data = out;
  }
  const lut = items['00283000'];
  if (lut) {
    // PS3.3 C.11.1: a Modality LUT Sequence or Rescale Slope and Intercept, not both.
    if (elements['00281052'] !== undefined || elements['00281053'] !== undefined)
      throw rangeError('DICOM: the file has both a Modality LUT Sequence and Rescale Slope or Intercept', 'sciviz');
    data = modalityLUT(lut, data, signed);
  } else data = rescale(data, num('00281053', 1)!, num('00281052', 0)!);
  const spacing = list('00280030', 2),
    position = list('00200032', 3),
    orientation = list('00200037', 6),
    pointer = elements['00280009'];
  return {
    rows,
    columns,
    frames,
    samplesPerPixel,
    data,
    pixelSpacing: spacing ? [spacing[0], spacing[1]] : [1, 1],
    position: position as [number, number, number] | undefined,
    orientation: orientation as DICOMImage['orientation'],
    sliceThickness: num('00180050'),
    spacingBetweenSlices: num('00180088'),
    instanceNumber: num('00200013'),
    seriesUID: str('0020000E'),
    modality: str('00080060'),
    photometric,
    transferSyntax: syntax,
    frameIncrementPointer: Array.isArray(pointer) ? pointer.map((t) => hex(Math.floor(t / 65536), t % 65536)) : [],
    elements,
  };
}

// Frame Increment Pointer targets that make the frames of an image time steps: Frame Time and Frame Time Vector.
const TIME_POINTERS = new Set(['00181063', '00181065']);

/**
 * Stacks the slices of one DICOM series into a volume, ordered by position along the slice normal (instance number
 * when positions are missing), with the slice step from the positions, else `SpacingBetweenSlices`, else
 * `SliceThickness`. Multi-frame images whose Frame Increment Pointer names Frame Time or Frame Time Vector become the
 * time steps (`frames`) of each slice; other multi-frame images are refused with code `unsupported`, since their
 * frames are not known to lie in space. Throws when slices differ in size or series.
 */
export function dicomSeries(images: readonly DICOMImage[]): FormatVolume {
  if (!images.length) throw rangeError('dicomSeries needs at least one image', 'sciviz');
  const first = images[0];
  for (const image of images) {
    if (image.rows !== first.rows || image.columns !== first.columns || image.samplesPerPixel !== first.samplesPerPixel)
      throw rangeError('dicomSeries: the slices differ in size; pass the images of one series', 'sciviz');
    if (image.seriesUID !== first.seriesUID)
      throw rangeError('dicomSeries: the images come from more than one series (SeriesInstanceUID)', 'sciviz');
    if (
      image.frames > 1 &&
      !(image.frameIncrementPointer.length && image.frameIncrementPointer.every((t) => TIME_POINTERS.has(t)))
    )
      throw fault(
        'unsupported',
        `dicomSeries: frames ordered by ${image.frameIncrementPointer.join(', ') || 'no Frame Increment Pointer'} are not stacked; only time frames (Frame Time, Frame Time Vector) are`,
        'sciviz',
      );
    if (image.frames !== first.frames)
      throw rangeError('dicomSeries: the images differ in their number of frames', 'sciviz');
  }
  const o = first.orientation ?? [1, 0, 0, 0, 1, 0];
  const normal = [o[1] * o[5] - o[2] * o[4], o[2] * o[3] - o[0] * o[5], o[0] * o[4] - o[1] * o[3]];
  const along = (image: DICOMImage) =>
    image.position
      ? image.position[0] * normal[0] + image.position[1] * normal[1] + image.position[2] * normal[2]
      : NaN;
  const slices = images.map((image) => ({ image, key: along(image), order: image.instanceNumber ?? 0 }));
  const positioned = slices.every((s) => Number.isFinite(s.key));
  slices.sort((a, b) => (positioned ? a.key - b.key : a.order - b.order));
  const plane = first.rows * first.columns * first.samplesPerPixel,
    nz = slices.length,
    frames = first.frames;
  const floating = slices.some((s) => !(s.image.data instanceof first.data.constructor));
  const Type = (floating ? Float32Array : first.data.constructor) as new (n: number) => GridData;
  const all = new Type(plane * nz * frames);
  for (let t = 0; t < frames; t++)
    slices.forEach((s, k) => all.set(s.image.data.subarray(t * plane, (t + 1) * plane), (t * nz + k) * plane));
  let step = first.spacingBetweenSlices ?? first.sliceThickness ?? 1;
  if (positioned && nz > 1) {
    const gaps = slices
      .slice(1)
      .map((s, k) => s.key - slices[k].key)
      .sort((a, b) => a - b);
    step = gaps[gaps.length >> 1] || step;
  }
  const [rowSpacing, columnSpacing] = first.pixelSpacing;
  const spacing: [number, number, number] = [columnSpacing, rowSpacing, Math.abs(step) || 1];
  const origin = (positioned ? slices[0].image.position : first.position) ?? [0, 0, 0];
  const matrix = new Float64Array([
    o[0] * columnSpacing,
    o[1] * columnSpacing,
    o[2] * columnSpacing,
    0,
    o[3] * rowSpacing,
    o[4] * rowSpacing,
    o[5] * rowSpacing,
    0,
    normal[0] * spacing[2],
    normal[1] * spacing[2],
    normal[2] * spacing[2],
    0,
    origin[0],
    origin[1],
    origin[2],
    1,
  ]);
  return build(all, [first.columns, first.rows, nz], first.samplesPerPixel, frames, spacing, matrix);
}

/** Fetches DICOM files and stacks them as one series. */
export async function loadDICOMSeries(
  urls: readonly (string | URL)[],
  options: FormatOptions & { readonly init?: RequestInit } = {},
): Promise<FormatVolume> {
  const images = await Promise.all(
    urls.map(async (url) => parseDICOM(await fetchBytes(new URL(url, globalThis.location?.href), options), options)),
  );
  return dicomSeries(images);
}

async function fetchBytes(
  url: URL,
  options: { readonly init?: RequestInit; readonly signal?: AbortSignal },
): Promise<Uint8Array> {
  const response = await fetch(url, { ...options.init, signal: options.signal });
  if (!response.ok) throw rangeError(`fetch of ${url.href} answered ${response.status}`, 'sciviz');
  return new Uint8Array(await response.arrayBuffer());
}

/** Fetches a NIfTI file (`.nii`, `.nii.gz`, or a `.hdr` whose `.img` sits next to it) and reads it. */
export async function loadNIfTI(
  url: string | URL,
  options: FormatOptions & { readonly init?: RequestInit } = {},
): Promise<NIfTIVolume> {
  const where = new URL(url, globalThis.location?.href);
  return parseNIfTI(await fetchBytes(where, options), {
    ...options,
    name: where.pathname.split('/').pop(),
    resolve: (path) => fetchBytes(new URL(path, where), options),
  });
}

// ----------------------------------------------------------------------------------------------------------------- Zarr

/** A key-value store of a Zarr hierarchy: a base URL, an object of keys to bytes, or a function. */
export type ZarrStore =
  | string
  | URL
  | Readonly<Record<string, Uint8Array | string>>
  | ((key: string, signal?: AbortSignal) => Promise<Uint8Array | undefined>);

/** Options of {@link openZarr}. */
export interface ZarrOptions {
  /** Request options for every fetch of a URL store. */
  readonly init?: RequestInit;
  readonly signal?: AbortSignal;
}

/** An open Zarr array; read it, or a box of it, with `read`. */
export interface ZarrArray {
  readonly zarrFormat: 2 | 3;
  /** Size of every dimension, slowest first (C order). */
  readonly shape: readonly number[];
  readonly chunks: readonly number[];
  readonly dtype: Kind | 'bool';
  readonly fillValue: number;
  readonly attributes: Readonly<Record<string, unknown>>;
  /** Names of the dimensions, when the metadata gives them. */
  readonly dimensionNames: readonly (string | null)[] | undefined;
  /**
   * Reads the box from `start` (inclusive) to `stop` (exclusive), default the whole array, into a typed array in C
   * order. Missing chunks read as the fill value.
   */
  read(options?: {
    readonly start?: readonly number[];
    readonly stop?: readonly number[];
    readonly signal?: AbortSignal;
    readonly maxSamples?: number;
  }): Promise<{ data: GridData; shape: number[] }>;
}

const V2_KIND: Record<string, Kind | 'bool'> = {
  b1: 'bool',
  i1: 'int8',
  u1: 'uint8',
  i2: 'int16',
  u2: 'uint16',
  i4: 'int32',
  u4: 'uint32',
  i8: 'int64',
  u8: 'uint64',
  f4: 'float32',
  f8: 'float64',
};

// Integer data types' ranges (Zarr v3 core data types), for fill values.
const INTEGER_RANGE: Partial<Record<Kind, [number, number]>> = {
  int8: [-(2 ** 7), 2 ** 7 - 1],
  uint8: [0, 2 ** 8 - 1],
  int16: [-(2 ** 15), 2 ** 15 - 1],
  uint16: [0, 2 ** 16 - 1],
  int32: [-(2 ** 31), 2 ** 31 - 1],
  uint32: [0, 2 ** 32 - 1],
  int64: [-(2 ** 63), 2 ** 63 - 1],
  uint64: [0, 2 ** 64 - 1],
};

// CRC-32C (Castagnoli), reflected polynomial 0x82F63B78, as the Zarr v3 crc32c codec stores it (little endian).
let crcTable: Uint32Array | undefined;
function crc32c(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function storeReader(
  store: ZarrStore,
  options: ZarrOptions,
): (key: string, signal?: AbortSignal) => Promise<Uint8Array | undefined> {
  if (typeof store === 'function') return store;
  if (typeof store === 'string' || store instanceof URL) {
    const base = new URL(store, globalThis.location?.href);
    if (!base.pathname.endsWith('/')) base.pathname += '/';
    return async (key, signal) => {
      const response = await fetch(new URL(key, base), { ...options.init, signal: signal ?? options.signal });
      // Only "not found" is an absent key; a refusal (403) or a server error is a failed read, not the fill value.
      if (response.status === 404) return undefined;
      if (!response.ok) throw fault('failed', `Zarr: fetch of ${key} answered ${response.status}`, 'sciviz');
      return new Uint8Array(await response.arrayBuffer());
    };
  }
  if (store && typeof store === 'object') {
    const map = store as Record<string, Uint8Array | string>;
    return async (key) => {
      const value = Object.hasOwn(map, key) ? map[key] : undefined;
      return typeof value === 'string' ? new TextEncoder().encode(value) : value;
    };
  }
  throw typeError('openZarr takes a URL, an object of keys or a function', 'sciviz');
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

interface Extension {
  readonly name: string;
  readonly configuration: Record<string, unknown>;
  readonly mustUnderstand: boolean;
}

/** A v3 extension point's value: an object with a name and optional configuration, or a short-hand name (3.1). */
function extension(value: unknown, what: string): Extension {
  if (typeof value === 'string') return { name: value, configuration: {}, mustUnderstand: true };
  if (!isObject(value) || typeof value.name !== 'string')
    throw rangeError(`Zarr: ${what} is neither a name nor an object with a name`, 'sciviz');
  if (value.configuration !== undefined && !isObject(value.configuration))
    throw rangeError(`Zarr: the configuration of ${what} ${value.name} is not an object`, 'sciviz');
  if (value.must_understand !== undefined && typeof value.must_understand !== 'boolean')
    throw rangeError(`Zarr: must_understand of ${what} ${value.name} is not a boolean`, 'sciviz');
  return {
    name: value.name,
    configuration: (value.configuration as Record<string, unknown>) ?? {},
    mustUnderstand: value.must_understand !== false,
  };
}

const countsOf = (value: unknown, what: string, least: number): number[] => {
  if (!Array.isArray(value) || value.some((n) => !Number.isInteger(n) || n < least))
    throw rangeError(`Zarr: ${what} ${JSON.stringify(value)} is not a list of counts`, 'sciviz');
  return value as number[];
};

/** A fill value of `kind`, as the v3 data type definitions and the v2 fill value encoding allow it. */
function parseFill(value: unknown, kind: Kind | 'bool', v3: boolean): number {
  const bad = () => rangeError(`Zarr: fill_value ${JSON.stringify(value)} is not a ${kind}`, 'sciviz');
  if (value === null && !v3) return 0;
  if (kind === 'bool') {
    if (typeof value !== 'boolean') throw bad();
    return value ? 1 : 0;
  }
  const integers = INTEGER_RANGE[kind];
  if (integers) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < integers[0] || value > integers[1])
      throw bad();
    return value;
  }
  if (typeof value === 'number') return value;
  if (value === 'NaN') return NaN;
  if (value === 'Infinity') return Infinity;
  if (value === '-Infinity') return -Infinity;
  // v3: "0x" and the float's bytes as an unsigned integer, 8 hex digits for float32 and 16 for float64.
  if (v3 && typeof value === 'string' && (kind === 'float32' ? /^0x[0-9a-f]{8}$/i : /^0x[0-9a-f]{16}$/i).test(value)) {
    const view = new DataView(new ArrayBuffer(8));
    if (kind === 'float32') {
      view.setUint32(0, parseInt(value, 16));
      return view.getFloat32(0);
    }
    view.setBigUint64(0, BigInt(value));
    return view.getFloat64(0);
  }
  throw bad();
}

/** A store path's key prefix; v2 also turns backslashes into slashes (v2 "logical paths"). */
function prefixOf(path: string, v2: boolean): string {
  if (typeof path !== 'string') throw typeError('openZarr: path is not a string', 'sciviz');
  const segments = (v2 ? path.replace(/\\/g, '/') : path).split('/').filter(Boolean);
  if (segments.some((s) => s === '.' || s === '..'))
    throw rangeError(`Zarr: path ${JSON.stringify(path)} holds a "." or ".." segment`, 'sciviz');
  return segments.length ? `${segments.join('/')}/` : '';
}

const V3_FIELDS = new Set([
  'zarr_format',
  'node_type',
  'shape',
  'data_type',
  'chunk_grid',
  'chunk_key_encoding',
  'fill_value',
  'codecs',
  'attributes',
  'storage_transformers',
  'dimension_names',
]);
// v3 codecs this reader has, by kind: array to array, array to bytes, bytes to bytes.
const CODEC_KIND: Record<string, 'array' | 'bytes' | 'compress'> = {
  transpose: 'array',
  bytes: 'bytes',
  gzip: 'compress',
  crc32c: 'compress',
};

/**
 * Opens a Zarr v2 or v3 array at `path` in `store`. Rejects with code `unsupported` for a codec, chunk grid, chunk key
 * encoding, storage transformer or metadata field this reader has not (blosc, zstd, sharding and the rest), naming
 * it, and with a RangeError for metadata the specification does not allow.
 */
export async function openZarr(store: ZarrStore, path = '', options: ZarrOptions = {}): Promise<ZarrArray> {
  const get = storeReader(store, options),
    decoder = new TextDecoder();
  const json = async (key: string): Promise<Record<string, unknown> | undefined> => {
    const bytes = await get(key, options.signal);
    if (!bytes) return undefined;
    let value: unknown;
    try {
      value = JSON.parse(decoder.decode(bytes));
    } catch {
      throw rangeError(`Zarr: ${key} is not JSON`, 'sciviz');
    }
    if (!isObject(value)) throw rangeError(`Zarr: ${key} is not a JSON object`, 'sciviz');
    return value;
  };
  let prefix = prefixOf(path, false);
  const v2Prefix = prefixOf(path, true);
  const v3 = await json(`${prefix}zarr.json`);
  let shape: number[], chunks: number[], kind: Kind | 'bool', little: boolean, fill: number;
  let attributes: Record<string, unknown> = {};
  let names: (string | null)[] | undefined;
  let key: (index: number[]) => string;
  // Bytes to bytes decode steps, last codec first, each given the size its output may reach.
  const compressors: { name: string; mustUnderstand: boolean }[] = [];
  let order: number[] | undefined;
  if (v3) {
    if (v3.zarr_format !== 3)
      throw rangeError(`Zarr: ${prefix}zarr.json gives zarr_format ${JSON.stringify(v3.zarr_format)}, not 3`, 'sciviz');
    if (v3.node_type !== 'array')
      throw rangeError(`Zarr: ${prefix || '/'} is a ${String(v3.node_type)}, not an array`, 'sciviz');
    for (const field of Object.keys(v3))
      if (
        !V3_FIELDS.has(field) &&
        !(isObject(v3[field]) && (v3[field] as Record<string, unknown>).must_understand === false)
      )
        throw fault('unsupported', `Zarr: metadata field ${field} is not understood`, 'sciviz');
    shape = countsOf(v3.shape, 'shape', 0);
    const grid = extension(v3.chunk_grid, 'chunk_grid');
    if (grid.name !== 'regular') throw fault('unsupported', `Zarr: chunk grid ${grid.name} is not read`, 'sciviz');
    chunks = countsOf(grid.configuration.chunk_shape, 'chunk_shape', 1);
    const type = v3.data_type;
    if (typeof type !== 'string' || (type !== 'bool' && !Object.hasOwn(SIZE, type)))
      throw fault('unsupported', `Zarr: data type ${JSON.stringify(type)} is not read`, 'sciviz');
    kind = type as Kind | 'bool';
    const encoding = extension(v3.chunk_key_encoding, 'chunk_key_encoding');
    if (encoding.name !== 'default' && encoding.name !== 'v2')
      throw fault('unsupported', `Zarr: chunk key encoding ${encoding.name} is not read`, 'sciviz');
    const separator = encoding.configuration.separator ?? (encoding.name === 'v2' ? '.' : '/');
    if (separator !== '/' && separator !== '.')
      throw rangeError(`Zarr: chunk key separator ${JSON.stringify(separator)} is neither "/" nor "."`, 'sciviz');
    key =
      encoding.name === 'v2'
        ? (index) => (index.length ? index.join(separator) : '0')
        : (index) => ['c', ...index].join(separator);
    if (v3.storage_transformers !== undefined) {
      if (!Array.isArray(v3.storage_transformers))
        throw rangeError('Zarr: storage_transformers is not a list', 'sciviz');
      for (const transformer of v3.storage_transformers.map((t) => extension(t, 'a storage transformer')))
        if (transformer.mustUnderstand)
          throw fault('unsupported', `Zarr: storage transformer ${transformer.name} is not read`, 'sciviz');
    }
    if (!Array.isArray(v3.codecs) || !v3.codecs.length)
      throw rangeError('Zarr: codecs is not a list holding the bytes codec', 'sciviz');
    const codecs = v3.codecs
      .map((codec) => extension(codec, 'a codec'))
      .filter((codec) => {
        if (Object.hasOwn(CODEC_KIND, codec.name)) return true;
        // An extension marked must_understand false may be passed over (core "must_understand").
        if (!codec.mustUnderstand) return false;
        throw fault('unsupported', `Zarr: codec ${codec.name} is not read`, 'sciviz');
      });
    // Array to array codecs, then exactly one array to bytes codec, then bytes to bytes codecs (core "codecs").
    const middle = codecs.findIndex((codec) => codec.name === 'bytes');
    if (
      middle < 0 ||
      codecs.some(
        (codec, k) =>
          (CODEC_KIND[codec.name] === 'array') !== k < middle || (codec.name === 'bytes') !== (k === middle),
      )
    )
      throw rangeError(
        `Zarr: codecs ${codecs.map((codec) => codec.name).join(', ')} are not array to array codecs, one bytes codec, then bytes to bytes codecs`,
        'sciviz',
      );
    const endian = codecs[middle].configuration.endian;
    if (endian !== undefined && endian !== 'big' && endian !== 'little')
      throw rangeError(`Zarr: bytes endian ${JSON.stringify(endian)} is neither "big" nor "little"`, 'sciviz');
    if (endian === undefined && kind !== 'bool' && SIZE[kind] > 1)
      throw rangeError(`Zarr: the bytes codec needs endian for ${kind}`, 'sciviz');
    little = endian !== 'big';
    for (const codec of codecs.slice(0, middle)) {
      const step = codec.configuration.order;
      if (
        !Array.isArray(step) ||
        step.length !== shape.length ||
        [...step].sort((a, b) => a - b).some((v, k) => v !== k)
      )
        throw rangeError(
          `Zarr: transpose order ${JSON.stringify(step)} is not a permutation of ${shape.length} dimensions`,
          'sciviz',
        );
      // Chained transposes compose: B[i] = A[o1[i]], C[i] = B[o2[i]] = A[o1[o2[i]]].
      const previous = order;
      order = previous ? (step as number[]).map((d) => previous[d]) : [...(step as number[])];
    }
    compressors.push(...codecs.slice(middle + 1));
    fill = parseFill(v3.fill_value, kind, true);
    if (v3.attributes !== undefined && !isObject(v3.attributes))
      throw rangeError('Zarr: attributes is not an object', 'sciviz');
    attributes = (v3.attributes as Record<string, unknown>) ?? {};
    const dimensionNames = v3.dimension_names;
    if (
      dimensionNames !== undefined &&
      (!Array.isArray(dimensionNames) ||
        dimensionNames.length !== shape.length ||
        dimensionNames.some((n) => n !== null && typeof n !== 'string'))
    )
      throw rangeError(`Zarr: dimension_names is not a list of ${shape.length} names or nulls`, 'sciviz');
    names = dimensionNames as (string | null)[] | undefined;
  } else {
    prefix = v2Prefix;
    const meta = await json(`${prefix}.zarray`);
    if (!meta) throw rangeError(`Zarr: no array at ${prefix || '/'} (neither zarr.json nor .zarray)`, 'sciviz');
    if (meta.zarr_format !== 2)
      throw rangeError(`Zarr: ${prefix}.zarray gives zarr_format ${JSON.stringify(meta.zarr_format)}, not 2`, 'sciviz');
    for (const field of ['shape', 'chunks', 'dtype', 'compressor', 'fill_value', 'order', 'filters'])
      if (!Object.hasOwn(meta, field)) throw rangeError(`Zarr: ${prefix}.zarray has no ${field}`, 'sciviz');
    shape = countsOf(meta.shape, 'shape', 0);
    chunks = countsOf(meta.chunks, 'chunks', 1);
    const dtype = meta.dtype,
      parsed = typeof dtype === 'string' ? /^([<>|])([a-zA-Z])(\d+)$/.exec(dtype) : null;
    if (!parsed || !Object.hasOwn(V2_KIND, parsed[2] + parsed[3]))
      throw fault('unsupported', `Zarr: dtype ${JSON.stringify(dtype)} is not read`, 'sciviz');
    kind = V2_KIND[parsed[2] + parsed[3]];
    // "|" is the byte order of a type it does not apply to: one byte long.
    if (parsed[1] === '|' && Number(parsed[3]) !== 1)
      throw rangeError(`Zarr: dtype ${dtype} gives no byte order for a multi-byte type`, 'sciviz');
    little = parsed[1] !== '>';
    if (meta.order !== 'C' && meta.order !== 'F')
      throw rangeError(`Zarr: order ${JSON.stringify(meta.order)} is neither "C" nor "F"`, 'sciviz');
    if (meta.order === 'F') order = shape.map((_, k) => shape.length - 1 - k);
    if (meta.filters !== null && !Array.isArray(meta.filters))
      throw rangeError('Zarr: filters is neither null nor a list', 'sciviz');
    if (Array.isArray(meta.filters) && meta.filters.length)
      throw fault(
        'unsupported',
        `Zarr: filters ${meta.filters.map((f) => (isObject(f) ? String(f.id) : JSON.stringify(f))).join(', ')} are not read`,
        'sciviz',
      );
    const compressor = meta.compressor;
    if (compressor !== null) {
      if (!isObject(compressor) || typeof compressor.id !== 'string')
        throw rangeError('Zarr: compressor is neither null nor an object with an id', 'sciviz');
      if (compressor.id !== 'gzip' && compressor.id !== 'zlib')
        throw fault('unsupported', `Zarr: compressor ${compressor.id} is not read`, 'sciviz');
      compressors.push({ name: compressor.id, mustUnderstand: true });
    }
    const separator = meta.dimension_separator ?? '.';
    if (separator !== '/' && separator !== '.')
      throw rangeError(`Zarr: dimension_separator ${JSON.stringify(separator)} is neither "/" nor "."`, 'sciviz');
    key = (index) => (index.length ? index.join(separator) : '0');
    fill = parseFill(meta.fill_value, kind, false);
    const zattrs = await json(`${prefix}.zattrs`);
    attributes = zattrs ?? {};
  }
  if (shape.length !== chunks.length) throw rangeError('Zarr: shape and chunks do not match', 'sciviz');
  const rank = shape.length,
    sampleKind: Kind = kind === 'bool' ? 'uint8' : kind;
  if (order && (order.length !== rank || [...order].sort((a, b) => a - b).some((v, k) => v !== k)))
    throw rangeError(`Zarr: transpose order [${order.join(', ')}] is not a permutation`, 'sciviz');
  const identity = !order || order.every((v, k) => v === k);
  const chunkSamples = chunks.reduce((a, b) => a * b, 1),
    chunkBytes = chunkSamples * SIZE[sampleKind];
  // Each bytes to bytes codec decodes to what it was given on encode: exactly so after bytes and crc32c, at most a
  // stored-block deflate stream plus a header allowance after a compressor.
  const steps: ((bytes: Uint8Array) => Uint8Array)[] = [];
  let encoded = chunkBytes;
  for (const { name } of compressors) {
    const decoded = encoded;
    if (name === 'crc32c') {
      steps.unshift((b) => {
        if (b.length < 4) throw rangeError('Zarr: chunk shorter than its crc32c', 'sciviz');
        const body = b.subarray(0, b.length - 4);
        if (crc32c(body) !== u32le(b, b.length - 4))
          throw fault('failed', 'Zarr: a chunk fails its crc32c check', 'sciviz');
        return body;
      });
      encoded += 4;
    } else {
      steps.unshift(name === 'zlib' ? (b) => unzlib(b, decoded) : (b) => gunzip(b, decoded));
      encoded += 5 * Math.ceil(encoded / 65535 + 1) + 65536;
    }
  }
  const decodeChunk = (bytes: Uint8Array): GridData => {
    let b = bytes;
    for (const step of steps) b = step(b);
    if (b.length !== chunkBytes)
      throw rangeError(
        `Zarr: a chunk decodes to ${b.length} bytes, its shape and data type give ${chunkBytes}`,
        'sciviz',
      );
    const values = samples(b, 0, chunkSamples, sampleKind, little);
    // The bytes codec stores false as 0 and true as 1 (v2: values "only True or False").
    if (kind === 'bool' && values.some((v) => v > 1))
      throw rangeError('Zarr: a bool chunk holds a byte other than 0 or 1', 'sciviz');
    if (identity) return values;
    // The stored chunk holds dims in `order`; put it back in C order of the array's own dims.
    const storedShape = order!.map((d) => chunks[d]),
      out = new (values.constructor as new (n: number) => GridData)(chunkSamples),
      strides = new Array<number>(rank);
    let s = 1;
    for (let d = rank - 1; d >= 0; d--) (strides[d] = s), (s *= chunks[d]);
    const index = new Array<number>(rank).fill(0);
    for (let i = 0; i < chunkSamples; i++) {
      let target = 0;
      for (let k = 0; k < rank; k++) target += index[k] * strides[order![k]];
      out[target] = values[i];
      for (let k = rank - 1; k >= 0; k--) {
        if (++index[k] < storedShape[k]) break;
        index[k] = 0;
      }
    }
    return out;
  };
  return {
    zarrFormat: v3 ? 3 : 2,
    shape,
    chunks,
    dtype: kind,
    fillValue: fill,
    attributes,
    dimensionNames: names,
    async read(readOptions = {}) {
      const start = readOptions.start ? [...readOptions.start] : shape.map(() => 0),
        stop = readOptions.stop ? [...readOptions.stop] : [...shape];
      if (start.length !== rank || stop.length !== rank)
        throw rangeError(`Zarr read: start and stop need ${rank} entries`, 'sciviz');
      for (let d = 0; d < rank; d++)
        if (
          !Number.isInteger(start[d]) ||
          !Number.isInteger(stop[d]) ||
          start[d] < 0 ||
          stop[d] > shape[d] ||
          start[d] > stop[d]
        )
          throw rangeError(
            `Zarr read: [${start[d]}, ${stop[d]}) is outside dimension ${d} of size ${shape[d]}`,
            'sciviz',
          );
      const outShape = stop.map((v, d) => v - start[d]),
        total = outShape.reduce((a, b) => a * b, 1),
        max = readOptions.maxSamples ?? DEFAULT_MAX;
      if (total > max) throw rangeError(`Zarr read: ${total} samples is past maxSamples ${max}`, 'sciviz');
      const Type = {
        int8: Int8Array,
        uint8: Uint8Array,
        int16: Int16Array,
        uint16: Uint16Array,
        int32: Int32Array,
        uint32: Uint32Array,
        int64: Float64Array,
        uint64: Float64Array,
        float32: Float32Array,
        float64: Float64Array,
      }[sampleKind];
      const out = new Type(total) as GridData;
      if (fill !== 0) out.fill(fill);
      const first = start.map((v, d) => Math.floor(v / chunks[d])),
        last = stop.map((v, d) => Math.ceil(v / chunks[d]) - 1);
      const outStrides = new Array<number>(rank),
        chunkStrides = new Array<number>(rank);
      let so = 1,
        sc = 1;
      for (let d = rank - 1; d >= 0; d--) {
        outStrides[d] = so;
        so *= outShape[d];
        chunkStrides[d] = sc;
        sc *= chunks[d];
      }
      if (total === 0) return { data: out, shape: outShape };
      const index = [...first],
        jobs: Promise<void>[] = [];
      const signal = readOptions.signal ?? options.signal;
      for (;;) {
        const at = [...index];
        jobs.push(
          (async () => {
            const bytes = await get(prefix + key(at), signal);
            if (!bytes) return;
            const values = decodeChunk(bytes);
            // Copy the overlap of this chunk and the box, a row of the last dimension at a time.
            const lo = at.map((c, d) => Math.max(start[d], c * chunks[d])),
              hi = at.map((c, d) => Math.min(stop[d], (c + 1) * chunks[d]));
            const p = [...lo];
            const width = rank ? hi[rank - 1] - lo[rank - 1] : 1;
            for (;;) {
              let src = 0,
                dst = 0;
              for (let d = 0; d < rank; d++) {
                src += (p[d] - at[d] * chunks[d]) * chunkStrides[d];
                dst += (p[d] - start[d]) * outStrides[d];
              }
              out.set(values.subarray(src, src + width), dst);
              let d = rank - 2;
              for (; d >= 0; d--) {
                if (++p[d] < hi[d]) break;
                p[d] = lo[d];
              }
              if (d < 0) break;
            }
          })(),
        );
        let d = rank - 1;
        for (; d >= 0; d--) {
          if (++index[d] <= last[d]) break;
          index[d] = first[d];
        }
        if (d < 0) break;
      }
      await Promise.all(jobs);
      return { data: out, shape: outShape };
    },
  };
}

/**
 * The volume grid of a Zarr box whose last three dimensions are z, y and x (C order, so x is fastest), such as an
 * OME-Zarr level with its time and channel dimensions read at one index. `spacing` is x, y, z.
 */
export function zarrGrid(
  read: { readonly data: GridData; readonly shape: readonly number[] },
  spacing: readonly [number, number, number] = [1, 1, 1],
): VolumeGrid {
  const shape = read.shape.filter((n, k) => n !== 1 || k >= read.shape.length - 3);
  if (shape.length > 3)
    throw rangeError(`zarrGrid: read one index of the leading dimensions of [${read.shape.join(', ')}]`, 'sciviz');
  const [nz, ny, nx] = [...Array(3 - shape.length).fill(1), ...shape] as number[];
  const dims: [number, number, number] = [nx, ny, nz];
  return {
    data: read.data,
    dims,
    bounds: [0, (nx - 1) * spacing[0], 0, (ny - 1) * spacing[1], 0, (nz - 1) * spacing[2]],
    range: rangeOf(read.data),
  };
}

/** Draws a grid from any reader here as a volume, with its bounds and range. */
export function volumeFromGrid(figure: Figure, grid: VolumeGrid, options: VolumeLayerOptions = {}): VolumeLayer {
  return figure.volume(grid.data, {
    ...options,
    dims: grid.dims,
    bounds: options.bounds ?? grid.bounds,
    range: options.range ?? (grid.range[0] < grid.range[1] ? grid.range : undefined),
  });
}
