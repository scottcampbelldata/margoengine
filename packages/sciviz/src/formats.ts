// Medical and array volume formats read into the grid `fig.volume()` takes:
// - NIfTI-1 and NIfTI-2 (`.nii`, `.nii.gz`, and `.hdr` with `.img`): the NIfTI Data Format Working Group's header
//   definitions (nifti1.h and nifti2.h documentation): dims, datatype, pixdim, vox_offset, scaling, qform and sform.
// - DICOM (PS3.10 files, PS3.5 data encoding): implicit and explicit VR little endian, explicit VR big endian and
//   deflated explicit VR little endian, uncompressed pixel data, and series stacked by position along the slice normal
//   (PS3.3 C.7.6.2, Image Plane Module). Compressed pixel data (JPEG, JPEG 2000, RLE and the rest) is refused.
// - Zarr v2 and v3 arrays over HTTP or any key store: regular chunks, C order, the bytes, gzip, zlib, crc32c and
//   transpose codecs, and missing chunks as the fill value (Zarr storage specification 2 and 3.0).
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
  /** Smallest and largest finite sample. */
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

async function decompress(bytes: Uint8Array, format: 'gzip' | 'deflate' | 'deflate-raw', max: number): Promise<Uint8Array> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream(format));
  const reader = stream.getReader(),
    parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let step;
    try {
      step = await reader.read();
    } catch (error) {
      throw rangeError(`damaged ${format} data: ${(error as Error).message}`, 'sciviz');
    }
    if (step.done) break;
    total += step.value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw rangeError(`${format} data inflates past ${max} bytes`, 'sciviz');
    }
    parts.push(step.value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
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
    throw rangeError(`the data holds ${Math.max(0, bytes.byteLength - offset)} bytes, the header declares ${count * size}`, 'sciviz');
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
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return min <= max ? [min, max] : [0, 0];
}

