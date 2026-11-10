// Unstructured grids: tetrahedra, hexahedra, wedges and pyramids with point or cell data, in VTK's UnstructuredGrid
// layout (points, connectivity, offsets, cell types; VTK file formats, Kitware, "VTK User's Guide" chapter 19). The
// outer surface is every face exactly one cell owns, found by a sorted-vertex key per face. A slice cuts every cell the
// plane crosses: the cell's edges that change side give the corners of one convex polygon (each cell is convex with
// planar faces), ordered by angle about their centre in the plane and fanned into triangles, with point values
// interpolated along the cut edges, so neighbouring cells meet without cracks. Both draw as triangle meshes coloured
// through a colour map by the interpolated value, flat-lit. parseVtk reads legacy VTK files (versions to 5.1) into
// this layout.
import { invertMatrix } from '@margoengine/math/mat4';
import { hexColor, SRGBToLinear, LinearToSRGB } from '@margoengine/math/color';
import { fault, rangeError, typeError } from '../../shared/errors.js';
import { colormapTexture, resolveColormap, type Bounds, type ColormapSource } from './layer.js';
import { frameWGSL, requireGPU, type Drawable, type GpuContext, type SciRenderer } from './render.js';
import type { Colormap } from './colormaps.js';
import type { Figure } from './figure.js';
import type { LayerAppearance } from './appearance.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number; STORAGE: number };
declare const GPUShaderStage: { VERTEX: number; FRAGMENT: number };

/** VTK cell type numbers the grid functions take (parseVtk also reads a voxel, 11, as a hexahedron). */
export const CELL_TYPES = { tetra: 10, hexahedron: 12, wedge: 13, pyramid: 14 } as const;

/** An unstructured grid in VTK's layout. */
export interface UnstructuredGrid {
  /** xyz of every point, in data units. */
  readonly points: ArrayLike<number>;
  /** Point indices of every cell, one cell after another. */
  readonly connectivity: ArrayLike<number>;
  /** End of each cell in `connectivity` (VTK XML style): cell c runs from `offsets[c - 1]` (0 for the first). */
  readonly offsets: ArrayLike<number>;
  /** VTK cell type of each cell: 10 tetra, 12 hexahedron, 13 wedge, 14 pyramid. */
  readonly types: ArrayLike<number>;
  /** One value per point. */
  readonly pointData?: ArrayLike<number>;
  /** One value per cell. */
  readonly cellData?: ArrayLike<number>;
}

/** Triangles with a value at every corner, three corners per triangle, flat normals. */
export interface TriangleSet {
  /** xyz per corner. */
  readonly positions: Float32Array;
  /** Flat normal per corner. */
  readonly normals: Float32Array;
  /** Value per corner (NaN where the grid has none). */
  readonly values: Float32Array;
  /** Source cell of each triangle. */
  readonly cells: Uint32Array;
  readonly bounds: Bounds;
}

/** Which data colours the mesh. */
export type GridValues = 'point' | 'cell';

// Faces (outward by VTK's node order) and edges of every cell type, by local node index.
const FACES: Record<number, number[][]> = {
  10: [
    [0, 2, 1],
    [0, 1, 3],
    [1, 2, 3],
    [0, 3, 2],
  ],
  12: [
    [0, 3, 2, 1],
    [4, 5, 6, 7],
    [0, 1, 5, 4],
    [1, 2, 6, 5],
    [2, 3, 7, 6],
    [3, 0, 4, 7],
  ],
  // VTK's wedge order since its 2025 correction (VTK 9.7 release notes, "VTK Wedge Cell Types: Fix Point Ordering"):
  // the points match the parametric coordinates (0,0,0) (1,0,0) (0,1,0) (0,0,1) (1,0,1) (0,1,1), so triangle 0-1-2 is
  // counter-clockwise seen from triangle 3-4-5, like a hexahedron's 0-1-2-3 seen from 4-5-6-7.
  13: [
    [0, 2, 1],
    [3, 4, 5],
    [0, 1, 4, 3],
    [1, 2, 5, 4],
    [2, 0, 3, 5],
  ],
  14: [
    [0, 3, 2, 1],
    [0, 1, 4],
    [1, 2, 4],
    [2, 3, 4],
    [3, 0, 4],
  ],
};
const NODES: Record<number, number> = { 10: 4, 12: 8, 13: 6, 14: 5 };
const EDGES: Record<number, number[][]> = {};
for (const [type, faces] of Object.entries(FACES)) {
  const seen = new Set<string>(),
    list: number[][] = [];
  for (const face of faces)
    for (let k = 0; k < face.length; k++) {
      const a = face[k],
        b = face[(k + 1) % face.length],
        key = a < b ? `${a},${b}` : `${b},${a}`;
      if (!seen.has(key)) seen.add(key), list.push([Math.min(a, b), Math.max(a, b)]);
    }
  EDGES[Number(type)] = list;
}

