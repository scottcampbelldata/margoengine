import { LoaderError, type LoadedGeometry, type ParseLimits } from './types.js';
import { checkCount, limits, toBytes, type BinaryInput } from './util.js';

const F = 'PRWM';

/** Options of parsePRWM: the shared size limits (ParseLimits). */
export interface PRWMOptions extends ParseLimits {}

/** The result of parsePRWM: a LoadedGeometry plus what the file said about each attribute. */
export interface PRWMGeometry extends LoadedGeometry {
  /** Every attribute in file order: its name, components per vertex (1 to 4), and whether the file marks it normalized or integer. */
  layout: { name: string; components: number; normalized: boolean; integer: boolean }[];
  /** True when the file had no index block (the triangle list is then 0, 1, 2, ...). */
  nonIndexed: boolean;
}

// Encoding type -> bytes per value, reader and the largest value (the normalization divisor). Values 0, 2, 5, 9 and
// 11 to 15 are reserved by the format.
type Read = (view: DataView, at: number, little: boolean) => number;
const ENCODINGS: Record<number, [size: number, read: Read, max: number, signed: boolean]> = {
  1: [4, (v, a, l) => v.getFloat32(a, l), 1, true],
  3: [1, (v, a) => v.getInt8(a), 127, true],
  4: [2, (v, a, l) => v.getInt16(a, l), 32767, true],
  6: [4, (v, a, l) => v.getInt32(a, l), 2147483647, true],
  7: [1, (v, a) => v.getUint8(a), 255, false],
  8: [2, (v, a, l) => v.getUint16(a, l), 65535, false],
  10: [4, (v, a, l) => v.getUint32(a, l), 4294967295, false],
};

/**
 * Parses a Packed Raw WebGL Model (PRWM version 1; specifications/prwm.md of github.com/kchapelier/PRWM).
 * Attributes named `position`, `normal`, `uv` (also `uv0`, `texcoord`) and `color` fill the matching fields (normalized
 * integers become floats in [0,1] or [-1,1]; `color` keeps RGB); every other attribute goes to `attributes` flattened.
 * A non-indexed file gets the sequential triangle list.
 */
export function parsePRWM(input: BinaryInput, options: PRWMOptions = {}): PRWMGeometry {
  const bytes = toBytes(input, F),
    limit = limits(options, F);
  if (bytes.length < 8) throw new LoaderError(F, 'truncated', 'file is shorter than the 8-byte header');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = bytes[0],
    flags = bytes[1];
  if (version === 0) throw new LoaderError(F, 'header', 'version 0 is invalid');
  if (version !== 1) throw new LoaderError(F, 'unsupported', `PRWM version ${version} is not supported`);
  const indexed = !!(flags & 0x80),
    index32 = !!(flags & 0x40),
    little = !(flags & 0x20),
    attributeCount = flags & 0x1f;
  const u24 = (at: number): number =>
    little
      ? bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16)
      : (bytes[at] << 16) | (bytes[at + 1] << 8) | bytes[at + 2];
  const valueCount = checkCount(u24(2), limit.maxVertices, F, 'vertex'),
    indexCount = u24(5);
  if (attributeCount === 0) throw new LoaderError(F, 'header', 'a model needs at least one attribute');
  if (!indexed && (indexCount !== 0 || index32))
    throw new LoaderError(F, 'header', 'a non-indexed model must have no indices and the 16-bit index type');
  checkCount(indexCount, limit.maxTriangles * 3, F, 'index');
  if (indexed && indexCount % 3) throw new LoaderError(F, 'header', 'the index count is not a multiple of 3');

  let pos = 8;
  const result: PRWMGeometry = { kind: 'mesh', positions: new Float32Array(0), layout: [], nonIndexed: !indexed };
  let hasPosition = false;
  for (let a = 0; a < attributeCount; a++) {
    let end = pos;
    while (end < bytes.length && bytes[end] !== 0) end++;
    if (end >= bytes.length - 1) throw new LoaderError(F, 'truncated', `attribute ${a} header is cut off`);
    let name = '';
    for (let i = pos; i < end; i++) name += String.fromCharCode(bytes[i]);
    const flag = bytes[end + 1];
    pos = (end + 2 + 3) & ~3; // the values start at a multiple of 4
    const integer = !!(flag & 0x80),
      normalized = !!(flag & 0x40),
      components = ((flag >> 4) & 3) + 1,
      encoding = ENCODINGS[flag & 15];
    if (!encoding) throw new LoaderError(F, 'unsupported', `attribute "${name}" uses reserved encoding ${flag & 15}`);
    const [size, read, max, signed] = encoding,
      total = valueCount * components;
    if (pos + total * size > bytes.length)
      throw new LoaderError(F, 'truncated', `attribute "${name}" ends past the end of the file`);
    const out = new Float32Array(total);
    const scale = normalized && (flag & 15) !== 1;
    for (let i = 0; i < total; i++) {
      const raw = read(view, pos + i * size, little);
      out[i] = scale ? (signed ? Math.max(raw / max, -1) : raw / max) : raw;
    }
    pos += total * size;
    result.layout.push({ name, components, normalized, integer });
    const key = name.toLowerCase();
    if (key === 'position' && components === 3) {
      result.positions = out;
      hasPosition = true;
    } else if (key === 'normal' && components === 3) result.normals = out;
    else if (['uv', 'uv0', 'texcoord'].includes(key) && components === 2) result.uvs ??= out;
    else if (key === 'color' && components >= 3) {
      const rgb = new Float32Array(valueCount * 3);
      for (let i = 0; i < valueCount; i++) for (let c = 0; c < 3; c++) rgb[i * 3 + c] = out[i * components + c];
      result.colors = rgb;
    } else (result.attributes ??= {})[name] = out;
  }
  if (!hasPosition) throw new LoaderError(F, 'header', 'no 3-component "position" attribute');

  let indices: Uint32Array;
  if (indexed) {
    pos = (pos + 3) & ~3;
    const size = index32 ? 4 : 2;
    if (pos + indexCount * size > bytes.length) throw new LoaderError(F, 'truncated', 'index block is cut off');
    indices = new Uint32Array(indexCount);
    for (let i = 0; i < indexCount; i++) {
      const v = index32 ? view.getUint32(pos + i * 4, little) : view.getUint16(pos + i * 2, little);
      if (v >= valueCount) throw new LoaderError(F, 'range', `index ${i} (${v}) is past the ${valueCount} vertices`);
      indices[i] = v;
    }
  } else {
    if (valueCount % 3) throw new LoaderError(F, 'header', 'a non-indexed model needs a multiple of 3 vertices');
    checkCount(valueCount, limit.maxTriangles * 3, F, 'index');
    indices = new Uint32Array(valueCount);
    for (let i = 0; i < valueCount; i++) indices[i] = i;
  }
  result.indices = indices;
  return result;
}
