import { rangeError } from '../../shared/errors.js';
import type { UnstructuredGrid } from './grids.js';
import type { Bounds } from './layer.js';
import type { PipelineOperator } from './pipeline.js';
import { checkComplex, simplices, cross3, dot3, sub3 } from './cell-complex.js';

/** Named arrays are flat interleaved tuples. Tuple width is inferred from the associated count. */
export interface AnalysisGrid extends UnstructuredGrid {
  readonly pointArrays?: Readonly<Record<string, ArrayLike<number>>>;
  readonly cellArrays?: Readonly<Record<string, ArrayLike<number>>>;
  /** Original cell IDs, retained through compositions of filters. Default current cell indices. */
  readonly sourceCells?: ArrayLike<number>;
}
/** Cartesian image samples, x fastest; bounds span first to last sample. */
export interface AnalysisImage {
  readonly dims: readonly [number, number, number];
  readonly bounds: Bounds;
  /** Optional explicit xyz per sample for a curvilinear structured grid. Default Cartesian bounds. */
  readonly points?: ArrayLike<number>;
  readonly pointData?: ArrayLike<number>;
  readonly cellData?: ArrayLike<number>;
  readonly pointArrays?: Readonly<Record<string, ArrayLike<number>>>;
  readonly cellArrays?: Readonly<Record<string, ArrayLike<number>>>;
}
/** Positive is retained, including the boundary. */
export type ClipShape =
  | { readonly kind: 'plane'; readonly normal: readonly [number, number, number]; readonly offset: number }
  | { readonly kind: 'box'; readonly bounds: Bounds }
  | { readonly kind: 'sphere'; readonly center: readonly [number, number, number]; readonly radius: number }
  | { readonly kind: 'scalar'; readonly value: number; readonly array?: string };
/** CPU filters borrow inputs, return owned arrays and cooperatively cancel with the exact reason. */
export interface ClipOptions {
  readonly signal?: AbortSignal;
  /** Keep the opposite side. Default false. */
  readonly invert?: boolean;
  /** Keep complete cells with at least one retained point, without cuts. Default false. */
  readonly crinkle?: boolean;
}
/** Inclusive range. Point mode defaults to all vertices in range. */
export interface ThresholdOptions {
  readonly association?: 'point' | 'cell';
  readonly array?: string;
  readonly mode?: 'all' | 'any';
  readonly invert?: boolean;
  readonly signal?: AbortSignal;
}
/** Inclusive sample indices, positive strides. Default full extent and unit strides. */
export interface SubsetOptions {
  readonly ranges?: readonly [readonly [number, number], readonly [number, number], readonly [number, number]];
  readonly strides?: readonly [number, number, number];
  readonly signal?: AbortSignal;
}
const pause = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const coordinate = (g: AnalysisGrid, id: number): number[] => [g.points[3 * id], g.points[3 * id + 1], g.points[3 * id + 2]];
function named(grid: AnalysisGrid, point: boolean): Record<string, ArrayLike<number>> {
  return { ...(point ? grid.pointArrays : grid.cellArrays), ...((point ? grid.pointData : grid.cellData) ? { '': (point ? grid.pointData : grid.cellData)! } : {}) };
}
function validate(grid: AnalysisGrid): void {
  checkComplex(grid, true);
  if (Object.hasOwn(grid.pointArrays ?? {}, '') || Object.hasOwn(grid.cellArrays ?? {}, ''))
    throw rangeError('Named analysis arrays must use a nonempty name; default scalars use pointData/cellData', 'sciviz');
  if (Array.from(grid.points).some(x => !Number.isFinite(x))) throw rangeError('Analysis coordinates must be finite', 'sciviz');
  for (const point of [false, true]) {
    const count = point ? grid.points.length / 3 : grid.types.length;
    for (const [name, data] of Object.entries(named(grid, point))) {
      if (!data || (count === 0 ? data.length !== 0 : !Number.isInteger(data.length / count) || data.length / count < 1))
        throw rangeError(`Analysis array ${name} must contain complete point or cell tuples`, 'sciviz');
    }
  }
  if (grid.sourceCells && (grid.sourceCells.length !== grid.types.length || Array.from(grid.sourceCells).some(id => !Number.isSafeInteger(id) || id < 0 || id > 0xffffffff)))
    throw rangeError('sourceCells must contain one unsigned 32-bit ID per cell', 'sciviz');
}
const asGrid = (input: AnalysisGrid | AnalysisImage): AnalysisGrid => 'dims' in input ? imageGrid(input) : input;

