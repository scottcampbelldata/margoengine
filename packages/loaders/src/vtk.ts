import { LoaderError, type LoadedGeometry, type ParseLimits } from './types.js';
import { checkCount, latin1, limits, TextScanner, toBytes, uints, type BinaryInput } from './util.js';

const F = 'VTK';
const SIZES: Record<string, number> = {
  bit: 0,
  unsigned_char: 1,
  char: 1,
  unsigned_short: 2,
  short: 2,
  unsigned_int: 4,
  int: 4,
  unsigned_long: 8,
  long: 8,
  float: 4,
  double: 8,
  vtktypeint8: 1,
  vtktypeuint8: 1,
  vtktypeint16: 2,
  vtktypeuint16: 2,
  vtktypeint32: 4,
  vtktypeuint32: 4,
  vtktypeint64: 8,
  vtktypeuint64: 8,
  vtkidtype: 8,
};

export interface VTKOptions extends ParseLimits {}

class Reader {
  pos = 0;
  private scanner?: TextScanner;
  constructor(
    readonly bytes: Uint8Array,
    binary: boolean,
    readonly maxValues: number,
  ) {
    if (!binary) this.scanner = new TextScanner(latin1(bytes), F);
  }
  get binary(): boolean {
    return !this.scanner;
  }
  mark(): number {
    return this.scanner ? this.scanner.pos : this.pos;
  }
  reset(mark: number): void {
    if (this.scanner) this.scanner.pos = mark;
    else this.pos = mark;
  }
  /** Reads one raw line; returns null at end of file. */
  line(): string | null {
    if (this.scanner) return this.scanner.line();
    const bytes = this.bytes;
    if (this.pos >= bytes.length) return null;
    let end = bytes.indexOf(10, this.pos);
    if (end < 0) end = bytes.length;
    const line = latin1(bytes, this.pos, Math.min(end, this.pos + 4096));
    this.pos = end + 1;
    return line.endsWith('\r') ? line.slice(0, -1) : line;
  }
  /** Next non-blank line, split into tokens. */
  keyword(): string[] | null {
    for (;;) {
      const line = this.line();
      if (line === null) return null;
      const trimmed = line.trim();
      if (trimmed) return trimmed.split(/\s+/);
    }
  }
  /** Reads `count` values of `type` (`binary` big-endian, or whitespace separated text). */
  values(type: string, count: number, what: string, forceType?: string): Float64Array {
    const kind = (forceType ?? type).toLowerCase();
    const size = Object.hasOwn(SIZES, kind) ? SIZES[kind] : undefined;
    if (size === undefined)
      throw new LoaderError(F, 'unsupported', `unknown data type "${type.slice(0, 32)}" in ${what}`);
    if (size === 0) throw new LoaderError(F, 'unsupported', `bit arrays are not supported (${what})`);
    if (!Number.isSafeInteger(count) || count < 0)
      throw new LoaderError(F, 'header', `invalid value count ${count} in ${what}`);
    if (count > this.maxValues)
      throw new LoaderError(F, 'limit', `${what} has ${count} values, more than the limit of ${this.maxValues}`);
    if (this.scanner) {
      if (count * 2 > this.scanner.text.length - this.scanner.pos + 1)
        throw new LoaderError(F, 'truncated', `file ends inside ${what}`);
      const out = new Float64Array(count);
      for (let i = 0; i < count; i++) out[i] = this.scanner.number(what);
      return out;
    }
    if (this.pos + count * size > this.bytes.length)
      throw new LoaderError(F, 'truncated', `binary data ends inside ${what}`);
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.pos, count * size),
      out = new Float64Array(count);
    const integer = kind !== 'float' && kind !== 'double',
      unsigned = kind.startsWith('unsigned') || kind.startsWith('vtktypeuint');
    for (let i = 0, o = 0; i < count; i++, o += size) {
      if (!integer) out[i] = size === 4 ? view.getFloat32(o) : view.getFloat64(o);
      else if (size === 1) out[i] = unsigned ? view.getUint8(o) : view.getInt8(o);
      else if (size === 2) out[i] = unsigned ? view.getUint16(o) : view.getInt16(o);
      else if (size === 4) out[i] = unsigned ? view.getUint32(o) : view.getInt32(o);
      else out[i] = Number(unsigned ? view.getBigUint64(o) : view.getBigInt64(o));
    }
    this.pos += count * size;
    return out;
  }
}