/** Applies `value * slope + intercept` when it changes anything, into a `Float32Array`. */
function rescale(data: GridData, slope: number, intercept: number): GridData {
  if (!Number.isFinite(slope) || slope === 0 || (slope === 1 && intercept === 0) || !Number.isFinite(intercept))
    return data;
  const out = new Float32Array(data.length);
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

const NIFTI_TYPES: Record<number, [Kind, number]> = {
  2: ['uint8', 1],
  4: ['int16', 1],
  8: ['int32', 1],
  16: ['float32', 1],
  64: ['float64', 1],
  128: ['uint8', 3],
  256: ['int8', 1],
  512: ['uint16', 1],
  768: ['uint32', 1],
  1024: ['int64', 1],
  1280: ['uint64', 1],
  2304: ['uint8', 4],
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
const TIME_UNITS: Record<number, string> = { 0: 'unknown', 8: 's', 16: 'ms', 24: 'us', 32: 'Hz', 40: 'ppm', 48: 'rad/s' };

const text = (bytes: Uint8Array, start: number, length: number): string => {
  let s = '';
  for (let i = start; i < start + length && bytes[i]; i++) s += String.fromCharCode(bytes[i]);
  return s.trim();
};

/**
 * Reads a NIfTI-1 or NIfTI-2 image, gzipped or not, in either byte order. Scaled data (`scl_slope`) comes back as
 * `Float32Array`; `matrix` is the sform when set, else the qform, else the voxel sizes.
 */
export async function parseNIfTI(input: ArrayBuffer | ArrayBufferView, options: NIfTIOptions = {}): Promise<NIfTIVolume> {
  options.signal?.throwIfAborted();
  const max = options.maxSamples ?? DEFAULT_MAX;
  let bytes = bytesOf(input, 'parseNIfTI');
  if (isGzip(bytes)) bytes = await decompress(bytes, 'gzip', max * 8 + (1 << 20));
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
  const magic = v2 ? text(bytes, 4, 3) : text(bytes, 344, 3);
  if (!['n+1', 'ni1', 'n+2', 'ni2'].includes(magic)) throw rangeError(`NIfTI: unknown magic "${magic}"`, 'sciviz');
  const dim: number[] = [],
    pixdim: number[] = [];
  for (let k = 0; k < 8; k++) {
    dim.push(v2 ? i64(16 + k * 8) : i16(40 + k * 2));
    pixdim.push(v2 ? f64(104 + k * 8) : f32(76 + k * 4));
  }
  const datatype = v2 ? i16(12) : i16(70);
  const type = NIFTI_TYPES[datatype];
  if (!type) throw fault('unsupported', `NIfTI: datatype ${datatype} is not read (complex and 128-bit types)`, 'sciviz');
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
  let body = bytes,
    offset = Math.floor(voxOffset);
  if (magic === 'ni1' || magic === 'ni2') {
    if (!options.resolve) throw typeError('NIfTI: a .hdr header needs resolve to read its .img', 'sciviz');
    const name = (options.name ?? 'image.hdr').replace(/\.hdr(\.gz)?$/i, '.img$1');
    body = await options.resolve(name);
    if (isGzip(body)) body = await decompress(body, 'gzip', count * SIZE[kind] + 1);
    offset = Math.max(0, offset);
  } else if (offset < size) offset = size + 4;
  options.signal?.throwIfAborted();
  const all = rescale(samples(body, offset, count, kind, little), slope, intercept);
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
  readonly samplesPerPixel: number;
  /** Rescaled samples (`RescaleSlope`, `RescaleIntercept`), frames after each other, rows of `columns`. */
  readonly data: GridData;
  /** Row spacing then column spacing in mm (`PixelSpacing`), `[1, 1]` when absent. */
  readonly pixelSpacing: [number, number];
  /** `ImagePositionPatient`, or undefined. */
  readonly position: [number, number, number] | undefined;
  /** `ImageOrientationPatient`: row then column direction cosines, or undefined. */
  readonly orientation: [number, number, number, number, number, number] | undefined;
  readonly sliceThickness: number | undefined;
  readonly instanceNumber: number | undefined;
  readonly seriesUID: string | undefined;
  readonly modality: string | undefined;
  readonly photometric: string;
  readonly transferSyntax: string;
  /** Every top-level element read as text or numbers, keyed `ggggeeee` in upper-case hex. */
  readonly elements: Readonly<Record<string, string | number[]>>;
}

const LONG_VR = new Set(['OB', 'OD', 'OF', 'OL', 'OV', 'OW', 'SQ', 'SV', 'UC', 'UN', 'UR', 'UT', 'UV']);
// The VRs of the elements this reader uses, for implicit VR files (PS3.6 data dictionary).
const IMPLICIT: Record<string, string> = {
  '00020010': 'UI',
  '00080060': 'CS',
  '00180050': 'DS',
  '00180088': 'DS',
  '0020000E': 'UI',
  '00200013': 'IS',
  '00200032': 'DS',
  '00200037': 'DS',
  '00280002': 'US',
  '00280004': 'CS',
  '00280006': 'US',
  '00280008': 'IS',
  '00280010': 'US',
  '00280011': 'US',
  '00280030': 'DS',
  '00280100': 'US',
  '00280101': 'US',
  '00280103': 'US',
  '00281050': 'DS',
  '00281051': 'DS',
  '00281052': 'DS',
  '00281053': 'DS',
  '7FE00010': 'OW',
};
const TEXT_VR = new Set(['AE', 'AS', 'CS', 'DA', 'DS', 'DT', 'IS', 'LO', 'LT', 'PN', 'SH', 'ST', 'TM', 'UC', 'UI', 'UR', 'UT']);
const NUMERIC_TEXT = new Set(['DS', 'IS']);
const UNDEFINED = 0xffffffff;

interface Cursor {
  view: DataView;
  bytes: Uint8Array;
  at: number;
  little: boolean;
  explicit: boolean;
}

const hex = (g: number, e: number) =>
  g.toString(16).toUpperCase().padStart(4, '0') + e.toString(16).toUpperCase().padStart(4, '0');

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
    readElement(c, undefined);
  }
  throw rangeError('DICOM: a sequence or item has no delimiter', 'sciviz');
}