/** Materialize a 2D/3D regular image as quads/hexahedra without changing its array values. */
export function imageGrid(image: AnalysisImage): AnalysisGrid {
  if (!image?.dims || image.dims.length !== 3 || image.bounds?.length !== 6 ||
    !image.dims.every(n => Number.isSafeInteger(n) && n >= 1) || !image.bounds.every(Number.isFinite))
    throw rangeError('An analysis image needs three positive dimensions and six finite bounds', 'sciviz');
  const d = image.dims, n = d[0] * d[1] * d[2], axes = [0, 1, 2].filter(a => d[a] > 1);
  if (!Number.isSafeInteger(n) || n > 1_000_000 || axes.length < 2)
    throw rangeError('Analysis images must have two or three active axes and at most 1000000 samples', 'sciviz');
  if (image.points && image.points.length !== n * 3) throw rangeError('Structured points must contain xyz per sample', 'sciviz');
  for (let a = 0; a < 3; a++) if (!image.points && (d[a] === 1) !== (image.bounds[2 * a] === image.bounds[2 * a + 1]))
    throw rangeError('Image singleton bounds must agree, and active-axis bounds must differ', 'sciviz');
  const points = new Float64Array(n * 3), connectivity: number[] = [], offsets: number[] = [], types: number[] = [];
  const stride = [1, d[0], d[0] * d[1]];
  for (let z = 0; z < d[2]; z++) for (let y = 0; y < d[1]; y++) for (let x = 0; x < d[0]; x++) {
    const c = [x, y, z], i = x + d[0] * (y + d[1] * z);
    for (let a = 0; a < 3; a++) points[3 * i + a] = image.points ? image.points[3 * i + a] : image.bounds[2 * a] + (d[a] === 1 ? 0 : c[a] / (d[a] - 1) * (image.bounds[2 * a + 1] - image.bounds[2 * a]));
    if (axes.some(a => c[a] === d[a] - 1)) continue;
    const [a, b, h] = axes.map(a => stride[a]), ids = [i, i + a, i + a + b, i + b];
    if (h !== undefined) ids.push(i + h, i + a + h, i + a + b + h, i + b + h);
    connectivity.push(...ids); offsets.push(connectivity.length); types.push(h === undefined ? 9 : 12);
  }
  const grid = { points, connectivity: new Uint32Array(connectivity), offsets: new Uint32Array(offsets), types: new Uint8Array(types),
    pointData: image.pointData, cellData: image.cellData, pointArrays: image.pointArrays, cellArrays: image.cellArrays };
  validate(grid); return grid;
}

function select(grid: AnalysisGrid, selected: readonly number[]): AnalysisGrid {
  const ids = new Map<number, number>(), oldPoints: number[] = [], connectivity: number[] = [], offsets: number[] = [];
  for (const c of selected) {
    for (let k = c === 0 ? 0 : grid.offsets[c - 1]; k < grid.offsets[c]; k++) {
      const id = grid.connectivity[k]; if (!ids.has(id)) { ids.set(id, ids.size); oldPoints.push(id); }
      connectivity.push(ids.get(id)!);
    }
    offsets.push(connectivity.length);
  }
  const arrays = (point: boolean) => Object.fromEntries(Object.entries(named(grid, point)).map(([name, data]) => {
    const count = point ? grid.points.length / 3 : grid.types.length, width = count ? data.length / count : 1;
    return [name, Float64Array.from((point ? oldPoints : selected).flatMap(id => Array.from({ length: width }, (_, k) => data[id * width + k])))];
  }));
  const pa = arrays(true), ca = arrays(false), pointData = pa[''], cellData = ca['']; delete pa['']; delete ca[''];
  return { points: Float64Array.from(oldPoints.flatMap(id => coordinate(grid, id))), connectivity: new Uint32Array(connectivity), offsets: new Uint32Array(offsets),
    types: Uint8Array.from(selected, c => grid.types[c]), pointData, cellData, pointArrays: pa, cellArrays: ca,
    sourceCells: Uint32Array.from(selected, c => grid.sourceCells?.[c] ?? c) };
}