/** Checks a grid and returns its cell count. Throws `TypeError` or `RangeError` naming what is wrong. */
export function checkGrid(grid: UnstructuredGrid): number {
  if (!grid || !grid.points || !grid.connectivity || !grid.offsets || !grid.types)
    throw typeError('An unstructured grid needs points, connectivity, offsets and types', 'sciviz');
  const points = grid.points.length / 3,
    cells = grid.types.length;
  if (!Number.isInteger(points)) throw rangeError('Grid points must hold xyz per point', 'sciviz');
  if (grid.offsets.length !== cells)
    throw rangeError(`Grid offsets hold ${grid.offsets.length} cells, types ${cells}`, 'sciviz');
  let start = 0;
  for (let c = 0; c < cells; c++) {
    const type = grid.types[c],
      end = grid.offsets[c];
    if (!NODES[type])
      throw rangeError(
        `Grid cell ${c} has VTK type ${type}; tetra 10, hexahedron 12, wedge 13 and pyramid 14 are read`,
        'sciviz',
      );
    if (end - start !== NODES[type])
      throw rangeError(`Grid cell ${c} of type ${type} has ${end - start} points, not ${NODES[type]}`, 'sciviz');
    for (let k = start; k < end; k++) {
      const p = grid.connectivity[k];
      if (!Number.isInteger(p) || p < 0 || p >= points)
        throw rangeError(`Grid cell ${c} names point ${p} of ${points}`, 'sciviz');
    }
    start = end;
  }
  if (start !== grid.connectivity.length)
    throw rangeError('Grid offsets do not end at the connectivity length', 'sciviz');
  if (grid.pointData && grid.pointData.length !== points)
    throw rangeError(`Grid pointData holds ${grid.pointData.length} values for ${points} points`, 'sciviz');
  if (grid.cellData && grid.cellData.length !== cells)
    throw rangeError(`Grid cellData holds ${grid.cellData.length} values for ${cells} cells`, 'sciviz');
  return cells;
}

class Builder {
  positions: number[] = [];
  normals: number[] = [];
  values: number[] = [];
  cells: number[] = [];
  min = [Infinity, Infinity, Infinity];
  max = [-Infinity, -Infinity, -Infinity];
  triangle(a: number[], b: number[], c: number[], va: number, vb: number, vc: number, cell: number): void {
    const ux = b[0] - a[0],
      uy = b[1] - a[1],
      uz = b[2] - a[2],
      wx = c[0] - a[0],
      wy = c[1] - a[1],
      wz = c[2] - a[2];
    let nx = uy * wz - uz * wy,
      ny = uz * wx - ux * wz,
      nz = ux * wy - uy * wx;
    const length = Math.hypot(nx, ny, nz);
    if (!(length > 0)) return;
    nx /= length;
    ny /= length;
    nz /= length;
    for (const [p, v] of [
      [a, va],
      [b, vb],
      [c, vc],
    ] as const) {
      this.positions.push(p[0], p[1], p[2]);
      this.normals.push(nx, ny, nz);
      this.values.push(v);
      for (let k = 0; k < 3; k++) {
        if (p[k] < this.min[k]) this.min[k] = p[k];
        if (p[k] > this.max[k]) this.max[k] = p[k];
      }
    }
    this.cells.push(cell);
  }
  done(): TriangleSet {
    const empty = !this.cells.length;
    return {
      positions: new Float32Array(this.positions),
      normals: new Float32Array(this.normals),
      values: new Float32Array(this.values),
      cells: new Uint32Array(this.cells),
      bounds: empty
        ? [0, 0, 0, 0, 0, 0]
        : [this.min[0], this.max[0], this.min[1], this.max[1], this.min[2], this.max[2]],
    };
  }
}

const point = (grid: UnstructuredGrid, p: number): number[] => [
  grid.points[p * 3],
  grid.points[p * 3 + 1],
  grid.points[p * 3 + 2],
];

function valueOf(grid: UnstructuredGrid, values: GridValues): (cell: number, p: number) => number {
  if (values === 'cell') {
    if (!grid.cellData) throw typeError("values: 'cell' needs the grid's cellData", 'sciviz');
    const data = grid.cellData;
    return (cell) => data[cell];
  }
  if (!grid.pointData) {
    if (grid.cellData) {
      const data = grid.cellData;
      return (cell) => data[cell];
    }
    return () => NaN;
  }
  const data = grid.pointData;
  return (_cell, p) => data[p];
}

/**
 * The outer surface of a grid: every face exactly one cell owns, split into triangles, facing out. Values come from
 * `pointData` (`values: 'point'`, the default when present) or `cellData`.
 */
export function gridSurface(grid: UnstructuredGrid, options: { readonly values?: GridValues } = {}): TriangleSet {
  const cells = checkGrid(grid),
    value = valueOf(grid, options.values ?? (grid.pointData || !grid.cellData ? 'point' : 'cell'));
  // Count every face by its sorted point indices; keep the first owner's oriented copy.
  const faces = new Map<string, { cell: number; nodes: number[]; count: number }>();
  let start = 0;
  for (let c = 0; c < cells; c++) {
    const type = grid.types[c];
    for (const face of FACES[type]) {
      const nodes = face.map((k) => grid.connectivity[start + k]),
        key = [...nodes].sort((a, b) => a - b).join(',');
      const seen = faces.get(key);
      if (seen) seen.count++;
      else faces.set(key, { cell: c, nodes, count: 1 });
    }
    start = grid.offsets[c];
  }
  const out = new Builder();
  for (const { cell, nodes, count } of faces.values()) {
    if (count !== 1) continue;
    const p = nodes.map((n) => point(grid, n)),
      v = nodes.map((n) => value(cell, n));
    for (let k = 1; k + 1 < nodes.length; k++) out.triangle(p[0], p[k], p[k + 1], v[0], v[k], v[k + 1], cell);
  }
  return out.done();
}

