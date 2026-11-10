// VTK XML files: PolyData (.vtp) and UnstructuredGrid (.vtu), with ascii, binary and appended arrays.
import { LoaderError, type LoadedGeometry, type ParseLimits } from './types.js';
import { checkCount, floats, latin1, limits, throwIfAborted, toBytes, uints, type BinaryInput } from './util.js';
import { readXMLTree, type XMLElement } from './xml.js';
import { inflate } from './zip.js';

const F = 'VTK XML';
const LITTLE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const SIZES: Record<string, number> = Object.assign(Object.create(null), {
  Int8: 1,
  UInt8: 1,
  Int16: 2,
  UInt16: 2,
  Int32: 4,
  UInt32: 4,
  Int64: 8,
  UInt64: 8,
  Float32: 4,
  Float64: 8,
});

type Numbers = ArrayLike<number>;

/** Options of {@link parseVTKXML}. */
export interface VTKXMLOptions extends ParseLimits {
  /** Volume cells of a grid: `'outer'` (default) keeps faces only one cell owns; `'all'` keeps every face. */
  surface?: 'outer' | 'all';
  signal?: AbortSignal;
}

/** One named data array of a VTK file. */
export interface VTKField {
  /** Values per point or cell. */
  components: number;
  values: Float32Array;
}

/** What {@link parseVTKXML} returns. Several pieces in one file are merged. */
export interface VTKXMLResult extends LoadedGeometry {
  /** `'PolyData'` or `'UnstructuredGrid'`. */
  type: string;
  /** Two point indices per line segment, from polylines and line cells. */
  lines: Uint32Array;
  /** The source cell of each triangle, for reading `cellData`. */
  triangleCells: Uint32Array;
  /** Every numeric array of `PointData`, by name. Null prototype. */
  pointData: Record<string, VTKField>;
  /** Every numeric array of `CellData`, by name. Null prototype. */
  cellData: Record<string, VTKField>;
  /** Cells in the file, across pieces. */
  cellCount: number;
  /** Things the parser moved past, each listed once. */
  warnings: string[];
}

/** Reads the bytes of one array in order; base64 sources decode as they go. */
interface Source {
  take(count: number): Uint8Array;
  peek(count: number): Uint8Array;
}

function decode64(text: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(text);
  } catch {
    throw new LoaderError(F, 'syntax', 'an array holds invalid base64');
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function rawSource(bytes: Uint8Array, start: number): Source {
  let pos = start;
  const peek = (count: number): Uint8Array => {
    if (pos + count > bytes.length) throw new LoaderError(F, 'truncated', 'an array runs past the end of the data');
    return bytes.subarray(pos, pos + count);
  };
  return {
    peek,
    take(count) {
      const out = peek(count);
      pos += count;
      return out;
    },
  };
}

function base64Source(text: string, start: number): Source {
  let pos = start;
  const peek = (count: number): Uint8Array => {
    const chars = Math.ceil(count / 3) * 4;
    if (pos + chars > text.length) throw new LoaderError(F, 'truncated', 'an array runs past the end of the data');
    return decode64(text.slice(pos, pos + chars)).subarray(0, count);
  };
  return {
    peek,
    take(count) {
      const out = peek(count);
      pos += Math.ceil(count / 3) * 4;
      return out;
    },
  };
}

/** Decodes one LZ4 block to exactly `size` bytes. */
function lz4(block: Uint8Array, size: number): Uint8Array {
  const out = new Uint8Array(size),
    bad = (): LoaderError => new LoaderError(F, 'zip', 'an LZ4 block is corrupt');
  let from = 0,
    to = 0;
  const length = (start: number): number => {
    let total = start;
    if (start === 15)
      for (;;) {
        if (from >= block.length) throw bad();
        const more = block[from++];
        total += more;
        if (more !== 255) break;
      }
    return total;
  };
  while (from < block.length) {
    const token = block[from++],
      literals = length(token >> 4);
    if (from + literals > block.length || to + literals > size) throw bad();
    out.set(block.subarray(from, from + literals), to);
    from += literals;
    to += literals;
    if (from >= block.length) break;
    if (from + 2 > block.length) throw bad();
    const offset = block[from] | (block[from + 1] << 8);
    from += 2;
    const match = length(token & 15) + 4;
    if (!offset || offset > to || to + match > size) throw bad();
    for (let i = 0; i < match; i++, to++) out[to] = out[to - offset];
  }
  if (to !== size) throw bad();
  return out;
}

interface Context {
  little: boolean;
  width: number;
  compressor?: 'zlib' | 'lz4' | 'lzma';
  /** Raw appended data, or the text of base64 appended data, and where it starts. */
  appended?: Uint8Array;
  appendedText?: string;
  maxBytes: number;
  signal?: AbortSignal;
  readAppended?: (offset: number, length: number, signal?: AbortSignal) => Promise<Uint8Array>;
}

function headerInt(bytes: Uint8Array, index: number, context: Context): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    { width, little } = context,
    value = width === 8 ? Number(view.getBigUint64(index * 8, little)) : view.getUint32(index * 4, little);
  if (!Number.isSafeInteger(value) || value > context.maxBytes)
    throw new LoaderError(F, 'limit', `an array declares ${value} bytes, past the limit of ${context.maxBytes}`);
  return value;
}