function scalar(grid: AnalysisGrid, point: boolean, array?: string): ArrayLike<number> {
  const data = array === undefined ? (point ? grid.pointData : grid.cellData) : (point ? grid.pointArrays : grid.cellArrays)?.[array];
  if (!data || data.length !== (point ? grid.points.length / 3 : grid.types.length))
    throw rangeError('Select a scalar array with one value per associated point or cell', 'sciviz');
  return data;
}

/** Retain complete cells by point or cell scalar range, compacting all arrays and preserving provenance. */
export async function thresholdGrid(input: AnalysisGrid | AnalysisImage, range: readonly [number, number], options: ThresholdOptions = {}): Promise<AnalysisGrid> {
  options.signal?.throwIfAborted(); const grid = asGrid(input); validate(grid);
  if (range.length !== 2 || !range.every(Number.isFinite) || range[0] > range[1] ||
    (options.association !== undefined && !['point', 'cell'].includes(options.association)) ||
    (options.mode !== undefined && !['all', 'any'].includes(options.mode)))
    throw rangeError('Threshold needs a finite ordered range, point/cell association and all/any point mode', 'sciviz');
  const point = (options.association ?? 'point') === 'point', data = scalar(grid, point, options.array), selected: number[] = [];
  const inside = (v: number) => Number.isFinite(v) && v >= range[0] && v <= range[1];
  for (let c = 0; c < grid.types.length; c++) {
    if (c % 2048 === 0) { await pause(); options.signal?.throwIfAborted(); }
    let keep = inside(data[c]);
    if (point) {
      const ids = Array.from({ length: grid.offsets[c] - (c ? grid.offsets[c - 1] : 0) }, (_, k) => grid.connectivity[(c ? grid.offsets[c - 1] : 0) + k]);
      keep = options.mode === 'any' ? ids.some(id => inside(data[id])) : ids.every(id => inside(data[id]));
    }
    if (keep !== (options.invert ?? false)) selected.push(c);
  }
  options.signal?.throwIfAborted(); return select(grid, selected);
}