/** A plane: points with `dot(normal, p) = offset`. */
export interface SlicePlane {
  readonly normal: readonly [number, number, number];
  readonly offset: number;
}

/**
 * Cuts a grid by a plane: one convex polygon per cell the plane crosses, fanned into triangles that face along the
 * plane's normal. Point values interpolate along the cut edges; cell values stay constant per cell.
 */
export function sliceGrid(
  grid: UnstructuredGrid,
  plane: SlicePlane,
  options: { readonly values?: GridValues } = {},
): TriangleSet {
  const cells = checkGrid(grid),
    value = valueOf(grid, options.values ?? (grid.pointData || !grid.cellData ? 'point' : 'cell'));
  const [nx, ny, nz] = plane.normal,
    length = Math.hypot(nx, ny, nz);
  if (!(length > 0) || !Number.isFinite(plane.offset))
    throw rangeError('A slice plane needs a non-zero normal and a finite offset', 'sciviz');
  const n = [nx / length, ny / length, nz / length],
    d = plane.offset / length;
  // Two axes in the plane, for ordering a polygon's corners by angle.
  const helper = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = [
      n[1] * helper[2] - n[2] * helper[1],
      n[2] * helper[0] - n[0] * helper[2],
      n[0] * helper[1] - n[1] * helper[0],
    ],
    ul = Math.hypot(u[0], u[1], u[2]);
  for (let k = 0; k < 3; k++) u[k] /= ul;
  const w = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
  const distance = new Float64Array(grid.points.length / 3);
  for (let p = 0; p < distance.length; p++)
    distance[p] = grid.points[p * 3] * n[0] + grid.points[p * 3 + 1] * n[1] + grid.points[p * 3 + 2] * n[2] - d;
  const out = new Builder();
  let start = 0;
  for (let c = 0; c < cells; c++) {
    const type = grid.types[c],
      corners: { p: number[]; v: number; angle: number }[] = [];
    let below = false,
      above = false;
    for (let k = 0; k < NODES[type]; k++) {
      const s = distance[grid.connectivity[start + k]];
      if (s < 0) below = true;
      else above = true;
    }
    if (below && above) {
      for (const [a, b] of EDGES[type]) {
        const pa = grid.connectivity[start + a],
          pb = grid.connectivity[start + b],
          sa = distance[pa],
          sb = distance[pb];
        // An edge changes side when one end is below and the other on or above (on counts as above, once).
        if (sa < 0 === sb < 0) continue;
        const t = sa / (sa - sb),
          A = point(grid, pa),
          B = point(grid, pb);
        corners.push({
          p: [A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t],
          v: value(c, pa) + (value(c, pb) - value(c, pa)) * t,
          angle: 0,
        });
      }
      if (corners.length >= 3) {
        const centre = [0, 0, 0];
        for (const corner of corners) for (let k = 0; k < 3; k++) centre[k] += corner.p[k] / corners.length;
        for (const corner of corners) {
          const r = [corner.p[0] - centre[0], corner.p[1] - centre[1], corner.p[2] - centre[2]];
          corner.angle = Math.atan2(r[0] * w[0] + r[1] * w[1] + r[2] * w[2], r[0] * u[0] + r[1] * u[1] + r[2] * u[2]);
        }
        corners.sort((a, b) => a.angle - b.angle);
        // Drop corners that coincide (a cut through a node gives one per edge at that node).
        const kept = corners.filter(
          (corner, k) => k === 0 || Math.hypot(...corner.p.map((x, i) => x - corners[k - 1].p[i])) > 1e-12,
        );
        if (kept.length > 2 && Math.hypot(...kept[0].p.map((x, i) => x - kept[kept.length - 1].p[i])) <= 1e-12)
          kept.pop();
        for (let k = 1; k + 1 < kept.length; k++)
          out.triangle(kept[0].p, kept[k].p, kept[k + 1].p, kept[0].v, kept[k].v, kept[k + 1].v, c);
      }
    }
    start = grid.offsets[c];
  }
  return out.done();
}

/** A grid read from a legacy VTK file, with every named scalar array it carries. */
export interface VtkGrid extends UnstructuredGrid {
  /** The file's header line (its second line). */
  readonly title: string;
  /** Point scalar arrays by name, one value per point (first component of multi-component scalars). */
  readonly pointArrays: Readonly<Record<string, Float64Array>>;
  /** Cell scalar arrays by name, one value per kept cell. */
  readonly cellArrays: Readonly<Record<string, Float64Array>>;
  /** Cells left out because they are not volume cells this entry draws (vertices, lines, surface and quadratic cells). */
  readonly skipped: number;
}

// Bytes per value in a binary legacy file. `long` and `unsigned_long` are left out: the format's own text says their
// length differs between systems, so a binary file holding them cannot be read portably.
const VTK_BYTES: Record<string, number> = {
  unsigned_char: 1,
  char: 1,
  unsigned_short: 2,
  short: 2,
  unsigned_int: 4,
  int: 4,
  float: 4,
  double: 8,
  vtktypeint64: 8,
  vtktypeuint64: 8,
  vtktypeint32: 4,
  vtktypeuint32: 4,
};

