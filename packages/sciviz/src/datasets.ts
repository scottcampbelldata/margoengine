// Clean-room dataset normalization. Sources and conventions: docs/clean-room.md, batch 176.
import { rangeError } from '../../shared/errors.js';
import type { AnalysisGrid } from './clip.js';
import { checkComplex, cross3, dot3, sub3 } from './cell-complex.js';
import { tessellateCell, type FiniteElementCell } from './datasets-elements.js';
import { decomposePolyhedron, polyhedronWeights } from './datasets-polyhedron.js';

/** Flat, interleaved named tuples; widths are inferred from the associated point or cell count. */
export interface DataSetFields {
  readonly pointData?: ArrayLike<number>;
  readonly cellData?: ArrayLike<number>;
  readonly pointArrays?: Readonly<Record<string, ArrayLike<number>>>;
  readonly cellArrays?: Readonly<Record<string, ArrayLike<number>>>;
}
/** A normalized dataset is directly accepted by the pipeline, contour, clip, calculator, probe and glyph entries.
 * Geometry is linearized once, with no dependency on the renderer. Composite boundaries are never welded.
 */
export interface DataSet extends AnalysisGrid {
  readonly kind: 'structured' | 'rectilinear' | 'polydata' | 'unstructured' | 'multiblock' | 'partitioned';
  /** Source structured shape; deliberately distinct from the regular-image filter's `dims` discriminator. */
  readonly dimensions?: readonly [number, number, number];
  readonly blocks?: readonly (DataSet | null)[];
  readonly names?: readonly string[];
  /** Top-level block of each normalized cell. */
  readonly blockIds?: Uint32Array;
  /** Original cell within the source leaf, including descendants of a tessellated cell. */
  readonly sourceCells: Uint32Array;
}
/** Mixed cells. Polyhedron faces contain global point IDs, in outward order; the stream is nfaces,npts,ids,... . */
export type DataSetCell =
  | { readonly type: number; readonly ids: readonly number[] }
  | { readonly type: 'polyhedron'; readonly faces: ArrayLike<number> }
  | FiniteElementCell;
/** Structured x-fastest topology permits singleton dimensions, including lines and individual points. */
export type DataSetInput = DataSetFields &
  (
    | {
        readonly kind: 'structured';
        readonly dimensions: readonly [number, number, number];
        readonly points: ArrayLike<number>;
      }
    | {
        readonly kind: 'rectilinear';
        readonly axes: readonly [ArrayLike<number>, ArrayLike<number>, ArrayLike<number>];
      }
    | {
        readonly kind: 'polydata';
        readonly points: ArrayLike<number>;
        readonly vertices?: readonly (readonly number[])[];
        readonly lines?: readonly (readonly number[])[];
        readonly polygons?: readonly (readonly number[])[];
        readonly strips?: readonly (readonly number[])[];
      }
    | { readonly kind: 'unstructured'; readonly points: ArrayLike<number>; readonly cells: readonly DataSetCell[] }
    | {
        readonly kind: 'multiblock' | 'partitioned';
        readonly blocks: readonly (DataSetInput | DataSet | null)[];
        readonly names?: readonly string[];
      }
  );
/** Bounded deterministic tessellation. Default 2 subdivisions per parametric direction, max 64. */
export interface DataSetOptions {
  readonly subdivisions?: number;
  readonly maxPoints?: number;
  readonly signal?: AbortSignal;
}

const bad = (message: string): never => {
  throw rangeError(`DataSet: ${message}; correct the source dataset`, 'sciviz');
};
const point = (p: ArrayLike<number>, id: number) => [p[3 * id], p[3 * id + 1], p[3 * id + 2]];