// Single plane in scalar space: clip simplex faces and cap, then pull the convex retained polytope.
async function cut(grid: AnalysisGrid, field: Float64Array, signal?: AbortSignal): Promise<AnalysisGrid> {
  const points: number[] = [], pointRows = named(grid, true), cellRows = named(grid, false),
    pa: Record<string, number[]> = Object.fromEntries(Object.keys(pointRows).map(k => [k, []])),
    ca: Record<string, number[]> = Object.fromEntries(Object.keys(cellRows).map(k => [k, []])),
    connectivity: number[] = [], offsets: number[] = [], types: number[] = [], source: number[] = [], ids = new Map<string, number>();
  const original = (id: number): number => {
    const key = `v${id}`; if (ids.has(key)) return ids.get(key)!;
    const index = points.length / 3; ids.set(key, index); points.push(...coordinate(grid, id));
    for (const [name, data] of Object.entries(pointRows)) {
      const width = data.length / (grid.points.length / 3); for (let k = 0; k < width; k++) pa[name].push(data[id * width + k]);
    }
    return index;
  };
  const edge = (a: number, b: number): number => {
    if (field[a] === 0) return original(a); if (field[b] === 0) return original(b);
    if (a > b) [a, b] = [b, a];
    const key = `${a},${b}`; if (ids.has(key)) return ids.get(key)!;
    const t = field[a] / (field[a] - field[b]), index = points.length / 3; ids.set(key, index);
    const p = coordinate(grid, a), q = coordinate(grid, b); points.push(...p.map((v, k) => v + t * (q[k] - v)));
    for (const [name, data] of Object.entries(pointRows)) {
      const width = data.length / (grid.points.length / 3);
      for (let k = 0; k < width; k++) pa[name].push(data[a * width + k] + t * (data[b * width + k] - data[a * width + k]));
    }
    return index;
  };
  const emit = (vertices: number[], cell: number) => {
    if (new Set(vertices).size !== vertices.length) return;
    const p = vertices.map(id => points.slice(3 * id, 3 * id + 3));
    const a = p.length > 1 ? sub3(p[1], p[0]) : [], b = p.length > 2 ? sub3(p[2], p[0]) : [],
      measure = p.length === 1 ? 1 : p.length === 2 ? Math.hypot(...a) : vertices.length === 4 ? dot3(cross3(a, b), sub3(p[3], p[0])) : Math.hypot(...cross3(a, b));
    if (measure === 0) return;
    if (vertices.length === 4 && measure < 0) [vertices[1], vertices[2]] = [vertices[2], vertices[1]];
    connectivity.push(...vertices); offsets.push(connectivity.length); types.push([0, 1, 3, 5, 10][vertices.length]); source.push(grid.sourceCells?.[cell] ?? cell);
    for (const [name, data] of Object.entries(cellRows)) {
      const width = data.length / grid.types.length; for (let k = 0; k < width; k++) ca[name].push(data[cell * width + k]);
    }
  };
  let visited = 0;
  for (const { ids: corners, cell } of simplices(grid)) {
    if (visited++ % 2048 === 0) { await pause(); signal?.throwIfAborted(); }
    if (corners.every(id => field[id] >= 0)) { emit(corners.map(original), cell); continue; }
    if (corners.every(id => field[id] < 0)) continue;
    if (corners.length === 2) {
      const [a, b] = corners;
      emit(field[a] >= 0 ? [original(a), edge(a, b)] : [edge(a, b), original(b)], cell);
      continue;
    }
    const volume = corners.length === 4, faces = volume ? [[0, 2, 1], [0, 1, 3], [1, 2, 3], [0, 3, 2]] : [[0, 1, 2]], clipped: number[][] = [], cap = new Set<number>();
    for (const face of faces) {
      const ring = face.map(k => corners[k]), out: number[] = [];
      for (let k = 0; k < ring.length; k++) {
        const a = ring[k], b = ring[(k + 1) % ring.length], ina = field[a] >= 0, inb = field[b] >= 0;
        if (ina) out.push(original(a));
        if (ina !== inb) { const id = edge(a, b); out.push(id); cap.add(id); }
        if (field[a] === 0) cap.add(original(a));
      }
      const unique = [...new Set(out)]; if (unique.length >= 3) clipped.push(unique);
    }
    if (volume && cap.size >= 3) {
      const ring = [...cap], p = ring.map(id => points.slice(3 * id, 3 * id + 3)), center = [0, 1, 2].map(a => p.reduce((s, x) => s + x[a], 0) / p.length), u = sub3(p[0], center);
      let n = [0, 0, 0];
      for (let k = 1; k < p.length && Math.hypot(...n) === 0; k++) n = cross3(u, sub3(p[k], center));
      const v = cross3(n, u);
      ring.sort((a, b) => {
        const pa = sub3(points.slice(3 * a, 3 * a + 3), center), pb = sub3(points.slice(3 * b, 3 * b + 3), center);
        return Math.atan2(dot3(pa, v), dot3(pa, u)) - Math.atan2(dot3(pb, v), dot3(pb, u));
      });
      clipped.push(ring);
    }
    if (volume) {
      const apex = Math.min(...clipped.flat());
      const seen = new Set<string>();
      for (const face of clipped) if (!face.includes(apex)) {
        const at = face.indexOf(Math.min(...face));
        for (let k = 1; k < face.length - 1; k++) {
          const tet = [apex, face[at], face[(at + k) % face.length], face[(at + k + 1) % face.length]], key = [...tet].sort((a, b) => a - b).join(',');
          if (!seen.has(key)) { seen.add(key); emit(tet, cell); }
        }
      }
    } else for (const face of clipped) for (let k = 1; k < face.length - 1; k++) emit([face[0], face[k], face[k + 1]], cell);
  }
  signal?.throwIfAborted();
  const pointData = pa[''] && new Float64Array(pa['']), cellData = ca[''] && new Float64Array(ca['']); delete pa['']; delete ca[''];
  const result = { points: new Float64Array(points), connectivity: new Uint32Array(connectivity), offsets: new Uint32Array(offsets), types: new Uint8Array(types), sourceCells: new Uint32Array(source),
    pointData, cellData, pointArrays: Object.fromEntries(Object.entries(pa).map(([k, v]) => [k, new Float64Array(v)])), cellArrays: Object.fromEntries(Object.entries(ca).map(([k, v]) => [k, new Float64Array(v)])) };
  return select(result, Array.from({ length: types.length }, (_, i) => i));
}