// A hexahedron's corner k is a voxel's corner VOXEL_TO_HEXAHEDRON[k]: a voxel numbers x fastest, then y, then z.
const VOXEL_TO_HEXAHEDRON = [0, 1, 3, 2, 4, 5, 7, 6];

/**
 * Reads a legacy VTK file (`.vtk`, versions 1.0 to 5.1, ASCII or big-endian BINARY) holding an UNSTRUCTURED_GRID, as
 * set out in "VTK File Formats" (Kitware, VTK User's Guide): POINTS, CELLS with a point count before each cell,
 * CELL_TYPES, and POINT_DATA and CELL_DATA attributes. Tetrahedra, voxels (reordered to hexahedra), hexahedra, wedges
 * and pyramids are kept; other cells are counted in `skipped` with their cell data dropped. The first SCALARS of each
 * kind become `pointData` and `cellData`; every SCALARS array is in `pointArrays` or `cellArrays`.
 */
export function parseVtk(source: string | ArrayBuffer | ArrayBufferView): VtkGrid {
  const bytes =
    typeof source === 'string'
      ? new TextEncoder().encode(source)
      : source instanceof ArrayBuffer
        ? new Uint8Array(source)
        : new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  const decode = (start: number, end: number) => new TextDecoder().decode(bytes.subarray(start, end));
  let at = 0;
  const space = (b: number) => b === 32 || (b >= 9 && b <= 13);
  const line = (): string => {
    const start = at;
    while (at < bytes.length && bytes[at] !== 10) at++;
    return decode(start, at++).replace(/\r$/, '');
  };
  const word = (): string => {
    while (at < bytes.length && space(bytes[at])) at++;
    const start = at;
    while (at < bytes.length && !space(bytes[at])) at++;
    if (start === at) throw rangeError('VTK file ends early', 'sciviz');
    return decode(start, at);
  };
  const count = (what: string): number => {
    const text = word(),
      n = Number(text);
    if (!Number.isSafeInteger(n) || n < 0)
      throw rangeError(`VTK ${what} must be a whole number, got ${text}`, 'sciviz');
    return n;
  };
  const version = /^# vtk DataFile Version (\d+)\.(\d+)/i.exec(line());
  if (!version)
    throw rangeError('Not a legacy VTK file: the first line must be "# vtk DataFile Version x.x"', 'sciviz');
  const title = line(),
    format = line().trim().toUpperCase();
  if (format !== 'ASCII' && format !== 'BINARY')
    throw rangeError(`VTK file format must be ASCII or BINARY, got ${format}`, 'sciviz');
  const binary = format === 'BINARY';
  // Binary data starts right after the newline that ends the keyword line.
  const endLine = () => {
    if (!binary) return;
    while (at < bytes.length && bytes[at] !== 10) at++;
    at++;
  };
  // Reads n values of a data type: words in ASCII, big-endian bytes in BINARY.
  const values = (n: number, type: string): Float64Array => {
    if (!Number.isSafeInteger(n) || n < 0 || n > bytes.length)
      throw rangeError('VTK count exceeds file bound', 'sciviz');
    const out = new Float64Array(n);
    if (!binary) {
      for (let i = 0; i < n; i++) {
        const text = word();
        out[i] = Number(text);
        if (Number.isNaN(out[i]) && !/^nan$/i.test(text))
          throw rangeError(`VTK value ${text} is not a number`, 'sciviz');
      }
      return out;
    }
    const size = VTK_BYTES[type];
    if (!size)
      throw rangeError(`VTK binary data type ${type} is not read (unsigned_char to double, not bit or long)`, 'sciviz');
    if (at + n * size > bytes.length) throw rangeError('VTK file ends early', 'sciviz');
    const view = new DataView(bytes.buffer, bytes.byteOffset + at, n * size),
      get =
        type === 'vtktypeint64'
          ? (o: number) => Number(view.getBigInt64(o))
          : type === 'vtktypeuint64'
            ? (o: number) => Number(view.getBigUint64(o))
            : type === 'vtktypeint32'
              ? (o: number) => view.getInt32(o)
              : type === 'vtktypeuint32'
                ? (o: number) => view.getUint32(o)
                : type === 'float'
                  ? (o: number) => view.getFloat32(o)
                  : type === 'double'
                    ? (o: number) => view.getFloat64(o)
                    : type === 'int'
                      ? (o: number) => view.getInt32(o)
                      : type === 'unsigned_int'
                        ? (o: number) => view.getUint32(o)
                        : type === 'short'
                          ? (o: number) => view.getInt16(o)
                          : type === 'unsigned_short'
                            ? (o: number) => view.getUint16(o)
                            : type === 'char'
                              ? (o: number) => view.getInt8(o)
                              : (o: number) => view.getUint8(o);
    for (let i = 0; i < n; i++) out[i] = get(i * size);
    at += n * size;
    return out;
  };
  const typeName = () => word().toLowerCase();
  if (word().toUpperCase() !== 'DATASET') throw rangeError('VTK file needs a DATASET line after its format', 'sciviz');
  const kind = word().toUpperCase();
  if (kind !== 'UNSTRUCTURED_GRID') throw rangeError(`VTK DATASET ${kind} is not read; UNSTRUCTURED_GRID is`, 'sciviz');
  let points: Float64Array | undefined,
    list: Float64Array | undefined,
    modernOffsets: Float64Array | undefined,
    types: Float64Array | undefined,
    cells = 0,
    attached: 'point' | 'cell' | undefined,
    attachedCount = 0;
  const pointArrays: Record<string, Float64Array> = Object.create(null),
    cellArrays: Record<string, Float64Array> = Object.create(null);
  for (;;) {
    while (at < bytes.length && space(bytes[at])) at++;
    if (at >= bytes.length) break;
    const key = word().toUpperCase();
    if (key === 'POINTS') {
      const n = count('POINTS count'),
        type = typeName();
      endLine();
      points = values(n * 3, type);
    } else if (key === 'CELLS') {
      cells = count('CELLS count');
      const size = count('CELLS size');
      endLine();
      if (Number(version[1]) >= 5) {
        if (cells < 1 || word().toUpperCase() !== 'OFFSETS')
          throw rangeError('VTK 5.1 CELLS requires OFFSETS', 'sciviz');
        const offsetType = typeName();
        endLine();
        modernOffsets = values(cells, offsetType);
        if (word().toUpperCase() !== 'CONNECTIVITY') throw rangeError('VTK 5.1 CELLS requires CONNECTIVITY', 'sciviz');
        const connectionType = typeName();
        endLine();
        list = values(size, connectionType);
        cells--;
        if (modernOffsets[0] !== 0 || modernOffsets[cells] !== list.length)
          throw rangeError('VTK 5.1 offsets must span connectivity', 'sciviz');
        for (let i = 0; i <= cells; i++)
          if (
            !Number.isSafeInteger(modernOffsets[i]) ||
            modernOffsets[i] < 0 ||
            (i > 0 && modernOffsets[i] < modernOffsets[i - 1])
          )
            throw rangeError('VTK 5.1 offsets must be increasing integers', 'sciviz');
      } else list = values(size, 'int');
    } else if (key === 'CELL_TYPES') {
      if (count('CELL_TYPES count') !== cells) throw rangeError('VTK CELL_TYPES count differs from CELLS', 'sciviz');
      endLine();
      types = values(cells, 'int');
    } else if (key === 'POINT_DATA' || key === 'CELL_DATA') {
      attached = key === 'POINT_DATA' ? 'point' : 'cell';
      attachedCount = count(`${key} count`);
      const expected = attached === 'point' ? (points?.length ?? 0) / 3 : cells;
      if (attachedCount !== expected)
        throw rangeError(`VTK ${key} ${attachedCount} differs from the ${expected} ${attached}s`, 'sciviz');
    } else if (key === 'METADATA') {
      // VTK 5.1 metadata is text even in a binary file and ends at an empty line.
      line();
      while (at < bytes.length && line().trim()) {
        /* skip metadata, not numeric arrays */
      }
    } else if (!attached) {
      throw rangeError(`VTK keyword ${key} is not part of an UNSTRUCTURED_GRID`, 'sciviz');
    } else if (key === 'SCALARS') {
      const name = word(),
        type = typeName();
      // numComp is optional (default 1); a LOOKUP_TABLE line follows either way.
      let components = 1,
        next = word();
      if (next.toUpperCase() !== 'LOOKUP_TABLE') {
        components = Number(next);
        if (!(Number.isInteger(components) && components >= 1 && components <= 4))
          throw rangeError(`VTK SCALARS ${name} has ${next} components; 1 to 4 are allowed`, 'sciviz');
        next = word();
      }
      if (next.toUpperCase() !== 'LOOKUP_TABLE')
        throw rangeError(`VTK SCALARS ${name} needs a LOOKUP_TABLE line`, 'sciviz');
      word();
      endLine();
      const data = values(attachedCount * components, type),
        first = new Float64Array(attachedCount);
      for (let i = 0; i < attachedCount; i++) first[i] = data[i * components];
      (attached === 'point' ? pointArrays : cellArrays)[name] = first;
    } else if (key === 'LOOKUP_TABLE') {
      word();
      const size = count('LOOKUP_TABLE size');
      endLine();
      values(size * 4, binary ? 'unsigned_char' : 'float');
    } else if (key === 'COLOR_SCALARS') {
      word();
      const n = count('COLOR_SCALARS values');
      endLine();
      values(attachedCount * n, binary ? 'unsigned_char' : 'float');
    } else if (key === 'VECTORS' || key === 'NORMALS' || key === 'TENSORS') {
      word();
      const type = typeName();
      endLine();
      values(attachedCount * (key === 'TENSORS' ? 9 : 3), type);
    } else if (key === 'TEXTURE_COORDINATES') {
      word();
      const dim = count('TEXTURE_COORDINATES dim'),
        type = typeName();
      endLine();
      values(attachedCount * dim, type);
    } else if (key === 'FIELD') {
      word();
      const arrays = count('FIELD array count');
      for (let a = 0; a < arrays; a++) {
        const name = word();
        const components = count('FIELD components'),
          tuples = count('FIELD tuples'),
          type = typeName();
        endLine();
        const data = values(components * tuples, type);
        if (components > 0 && tuples === attachedCount) {
          const first = Float64Array.from({ length: tuples }, (_, i) => data[i * components]);
          (attached === 'point' ? pointArrays : cellArrays)[name] = first;
        }
      }
    } else {
      throw rangeError(`VTK keyword ${key} is not read`, 'sciviz');
    }
  }
  if (!points || !list || !types)
    throw rangeError('A VTK UNSTRUCTURED_GRID needs POINTS, CELLS and CELL_TYPES', 'sciviz');
  // Keep the volume cells; a voxel numbers its corners x fastest, then y, then z, so it is reordered to a hexahedron.
  const connectivity: number[] = [],
    offsets: number[] = [],
    kept: number[] = [],
    keptTypes: number[] = [];
  let p = 0;
  for (let c = 0; c < cells; c++) {
    const n = modernOffsets ? modernOffsets[c + 1] - modernOffsets[c] : list[p],
      type = types[c];
    if (!(Number.isSafeInteger(n) && n >= 0 && (modernOffsets ? p + n <= list.length : p + n < list.length)))
      throw rangeError(`VTK cell ${c} runs past the CELLS list`, 'sciviz');
    const ids = list.subarray(p + (modernOffsets ? 0 : 1), p + (modernOffsets ? 0 : 1) + n);
    if (ids.some((id) => !Number.isSafeInteger(id) || id < 0 || id >= points.length / 3))
      throw rangeError(`VTK cell ${c} has an invalid point index`, 'sciviz');
    p += (modernOffsets ? 0 : 1) + n;
    const voxel = type === 11;
    if (!voxel && !NODES[type]) continue;
    if (n !== (voxel ? 8 : NODES[type])) throw rangeError(`VTK cell ${c} of type ${type} has ${n} points`, 'sciviz');
    for (let k = 0; k < n; k++) connectivity.push(ids[voxel ? VOXEL_TO_HEXAHEDRON[k] : k]);
    offsets.push(connectivity.length);
    kept.push(c);
    keptTypes.push(voxel ? CELL_TYPES.hexahedron : type);
  }
  if (p !== list.length) throw rangeError('VTK CELLS size differs from its cells', 'sciviz');
  for (const name of Object.keys(cellArrays)) {
    const all = cellArrays[name];
    cellArrays[name] = Float64Array.from(kept, (c) => all[c]);
  }
  const firstPoint = Object.values(pointArrays)[0],
    firstCell = Object.values(cellArrays)[0];
  const grid: VtkGrid = {
    title,
    points,
    connectivity,
    offsets,
    types: keptTypes,
    ...(firstPoint ? { pointData: firstPoint } : {}),
    ...(firstCell ? { cellData: firstCell } : {}),
    pointArrays,
    cellArrays,
    skipped: cells - kept.length,
  };
  checkGrid(grid);
  return grid;
}