/** Ear clipping on the dominant projection supports simple, planar concave polygons without a fan outside the face. */
function triangles(ids: readonly number[], points: ArrayLike<number>): number[][] {
  if (ids.length < 3 || new Set(ids).size !== ids.length) bad('a polygon needs at least three distinct vertices');
  const p = ids.map((id) => point(points, id)),
    n = [0, 0, 0];
  for (let i = 0; i < p.length; i++) {
    const q = p[(i + 1) % p.length];
    for (let a = 0; a < 3; a++) n[a] += (p[i][(a + 1) % 3] - q[(a + 1) % 3]) * (p[i][(a + 2) % 3] + q[(a + 2) % 3]);
  }
  const axis = n.map(Math.abs).indexOf(Math.max(...n.map(Math.abs))),
    norm = Math.hypot(...n);
  if (!norm) bad('degenerate polygon');
  const scale = Math.max(...p.map((q) => Math.hypot(...sub3(q, p[0]))));
  if (p.some((q) => Math.abs(dot3(n, sub3(q, p[0]))) > 1e-10 * norm * scale)) bad('polygon is not planar');
  const axes = [0, 1, 2].filter((a) => a !== axis),
    orient = (a: number, b: number, c: number) =>
      (p[b][axes[0]] - p[a][axes[0]]) * (p[c][axes[1]] - p[a][axes[1]]) -
      (p[b][axes[1]] - p[a][axes[1]]) * (p[c][axes[0]] - p[a][axes[0]]);
  const sign = Math.sign(
    ids.reduce(
      (s, _, i) => s + p[i][axes[0]] * p[(i + 1) % p.length][axes[1]] - p[(i + 1) % p.length][axes[0]] * p[i][axes[1]],
      0,
    ),
  );
  const ring = ids.map((_, i) => i),
    out: number[][] = [];
  while (ring.length > 3) {
    let found = false;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[(i + ring.length - 1) % ring.length],
        b = ring[i],
        c = ring[(i + 1) % ring.length];
      if (sign * orient(a, b, c) <= 0) continue;
      if (
        ring.some(
          (v) =>
            v !== a &&
            v !== b &&
            v !== c &&
            sign * orient(a, b, v) >= 0 &&
            sign * orient(b, c, v) >= 0 &&
            sign * orient(c, a, v) >= 0,
        )
      )
        continue;
      out.push([ids[a], ids[b], ids[c]]);
      ring.splice(i, 1);
      found = true;
      break;
    }
    if (!found) bad('polygon self-intersects or has degenerate edges');
  }
  out.push(ring.map((i) => ids[i]));
  return out;
}

function fields(input: DataSetFields, points: number, cells: number) {
  const copy = (a: ArrayLike<number> | undefined, count: number, scalar: boolean) => {
    if (!a) return undefined;
    if (
      (scalar && a.length !== count) ||
      (!scalar && (!count ? a.length !== 0 : a.length % count !== 0 || a.length / count < 1))
    )
      bad('field tuple count differs from topology');
    const out = Float64Array.from(a);
    if (out.some((x) => !Number.isFinite(x))) bad('fields need finite values');
    return out;
  };
  const named = (a: Readonly<Record<string, ArrayLike<number>>> | undefined, count: number) =>
    Object.fromEntries(
      Object.entries(a ?? {}).map(([name, data]) => {
        if (!name) bad('named arrays need nonempty names');
        return [name, copy(data, count, false)!];
      }),
    );
  return {
    pointData: copy(input.pointData, points, true),
    cellData: copy(input.cellData, cells, true),
    pointArrays: named(input.pointArrays, points),
    cellArrays: named(input.cellArrays, cells),
  };
}