/** Reads one element at the cursor; stores it in `into` when given. Returns the tag, or undefined at the pixel data. */
function readElement(c: Cursor, into: Record<string, string | number[]> | undefined, pixels?: { at: number; length: number; vr: string }): string {
  const { view, little } = c;
  if (c.at + 8 > c.bytes.byteLength) throw rangeError('DICOM: an element runs past the end', 'sciviz');
  const g = view.getUint16(c.at, little),
    e = view.getUint16(c.at + 2, little),
    tag = hex(g, e);
  let vr: string,
    length: number;
  // Group 0002 is always explicit VR little endian; items and delimiters have no VR.
  const explicit = c.explicit && g !== 0xfffe;
  if (explicit) {
    vr = String.fromCharCode(c.bytes[c.at + 4], c.bytes[c.at + 5]);
    if (LONG_VR.has(vr)) {
      length = view.getUint32(c.at + 8, little);
      c.at += 12;
    } else {
      length = view.getUint16(c.at + 6, little);
      c.at += 8;
    }
  } else {
    vr = IMPLICIT[tag] ?? (g === 0xfffe ? '' : 'UN');
    length = view.getUint32(c.at + 4, little);
    c.at += 8;
  }
  if (tag === '7FE00010' && pixels) {
    pixels.at = c.at;
    pixels.length = length;
    pixels.vr = vr;
    if (length === UNDEFINED) skipUndefined(c, 0xe0dd);
    else c.at += length;
    return tag;
  }
  if (length === UNDEFINED) {
    // A sequence (or an implicit-VR element of unknown VR) of undefined length.
    skipUndefined(c, 0xe0dd);
    return tag;
  }
  if (c.at + length > c.bytes.byteLength) throw rangeError(`DICOM: element ${tag} runs past the end`, 'sciviz');
  if (into && vr !== 'SQ') {
    if (TEXT_VR.has(vr)) {
      let s = '';
      for (let i = 0; i < length; i++) s += String.fromCharCode(c.bytes[c.at + i]);
      s = s.replace(/[\0 ]+$/, '').trim();
      into[tag] = NUMERIC_TEXT.has(vr) ? s.split('\\').map(Number) : s;
    } else if (vr === 'US' || vr === 'SS' || vr === 'UL' || vr === 'SL' || vr === 'FL' || vr === 'FD') {
      const size = vr === 'US' || vr === 'SS' ? 2 : vr === 'FD' ? 8 : 4,
        values: number[] = [];
      for (let i = 0; i + size <= length; i += size) {
        const o = c.at + i;
        values.push(
          vr === 'US'
            ? view.getUint16(o, little)
            : vr === 'SS'
              ? view.getInt16(o, little)
              : vr === 'UL'
                ? view.getUint32(o, little)
                : vr === 'SL'
                  ? view.getInt32(o, little)
                  : vr === 'FL'
                    ? view.getFloat32(o, little)
                    : view.getFloat64(o, little),
        );
      }
      into[tag] = values;
    }
  }
  c.at += length;
  return tag;
}

const SYNTAX = {
  implicit: '1.2.840.10008.1.2',
  explicit: '1.2.840.10008.1.2.1',
  deflated: '1.2.840.10008.1.2.1.99',
  big: '1.2.840.10008.1.2.2',
};

/**
 * Reads one DICOM Part 10 file (with or without the 128-byte preamble) holding uncompressed pixel data. Rejects with
 * code `unsupported` for a compressed transfer syntax, naming it.
 */
