import { LoaderError, type LoadedGeometry, type ParseLimits } from './types.js';
import { limits, toBytes, throwIfAborted, uints, type BinaryInput } from './util.js';
import { Reader, integerOf } from './vtk-reader.js';
import { Builder, gridCell } from './vtk-cells.js';

const F = 'VTK legacy';
const fixedCorners: Record<number, number> = {
  1: 1,
  3: 2,
  5: 3,
  8: 4,
  9: 4,
  10: 4,
  11: 8,
  12: 8,
  13: 6,
  14: 5,
  15: 10,
  16: 12,
  21: 3,
  22: 6,
  23: 8,
  24: 10,
  25: 20,
};
/** One numeric legacy dataset array, without conversion to float32. */
export interface VTKLegacyField {
  /** Values per tuple. */
  components: number;
  /** Owned tuple-major values, retaining double precision. */
  values: Float64Array;
}
/** Legacy topology, source arrays and renderable surface/line/vertex indices. */
export interface VTKLegacyResult extends LoadedGeometry {
  /** The source DATASET keyword. */
  type: string;
  /** Structured point dimensions, x fastest. */
  dimensions?: [number, number, number];
  /** Structured point origin. */
  origin?: [number, number, number];
  /** Structured point spacing. */
  spacing?: [number, number, number];
  /** Cell offsets with a leading zero and final connectivity length. */
  offsets: Uint32Array;
  /** Original cell connectivity, including volume cells. */
  connectivity: Uint32Array;
  /** Original VTK cell type per cell. */
  cellTypes: Uint32Array;
  /** Number of source cells. */
  cellCount: number;
  /** Two point indices per polyline segment. */
  lines: Uint32Array;
  /** Source cell per line segment. */
  lineCells: Uint32Array;
  /** Explicit VERTEX/POLY_VERTEX point indices. */
  vertices: Uint32Array;
  /** Source cell per explicit vertex index. */
  vertexCells: Uint32Array;
  /** Source cell per output surface triangle. */
  triangleCells: Uint32Array;
  /** Every POINT_DATA array, keyed safely by file-supplied name. */
  pointData: Record<string, VTKLegacyField>;
  /** Every CELL_DATA array in source cell order. */
  cellData: Record<string, VTKLegacyField>;
  /** Global FIELD arrays. */
  fieldData: Record<string, VTKLegacyField>;
  /** Explicit differences in the drawing of higher-order or unknown cells. Topology remains intact. */
  warnings: string[];
}
/** Limits and surface policy for parseVTKLegacy. */
export interface VTKLegacyOptions extends ParseLimits {
  /** Maximum source cells. Default maxTriangles (16,000,000). */
  maxCells?: number;
  /** Outer volume faces only by default; all retains internal faces. */
  surface?: 'outer' | 'all';
  /** Cancellation checked while reading and generating topology. */
  signal?: AbortSignal;
}