/** Options for a mesh layer. */
export interface MeshLayerOptions {
  /** Optional atmospheric transport. Default camera headlight. */
  readonly appearance?: LayerAppearance;
  /** Multiply opacity by the scalar clamped to [0,1], for density shells. Default false. */
  readonly scalarOpacity?: boolean;
  /** Colour map. Default `'aurora'`. */
  readonly colormap?: ColormapSource;
  /** Value range the colour map spans. Default the values' min and max. */
  readonly range?: readonly [number, number];
  /** Opacity, 0 to 1. Default 1. */
  readonly opacity?: number;
  /** Colour where a value is NaN, a hex colour such as `#rrggbb`. Default `'#9aa4b2'`. */
  readonly missing?: string;
}

const meshShader = /* wgsl */ `${frameWGSL}
struct Mesh { model: mat4x4f, normalModel: mat4x4f, style: vec4f, missing: vec4f }
@group(1) @binding(0) var<uniform> mesh: Mesh;
@group(1) @binding(1) var<storage, read> corners: array<vec4f>;
@group(1) @binding(2) var colours: texture_2d<f32>;
@group(1) @binding(3) var colourSampler: sampler;
struct Out { @builtin(position) clip: vec4f, @location(0) world: vec3f, @location(1) normal: vec3f, @location(2) value: f32 }
@vertex fn vertex(@builtin(vertex_index) index: u32) -> Out {
  let a = corners[index * 2u];
  let b = corners[index * 2u + 1u];
  let world = mesh.model * vec4f(a.xyz, 1.0);
  var out: Out;
  out.world = world.xyz;
  out.clip = frame.clip * world;
  out.normal = (mesh.normalModel * vec4f(b.xyz, 0.0)).xyz;
  out.value = a.w;
  return out;
}
fn isNan(v: f32) -> bool { return (bitcast<u32>(v) & 0x7fffffffu) > 0x7f800000u; }
@fragment fn fragment(in: Out) -> @location(0) vec4f {
  let t = clamp((in.value - mesh.style.x) / max(mesh.style.y - mesh.style.x, 1e-30), 0.0, 1.0);
  var albedo = textureSampleLevel(colours, colourSampler, vec2f(t, 0.5), 0.0).rgb;
  if (isNan(in.value)) { albedo = mesh.missing.rgb; }
  var n = in.normal;
  if (dot(n, n) < 1e-12) { n = vec3f(0.0, 1.0, 0.0); }
  let colour = shade(albedo, normalize(n), normalize(frame.eye.xyz - in.world));
  return vec4f(toOutput(colour), mesh.style.z * select(1.0, select(0.0, clamp(in.value, 0.0, 1.0), !isNan(in.value)), mesh.style.w > 0.5));
}`;