export async function parseDICOM(input: ArrayBuffer | ArrayBufferView, options: FormatOptions = {}): Promise<DICOMImage> {
  options.signal?.throwIfAborted();
  let bytes = bytesOf(input, 'parseDICOM');
  const max = options.maxSamples ?? DEFAULT_MAX;
  let at = 0;
  const magic = (o: number) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  if (bytes.byteLength >= 132 && magic(128) === 'DICM') at = 132;
  else if (bytes.byteLength >= 4 && magic(0) === 'DICM') at = 4;
  const elements: Record<string, string | number[]> = Object.create(null);
  let c: Cursor = { view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), bytes, at, little: true, explicit: true };
  // The file meta group, explicit VR little endian; a file without it is taken as implicit VR little endian.
  let syntax = SYNTAX.implicit;
  if (at > 0) {
    while (c.at + 4 <= bytes.byteLength && c.view.getUint16(c.at, true) === 0x0002) readElement(c, elements);
    const named = elements['00020010'];
    if (typeof named === 'string' && named) syntax = named;
  } else {
    // No preamble: guess explicit when the first element carries two letters where a VR goes.
    const a = bytes[4],
      b = bytes[5];
    c.explicit = a >= 65 && a <= 90 && b >= 65 && b <= 90;
    syntax = c.explicit ? SYNTAX.explicit : SYNTAX.implicit;
  }
  if (syntax === SYNTAX.deflated) {
    const rest = await decompress(bytes.subarray(c.at), 'deflate-raw', max * 8 + (1 << 20));
    bytes = rest;
    c = { view: new DataView(rest.buffer, rest.byteOffset, rest.byteLength), bytes: rest, at: 0, little: true, explicit: true };
  } else if (syntax === SYNTAX.implicit) c.explicit = at > 0 ? false : c.explicit;
  else if (syntax === SYNTAX.explicit) c.explicit = true;
  else if (syntax === SYNTAX.big) {
    c.explicit = true;
    c.little = false;
  } else throw fault('unsupported', `DICOM: transfer syntax ${syntax} (compressed pixel data) is not read`, 'sciviz');
  const pixels = { at: -1, length: 0, vr: '' };
  while (c.at + 8 <= c.bytes.byteLength) {
    options.signal?.throwIfAborted();
    const tag = readElement(c, elements, pixels);
    if (tag === '7FE00010') break;
  }
  if (pixels.at < 0) throw rangeError('DICOM: the file has no pixel data', 'sciviz');
  if (pixels.length === UNDEFINED) throw rangeError('DICOM: encapsulated pixel data in an uncompressed syntax', 'sciviz');
  const num = (tag: string, fallback?: number): number | undefined => {
    const v = elements[tag];
    return Array.isArray(v) && Number.isFinite(v[0]) ? v[0] : fallback;
  };
  const list = (tag: string, n: number): number[] | undefined => {
    const v = elements[tag];
    return Array.isArray(v) && v.length >= n && v.slice(0, n).every(Number.isFinite) ? v.slice(0, n) : undefined;
  };
  const rows = num('00280010'),
    columns = num('00280011');
  if (!rows || !columns) throw rangeError('DICOM: Rows and Columns are missing', 'sciviz');
  const samplesPerPixel = num('00280002', 1)!,
    bits = num('00280100', 16)!,
    signed = num('00280103', 0) === 1,
    frames = num('00280008', 1)!,
    planar = num('00280006', 0)!;
  if (bits !== 8 && bits !== 16 && bits !== 32) throw fault('unsupported', `DICOM: BitsAllocated ${bits} is not read`, 'sciviz');
  const count = rows * columns * frames * samplesPerPixel;
  if (count > max) throw rangeError(`DICOM: ${count} samples is past maxSamples ${max}`, 'sciviz');
  const kind: Kind = bits === 8 ? (signed ? 'int8' : 'uint8') : bits === 16 ? (signed ? 'int16' : 'uint16') : signed ? 'int32' : 'uint32';
  let data = samples(c.bytes, pixels.at, count, kind, c.little);
  // Planar configuration 1 stores each colour plane in turn; interleave it.
  if (samplesPerPixel > 1 && planar === 1) {
    const out = new (data.constructor as new (n: number) => GridData)(count),
      plane = rows * columns;
    for (let f = 0; f < frames; f++)
      for (let s = 0; s < samplesPerPixel; s++)
        for (let p = 0; p < plane; p++) out[(f * plane + p) * samplesPerPixel + s] = data[(f * samplesPerPixel + s) * plane + p];
    data = out;
  }
  data = rescale(data, num('00281053', 1)!, num('00281052', 0)!);
  const spacing = list('00280030', 2),
    position = list('00200032', 3),
    orientation = list('00200037', 6);
  const str = (tag: string) => (typeof elements[tag] === 'string' ? (elements[tag] as string) : undefined);
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
    instanceNumber: num('00200013'),
    seriesUID: str('0020000E'),
    modality: str('00080060'),
    photometric: str('00280004') ?? 'MONOCHROME2',
    transferSyntax: syntax,
    elements,
  };
}