async function payload(source: Source, context: Context): Promise<Uint8Array> {
  const { width, compressor } = context;
  if (!compressor) return source.take(headerInt(source.take(width), 0, context));
  const first = source.peek(3 * width),
    blocks = headerInt(first, 0, context),
    block = headerInt(first, 1, context),
    last = headerInt(first, 2, context),
    header = source.take((3 + blocks) * width),
    total = blocks === 0 ? 0 : last ? (blocks - 1) * block + last : blocks * block;
  if (total > context.maxBytes)
    throw new LoaderError(F, 'limit', `an array expands to ${total} bytes, past the limit of ${context.maxBytes}`);
  const sizes: number[] = [];
  let packed = 0;
  for (let i = 0; i < blocks; i++) packed += sizes[sizes.push(headerInt(header, 3 + i, context)) - 1];
  const data = source.take(packed),
    out = new Uint8Array(total);
  let from = 0,
    to = 0;
  for (let i = 0; i < blocks; i++) {
    const size = i === blocks - 1 && last ? last : block,
      part = data.subarray(from, from + sizes[i]);
    out.set(
      compressor === 'lz4'
        ? lz4(part, size)
        : compressor === 'lzma'
          ? await unxz(part, size, i)
          : await inflate(part, size, `block ${i}`, context.signal, 'deflate', F),
      to,
    );
    from += sizes[i];
    to += size;
  }
  return out;
}

/** An LZMA block, which VTK writes as an `.xz` stream and `@margoengine/decoders` undoes, loaded only for a file that needs it. */
async function unxz(part: Uint8Array, size: number, block: number): Promise<Uint8Array> {
  const { decodeXz } = await import('@margoengine/decoders/xz');
  let out: Uint8Array;
  try {
    out = decodeXz(part, { maxBytes: size });
  } catch (error) {
    throw new LoaderError(F, 'zip', `block ${block}: ${(error as Error).message}`);
  }
  if (out.length !== size) throw new LoaderError(F, 'zip', `block ${block} holds ${out.length} bytes, not ${size}`);
  return out;
}

function view(bytes: Uint8Array, type: string, little: boolean): Numbers {
  const size = SIZES[type];
  if (bytes.length % size) throw new LoaderError(F, 'syntax', `${bytes.length} bytes are not whole ${type} values`);
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  if (little !== LITTLE) for (let i = 0; i < copy.length; i += size) copy.subarray(i, i + size).reverse();
  const { buffer } = copy,
    count = copy.length / size;
  switch (type) {
    case 'Int8':
      return new Int8Array(buffer, 0, count);
    case 'UInt8':
      return copy;
    case 'Int16':
      return new Int16Array(buffer, 0, count);
    case 'UInt16':
      return new Uint16Array(buffer, 0, count);
    case 'Int32':
      return new Int32Array(buffer, 0, count);
    case 'UInt32':
      return new Uint32Array(buffer, 0, count);
    case 'Float32':
      return new Float32Array(buffer, 0, count);
    case 'Float64':
      return new Float64Array(buffer, 0, count);
    default: {
      const wide = type === 'Int64' ? new BigInt64Array(buffer, 0, count) : new BigUint64Array(buffer, 0, count),
        out = new Float64Array(count);
      for (let i = 0; i < count; i++) {
        out[i] = Number(wide[i]);
        if (!Number.isSafeInteger(out[i]))
          throw new LoaderError(F, 'range', '64-bit integer exceeds exact JavaScript number precision');
      }
      return out;
    }
  }
}