/** Reads all five legacy VTK dataset types, ASCII/big endian and pre-5/5.x cell layouts. */
export function parseVTKLegacy(input: BinaryInput, options: VTKLegacyOptions = {}): VTKLegacyResult {
  throwIfAborted(options.signal, F);
  const bytes = toBytes(input, F),
    limit = limits(options, F);
  const maxCells = options.maxCells ?? limit.maxTriangles;
  if (!Number.isSafeInteger(maxCells) || maxCells < 0)
    throw new LoaderError(F, 'limit', 'maxCells must be a nonnegative safe integer');
  if (options.surface !== undefined && !['outer', 'all'].includes(options.surface))
    throw new LoaderError(F, 'range', 'surface must be outer or all');
  const reader = new Reader(bytes, false, Math.max(limit.maxVertices * 9, maxCells * 9));
  const banner = /^# vtk DataFile Version (\d+)\.(\d+)\s*$/.exec(reader.line() ?? '');
  if (!banner) throw new LoaderError(F, 'header', 'expected a legacy VTK version banner');
  reader.line();
  const encoding = reader.line()?.trim().toUpperCase();
  if (!['ASCII', 'BINARY'].includes(encoding ?? ''))
    throw new LoaderError(F, 'header', 'third line must be ASCII or BINARY');
  const body = reader.mark();
  const data = new Reader(bytes, encoding === 'BINARY', Math.max(limit.maxVertices * 9, maxCells * 9));
  data.reset(body);
  const dataset = data.keyword();
  const type = dataset?.[1]?.toUpperCase() ?? '';
  if (
    dataset?.[0]?.toUpperCase() !== 'DATASET' ||
    !['POLYDATA', 'STRUCTURED_POINTS', 'STRUCTURED_GRID', 'RECTILINEAR_GRID', 'UNSTRUCTURED_GRID'].includes(type)
  )
    throw new LoaderError(F, 'unsupported', `unsupported DATASET ${type}`);
  let positions: Float32Array | undefined, dimensions: [number, number, number] | undefined;
  let origin: [number, number, number] = [0, 0, 0],
    spacing: [number, number, number] = [1, 1, 1];
  const axes: (Float64Array | undefined)[] = [];
  const cells: { type: number; points: number[] }[] = [];
  let pending: number[][] | undefined;
  let section: 'point' | 'cell' | 'field' = 'field',
    tuples = 0;
  let declaredPoints: number | undefined, declaredCells: number | undefined;
  let normalName: string | undefined, uvName: string | undefined, colorName: string | undefined;
  const pointData: Record<string, VTKLegacyField> = Object.create(null),
    cellData: Record<string, VTKLegacyField> = Object.create(null),
    fieldData: Record<string, VTKLegacyField> = Object.create(null);
  const count = (token: string | undefined, what: string, max: number): number => {
    const n = integerOf(token, what);
    if (n > max) throw new LoaderError(F, 'limit', `${what} exceeds ${max}`);
    return n;
  };
  const pointTotal = (): number => (dimensions ? dimensions.reduce((a, b) => a * b, 1) : (positions?.length ?? 0) / 3);
  const add = (cell: { type: number; points: number[] }): void => {
    if (cells.length >= maxCells) throw new LoaderError(F, 'limit', `source cells exceed ${maxCells}`);
    cells.push(cell);
  };
  const save = (name: string, components: number, values: Float64Array, tupleCount = tuples): void => {
    if (!Number.isSafeInteger(components) || components < 1 || components > 65536)
      throw new LoaderError(F, 'range', 'array component count must be 1..65536');
    const target = section === 'point' ? pointData : section === 'cell' ? cellData : fieldData;
    if (Object.hasOwn(target, name)) throw new LoaderError(F, 'syntax', `duplicate array ${name}`);
    if (values.length !== tupleCount * components)
      throw new LoaderError(F, 'range', `array ${name} has the wrong tuple count`);
    target[name] = { components, values };
  };
  const readCells = (tokens: string[]): number[][] => {
    const number = count(tokens[1], 'cell count', maxCells + 1),
      size = count(tokens[2], 'connectivity size', maxCells * 65536);
    const mark = data.mark(),
      next = data.keyword();
    if (next?.[0]?.toUpperCase() === 'OFFSETS') {
      const offsets = data.values(next[1] ?? 'vtktypeint64', number, 'cell offsets');
      const key = data.keyword();
      if (key?.[0]?.toUpperCase() !== 'CONNECTIVITY')
        throw new LoaderError(F, 'syntax', 'expected CONNECTIVITY after OFFSETS');
      const values = data.values(key[1] ?? 'vtktypeint64', size, 'cell connectivity');
      if (offsets.length < 1 || offsets[0] !== 0 || offsets.at(-1) !== values.length)
        throw new LoaderError(F, 'range', 'cell offsets must span all connectivity');
      const result: number[][] = [];
      for (let c = 0; c + 1 < offsets.length; c++) {
        const a = offsets[c],
          b = offsets[c + 1];
        if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 0 || b < a || b > size || b - a > 65536)
          throw new LoaderError(F, 'range', 'invalid cell offsets');
        result.push(Array.from(values.subarray(a, b)));
      }
      return result;
    }
    data.reset(mark);
    const values = data.values('int', size, 'cell connectivity'),
      result: number[][] = [];
    let at = 0;
    for (let c = 0; c < number; c++) {
      const n = values[at++];
      if (!Number.isSafeInteger(n) || n < 0 || n > 65536 || at + n > size)
        throw new LoaderError(F, 'range', 'invalid cell point count');
      result.push(Array.from(values.subarray(at, at + n)));
      at += n;
    }
    if (at !== size) throw new LoaderError(F, 'range', 'cell size does not match connectivity');
    return result;
  };
  for (let tokens = data.keyword(); tokens; tokens = data.keyword()) {
    throwIfAborted(options.signal, F);
    const key = tokens[0].toUpperCase(),
      what = tokens.join(' ');
    if (key === 'DIMENSIONS') {
      if (dimensions) throw new LoaderError(F, 'syntax', 'duplicate DIMENSIONS');
      dimensions = [
        count(tokens[1], 'x dimension', limit.maxVertices),
        count(tokens[2], 'y dimension', limit.maxVertices),
        count(tokens[3], 'z dimension', limit.maxVertices),
      ];
      if (dimensions.some((n) => n < 1) || pointTotal() > limit.maxVertices)
        throw new LoaderError(F, 'limit', 'DIMENSIONS exceed the vertex limit or contain zero');
    } else if (key === 'ORIGIN' || key === 'SPACING' || key === 'ASPECT_RATIO') {
      const values = tokens.slice(1).map(Number);
      if (
        values.length !== 3 ||
        values.some((v) => !Number.isFinite(v)) ||
        (key !== 'ORIGIN' && values.some((v) => v <= 0))
      )
        throw new LoaderError(F, 'range', `invalid ${key}`);
      if (key === 'ORIGIN') origin = values as [number, number, number];
      else spacing = values as [number, number, number];
    } else if (key === 'POINTS') {
      if (positions) throw new LoaderError(F, 'syntax', 'duplicate POINTS');
      const n = count(tokens[1], 'point count', limit.maxVertices);
      positions = Float32Array.from(data.values(tokens[2] ?? 'float', n * 3, what));
    } else if (/^[XYZ]_COORDINATES$/.test(key)) {
      const axis = 'XYZ'.indexOf(key[0]),
        n = count(tokens[1], 'coordinate count', limit.maxVertices);
      if (axes[axis]) throw new LoaderError(F, 'syntax', 'duplicate coordinate axis');
      axes[axis] = data.values(tokens[2] ?? 'float', n, what);
    } else if (['VERTICES', 'LINES', 'POLYGONS', 'TRIANGLE_STRIPS', 'CELLS'].includes(key)) {
      const rows = readCells(tokens);
      if (key === 'CELLS') {
        if (pending) throw new LoaderError(F, 'syntax', 'duplicate CELLS');
        pending = rows;
      } else {
        if (type !== 'POLYDATA') throw new LoaderError(F, 'syntax', `${key} requires POLYDATA`);
        const code = ({ VERTICES: 2, LINES: 4, POLYGONS: 7, TRIANGLE_STRIPS: 6 } as Record<string, number>)[key];
        for (const points of rows) add({ type: code, points });
      }
    } else if (key === 'CELL_TYPES') {
      const n = count(tokens[1], 'cell type count', maxCells);
      if (!pending || pending.length !== n) throw new LoaderError(F, 'range', 'CELL_TYPES must match CELLS');
      const types = data.values('int', n, what);
      for (let i = 0; i < n; i++) add({ type: types[i], points: pending[i] });
      pending = undefined;
    } else if (key === 'POINT_DATA' || key === 'CELL_DATA') {
      section = key === 'POINT_DATA' ? 'point' : 'cell';
      tuples = count(tokens[1], `${key} tuples`, section === 'point' ? limit.maxVertices : maxCells);
      if (section === 'point') declaredPoints = tuples;
      else declaredCells = tuples;
    } else if (key === 'SCALARS') {
      if (section === 'field') throw new LoaderError(F, 'syntax', 'SCALARS require POINT_DATA or CELL_DATA');
      const components = tokens[3] ? count(tokens[3], 'scalar components', 4) : 1;
      const mark = data.mark();
      if (data.keyword()?.[0]?.toUpperCase() !== 'LOOKUP_TABLE') data.reset(mark);
      save(tokens[1], components, data.values(tokens[2] ?? 'float', tuples * components, what));
    } else if (
      [
        'NORMALS',
        'VECTORS',
        'TENSORS',
        'TENSORS6',
        'TEXTURE_COORDINATES',
        'COLOR_SCALARS',
        'GLOBAL_IDS',
        'PEDIGREE_IDS',
      ].includes(key)
    ) {
      if (section === 'field') throw new LoaderError(F, 'syntax', `${key} requires POINT_DATA or CELL_DATA`);
      const components =
        key === 'TENSORS'
          ? 9
          : key === 'TENSORS6'
            ? 6
            : key === 'TEXTURE_COORDINATES' || key === 'COLOR_SCALARS'
              ? count(tokens[2], 'array components', 4)
              : key.endsWith('_IDS')
                ? 1
                : 3;
      const kind =
        key === 'COLOR_SCALARS'
          ? data.binary
            ? 'unsigned_char'
            : 'float'
          : key === 'TEXTURE_COORDINATES'
            ? tokens[3]
            : tokens[2];
      const values = data.values(kind ?? 'float', tuples * components, what);
      if (key === 'COLOR_SCALARS' && data.binary) for (let i = 0; i < values.length; i++) values[i] /= 255;
      save(tokens[1], components, values);
      if (section === 'point') {
        if (key === 'NORMALS') normalName = tokens[1];
        if (key === 'TEXTURE_COORDINATES' && components >= 2) uvName = tokens[1];
        if (key === 'COLOR_SCALARS' && components >= 3) colorName = tokens[1];
      }
    } else if (key === 'FIELD') {
      const n = count(tokens[2], 'field array count', 65536);
      for (let i = 0; i < n; i++) {
        const row = data.keyword();
        if (!row) throw new LoaderError(F, 'truncated', 'FIELD ends early');
        const components = count(row[1], 'field components', 65536),
          nTuples = count(row[2], 'field tuples', Math.max(limit.maxVertices, maxCells));
        const values = data.values(row[3] ?? 'float', components * nTuples, `FIELD ${row[0]}`);
        if (section !== 'field' && nTuples !== tuples) fieldData[row[0]] = { components, values };
        else save(row[0], components, values, nTuples);
      }
    } else if (key === 'LOOKUP_TABLE')
      data.values(data.binary ? 'unsigned_char' : 'float', count(tokens[2], 'lookup table size', 65536) * 4, what);
    else if (key === 'METADATA') {
      for (let line = data.line(); line !== null && line.trim(); line = data.line());
    } else throw new LoaderError(F, 'unsupported', `unknown legacy keyword ${key}`);
  }
  if (pending) throw new LoaderError(F, 'syntax', 'CELLS have no matching CELL_TYPES');
  const structured = ['STRUCTURED_POINTS', 'STRUCTURED_GRID', 'RECTILINEAR_GRID'].includes(type);
  if (structured) {
    if (!dimensions) throw new LoaderError(F, 'header', 'structured datasets require DIMENSIONS');
    const [nx, ny, nz] = dimensions;
    if (type === 'STRUCTURED_GRID') {
      if (!positions || positions.length !== pointTotal() * 3)
        throw new LoaderError(F, 'range', 'POINTS must match DIMENSIONS');
    } else {
      if (
        (type === 'RECTILINEAR_GRID' && axes.some((a, i) => !a || a.length !== dimensions[i])) ||
        (type === 'RECTILINEAR_GRID' && axes.length !== 3)
      )
        throw new LoaderError(F, 'range', 'coordinate axes must match DIMENSIONS');
      positions = new Float32Array(pointTotal() * 3);
      let at = 0;
      for (let z = 0; z < nz; z++)
        for (let y = 0; y < ny; y++)
          for (let x = 0; x < nx; x++) {
            if (!(at % 4096)) throwIfAborted(options.signal, F);
            for (let a = 0; a < 3; a++) {
              const n = [x, y, z][a];
              positions[at++] = type === 'RECTILINEAR_GRID' ? axes[a]![n] : origin[a] + spacing[a] * n;
            }
          }
    }
    if (cells.length) throw new LoaderError(F, 'syntax', 'structured datasets must use implicit cells');
    const active = dimensions.map((n, i) => (n > 1 ? i : -1)).filter((i) => i >= 0);
    const id = (xyz: number[]): number => xyz[0] + nx * (xyz[1] + ny * xyz[2]);
    for (let z = 0; z < Math.max(1, nz - 1); z++)
      for (let y = 0; y < Math.max(1, ny - 1); y++)
        for (let x = 0; x < Math.max(1, nx - 1); x++) {
          if (!(cells.length % 1024)) throwIfAborted(options.signal, F);
          const base = [x, y, z],
            p = (bits: number[]): number => id(base.map((v, a) => v + (bits[active.indexOf(a)] ?? 0)));
          if (active.length === 3)
            add({
              type: 12,
              points: [
                [0, 0, 0],
                [1, 0, 0],
                [1, 1, 0],
                [0, 1, 0],
                [0, 0, 1],
                [1, 0, 1],
                [1, 1, 1],
                [0, 1, 1],
              ].map(p),
            });
          else if (active.length === 2)
            add({
              type: 9,
              points: [
                [0, 0],
                [1, 0],
                [1, 1],
                [0, 1],
              ].map(p),
            });
          else if (active.length === 1) add({ type: 3, points: [[0], [1]].map(p) });
          else add({ type: 1, points: [id(base)] });
        }
  }
  if (!positions) throw new LoaderError(F, 'header', 'dataset requires POINTS');
  if (positions.some((v) => !Number.isFinite(v)))
    throw new LoaderError(F, 'range', 'point coordinates must be finite float32 values');
  const points = positions.length / 3;
  if (
    (declaredPoints !== undefined && declaredPoints !== points) ||
    (declaredCells !== undefined && declaredCells !== cells.length)
  )
    throw new LoaderError(F, 'range', 'data tuple count does not match topology');
  if (type === 'POLYDATA') cells.sort((a, b) => [2, 4, 7, 6].indexOf(a.type) - [2, 4, 7, 6].indexOf(b.type));
  const builder = new Builder(limit.maxTriangles, options.surface !== 'all'),
    connectivity = uints(),
    offsets = uints(),
    types = uints(),
    vertices = uints(),
    vertexCells = uints(),
    lineCells = uints();
  offsets.push(0);
  for (let c = 0; c < cells.length; c++) {
    if (!(c % 1024)) throwIfAborted(options.signal, F);
    const cell = cells[c];
    if (
      (fixedCorners[cell.type] !== undefined && cell.points.length !== fixedCorners[cell.type]) ||
      (cell.type === 2 && !cell.points.length) ||
      (cell.type === 4 && cell.points.length < 2) ||
      ((cell.type === 6 || cell.type === 7) && cell.points.length < 3)
    )
      throw new LoaderError(F, 'range', `cell ${c} has the wrong point count for type ${cell.type}`);
    if (!Number.isSafeInteger(cell.type) || cell.type < 0)
      throw new LoaderError(F, 'range', 'cell type must be a nonnegative integer');
    if (cell.type === 42) {
      let at = 1;
      const faces = cell.points[0];
      if (!Number.isSafeInteger(faces) || faces < 4)
        throw new LoaderError(F, 'range', 'polyhedron needs at least four faces');
      for (let f = 0; f < faces; f++) {
        const n = cell.points[at++];
        if (!Number.isSafeInteger(n) || n < 3 || at + n > cell.points.length)
          throw new LoaderError(F, 'range', 'invalid polyhedron face stream');
        const face = cell.points.slice(at, at + n);
        for (const index of face) builder.check(index, points);
        builder.face(face, c);
        at += n;
      }
      if (at !== cell.points.length) throw new LoaderError(F, 'range', 'polyhedron face stream has trailing values');
    } else for (const index of cell.points) builder.check(index, points);
    for (const index of cell.points) connectivity.push(index);
    offsets.push(connectivity.length);
    types.push(cell.type);
    if (cell.type === 1 || cell.type === 2)
      for (const index of cell.points) {
        vertices.push(index);
        vertexCells.push(c);
      }
    const linesBefore = builder.lines.length;
    if (cell.type !== 42) gridCell(cell.type, cell.points, c, builder, undefined, 0, points, 0);
    for (let i = linesBefore; i < builder.lines.length; i += 2) lineCells.push(c);
  }
  builder.finish();
  const triangles = builder.triangles.result();
  const result: VTKLegacyResult = {
    type,
    kind: triangles.length ? 'mesh' : 'points',
    positions,
    offsets: offsets.result(),
    connectivity: connectivity.result(),
    cellTypes: types.result(),
    cellCount: cells.length,
    lines: builder.lines.result(),
    lineCells: lineCells.result(),
    vertices: vertices.result(),
    vertexCells: vertexCells.result(),
    triangleCells: builder.cells.result(),
    pointData,
    cellData,
    fieldData,
    warnings: [...builder.warnings],
  };
  if (triangles.length) result.indices = triangles;
  if (dimensions) result.dimensions = dimensions;
  if (type === 'STRUCTURED_POINTS') {
    result.origin = origin;
    result.spacing = spacing;
  }
  const attributes: Record<string, Float32Array> = Object.create(null);
  for (const [name, field] of Object.entries(pointData))
    if (field.components === 1) attributes[name] = Float32Array.from(field.values);
  if (Object.keys(attributes).length) result.attributes = attributes;
  const vertexAttribute = (name: string, width: number): Float32Array => {
    const field = pointData[name],
      out = new Float32Array(points * width);
    for (let p = 0; p < points; p++)
      for (let c = 0; c < width; c++) out[p * width + c] = field.values[p * field.components + c];
    return out;
  };
  if (normalName) result.normals = vertexAttribute(normalName, 3);
  if (uvName) result.uvs = vertexAttribute(uvName, 2);
  if (colorName) result.colors = vertexAttribute(colorName, 3);
  return result;
}