/** Cut convex grids or regular images by an interpolated implicit/scalar field. Box uses six exact halfspaces. */
export async function clipGrid(input: AnalysisGrid | AnalysisImage, shape: ClipShape, options: ClipOptions = {}): Promise<AnalysisGrid> {
  options.signal?.throwIfAborted(); let grid = asGrid(input); validate(grid);
  const finite = (v: readonly number[]) => Array.isArray(v) && v.every(Number.isFinite);
  if (!shape || !['plane', 'box', 'sphere', 'scalar'].includes(shape.kind)) throw rangeError('Clip needs plane, box, sphere or scalar shape', 'sciviz');
  if (shape.kind === 'plane' && (!finite(shape.normal) || shape.normal.length !== 3 || Math.hypot(...shape.normal) === 0 || !Number.isFinite(shape.offset)))
    throw rangeError('Clip plane needs a finite nonzero normal and finite offset', 'sciviz');
  if (shape.kind === 'sphere' && (!finite(shape.center) || shape.center.length !== 3 || !(shape.radius > 0) || !Number.isFinite(shape.radius)))
    throw rangeError('Clip sphere needs a finite center and positive finite radius', 'sciviz');
  if (shape.kind === 'scalar' && !Number.isFinite(shape.value)) throw rangeError('Scalar clip value must be finite', 'sciviz');
  if (shape.kind === 'box' && (shape.bounds.length !== 6 || !finite(shape.bounds) || [0, 1, 2].some(a => shape.bounds[2 * a] > shape.bounds[2 * a + 1])))
    throw rangeError('Clip box needs six finite ordered bounds', 'sciviz');
  if (shape.kind === 'box' && options.crinkle) {
    const exact = await clipGrid(grid, shape, { ...options, crinkle: false });
    const retained = new Set(Array.from(exact.sourceCells ?? []));
    return select(grid, Array.from({ length: grid.types.length }, (_, c) => c).filter(c => retained.has(grid.sourceCells?.[c] ?? c)));
  }
  if (shape.kind === 'box' && !options.crinkle) {
    const pieces: AnalysisGrid[] = [];
    for (let axis = 0; axis < 3; axis++) for (const side of [0, 1]) {
      const normal = [0, 0, 0] as [number, number, number]; normal[axis] = side === 0 ? 1 : -1;
      const plane: ClipShape = { kind: 'plane', normal, offset: side === 0 ? -shape.bounds[2 * axis] : shape.bounds[2 * axis + 1] };
      if (options.invert) pieces.push(await clipGrid(grid, plane, { signal: options.signal, invert: true }));
      grid = await clipGrid(grid, plane, { signal: options.signal });
    }
    if (options.invert) return joinGrids(pieces);
    return grid;
  }
  const data = shape.kind === 'scalar' ? scalar(grid, true, shape.array) : undefined;
  const field = Float64Array.from({ length: grid.points.length / 3 }, (_, i) => {
    const p = coordinate(grid, i);
    const value = shape.kind === 'plane' ? dot3(p, shape.normal) + shape.offset : shape.kind === 'sphere' ? shape.radius ** 2 - p.reduce((s, x, k) => s + (x - shape.center[k]) ** 2, 0)
      : shape.kind === 'box' ? Math.min(...[0, 1, 2].flatMap(a => [p[a] - shape.bounds[2 * a], shape.bounds[2 * a + 1] - p[a]])) : data![i] - shape.value;
    return (options.invert ? -1 : 1) * value;
  });
  if (field.some(v => !Number.isFinite(v))) throw rangeError('Clip scalar/implicit values must be finite; rescale coordinates or select valid data', 'sciviz');
  if (options.crinkle) {
    const selected: number[] = [];
    for (let c = 0; c < grid.types.length; c++) {
      if (c % 2048 === 0) { await pause(); options.signal?.throwIfAborted(); }
      for (let k = c ? grid.offsets[c - 1] : 0; k < grid.offsets[c]; k++) if (field[grid.connectivity[k]] >= 0) { selected.push(c); break; }
    }
    return select(grid, selected);
  }
  return cut(grid, field, options.signal);
}