function readAscii(text: string, type: string): Numbers {
  const words = text.trim() ? text.trim().split(/\s+/) : [],
    out = new Float64Array(words.length),
    float = type.startsWith('Float');
  for (let i = 0; i < words.length; i++) {
    const value = Number(words[i]);
    if ((Number.isNaN(value) && !/^[+-]?nan$/i.test(words[i])) || (!float && !Number.isSafeInteger(value)))
      throw new LoaderError(F, 'syntax', `invalid ${type} value "${words[i].slice(0, 32)}"`);
    out[i] = value;
  }
  return out;
}

async function readArray(element: XMLElement, context: Context): Promise<Numbers> {
  const { type, format, offset } = element.attributes,
    name = element.attributes.Name ?? type;
  if (!(type in SIZES))
    throw new LoaderError(
      F,
      'unsupported',
      `array "${String(name).slice(0, 32)}" has type ${String(type).slice(0, 32)}`,
    );
  if ((format ?? 'ascii') === 'ascii') return readAscii(element.text, type);
  let source: Source;
  if (format === 'binary') {
    const text = element.text.replace(/\s+/g, ''),
      { width, compressor } = context;
    // Uncompressed writers differ: the size is its own base64 run, which ends in padding, or one run holds both.
    if (!compressor && text[width === 8 ? 11 : 7] !== '=') source = rawSource(decode64(text), 0);
    else source = base64Source(text, 0);
  } else if (format === 'appended') {
    const start = Number(offset);
    if (!Number.isSafeInteger(start) || start < 0)
      throw new LoaderError(F, 'syntax', `array "${String(name).slice(0, 32)}" has a bad offset`);
    if (context.readAppended) {
      const read = async (at: number, count: number): Promise<Uint8Array> => {
        if (!Number.isSafeInteger(count) || count < 0 || count > context.maxBytes)
          throw new LoaderError(F, 'limit', 'appended array exceeds its byte bound');
        throwIfAborted(context.signal, F);
        const bytes = await context.readAppended!(at, count, context.signal);
        throwIfAborted(context.signal, F);
        if (bytes.length !== count) throw new LoaderError(F, 'truncated', 'appended array ends early');
        return bytes;
      };
      const width = context.width;
      let head = await read(start, (context.compressor ? 3 : 1) * width);
      let length: number;
      if (context.compressor) {
        const blocks = headerInt(head, 0, context);
        head = await read(start, (3 + blocks) * width);
        length = head.length;
        for (let i = 0; i < blocks; i++) length += headerInt(head, 3 + i, context);
      } else length = width + headerInt(head, 0, context);
      source = rawSource(await read(start, length), 0);
    } else if (context.appendedText !== undefined) {
      const text = context.appendedText,
        width = context.width;
      if (!context.compressor && text[start + (width === 8 ? 11 : 7)] !== '=') {
        const header = decode64(text.slice(start, start + Math.ceil(width / 3) * 4));
        const length = width + headerInt(header, 0, context);
        source = rawSource(decode64(text.slice(start, start + Math.ceil(length / 3) * 4)), 0);
      } else source = base64Source(text, start);
    } else if (context.appended) source = rawSource(context.appended, start);
    else throw new LoaderError(F, 'syntax', 'an appended array needs an <AppendedData> element');
  } else throw new LoaderError(F, 'syntax', `unknown array format "${String(format).slice(0, 32)}"`);
  return view(await payload(source, context), type, context.little);
}

const child = (element: XMLElement, name: string): XMLElement | undefined =>
  element.children.find((candidate) => candidate.name === name);
const arrays = (element: XMLElement | undefined): XMLElement[] =>
  element?.children.filter((candidate) => candidate.name === 'DataArray') ?? [];