/** Owns all normalized arrays. No caller input is mutated, no loading or GPU work occurs. */
export async function createDataSet(input: DataSetInput, options: DataSetOptions = {}): Promise<DataSet> {
  return normalize(input, options, new Set(), 0);
}
async function normalize(
  input: DataSetInput,
  options: DataSetOptions,
  ancestors: Set<unknown>,
  depth: number,
): Promise<DataSet> {
  const signal = options.signal,
    max = options.maxPoints ?? 1_000_000,
    subdivisions = options.subdivisions ?? 2;
  signal?.throwIfAborted();
  if (!input || depth > 64 || ancestors.has(input)) bad('cyclic or excessively nested dataset');
  const next = new Set(ancestors).add(input);
  if (
    !Number.isSafeInteger(max) ||
    max < 1 ||
    max > 10_000_000 ||
    !Number.isInteger(subdivisions) ||
    subdivisions < 1 ||
    subdivisions > 64
  )
    bad('maxPoints must be 1..10000000 and subdivisions 1..64');
  if (input.kind === 'multiblock' || input.kind === 'partitioned') {
    const blocks: (DataSet | null)[] = [];
    for (const b of input.blocks) blocks.push(b ? await createDataSetInput(b, options, next, depth + 1) : null);
    return combine(input.kind, blocks, input.names, max);
  }
  let points: number[],
    cells: DataSetCell[] = [],
    dimensions: [number, number, number] | undefined;
  if (input.kind === 'structured' || input.kind === 'rectilinear') {
    dimensions = [...(input.kind === 'structured' ? input.dimensions : input.axes.map((a) => a.length))] as [
      number,
      number,
      number,
    ];
    if (dimensions.some((n) => !Number.isSafeInteger(n) || n < 1) || dimensions.reduce((a, b) => a * b, 1) > max)
      bad('invalid structured dimensions or point limit');
    const [nx, ny, nz] = dimensions,
      count = nx * ny * nz;
    if (input.kind === 'structured') points = Array.from(input.points);
    else {
      for (const axis of input.axes) {
        if (Array.from(axis).some((x) => !Number.isFinite(x))) bad('rectilinear coordinates must be finite');
        const sign = Math.sign(axis[1] - axis[0]);
        for (let i = 1; i < axis.length; i++)
          if (!sign || Math.sign(axis[i] - axis[i - 1]) !== sign) bad('rectilinear axes must be strictly monotone');
      }
      points = [];
      for (let z = 0; z < nz; z++)
        for (let y = 0; y < ny; y++)
          for (let x = 0; x < nx; x++) points.push(input.axes[0][x], input.axes[1][y], input.axes[2][z]);
    }
    if (points.length !== count * 3) bad('structured point count differs from dimensions');
    const active = [0, 1, 2].filter((a) => dimensions![a] > 1),
      strides = [1, nx, nx * ny];
    for (let z = 0; z < Math.max(1, nz - 1); z++)
      for (let y = 0; y < Math.max(1, ny - 1); y++)
        for (let x = 0; x < Math.max(1, nx - 1); x++) {
          const id = x + nx * (y + ny * z),
            [a, b, c] = active.map((i) => strides[i]);
          const ids =
            active.length === 0 ? [id] : active.length === 1 ? [id, id + a] : [id, id + a, id + a + b, id + b];
          if (active.length === 3) ids.push(id + c, id + a + c, id + a + b + c, id + b + c);
          cells.push({ type: [1, 3, 9, 12][active.length], ids });
        }
  } else if (input.kind === 'polydata') {
    points = Array.from(input.points);
    for (const [type, group] of [
      [2, input.vertices],
      [4, input.lines],
      [7, input.polygons],
      [6, input.strips],
    ] as const)
      for (const ids of group ?? []) cells.push({ type, ids });
  } else if (input.kind === 'unstructured') {
    points = Array.from(input.points);
    cells = [...input.cells];
  } else return bad('unknown dataset kind');
  if (points.length % 3 || points.length / 3 > max || points.some((x) => !Number.isFinite(x)))
    bad('invalid xyz coordinates or point limit');
  if (cells.length > max) bad('source cell count exceeds maxPoints');
  const data = fields(input, points.length / 3, cells.length),
    outPoints = [...points],
    connectivity: number[] = [],
    offsets: number[] = [],
    types: number[] = [],
    source: number[] = [];
  const pa = Object.fromEntries(
    Object.entries({ ...data.pointArrays, ...(data.pointData ? { '': data.pointData } : {}) }).map(([k, a]) => [
      k,
      Array.from(a),
    ]),
  );
  const ca = Object.fromEntries(
    Object.keys({ ...data.cellArrays, ...(data.cellData ? { '': data.cellData } : {}) }).map((k) => [
      k,
      [] as number[],
    ]),
  );
  const cellRows = { ...data.cellArrays, ...(data.cellData ? { '': data.cellData } : {}) };
  const emit = (ids: readonly number[], type: number, cell: number) => {
    const widths: Record<number, number> = { 1: 1, 3: 2, 5: 3, 9: 4, 10: 4, 12: 8, 13: 6, 14: 5 };
    if (!widths[type] || ids.length !== widths[type] || offsets.length >= max * 4)
      bad('invalid linear cell or output cell limit');
    connectivity.push(...ids);
    offsets.push(connectivity.length);
    types.push(type);
    source.push(cell);
    for (const [name, row] of Object.entries(cellRows)) {
      const width = row.length / cells.length;
      for (let k = 0; k < width; k++) ca[name].push(row[cell * width + k]);
    }
  };
  const generated = new Map<string, number>();
  const insert = (weights: readonly number[], ids: readonly number[]) => {
    const nonzero = weights
      .map((w, i) => ({ w, id: ids[i] }))
      .filter((x) => Math.abs(x.w) > 1e-15)
      .sort((a, b) => a.id - b.id);
    if (nonzero.length === 1 && Math.abs(nonzero[0].w - 1) < 1e-14) return nonzero[0].id;
    const key = nonzero.map((x) => `${x.id}:${x.w.toPrecision(14)}`).join(';');
    if (generated.has(key)) return generated.get(key)!;
    const id = outPoints.length / 3;
    if (id >= max) bad('tessellation exceeds maxPoints');
    for (let a = 0; a < 3; a++) outPoints.push(weights.reduce((s, w, k) => s + w * points[3 * ids[k] + a], 0));
    for (const [name, a] of Object.entries(pa)) {
      const width = (name === '' ? data.pointData! : data.pointArrays[name]).length / (points.length / 3);
      for (let k = 0; k < width; k++) a.push(weights.reduce((s, w, i) => s + w * a[ids[i] * width + k], 0));
    }
    generated.set(key, id);
    return id;
  };
  for (let c = 0; c < cells.length; c++) {
    if (c % 2048 === 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      signal?.throwIfAborted();
    }
    const cell = cells[c];
    if (cell.type === 'polyhedron') {
      const f = Array.from(cell.faces),
        faces: number[][] = [];
      let at = 1;
      if (!Number.isSafeInteger(f[0]) || f[0] < 4) bad('polyhedron needs a face stream with at least four faces');
      for (let i = 0; i < f[0]; i++) {
        const count = f[at++];
        if (!Number.isInteger(count) || count < 3 || at + count > f.length) bad('invalid face stream');
        faces.push(f.slice(at, at + count));
        at += count;
      }
      if (at !== f.length) bad('face stream has trailing data');
      const ids = [...new Set(faces.flat())];
      validateIds(ids, points.length / 3);
      const edges = new Map<string, number[]>();
      for (const face of faces)
        for (let i = 0; i < face.length; i++) {
          const a = face[i],
            b = face[(i + 1) % face.length],
            key = a < b ? `${a},${b}` : `${b},${a}`;
          edges.set(key, [...(edges.get(key) ?? []), Math.sign(b - a)]);
        }
      if ([...edges.values()].some((e) => e.length !== 2 || e[0] + e[1] !== 0))
        bad('polyhedron faces must be closed and consistently outward oriented');
      const origin = [0, 1, 2].map((a) => ids.reduce((s, id) => s + points[3 * id + a], 0) / ids.length);
      const facets = faces.flatMap((face) => triangles(face, points));
      const local = ids.map((id) => point(points, id)),
        localFacets = facets.map((tri) => tri.map((id) => ids.indexOf(id)));
      if (
        facets.some((tri) => {
          const [a, b, d] = tri.map((id) => point(points, id));
          return dot3(cross3(sub3(b, a), sub3(d, a)), sub3(origin, a)) >= 0;
        })
      ) {
        decomposePolyhedron(
          local,
          localFacets,
          (w) => insert(w, ids),
          (tet) => emit(tet, 10, c),
        );
      } else {
        const scale = Math.max(...local.map((p) => Math.hypot(...sub3(p, origin))));
        const apex = insert(polyhedronWeights(origin, local, localFacets, scale * 128 * Number.EPSILON), ids);
        for (const tri of facets) emit([apex, ...tri], 10, c);
      }
    } else {
      validateIds(cell.ids, points.length / 3);
      if (cell.type === 'lagrange' || cell.type === 'quadratic') {
        tessellateCell(
          cell,
          subdivisions,
          (weights) => insert(weights, cell.ids),
          (ids, type) => emit(ids, type, c),
        );
      } else if (cell.type === 2) {
        if (!cell.ids.length) bad('polyvertex is empty');
        for (const id of cell.ids) emit([id], 1, c);
      } else if (cell.type === 4) {
        if (cell.ids.length < 2) bad('polyline needs two vertices');
        for (let i = 1; i < cell.ids.length; i++) emit([cell.ids[i - 1], cell.ids[i]], 3, c);
      } else if (cell.type === 6) {
        if (cell.ids.length < 3) bad('strip needs three vertices');
        for (let i = 2; i < cell.ids.length; i++)
          emit(
            i % 2 ? [cell.ids[i - 1], cell.ids[i - 2], cell.ids[i]] : [cell.ids[i - 2], cell.ids[i - 1], cell.ids[i]],
            5,
            c,
          );
      } else if (cell.type === 7) for (const tri of triangles(cell.ids, points)) emit(tri, 5, c);
      else emit(cell.ids, cell.type, c);
    }
  }
  const pointData = pa[''] && Float64Array.from(pa['']),
    cellData = ca[''] && Float64Array.from(ca['']);
  delete pa[''];
  delete ca[''];
  const result: DataSet = {
    kind: input.kind,
    dimensions,
    points: Float64Array.from(outPoints),
    connectivity: Uint32Array.from(connectivity),
    offsets: Uint32Array.from(offsets),
    types: Uint8Array.from(types),
    sourceCells: Uint32Array.from(source),
    pointData,
    cellData,
    pointArrays: Object.fromEntries(Object.entries(pa).map(([k, a]) => [k, Float64Array.from(a)])),
    cellArrays: Object.fromEntries(Object.entries(ca).map(([k, a]) => [k, Float64Array.from(a)])),
  };
  checkComplex(result, true);
  signal?.throwIfAborted();
  return result;
}