const integerOf = (token: string | undefined, what: string): number => {
  const value = Number(token);
  if (token === undefined || !Number.isSafeInteger(value) || value < 0)
    throw new LoaderError(F, 'header', `invalid ${what} "${String(token).slice(0, 32)}"`);
  return value;
};

/**
 * Parses a legacy VTK file (`# vtk DataFile Version` 1.0 to 5.1, ASCII or BINARY) holding `DATASET POLYDATA`.
 * Replaces the legacy part of Three.js `VTKLoader`. POLYGONS are fan-triangulated, TRIANGLE_STRIPS unrolled
 * with alternating winding, VERTICES and LINES ignored (a file with only those is returned as a point cloud).
 * Point NORMALS, COLOR_SCALARS, TEXTURE_COORDINATES and single-component SCALARS are read; cell data is skipped.
 */
export function parseVTK(input: BinaryInput, options: VTKOptions = {}): LoadedGeometry {
  const bytes = toBytes(input, F),
    limit = limits(options, F);
  const head = latin1(bytes, 0, Math.min(bytes.length, 1024));
  const firstLine = /^# vtk DataFile Version (\d+)\.(\d+)/.exec(head);
  if (!firstLine) throw new LoaderError(F, 'header', 'missing "# vtk DataFile Version" line');
  const major = Number(firstLine[1]);
  const lines = head.split('\n');
  if (lines.length < 3) throw new LoaderError(F, 'truncated', 'header ends early');
  const mode = lines[2].trim().toUpperCase();
  if (mode !== 'ASCII' && mode !== 'BINARY')
    throw new LoaderError(F, 'header', `third line must be ASCII or BINARY, got "${lines[2].trim().slice(0, 32)}"`);
  const maxValues = Math.max(limit.maxVertices * 4, limit.maxTriangles * 4);
  const reader = new Reader(bytes, mode === 'BINARY', maxValues);
  reader.line();
  reader.line();
  reader.line();

  let positions: Float32Array | undefined,
    normals: Float32Array | undefined,
    colors: Float32Array | undefined,
    uvs: Float32Array | undefined;
  // Null prototype: SCALARS names come from the file (`SCALARS __proto__ float` swapped a plain object's prototype).
  const attributes: Record<string, Float32Array> = Object.create(null);
  const indices = uints();
  let pointCount = 0,
    section: 'none' | 'point' | 'cell' = 'none',
    sectionCount = 0,
    dataset = false;
  const toFloat32 = (values: Float64Array, stride: number, take: number): Float32Array => {
    const count = values.length / stride,
      out = new Float32Array(count * take);
    for (let i = 0; i < count; i++) for (let a = 0; a < take; a++) out[i * take + a] = values[i * stride + a];
    return out;
  };
  const triangleLimit = (extra: number): void => {
    if (indices.length / 3 + extra > limit.maxTriangles)
      throw new LoaderError(F, 'limit', `triangle count exceeds the limit of ${limit.maxTriangles}`);
  };
  const emitCell = (kind: string, cell: ArrayLike<number>, start: number, size: number): void => {
    for (let k = start; k < start + size; k++) {
      const index = cell[k];
      if (!Number.isSafeInteger(index) || index < 0 || index >= 0xffffffff)
        throw new LoaderError(F, 'range', `${kind} index ${index} is not a valid point index`);
    }
    if (kind === 'POLYGONS') {
      if (size < 3) return;
      triangleLimit(size - 2);
      for (let k = 2; k < size; k++) indices.push3(cell[start], cell[start + k - 1], cell[start + k]);
    } else if (kind === 'TRIANGLE_STRIPS') {
      triangleLimit(Math.max(0, size - 2));
      for (let k = 0; k + 2 < size; k++) {
        const a = cell[start + k],
          b = cell[start + k + 1],
          c = cell[start + k + 2];
        if (a === b || b === c || a === c) continue;
        if (k % 2) indices.push3(b, a, c);
        else indices.push3(a, b, c);
      }
    }
  };

  for (let tokens = reader.keyword(); tokens; tokens = reader.keyword()) {
    const key = tokens[0].toUpperCase();
    const what = tokens.join(' ').slice(0, 64);
    if (key === 'DATASET') {
      if ((tokens[1] ?? '').toUpperCase() !== 'POLYDATA')
        throw new LoaderError(F, 'unsupported', `only DATASET POLYDATA is supported, got ${tokens[1] ?? 'nothing'}`);
      dataset = true;
    } else if (key === 'POINTS') {
      pointCount = checkCount(integerOf(tokens[1], 'point count'), limit.maxVertices, F, 'point');
      positions = toFloat32(reader.values(tokens[2] ?? 'float', pointCount * 3, what), 3, 3);
    } else if (key === 'METADATA') {
      for (let line = reader.line(); line !== null && line.trim(); line = reader.line());
    } else if (key === 'VERTICES' || key === 'LINES' || key === 'POLYGONS' || key === 'TRIANGLE_STRIPS') {
      const cells = integerOf(tokens[1], `${key} count`),
        size = integerOf(tokens[2], `${key} size`);
      if (major >= 5) {
        // 5.x: "POLYGONS <offsets> <connectivity>", then OFFSETS and CONNECTIVITY arrays.
        const offsetsLine = reader.keyword();
        if (offsetsLine?.[0]?.toUpperCase() !== 'OFFSETS')
          throw new LoaderError(F, 'syntax', `expected OFFSETS after ${key}`);
        const offsets = reader.values(offsetsLine[1] ?? 'vtktypeint64', cells, `${key} offsets`);
        const connectivityLine = reader.keyword();
        if (connectivityLine?.[0]?.toUpperCase() !== 'CONNECTIVITY')
          throw new LoaderError(F, 'syntax', `expected CONNECTIVITY after ${key} offsets`);
        const connectivity = reader.values(connectivityLine[1] ?? 'vtktypeint64', size, `${key} connectivity`);
        for (let c = 0; c + 1 < cells; c++) {
          const start = offsets[c],
            end = offsets[c + 1];
          if (!(Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end >= start && end <= size))
            throw new LoaderError(F, 'range', `${key} offsets are not increasing within the connectivity array`);
          emitCell(key, connectivity, start, end - start);
        }
      } else {
        const data = reader.values('int', size, key);
        let p = 0;
        for (let c = 0; c < cells; c++) {
          if (p >= size)
            throw new LoaderError(
              F,
              'range',
              `${key} declares ${cells} cells but its size ${size} runs out at cell ${c}`,
            );
          const count = data[p];
          if (!Number.isSafeInteger(count) || count < 0 || p + 1 + count > size)
            throw new LoaderError(F, 'range', `${key} cell ${c} has an invalid point count ${count}`);
          emitCell(key, data, p + 1, count);
          p += 1 + count;
        }
        if (p !== size) throw new LoaderError(F, 'range', `${key} size ${size} does not match its cells (${p})`);
      }
    } else if (key === 'POINT_DATA' || key === 'CELL_DATA') {
      section = key === 'POINT_DATA' ? 'point' : 'cell';
      sectionCount = integerOf(tokens[1], `${key} count`);
      if (sectionCount > maxValues) throw new LoaderError(F, 'limit', `${key} count ${sectionCount} exceeds the limit`);
      if (section === 'point' && positions && sectionCount !== pointCount)
        throw new LoaderError(F, 'range', `POINT_DATA ${sectionCount} does not match POINTS ${pointCount}`);
    } else if (key === 'SCALARS') {
      if (section === 'none') throw new LoaderError(F, 'syntax', 'SCALARS outside POINT_DATA or CELL_DATA');
      const components = tokens[3] ? integerOf(tokens[3], 'SCALARS component count') : 1;
      if (components < 1 || components > 4)
        throw new LoaderError(F, 'range', `SCALARS component count ${components} must be 1 to 4`);
      // LOOKUP_TABLE is required by the legacy format but optional in practice; peek for it.
      const mark = reader.mark();
      if (reader.keyword()?.[0]?.toUpperCase() !== 'LOOKUP_TABLE') reader.reset(mark);
      const values = reader.values(tokens[2] ?? 'float', sectionCount * components, what);
      if (section === 'point' && components === 1) attributes[tokens[1]] = Float32Array.from(values);
    } else if (key === 'LOOKUP_TABLE') {
      const size = integerOf(tokens[2], 'LOOKUP_TABLE size');
      reader.values(reader.binary ? 'unsigned_char' : 'float', size * 4, what);
    } else if (key === 'COLOR_SCALARS') {
      if (section === 'none') throw new LoaderError(F, 'syntax', 'COLOR_SCALARS outside POINT_DATA or CELL_DATA');
      const components = integerOf(tokens[2], 'COLOR_SCALARS component count');
      if (components < 1 || components > 4)
        throw new LoaderError(F, 'range', `COLOR_SCALARS component count ${components} must be 1 to 4`);
      const values = reader.values(reader.binary ? 'unsigned_char' : 'float', sectionCount * components, what);
      if (section === 'point' && components >= 3) {
        colors = toFloat32(values, components, 3);
        if (reader.binary) for (let i = 0; i < colors.length; i++) colors[i] /= 255;
      }
    } else if (key === 'NORMALS' || key === 'VECTORS') {
      const values = reader.values(tokens[2] ?? 'float', sectionCount * 3, what);
      if (section === 'point' && key === 'NORMALS') normals = toFloat32(values, 3, 3);
    } else if (key === 'TEXTURE_COORDINATES') {
      const dimension = integerOf(tokens[2], 'TEXTURE_COORDINATES dimension');
      if (dimension < 1 || dimension > 3)
        throw new LoaderError(F, 'range', `TEXTURE_COORDINATES dimension ${dimension} must be 1 to 3`);
      const values = reader.values(tokens[3] ?? 'float', sectionCount * dimension, what);
      if (section === 'point' && dimension >= 2) uvs = toFloat32(values, dimension, 2);
    } else if (key === 'TENSORS' || key === 'TENSORS6') {
      reader.values(tokens[2] ?? 'float', sectionCount * (key === 'TENSORS' ? 9 : 6), what);
    } else if (key === 'GLOBAL_IDS' || key === 'PEDIGREE_IDS') {
      reader.values(tokens[2] ?? 'int', sectionCount, what);
    } else if (key === 'FIELD') {
      const arrays = integerOf(tokens[2], 'FIELD array count');
      for (let a = 0; a < arrays; a++) {
        const array = reader.keyword();
        if (!array) throw new LoaderError(F, 'truncated', 'file ends inside FIELD');
        if (array[0].toUpperCase() === 'METADATA') {
          for (let line = reader.line(); line !== null && line.trim(); line = reader.line());
          a--;
          continue;
        }
        const components = integerOf(array[1], 'FIELD component count'),
          tuples = integerOf(array[2], 'FIELD tuple count');
        reader.values(array[3] ?? 'float', components * tuples, `FIELD array ${array[0].slice(0, 32)}`);
      }
    } else throw new LoaderError(F, 'syntax', `unknown keyword "${tokens[0].slice(0, 32)}"`);
  }
  if (!dataset) throw new LoaderError(F, 'header', 'missing DATASET line');
  if (!positions) throw new LoaderError(F, 'syntax', 'missing POINTS');
  const triangles = indices.result();
  for (let i = 0; i < triangles.length; i++)
    if (!(triangles[i] < pointCount))
      throw new LoaderError(F, 'range', `cell index ${triangles[i]} is outside 0..${pointCount - 1}`);
  const result: LoadedGeometry = { kind: triangles.length ? 'mesh' : 'points', positions };
  if (normals) result.normals = normals;
  if (colors) result.colors = colors;
  if (uvs) result.uvs = uvs;
  if (triangles.length) result.indices = triangles;
  if (Object.keys(attributes).length) result.attributes = attributes;
  return result;
}