/** Corner lists of the faces of a volume cell, outward by VTK's ordering of its points. */
const TETRA = [
  [0, 2, 1],
  [0, 1, 3],
  [1, 2, 3],
  [0, 3, 2],
];
const HEXAHEDRON = [
  [0, 3, 2, 1],
  [4, 5, 6, 7],
  [0, 1, 5, 4],
  [1, 2, 6, 5],
  [2, 3, 7, 6],
  [3, 0, 4, 7],
];
const VOXEL = [
  [0, 2, 3, 1],
  [4, 5, 7, 6],
  [0, 1, 5, 4],
  [1, 3, 7, 5],
  [3, 2, 6, 7],
  [2, 0, 4, 6],
];
const WEDGE = [
  [0, 1, 2],
  [3, 5, 4],
  [0, 3, 4, 1],
  [1, 4, 5, 2],
  [2, 5, 3, 0],
];
const PYRAMID = [
  [0, 3, 2, 1],
  [0, 1, 4],
  [1, 2, 4],
  [2, 3, 4],
  [3, 0, 4],
];
function prism(sides: number): number[][] {
  const base = Array.from({ length: sides }, (_, i) => sides - 1 - i),
    top = Array.from({ length: sides }, (_, i) => sides + i),
    faces = [base, top];
  for (let i = 0; i < sides; i++) {
    const next = (i + 1) % sides;
    faces.push([i, next, sides + next, sides + i]);
  }
  return faces;
}
const VOLUMES: Record<number, { corners: number; faces: number[][] }> = {
  10: { corners: 4, faces: TETRA },
  11: { corners: 8, faces: VOXEL },
  12: { corners: 8, faces: HEXAHEDRON },
  13: { corners: 6, faces: WEDGE },
  14: { corners: 5, faces: PYRAMID },
  15: { corners: 10, faces: prism(5) },
  16: { corners: 12, faces: prism(6) },
  24: { corners: 4, faces: TETRA },
  25: { corners: 8, faces: HEXAHEDRON },
};
/** Second-order surface cells, by the corners kept. */
const QUADRATIC: Record<number, number> = { 22: 3, 23: 4 };

class Builder {
  readonly positions = floats();
  readonly triangles = uints();
  readonly cells = uints();
  readonly lines = uints();
  readonly warnings = new Set<string>();
  /** A face of a volume cell by its sorted corners; `null` once two cells share it. */
  readonly faces = new Map<string, { corners: number[]; cell: number } | null>();
  cellCount = 0;
  constructor(
    readonly maxTriangles: number,
    readonly outer: boolean,
  ) {}
  check(index: number, points: number): number {
    if (!(index >= 0 && index < points && Number.isInteger(index)))
      throw new LoaderError(F, 'range', `cell index ${index} is outside 0..${points - 1}`);
    return index;
  }
  polygon(corners: number[], cell: number): void {
    for (let c = 1; c + 1 < corners.length; c++) {
      if (this.triangles.length / 3 >= this.maxTriangles)
        throw new LoaderError(F, 'limit', `triangle count exceeds the limit of ${this.maxTriangles}`);
      this.triangles.push3(corners[0], corners[c], corners[c + 1]);
      this.cells.push(cell);
    }
  }
  strip(corners: number[], cell: number): void {
    for (let c = 0; c + 2 < corners.length; c++)
      this.polygon(
        c % 2 ? [corners[c + 1], corners[c], corners[c + 2]] : [corners[c], corners[c + 1], corners[c + 2]],
        cell,
      );
  }
  polyline(corners: number[]): void {
    for (let c = 0; c + 1 < corners.length; c++) {
      this.lines.push(corners[c]);
      this.lines.push(corners[c + 1]);
    }
  }
  face(corners: number[], cell: number): void {
    if (!this.outer) {
      this.polygon(corners, cell);
      return;
    }
    const id = [...corners].sort((a, b) => a - b).join(' ');
    this.faces.set(id, this.faces.has(id) ? null : { corners, cell });
  }
  finish(): void {
    for (const face of this.faces.values()) if (face) this.polygon(face.corners, face.cell);
  }
}

function polyCells(
  connectivity: Numbers,
  offsets: Numbers,
  points: number,
  each: (corners: number[], i: number) => void,
  builder: Builder,
): void {
  let start = 0;
  for (let i = 0; i < offsets.length; i++) {
    const end = offsets[i];
    if (!(end >= start && end <= connectivity.length))
      throw new LoaderError(F, 'range', `cell offset ${end} is outside the connectivity`);
    const corners: number[] = [];
    for (let k = start; k < end; k++) corners.push(builder.check(connectivity[k], points));
    each(corners, i);
    start = end;
  }
}

async function cellArrays(element: XMLElement, context: Context): Promise<Record<string, Numbers>> {
  const found: Record<string, Numbers> = Object.create(null);
  for (const array of arrays(element)) found[array.attributes.Name] = await readArray(array, context);
  return found;
}