function validateIds(ids: readonly number[], count: number): void {
  if (ids.some((id) => !Number.isSafeInteger(id) || id < 0 || id >= count) || new Set(ids).size !== ids.length)
    bad('invalid or repeated cell point index');
}
async function createDataSetInput(
  input: DataSetInput | DataSet,
  options: DataSetOptions,
  ancestors: Set<unknown>,
  depth: number,
): Promise<DataSet> {
  if (depth > 64 || ancestors.has(input)) bad('cyclic or excessively nested dataset');
  if ('connectivity' in input) {
    const ids = Array.from(input.connectivity);
    const copy = await normalize(
      {
        ...input,
        cells: Array.from(input.types, (type, c) => ({
          type,
          ids: ids.slice(c ? input.offsets[c - 1] : 0, input.offsets[c]),
        })),
        kind: 'unstructured',
      },
      options,
      ancestors,
      depth,
    );
    return {
      ...copy,
      kind: input.kind,
      dimensions: input.dimensions,
      sourceCells: input.sourceCells.slice(),
      blocks:
        input.blocks &&
        (await Promise.all(
          input.blocks.map((b) =>
            b ? createDataSetInput(b, options, new Set(ancestors).add(input), depth + 1) : null,
          ),
        )),
      names: input.names && [...input.names],
      blockIds: input.blockIds?.slice(),
    };
  }
  return normalize(input, options, ancestors, depth);
}