// Complement box pieces are disjoint by construction: each failed halfspace is removed before the next.
function joinGrids(grids: readonly AnalysisGrid[]): AnalysisGrid {
  const points: number[] = [], connectivity: number[] = [], offsets: number[] = [], types: number[] = [], source: number[] = [], pa: Record<string, number[]> = {}, ca: Record<string, number[]> = {};
  for (const g of grids) {
    const base = points.length / 3, offset = connectivity.length; for (const value of Array.from(g.points)) points.push(value); for (const id of Array.from(g.connectivity)) connectivity.push(id + base);
    for (const end of Array.from(g.offsets)) offsets.push(end + offset); for (const type of Array.from(g.types)) types.push(type); for (let c = 0; c < g.types.length; c++) source.push(g.sourceCells?.[c] ?? c);
    for (const [key, data] of Object.entries(named(g, true))) for (const value of Array.from(data)) (pa[key] ??= []).push(value);
    for (const [key, data] of Object.entries(named(g, false))) for (const value of Array.from(data)) (ca[key] ??= []).push(value);
  }
  const pointData = pa[''] && new Float64Array(pa['']), cellData = ca[''] && new Float64Array(ca['']); delete pa['']; delete ca[''];
  return { points: new Float64Array(points), connectivity: new Uint32Array(connectivity), offsets: new Uint32Array(offsets), types: new Uint8Array(types), sourceCells: new Uint32Array(source), pointData, cellData,
    pointArrays: Object.fromEntries(Object.entries(pa).map(([k, v]) => [k, new Float64Array(v)])), cellArrays: Object.fromEntries(Object.entries(ca).map(([k, v]) => [k, new Float64Array(v)])) };
}

/** Exact interval of the piecewise-linear point scalar, with all associated arrays retained. */
export async function isoVolume(input: AnalysisGrid | AnalysisImage, range: readonly [number, number], options: { readonly array?: string; readonly signal?: AbortSignal } = {}): Promise<AnalysisGrid> {
  if (range.length !== 2 || !range.every(Number.isFinite) || range[0] > range[1]) throw rangeError('Iso-volume needs a finite ordered scalar range', 'sciviz');
  const lower = await clipGrid(input, { kind: 'scalar', array: options.array, value: range[0] }, { signal: options.signal });
  return clipGrid(lower, { kind: 'scalar', array: options.array, value: range[1] }, { signal: options.signal, invert: true });
}