function gridCell(
  type: number,
  corners: number[],
  cell: number,
  builder: Builder,
  stream: Numbers | undefined,
  from: number,
  points: number,
  base: number,
): void {
  const volume = VOLUMES[type];
  if (volume) {
    if (corners.length < volume.corners)
      throw new LoaderError(F, 'range', `cell ${cell} of type ${type} has ${corners.length} points`);
    if (type >= 21) builder.warnings.add('second-order cells are drawn from their corner points');
    for (const face of volume.faces)
      builder.face(
        face.map((k) => corners[k]),
        cell,
      );
    return;
  }
  switch (type) {
    case 1:
    case 2:
      return; // Vertex cells: their points are in `positions` already.
    case 3:
    case 4:
      builder.polyline(corners);
      return;
    case 21:
      builder.warnings.add('second-order cells are drawn from their corner points');
      builder.polyline(corners.slice(0, 2));
      return;
    case 5:
    case 7:
    case 9:
      builder.polygon(corners, cell);
      return;
    case 6:
      builder.strip(corners, cell);
      return;
    case 8:
      builder.polygon([corners[0], corners[1], corners[3], corners[2]], cell);
      return;
    case 22:
    case 23:
      builder.warnings.add('second-order cells are drawn from their corner points');
      builder.polygon(corners.slice(0, QUADRATIC[type]), cell);
      return;
    case 42: {
      if (!stream) throw new LoaderError(F, 'syntax', `polyhedron ${cell} has no faces array`);
      let at = from;
      const count = stream[at++];
      for (let f = 0; f < count; f++) {
        const size = stream[at++],
          face: number[] = [];
        if (!(at + size <= stream.length))
          throw new LoaderError(F, 'range', `polyhedron ${cell} runs past its faces array`);
        for (let k = 0; k < size; k++) face.push(builder.check(stream[at++], points) + base);
        builder.face(face, cell);
      }
      return;
    }
    default:
      builder.warnings.add(`cell type ${type} is not drawn`);
  }
}