function combine(
  kind: 'multiblock' | 'partitioned',
  blocks: readonly (DataSet | null)[],
  names: readonly string[] | undefined,
  max: number,
): DataSet {
  if (names && (names.length !== blocks.length || names.some((n) => typeof n !== 'string')))
    bad('composite names must match blocks');
  const live = blocks.filter((b): b is DataSet => !!b),
    points: number[] = [],
    connectivity: number[] = [],
    offsets: number[] = [],
    types: number[] = [],
    source: number[] = [],
    blockIds: number[] = [];
  const rows = (association: 'point' | 'cell') => {
    const arrays: Record<string, ArrayLike<number>>[] = live.map((b) => ({
      ...(association === 'point' ? b.pointArrays : b.cellArrays),
      ...((association === 'point' ? b.pointData : b.cellData)
        ? { '': (association === 'point' ? b.pointData : b.cellData)! }
        : {}),
    }));
    const keys = Object.keys(arrays[0] ?? {}).filter((k) => arrays.every((a) => Object.hasOwn(a, k))),
      result: Record<string, Float64Array> = {};
    for (const key of keys) {
      let width = 0;
      for (let i = 0; i < live.length; i++)
        if (arrays[i][key]) {
          const count = association === 'point' ? live[i].points.length / 3 : live[i].types.length;
          if (!count) continue;
          const w = arrays[i][key].length / count;
          if (width && width !== w) bad('composite field widths differ');
          width = w;
        }
      const joined: number[] = [];
      for (let i = 0; i < live.length; i++) {
        for (const value of Array.from(arrays[i][key] ?? [])) joined.push(value);
      }
      result[key] = Float64Array.from(joined);
    }
    return result;
  };
  const pa = rows('point'),
    ca = rows('cell');
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (!b) continue;
    const base = points.length / 3,
      start = connectivity.length;
    if (base + b.points.length / 3 > max) bad('composite exceeds maxPoints');
    for (const v of Array.from(b.points)) points.push(v);
    for (const v of Array.from(b.connectivity)) connectivity.push(base + v);
    for (let c = 0; c < b.types.length; c++) {
      offsets.push(start + b.offsets[c]);
      types.push(b.types[c]);
      source.push(b.sourceCells[c]);
      blockIds.push(i);
    }
  }
  const pointData = pa[''],
    cellData = ca[''];
  delete pa[''];
  delete ca[''];
  return {
    kind,
    blocks,
    names: names && [...names],
    points: Float64Array.from(points),
    connectivity: Uint32Array.from(connectivity),
    offsets: Uint32Array.from(offsets),
    types: Uint8Array.from(types),
    sourceCells: Uint32Array.from(source),
    blockIds: Uint32Array.from(blockIds),
    pointData,
    cellData,
    pointArrays: pa,
    cellArrays: ca,
  };
}

export { openDataSet, parsePLOT3D } from './datasets-readers.js';
export type { DataSetReadOptions, PLOT3DOptions } from './datasets-readers.js';
export type { FiniteElementCell, ElementShape } from './datasets-elements.js';