/**
 * Stacks the slices of one DICOM series into a volume, ordered by position along the slice normal (instance number
 * when positions are missing), with the slice step from the positions. Throws when slices differ in size or series.
 */
export function dicomSeries(images: readonly DICOMImage[]): FormatVolume {
  if (!images.length) throw rangeError('dicomSeries needs at least one image', 'sciviz');
  const first = images[0];
  for (const image of images) {
    if (image.rows !== first.rows || image.columns !== first.columns || image.samplesPerPixel !== first.samplesPerPixel)
      throw rangeError('dicomSeries: the slices differ in size; pass the images of one series', 'sciviz');
    if (image.seriesUID !== first.seriesUID)
      throw rangeError('dicomSeries: the images come from more than one series (SeriesInstanceUID)', 'sciviz');
  }
  const o = first.orientation ?? [1, 0, 0, 0, 1, 0];
  const normal = [o[1] * o[5] - o[2] * o[4], o[2] * o[3] - o[0] * o[5], o[0] * o[4] - o[1] * o[3]];
  const along = (image: DICOMImage) =>
    image.position ? image.position[0] * normal[0] + image.position[1] * normal[1] + image.position[2] * normal[2] : NaN;
  const slices = images.flatMap((image) =>
    Array.from({ length: image.frames }, (_, f) => ({ image, frame: f, key: along(image), order: image.instanceNumber ?? 0 })),
  );
  const positioned = slices.every((s) => Number.isFinite(s.key));
  slices.sort((a, b) => (positioned ? a.key - b.key : a.order - b.order) || a.frame - b.frame);
  const plane = first.rows * first.columns * first.samplesPerPixel,
    nz = slices.length;
  const floating = slices.some((s) => !(s.image.data instanceof first.data.constructor));
  const Type = (floating ? Float32Array : first.data.constructor) as new (n: number) => GridData;
  const all = new Type(plane * nz);
  slices.forEach((s, k) => all.set(s.image.data.subarray(s.frame * plane, (s.frame + 1) * plane), k * plane));
  let step = first.sliceThickness ?? 1;
  if (positioned && nz > 1) {
    const gaps = slices.slice(1).map((s, k) => s.key - slices[k].key).sort((a, b) => a - b);
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
  return build(all, [first.columns, first.rows, nz], first.samplesPerPixel, 1, spacing, matrix);
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

async function fetchBytes(url: URL, options: { readonly init?: RequestInit; readonly signal?: AbortSignal }): Promise<Uint8Array> {
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

function storeReader(store: ZarrStore, options: ZarrOptions): (key: string, signal?: AbortSignal) => Promise<Uint8Array | undefined> {
  if (typeof store === 'function') return store;
  if (typeof store === 'string' || store instanceof URL) {
    const base = new URL(store, globalThis.location?.href);
    if (!base.pathname.endsWith('/')) base.pathname += '/';
    return async (key, signal) => {
      const response = await fetch(new URL(key, base), { ...options.init, signal: signal ?? options.signal });
      if (response.status === 404 || response.status === 403) return undefined;
      if (!response.ok) throw rangeError(`Zarr fetch of ${key} answered ${response.status}`, 'sciviz');
      return new Uint8Array(await response.arrayBuffer());
    };
  }
  if (store && typeof store === 'object') {
    const map = store as Record<string, Uint8Array | string>;
    return async (key) => {
      const value = Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
      return typeof value === 'string' ? new TextEncoder().encode(value) : value;
    };
  }
  throw typeError('openZarr takes a URL, an object of keys or a function', 'sciviz');
}

const parseFill = (value: unknown, kind: Kind | 'bool'): number => {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === 'NaN') return NaN;
  if (value === 'Infinity') return Infinity;
  if (value === '-Infinity') return -Infinity;
  if (typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value)) {
    const view = new DataView(new ArrayBuffer(8));
    if (kind === 'float32') {
      view.setUint32(0, parseInt(value, 16));
      return view.getFloat32(0);
    }
    view.setBigUint64(0, BigInt(value));
    return view.getFloat64(0);
  }
  throw fault('unsupported', `Zarr: fill_value ${JSON.stringify(value)} is not read`, 'sciviz');
};

/**
 * Opens a Zarr v2 or v3 array at `path` in `store`. Rejects with code `unsupported` for a codec this reader has
 * not (blosc, zstd, sharding and the rest), naming it.
 */
export async function openZarr(store: ZarrStore, path = '', options: ZarrOptions = {}): Promise<ZarrArray> {
  const get = storeReader(store, options),
    prefix = path.replace(/^\/+|\/+$/g, '') ? `${path.replace(/^\/+|\/+$/g, '')}/` : '',
    decoder = new TextDecoder();
  const json = async (key: string): Promise<Record<string, unknown> | undefined> => {
    const bytes = await get(prefix + key, options.signal);
    if (!bytes) return undefined;
    try {
      return JSON.parse(decoder.decode(bytes)) as Record<string, unknown>;
    } catch {
      throw rangeError(`Zarr: ${prefix + key} is not JSON`, 'sciviz');
    }
  };
  const v3 = await json('zarr.json');
  let shape: number[], chunks: number[], kind: Kind | 'bool', little: boolean, fill: number;
  let attributes: Record<string, unknown> = {};
  let names: (string | null)[] | undefined;
  let key: (index: number[]) => string;
  const steps: ((bytes: Uint8Array, max: number) => Promise<Uint8Array>)[] = [];
  let order: number[] | undefined;
  if (v3) {
    if (v3.node_type !== 'array') throw rangeError(`Zarr: ${prefix || '/'} is a ${String(v3.node_type)}, not an array`, 'sciviz');
    shape = (v3.shape as number[]) ?? [];
    const grid = v3.chunk_grid as { name: string; configuration: { chunk_shape: number[] } };
    if (grid?.name !== 'regular') throw fault('unsupported', `Zarr: chunk grid ${grid?.name} is not read`, 'sciviz');
    chunks = grid.configuration.chunk_shape;
    const type = String(v3.data_type);
    kind = type === 'bool' ? 'bool' : (type as Kind);
    if (!(kind in SIZE) && kind !== 'bool') throw fault('unsupported', `Zarr: data type ${type} is not read`, 'sciviz');
    const encoding = (v3.chunk_key_encoding as { name: string; configuration?: { separator?: string } }) ?? {
      name: 'default',
    };
    const separator = encoding.configuration?.separator ?? (encoding.name === 'v2' ? '.' : '/');
    key =
      encoding.name === 'v2'
        ? (index) => (index.length ? index.join(separator) : '0')
        : (index) => ['c', ...index].join(separator);
    little = true;
    let seenBytes = false;
    for (const codec of (v3.codecs as { name: string; configuration?: Record<string, unknown> }[]) ?? []) {
      if (codec.name === 'bytes') {
        seenBytes = true;
        little = codec.configuration?.endian !== 'big';
      } else if (codec.name === 'transpose') {
        if (seenBytes) throw rangeError('Zarr: transpose after bytes', 'sciviz');
        order = codec.configuration?.order as number[];
      } else if (codec.name === 'gzip') steps.unshift((b, max) => decompress(b, 'gzip', max));
      else if (codec.name === 'crc32c')
        steps.unshift(async (b) => {
          if (b.length < 4) throw rangeError('Zarr: chunk shorter than its crc32c', 'sciviz');
          const body = b.subarray(0, b.length - 4),
            stored = new DataView(b.buffer, b.byteOffset + b.length - 4, 4).getUint32(0, true);
          if (crc32c(body) !== stored) throw fault('failed', 'Zarr: a chunk fails its crc32c check', 'sciviz');
          return body;
        });
      else throw fault('unsupported', `Zarr: codec ${codec.name} is not read`, 'sciviz');
    }
    fill = parseFill(v3.fill_value, kind);
    attributes = (v3.attributes as Record<string, unknown>) ?? {};
    names = v3.dimension_names as (string | null)[] | undefined;
  } else {
    const meta = await json('.zarray');
    if (!meta) throw rangeError(`Zarr: no array at ${prefix || '/'} (neither zarr.json nor .zarray)`, 'sciviz');
    shape = meta.shape as number[];
    chunks = meta.chunks as number[];
    const dtype = String(meta.dtype);
    const parsed = /^([<>|])([biuf][1248])$/.exec(dtype);
    if (!parsed || !V2_KIND[parsed[2]]) throw fault('unsupported', `Zarr: dtype ${dtype} is not read`, 'sciviz');
    kind = V2_KIND[parsed[2]];
    little = parsed[1] !== '>';
    if (meta.order === 'F') order = shape.map((_, k) => shape.length - 1 - k);
    if (Array.isArray(meta.filters) && meta.filters.length)
      throw fault('unsupported', `Zarr: filters ${(meta.filters as { id: string }[]).map((f) => f.id).join(', ')} are not read`, 'sciviz');
    const compressor = meta.compressor as { id: string } | null;
    if (compressor?.id === 'gzip') steps.push((b, max) => decompress(b, 'gzip', max));
    else if (compressor?.id === 'zlib') steps.push((b, max) => decompress(b, 'deflate', max));
    else if (compressor) throw fault('unsupported', `Zarr: compressor ${compressor.id} is not read`, 'sciviz');
    const separator = (meta.dimension_separator as string) ?? '.';
    key = (index) => (index.length ? index.join(separator) : '0');
    fill = parseFill(meta.fill_value, kind);
    attributes = (await json('.zattrs')) ?? {};
  }
  if (!Array.isArray(shape) || !Array.isArray(chunks) || shape.length !== chunks.length)
    throw rangeError('Zarr: shape and chunks do not match', 'sciviz');
  if (shape.some((n) => !Number.isInteger(n) || n < 0) || chunks.some((n) => !Number.isInteger(n) || n < 1))
    throw rangeError(`Zarr: shape [${shape.join(', ')}] or chunks [${chunks.join(', ')}] are not counts`, 'sciviz');
  const rank = shape.length,
    sampleKind: Kind = kind === 'bool' ? 'uint8' : kind;
  if (order && (order.length !== rank || [...order].sort((a, b) => a - b).some((v, k) => v !== k)))
    throw rangeError(`Zarr: transpose order [${order.join(', ')}] is not a permutation`, 'sciviz');
  const identity = !order || order.every((v, k) => v === k);
  const chunkSamples = chunks.reduce((a, b) => a * b, 1);
  const decodeChunk = async (bytes: Uint8Array): Promise<GridData> => {
    let b = bytes;
    for (const step of steps) b = await step(b, chunkSamples * SIZE[sampleKind]);
    const values = samples(b, 0, chunkSamples, sampleKind, little);
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
        if (!Number.isInteger(start[d]) || !Number.isInteger(stop[d]) || start[d] < 0 || stop[d] > shape[d] || start[d] > stop[d])
          throw rangeError(`Zarr read: [${start[d]}, ${stop[d]}) is outside dimension ${d} of size ${shape[d]}`, 'sciviz');
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
            const values = await decodeChunk(bytes);
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
  if (shape.length > 3) throw rangeError(`zarrGrid: read one index of the leading dimensions of [${read.shape.join(', ')}]`, 'sciviz');
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