/** Splits the file at raw appended data, which is not XML, and reads its encoding. */
function splitAppended(bytes: Uint8Array): { xml: string; appended?: Uint8Array; appendedText?: string } {
  const text = latin1(bytes),
    tag = text.indexOf('<AppendedData');
  if (tag < 0) return { xml: new TextDecoder().decode(bytes) };
  const close = text.indexOf('>', tag),
    mark = text.indexOf('_', close);
  if (close < 0 || mark < 0) throw new LoaderError(F, 'truncated', '<AppendedData> has no data');
  const xml = `${new TextDecoder().decode(bytes.subarray(0, tag))}</VTKFile>`;
  if (/encoding\s*=\s*["']raw["']/.test(text.slice(tag, close))) return { xml, appended: bytes.subarray(mark + 1) };
  const end = text.indexOf('<', mark);
  return { xml, appendedText: text.slice(mark + 1, end < 0 ? text.length : end).replace(/\s+/g, '') };
}

/** Lazy numeric array, decoded by the same array reader as parseVTKXML. */
export interface VTKXMLArray {
  readonly name: string;
  readonly type: string;
  readonly components: number;
  read(signal?: AbortSignal): Promise<Float64Array>;
}

/** One source piece, without triangulation or loss of its volume topology. */
export interface VTKXMLPiece {
  readonly attributes: Readonly<Record<string, string>>;
  readonly pointData: Readonly<Record<string, VTKXMLArray>>;
  readonly cellData: Readonly<Record<string, VTKXMLArray>>;
  readonly points?: VTKXMLArray;
  readonly cells: Readonly<Record<string, VTKXMLArray>>;
}

/** The file metadata. Numeric payloads are read only on demand. */
export interface VTKXMLDataset {
  readonly type: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly pieces: readonly VTKXMLPiece[];
}

/** Lazy dataset options. The appended callback is for raw binary offsets relative to the underscore. */
export interface VTKXMLDatasetOptions extends VTKXMLOptions {
  /** Maximum decoded array bytes. Default 256 MiB. */
  maxBytes?: number;
  readAppended?: (offset: number, length: number, signal?: AbortSignal) => Promise<Uint8Array>;
}

function xmlContext(bytes: Uint8Array, maxBytes: number, signal?: AbortSignal): { file: XMLElement; context: Context } {
  throwIfAborted(signal, F);
  const { xml, appended, appendedText } = splitAppended(bytes),
    file = child(readXMLTree(xml, F), 'VTKFile');
  if (!file) throw new LoaderError(F, 'header', 'no <VTKFile> element');
  const { byte_order: order, header_type: headerType, compressor: named } = file.attributes;
  if (order !== undefined && order !== 'LittleEndian' && order !== 'BigEndian')
    throw new LoaderError(F, 'header', 'byte_order must be LittleEndian or BigEndian');
  if (headerType !== undefined && headerType !== 'UInt32' && headerType !== 'UInt64')
    throw new LoaderError(F, 'header', `unknown header_type "${headerType.slice(0, 32)}"`);
  let compressor: Context['compressor'];
  if (named === 'vtkZLibDataCompressor') compressor = 'zlib';
  else if (named === 'vtkLZ4DataCompressor') compressor = 'lz4';
  else if (named === 'vtkLZMADataCompressor') compressor = 'lzma';
  else if (named) throw new LoaderError(F, 'unsupported', `compressor "${named.slice(0, 32)}" is not read`);
  return {
    file,
    context: {
      little: order !== 'BigEndian',
      width: headerType === 'UInt64' ? 8 : 4,
      compressor,
      appended,
      appendedText,
      maxBytes,
      signal,
    },
  };
}

/**
 * Opens .vtu/.vti/.vts/.vtp metadata and lazy arrays. No geometry is discarded or tessellated.
 * A raw-appended header may end after the underscore when readAppended supplies the remaining file.
 * Inline and base64 arrays remain in the supplied input, while raw appended arrays can use HTTP Range.
 */
export function openVTKXMLDataset(input: BinaryInput, options: VTKXMLDatasetOptions = {}): VTKXMLDataset {
  const maxBytes = options.maxBytes ?? 256 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new LoaderError(F, 'limit', 'maxBytes must be a positive safe integer');
  const { file, context } = xmlContext(toBytes(input, F), maxBytes, options.signal),
    type = file.attributes.type;
  if (!['PolyData', 'UnstructuredGrid', 'ImageData', 'StructuredGrid'].includes(type))
    throw new LoaderError(F, 'unsupported', `dataset type "${String(type).slice(0, 32)}" is not read`);
  const dataset = child(file, type);
  if (!dataset) throw new LoaderError(F, 'syntax', `no <${type}> element`);
  context.readAppended = options.readAppended;
  const entry = (array: XMLElement): VTKXMLArray => {
    const components = Number(array.attributes.NumberOfComponents ?? 1);
    if (!Number.isSafeInteger(components) || components < 1 || !(array.attributes.type in SIZES))
      throw new LoaderError(F, 'syntax', 'invalid array components or type');
    return {
      name: array.attributes.Name ?? '',
      type: array.attributes.type,
      components,
      async read(signal) {
        const joined =
          signal && context.signal ? AbortSignal.any([signal, context.signal]) : (signal ?? context.signal);
        throwIfAborted(joined, F);
        const values = await readArray(array, { ...context, signal: joined });
        if (values.length * 8 > maxBytes) throw new LoaderError(F, 'limit', 'float64 array exceeds maxBytes');
        throwIfAborted(joined, F);
        return Float64Array.from(values);
      },
    };
  };
  const fields = (owner?: XMLElement): Record<string, VTKXMLArray> => {
    const out: Record<string, VTKXMLArray> = Object.create(null);
    for (const array of arrays(owner)) {
      const value = entry(array);
      if (Object.hasOwn(out, value.name)) throw new LoaderError(F, 'syntax', 'duplicate array name');
      out[value.name] = value;
    }
    return out;
  };
  const pieces = dataset.children
    .filter((p) => p.name === 'Piece')
    .map((p) => ({
      attributes: { ...p.attributes },
      pointData: fields(child(p, 'PointData')),
      cellData: fields(child(p, 'CellData')),
      points: arrays(child(p, 'Points'))[0] ? entry(arrays(child(p, 'Points'))[0]) : undefined,
      cells: fields(child(p, 'Cells')),
    }));
  if (!pieces.length) throw new LoaderError(F, 'syntax', 'dataset has no pieces');
  return { type, attributes: { ...dataset.attributes }, pieces };
}

/**
 * Reads a VTK XML file, the output of ParaView and most simulation tools: `.vtp` PolyData and `.vtu` unstructured grids
 * with ascii, binary and appended arrays (raw or base64), either byte order, 32 or 64-bit headers and zlib, LZ4 or LZMA
 * blocks. Polygons and strips become triangles over the file's points, polylines become `lines`, and volume cells are
 * reduced to the faces only one cell owns (their outer surface). `Normals`, `TCoords` and a 3 or 4 component `UInt8`
 * `Scalars` array fill `normals`, `uvs` and `colors`; every array is in `pointData` or `cellData`.
 *
 * @param input The file's bytes.
 * @param options The shared size limits, which faces to keep and an AbortSignal.
 * @returns The merged geometry and its data arrays.
 * @throws LoaderError with code `header`, `syntax`, `truncated`, `range`, `limit`, `zip`, `aborted` or `unsupported`
 * (other dataset types).
 *
 * @example
 * ```ts
 * import { parseVTKXML } from '@margoengine/loaders/vtk-xml';
 *
 * const file = `<VTKFile type="PolyData"><PolyData><Piece NumberOfPoints="3" NumberOfPolys="1">
 *   <Points><DataArray type="Float32" NumberOfComponents="3" format="ascii">0 0 0 1 0 0 0 1 0</DataArray></Points>
 *   <Polys><DataArray type="Int32" Name="connectivity" format="ascii">0 1 2</DataArray>
 *   <DataArray type="Int32" Name="offsets" format="ascii">3</DataArray></Polys>
 * </Piece></PolyData></VTKFile>`;
 * const { positions, indices } = await parseVTKXML(new TextEncoder().encode(file));
 * console.log(positions.length, indices);
 * ```
 */
export async function parseVTKXML(input: BinaryInput, options: VTKXMLOptions = {}): Promise<VTKXMLResult> {
  const bytes = toBytes(input, F),
    { maxVertices, maxTriangles } = limits(options, F),
    { signal, surface = 'outer' } = options;
  throwIfAborted(signal, F);
  if (surface !== 'outer' && surface !== 'all') throw new LoaderError(F, 'range', 'surface must be "outer" or "all"');
  const { file, context } = xmlContext(bytes, maxVertices * 128 + maxTriangles * 128, signal);
  const { type } = file.attributes;
  if (type !== 'PolyData' && type !== 'UnstructuredGrid')
    throw new LoaderError(F, 'unsupported', `dataset type "${String(type).slice(0, 32)}" is not read`);
  const dataset = child(file, type);
  if (!dataset) throw new LoaderError(F, 'syntax', `no <${type}> element`);
  const builder = new Builder(maxTriangles, surface === 'outer'),
    pointArrays = new Map<string, { components: number; parts: Numbers[] }>(),
    cellFields = new Map<string, { components: number; parts: Numbers[] }>();
  let base = 0,
    normalsName: string | undefined,
    uvsName: string | undefined,
    colorsName: string | undefined;

  const collect = async (
    owner: XMLElement | undefined,
    into: Map<string, { components: number; parts: Numbers[] }>,
    expected: number,
  ): Promise<void> => {
    for (const array of arrays(owner)) {
      const { Name: name = '', type: arrayType, NumberOfComponents: count } = array.attributes;
      if (arrayType === 'String') {
        builder.warnings.add('string arrays are not read');
        continue;
      }
      const components = Number(count ?? 1),
        values = await readArray(array, context);
      if (!Number.isSafeInteger(components) || components < 1)
        throw new LoaderError(F, 'syntax', `array "${name.slice(0, 32)}" has a bad component count`);
      if (values.length !== expected * components)
        throw new LoaderError(
          F,
          'syntax',
          `array "${name.slice(0, 32)}" has ${values.length} values, expected ${expected * components}`,
        );
      let entry = into.get(name);
      if (!entry) into.set(name, (entry = { components, parts: [] }));
      entry.parts.push(values);
    }
  };

  for (const piece of dataset.children) {
    if (piece.name !== 'Piece') continue;
    throwIfAborted(signal, F);
    const points = checkCount(Number(piece.attributes.NumberOfPoints ?? 0), maxVertices - base, F, 'point');
    const pointsArray = arrays(child(piece, 'Points'))[0];
    if (!pointsArray) throw new LoaderError(F, 'syntax', 'a piece has no <Points> array');
    const coordinates = await readArray(pointsArray, context);
    if (coordinates.length !== points * 3)
      throw new LoaderError(F, 'syntax', `<Points> has ${coordinates.length} values for ${points} points`);
    for (let i = 0; i < coordinates.length; i += 3)
      builder.positions.push3(coordinates[i], coordinates[i + 1], coordinates[i + 2]);
    const pointData = child(piece, 'PointData');
    normalsName ??= pointData?.attributes.Normals;
    uvsName ??= pointData?.attributes.TCoords;
    const scalars = pointData?.attributes.Scalars;
    if (
      scalars &&
      arrays(pointData).some(
        (a) =>
          a.attributes.Name === scalars &&
          a.attributes.type === 'UInt8' &&
          Number(a.attributes.NumberOfComponents) >= 3,
      )
    )
      colorsName ??= scalars;
    await collect(pointData, pointArrays, points);

    const firstCell = builder.cellCount;
    let cells = 0;
    const offsetIndex = (corners: number[]): number[] => corners.map((corner) => corner + base);
    if (type === 'PolyData') {
      for (const name of ['Verts', 'Lines', 'Strips', 'Polys']) {
        const owner = child(piece, name);
        if (!owner) continue;
        const { connectivity, offsets } = await cellArrays(owner, context);
        if (!connectivity || !offsets) throw new LoaderError(F, 'syntax', `<${name}> needs connectivity and offsets`);
        polyCells(
          connectivity,
          offsets,
          points,
          (corners, i) => {
            const shifted = offsetIndex(corners),
              cell = firstCell + cells + i;
            if (name === 'Lines') builder.polyline(shifted);
            else if (name === 'Strips') builder.strip(shifted, cell);
            else if (name === 'Polys') builder.polygon(shifted, cell);
          },
          builder,
        );
        cells += offsets.length;
      }
    } else {
      const owner = child(piece, 'Cells');
      if (!owner) throw new LoaderError(F, 'syntax', 'a piece has no <Cells>');
      const { connectivity, offsets, types, faces, faceoffsets } = await cellArrays(owner, context);
      if (!connectivity || !offsets || !types)
        throw new LoaderError(F, 'syntax', '<Cells> needs connectivity, offsets and types');
      if (types.length !== offsets.length)
        throw new LoaderError(F, 'syntax', `<Cells> has ${types.length} types for ${offsets.length} offsets`);
      let faceStart = 0;
      polyCells(
        connectivity,
        offsets,
        points,
        (corners, i) => {
          gridCell(types[i], offsetIndex(corners), firstCell + i, builder, faces, faceStart, points, base);
          // faceoffsets holds where each polyhedron's faces end, and -1 for every other cell.
          if (faceoffsets && faceoffsets[i] >= 0) faceStart = faceoffsets[i];
        },
        builder,
      );
      cells = offsets.length;
    }
    await collect(child(piece, 'CellData'), cellFields, cells);
    builder.cellCount += cells;
    base += points;
  }
  if (!base) throw new LoaderError(F, 'syntax', 'the file has no points');
  builder.finish();

  const merge = (
    fields: Map<string, { components: number; parts: Numbers[] }>,
    count: number,
  ): Record<string, VTKField> => {
    const out: Record<string, VTKField> = Object.create(null);
    for (const [name, { components, parts }] of fields) {
      const values = new Float32Array(count * components);
      let at = 0;
      for (const part of parts) {
        if (at + part.length > values.length)
          throw new LoaderError(F, 'syntax', `array "${name.slice(0, 32)}" does not match its pieces`);
        values.set(part, at);
        at += part.length;
      }
      if (at !== values.length)
        throw new LoaderError(F, 'syntax', `array "${name.slice(0, 32)}" is not in every piece`);
      out[name] = { components, values };
    }
    return out;
  };
  const pointData = merge(pointArrays, base),
    cellData = merge(cellFields, builder.cellCount),
    triangles = builder.triangles.result();
  const result: VTKXMLResult = {
    kind: triangles.length || builder.lines.length ? 'mesh' : 'points',
    type,
    positions: builder.positions.result(),
    lines: builder.lines.result(),
    triangleCells: builder.cells.result(),
    pointData,
    cellData,
    cellCount: builder.cellCount,
    warnings: [...builder.warnings],
  };
  if (triangles.length) result.indices = triangles;
  const normals = normalsName === undefined ? undefined : pointData[normalsName];
  if (normals?.components === 3) result.normals = normals.values;
  const uvs = uvsName === undefined ? undefined : pointData[uvsName];
  if (uvs && uvs.components >= 2) {
    const pairs = new Float32Array(base * 2);
    for (let i = 0; i < base; i++) {
      pairs[i * 2] = uvs.values[i * uvs.components];
      pairs[i * 2 + 1] = 1 - uvs.values[i * uvs.components + 1];
    }
    result.uvs = pairs;
  }
  const colors = colorsName === undefined ? undefined : pointData[colorsName];
  if (colors) {
    const rgb = new Float32Array(base * 3);
    for (let i = 0; i < base; i++)
      for (let c = 0; c < 3; c++) rgb[i * 3 + c] = colors.values[i * colors.components + c] / 255;
    result.colors = rgb;
  }
  const attributes: Record<string, Float32Array> = Object.create(null);
  for (const name in pointData) if (pointData[name].components === 1) attributes[name] = pointData[name].values;
  if (Object.keys(attributes).length) result.attributes = attributes;
  return result;
}