/** Sample an image by inclusive index ranges and strides, retaining point and source-cell tuples. */
export async function extractSubset(image: AnalysisImage, options: SubsetOptions = {}): Promise<AnalysisImage> {
  options.signal?.throwIfAborted(); const grid = imageGrid(image), ranges = options.ranges ?? image.dims.map(n => [0, n - 1]), strides = options.strides ?? [1, 1, 1];
  if (ranges.length !== 3 || strides.length !== 3 || ranges.some((r, a) => r.length !== 2 || !r.every(Number.isInteger) || r[0] < 0 || r[1] < r[0] || r[1] >= image.dims[a]) || strides.some(s => !Number.isInteger(s) || s < 1))
    throw rangeError('Subset needs three inclusive index ranges within the image and positive integer strides', 'sciviz');
  const axes = ranges.map((r, a) => Array.from({ length: Math.floor((r[1] - r[0]) / strides[a]) + 1 }, (_, i) => r[0] + i * strides[a])), dims = axes.map(a => a.length) as [number, number, number],
    pointIds: number[] = [], cellIds: number[] = [], old = image.dims, oldCells = old.map(n => Math.max(1, n - 1));
  for (const z of axes[2]) for (const y of axes[1]) for (const x of axes[0]) pointIds.push(x + old[0] * (y + old[1] * z));
  let visited = 0;
  for (let z = 0; z < Math.max(1, dims[2] - 1); z++) for (let y = 0; y < Math.max(1, dims[1] - 1); y++) for (let x = 0; x < Math.max(1, dims[0] - 1); x++) {
    if (visited++ % 2048 === 0) { await pause(); options.signal?.throwIfAborted(); }
    cellIds.push(Math.min(axes[0][x], oldCells[0] - 1) + oldCells[0] * (Math.min(axes[1][y], oldCells[1] - 1) + oldCells[1] * Math.min(axes[2][z], oldCells[2] - 1)));
  }
  const arrays = (point: boolean) => Object.fromEntries(Object.entries(named(grid, point)).map(([name, data]) => {
    const width = data.length / (point ? grid.points.length / 3 : grid.types.length), ids = point ? pointIds : cellIds;
    return [name, Float64Array.from(ids.flatMap(id => Array.from({ length: width }, (_, k) => data[id * width + k])))];
  }));
  const pa = arrays(true), ca = arrays(false), pointData = pa[''], cellData = ca['']; delete pa['']; delete ca[''];
  let bounds = axes.flatMap((ids, a) => [ids[0], ids[ids.length - 1]].map(i => image.bounds[2 * a] + (old[a] === 1 ? 0 : i / (old[a] - 1) * (image.bounds[2 * a + 1] - image.bounds[2 * a])))) as unknown as Bounds;
  const points = image.points ? Float64Array.from(pointIds.flatMap(id => coordinate(grid, id))) : undefined;
  if (points) {
    const b = [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity];
    for (let i = 0; i < points.length; i++) { const a = i % 3; b[2 * a] = Math.min(b[2 * a], points[i]); b[2 * a + 1] = Math.max(b[2 * a + 1], points[i]); }
    bounds = b as unknown as Bounds;
  }
  options.signal?.throwIfAborted(); return { dims, bounds, points, pointData, cellData, pointArrays: pa, cellArrays: ca };
}

/** JSON pipeline adapter. Params: `{ operation: 'clip'|'threshold'|'isoVolume'|'subset', ... }`. */
export function clipOperator(): PipelineOperator {
  return { kind: 'filter', execute: c => {
    const p = c.params as unknown as { operation: string; shape: ClipShape; range: [number, number]; options?: ClipOptions & ThresholdOptions & SubsetOptions & { array?: string } };
    const input = c.inputs[0] as AnalysisGrid | AnalysisImage, options = { ...p?.options, signal: c.signal };
    if (p?.operation === 'clip') return clipGrid(input, p.shape, options);
    if (p?.operation === 'threshold') return thresholdGrid(input, p.range, options);
    if (p?.operation === 'isoVolume') return isoVolume(input, p.range, options);
    if (p?.operation === 'subset' && 'dims' in input) return extractSubset(input, options);
    throw rangeError('Clip pipeline params need clip, threshold, isoVolume or image subset operation', 'sciviz');
  } };
}