/**
 * Triangles coloured by value through a colour map, in data units: the surface or a slice of an unstructured grid,
 * or any {@link TriangleSet}. Create it with {@link meshLayer} or {@link gridLayer}; `update(set)` replaces the
 * triangles (a new slice position).
 */
export class MeshLayer implements Drawable {
  /** Whether the optional publication exporter can express this material without a raster. */
  get vectorSupported(): boolean {
    return !this.#appearance && !this.#scalarOpacity;
  }
  /** Owned data-coordinate mesh and current scalar colours for publication output. */
  async vectorGeometry(
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<import('./vector-types.js').VectorGeometry> {
    options.signal?.throwIfAborted();
    if (this.#disposed) throw fault('disposed', 'Mesh is disposed; create a new layer before export', 'sciviz');
    if (this.#appearance || this.#scalarOpacity)
      throw fault('unsupported', 'Use raster export for custom transport or scalar-opacity meshes', 'sciviz');
    const { scalarMesh } = await import('./vector-snapshot.js');
    options.signal?.throwIfAborted();
    return scalarMesh(
      this.#set.positions,
      this.#set.values,
      this.colormap,
      this.#range,
      this.#opacity,
      this.#missing.map(LinearToSRGB),
    );
  }
  readonly #appearance: LayerAppearance | undefined;
  readonly #scalarOpacity: boolean;
  /** False hides the layer. */
  visible = true;
  readonly colormap: Colormap;
  #range: [number, number];
  #bounds: Bounds;
  readonly #fixedRange: boolean;
  readonly #opacity: number;
  readonly #missing: [number, number, number];
  readonly #renderer: SciRenderer;
  #corners: GPUBuffer | undefined;
  #capacity = 0;
  #count = 0;
  #uniform: GPUBuffer | undefined;
  #layout: GPUBindGroupLayout | undefined;
  #group: GPUBindGroup | undefined;
  #texture: GPUTexture | undefined;
  #sampler: GPUSampler | undefined;
  readonly #model = new Float32Array(16);
  readonly #values = new Float32Array(40);
  #set: TriangleSet;
  #disposed = false;

  /** @internal Use {@link meshLayer}. */
  constructor(renderer: SciRenderer, set: TriangleSet, options: MeshLayerOptions = {}) {
    this.#renderer = renderer;
    this.#appearance = options.appearance;
    this.#scalarOpacity = options.scalarOpacity ?? false;
    this.colormap = resolveColormap(options.colormap);
    this.#opacity = options.opacity ?? 1;
    if (!(this.#opacity >= 0 && this.#opacity <= 1)) throw rangeError('Mesh opacity must be in [0, 1]', 'sciviz');
    const missing = hexColor(options.missing ?? '#9aa4b2');
    if (!missing)
      throw typeError(`Mesh missing colour ${options.missing} is not a hex colour such as #rrggbb`, 'sciviz');
    this.#missing = [SRGBToLinear(missing[0]), SRGBToLinear(missing[1]), SRGBToLinear(missing[2])];
    this.#fixedRange = !!options.range;
    this.#range = options.range ? [options.range[0], options.range[1]] : [0, 1];
    if (options.range && !(options.range[0] < options.range[1]))
      throw rangeError('Mesh range must be [min, max] with min < max', 'sciviz');
    this.#bounds = set.bounds;
    this.#set = set;
    try {
      this.#build();
      this.update(set);
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  #build(): void {
    const device = this.#renderer.device!;
    this.#uniform = device.createBuffer({
      size: this.#values.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.#layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    });
    this.#texture = colormapTexture(device, this.colormap);
    this.#sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
  }

  /** @internal Rebuilds all bindings and the latest triangle data. */
  restore(): void {
    this.#corners?.destroy();
    this.#uniform?.destroy();
    this.#texture?.destroy();
    this.#capacity = 0;
    this.#group = undefined;
    this.#build();
    this.update(this.#set);
  }

  /** Blended when `opacity` is below 1. */
  get transparent(): boolean {
    return this.#opacity < 1;
  }

  /** Data bounds of the triangles. */
  get bounds(): Bounds {
    return this.#bounds;
  }

  /** The value range the colour map spans. */
  get range(): readonly [number, number] {
    return this.#range;
  }

  /** Triangles drawn. */
  get triangles(): number {
    return this.#count / 3;
  }

  /** Replaces the triangles. The range follows the new values unless one was given. */
  update(set: TriangleSet): void {
    if (this.#disposed) throw typeError('Mesh layer disposed; create a new one', 'sciviz');
    const count = set.positions.length / 3;
    if (!Number.isInteger(count / 3) || set.normals.length !== set.positions.length || set.values.length !== count)
      throw rangeError(
        'A triangle set needs xyz, a normal and a value per corner, three corners per triangle',
        'sciviz',
      );
    this.#set = {
      ...set,
      positions: set.positions.slice(),
      normals: set.normals.slice(),
      values: set.values.slice(),
      bounds: [...set.bounds] as Bounds,
    };
    const device = this.#renderer.device!;
    if (count > this.#capacity) {
      this.#corners?.destroy();
      this.#capacity = Math.max(3, Math.ceil(count * 1.25));
      this.#corners = device.createBuffer({
        size: this.#capacity * 32,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this.#group = device.createBindGroup({
        layout: this.#layout!,
        entries: [
          { binding: 0, resource: { buffer: this.#uniform! } },
          { binding: 1, resource: { buffer: this.#corners } },
          { binding: 2, resource: this.#texture!.createView() },
          { binding: 3, resource: this.#sampler! },
        ],
      });
    }
    const packed = new Float32Array(count * 8);
    let min = Infinity,
      max = -Infinity;
    for (let i = 0; i < count; i++) {
      packed.set(set.positions.subarray(i * 3, i * 3 + 3), i * 8);
      packed[i * 8 + 3] = set.values[i];
      packed.set(set.normals.subarray(i * 3, i * 3 + 3), i * 8 + 4);
      const v = set.values[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (count) device.queue.writeBuffer(this.#corners!, 0, packed);
    this.#count = count;
    this.#bounds = set.bounds;
    if (!this.#fixedRange)
      this.#range = min < max ? [min, max] : min === max && Number.isFinite(min) ? [min - 0.5, min + 0.5] : [0, 1];
  }

  /** @internal The figure's data-to-scene transform. */
  setModel(model: Float32Array): void {
    this.#model.set(model);
  }

  /** @internal */
  center(): readonly [number, number, number] {
    const [x0, x1, y0, y1, z0, z1] = this.#bounds,
      m = this.#model,
      c = [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2];
    return [0, 1, 2].map((r) => m[r] * c[0] + m[4 + r] * c[1] + m[8 + r] * c[2] + m[12 + r]) as unknown as [
      number,
      number,
      number,
    ];
  }

  /** @internal */
  prepare(context?: GpuContext): void {
    if (context) this.#appearance?.prepare?.(context);
    const v = this.#values;
    v.set(this.#model, 0);
    const inverse = new Float32Array(16);
    invertMatrix(this.#model, inverse);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) v[16 + c * 4 + r] = inverse[r * 4 + c];
    v[31] = 1;
    v.set([this.#range[0], this.#range[1], this.#opacity, this.#scalarOpacity ? 1 : 0], 32);
    v.set([...this.#missing, 1], 36);
    this.#renderer.device!.queue.writeBuffer(this.#uniform!, 0, v);
  }

  /** @internal */
  draw(pass: GPURenderPassEncoder, context: GpuContext, renderer: SciRenderer): void {
    if (!this.#count || !this.#group) return;
    const blend = this.transparent;
    const pipeline = renderer.pipeline(
      `${blend ? 'mesh-blend' : 'mesh'}:${this.#appearance?.key ?? ''}`,
      context,
      (target) => {
        const module = renderer.device!.createShaderModule({
          code: this.#appearance
            ? meshShader.replace(
                'shade(albedo, normalize(n), normalize(frame.eye.xyz - in.world))',
                this.#appearance.surface ? 'planetSurface(in.world, albedo)' : 'planetAerial(in.world, albedo)',
              ) + this.#appearance.shader
            : meshShader,
          label: 'sciviz mesh',
        });
        return {
          label: 'sciviz mesh',
          layout: renderer.device!.createPipelineLayout({
            bindGroupLayouts: [
              renderer.frameLayout!,
              this.#layout!,
              ...(this.#appearance ? [this.#appearance.layout] : []),
            ],
          }),
          vertex: { module, entryPoint: 'vertex' },
          fragment: {
            module,
            entryPoint: 'fragment',
            targets: [
              blend
                ? {
                    format: target.format,
                    blend: {
                      color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                    },
                  }
                : { format: target.format },
            ],
          },
          primitive: { topology: 'triangle-list', cullMode: 'none' },
          multisample: target.multisample,
          depthStencil: { format: target.depth, depthWriteEnabled: !blend, depthCompare: 'greater-equal' },
        };
      },
    );
    pass.setPipeline(pipeline);
    if (this.#appearance) pass.setBindGroup(2, this.#appearance.group);
    pass.setBindGroup(1, this.#group);
    pass.draw(this.#count);
  }

  /** Frees the GPU resources and leaves the figure's renderer. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#renderer.remove(this);
    this.#corners?.destroy();
    this.#uniform?.destroy();
    this.#texture?.destroy();
  }

  /** Same as `dispose()`, for `using`. */
  [Symbol.dispose](): void {
    this.dispose();
  }
}

/** Draws any triangle set in a figure (3D mode). */
export function meshLayer(figure: Figure, set: TriangleSet, options: MeshLayerOptions = {}): MeshLayer {
  requireGPU(figure.renderer);
  const layer = new MeshLayer(figure.renderer, set, options);
  try {
    figure.renderer.add(layer);
    return figure.addLayer(layer);
  } catch (error) {
    layer.dispose();
    throw error;
  }
}

/** Options of {@link gridLayer}. */
export interface GridLayerOptions extends MeshLayerOptions {
  /** `'point'` (default when the grid has pointData) or `'cell'`. */
  readonly values?: GridValues;
  /** A slice plane: draws the cut instead of the outer surface. Default none. */
  readonly slice?: SlicePlane;
}

/**
 * Draws an unstructured grid in a figure: its outer surface, or with `slice` the cut through it, coloured by point or
 * cell data. `layer.update(sliceGrid(grid, plane))` moves the slice.
 */
export function gridLayer(figure: Figure, grid: UnstructuredGrid, options: GridLayerOptions = {}): MeshLayer {
  const set = options.slice ? sliceGrid(grid, options.slice, options) : gridSurface(grid, options);
  return meshLayer(figure, set, options);
}
