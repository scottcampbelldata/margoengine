// Clean-room marching simplices: Doi and Koide (1991); consistent pulling faces: Beck and Sanyal (2018).
import type { ComputeContext } from '@margoengine/compute';
import { rangeError } from '../../shared/errors.js';
import type { UnstructuredGrid, TriangleSet } from './grids.js';
import type { Bounds } from './layer.js';
import type { PipelineOperator } from './pipeline.js';
import { checkComplex, simplices, cross3, dot3, sub3 } from './cell-complex.js';

/** A surface or volume grid; VTK triangles (5) and quads (9) produce isolines. */
export type ContourGrid = UnstructuredGrid;
/** Cancellation is checked between bounded batches; exact abort reasons propagate. */
export interface ContourOptions { readonly signal?: AbortSignal }
/** Independent segments, two xyz endpoints per segment. */
export interface ContourLines {
  readonly positions: Float32Array;
  readonly values: Float32Array;
  readonly cells: Uint32Array;
  readonly bounds: Bounds;
}
/** Owned CPU arrays; level indices refer to the supplied levels, including repeated levels. */
export interface GridContours {
  readonly triangles: TriangleSet;
  readonly lines: ContourLines;
  /** Isolated crossings of line cells, and matching vertex cells; one xyz tuple per point. */
  readonly points: ContourLines;
  readonly triangleLevels: Uint32Array;
  readonly lineLevels: Uint32Array;
  readonly pointLevels: Uint32Array;
  /** Absolute per-coordinate CPU/GPU bound on the shared float32 input. Normals are identical. */
  readonly floatBound: number;
}

interface Primitive { edges: number[][]; normal: number[]; cell: number; level: number; value: number }
const pause = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const BATCH = 4096;

function snapshot(grid: ContourGrid, levels: readonly number[]) {
  checkComplex(grid, true);
  if (!grid.pointData) throw rangeError('Contours require one scalar pointData value per point', 'sciviz');
  const finite = (values: ArrayLike<number>) => {
    const copy = Float32Array.from(values);
    if (copy.some(v => !Number.isFinite(v) || Math.abs(v) > 1e18 || (v !== 0 && Math.abs(v) < 1e-18)))
      throw rangeError('Contour coordinates, scalars and levels must be finite float32, zero or magnitude 1e-18 to 1e18; rescale units', 'sciviz');
    return copy;
  };
  if (grid.points.length / 3 > 1_000_000 || levels.length > 256)
    throw rangeError('Contours support up to 1000000 points and 256 levels per request', 'sciviz');
  return { ...grid, points: finite(grid.points), pointData: finite(grid.pointData),
    connectivity: Uint32Array.from(grid.connectivity), offsets: Uint32Array.from(grid.offsets), types: Uint8Array.from(grid.types),
    levels: finite(levels) };
}

// Topology depends only on comparisons, never rounded GPU intersections. GPU computes every output coordinate.
function* plan(grid: ReturnType<typeof snapshot>): Generator<Primitive | null> {
  for (const { ids, cell } of simplices(grid)) {
    if (ids.length < 3) {
      for (let level = 0; level < grid.levels.length; level++) {
        const value = grid.levels[level], a = ids[0], b = ids[ids.length - 1], va = grid.pointData[a], vb = grid.pointData[b];
        if (ids.length === 1 ? va === value : (va < value && vb >= value) || (vb < value && va >= value))
          yield { edges: [[a, b]], normal: [0, 0, 0], cell, level, value };
      }
      yield null; continue;
    }
    const p = ids.map(id => Array.from(grid.points.subarray(3 * id, 3 * id + 3))), v = ids.map(id => grid.pointData[id]);
    const a = sub3(p[1], p[0]), b = sub3(p[2], p[0]), ab = cross3(a, b);
    let gradient: number[];
    if (ids.length === 4) {
      const c = sub3(p[3], p[0]), det = dot3(a, cross3(b, c));
      if (det === 0) throw rangeError(`Contour cell ${cell} has a degenerate tetrahedron`, 'sciviz');
      const bc = cross3(b, c), ca = cross3(c, a);
      gradient = ab.map((x, k) => ((v[1] - v[0]) * bc[k] + (v[2] - v[0]) * ca[k] + (v[3] - v[0]) * x) / det);
    } else {
      const det = dot3(ab, ab);
      if (det === 0) throw rangeError(`Contour cell ${cell} has a degenerate triangle`, 'sciviz');
      const ba = cross3(b, ab), aa = cross3(ab, a);
      gradient = ba.map((x, k) => ((v[1] - v[0]) * x + (v[2] - v[0]) * aa[k]) / det);
    }
    const length = Math.hypot(...gradient), normal = gradient.map(x => Math.fround(length === 0 ? 0 : x / length));
    for (let level = 0; level < grid.levels.length; level++) {
      const value = grid.levels[level], low = ids.filter(id => grid.pointData[id] < value), high = ids.filter(id => grid.pointData[id] >= value);
      if (!low.length || !high.length) continue;
      let edges: number[][];
      if (low.length === 2 && high.length === 2) {
        edges = [[low[0], high[0]], [low[0], high[1]], [low[1], high[1]], [low[1], high[0]]];
      } else {
        const one = low.length === 1 ? low : high, many = low.length === 1 ? high : low;
        edges = many.map(id => [one[0], id]);
      }
      edges = edges.map(([x, y]) => x < y ? [x, y] : [y, x]);
      // Equal-level vertices have one symbolic identity, removing zero-area/length primitives exactly.
      const key = ([x, y]: number[]) => grid.pointData[x] === value ? `v${x}` : grid.pointData[y] === value ? `v${y}` : `${x},${y}`;
      const primitives = edges.length === 4 ? [[edges[0], edges[1], edges[2]], [edges[0], edges[2], edges[3]]] : [edges];
      for (const edgeList of primitives) if (new Set(edgeList.map(key)).size === edgeList.length)
        yield { edges: edgeList, normal, cell, level, value };
    }
    yield null;
  }
}

const shader = /* wgsl */ `
@group(0) @binding(0) var<storage, read> endpoints: array<vec4f>;
@group(0) @binding(1) var<storage, read> levels: array<f32>;
@group(0) @binding(2) var<storage, read_write> positions: array<f32>;
struct Params { count: u32 }
@group(0) @binding(3) var<uniform> params: Params;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x; if (i >= params.count) { return; }
  let a = endpoints[2u*i]; let b = endpoints[2u*i+1u];
  let t = select(clamp((levels[i]-a.w)/(b.w-a.w),0.0,1.0), 0.0, a.w == b.w);
  let p = a.xyz + t*(b.xyz-a.xyz);
  positions[3u*i] = p.x; positions[3u*i+1u] = p.y; positions[3u*i+2u] = p.z;
}`;

async function execute(grid: ContourGrid, levels: readonly number[], options: ContourOptions, gpu?: ComputeContext): Promise<GridContours> {
  options.signal?.throwIfAborted();
  const input = snapshot(grid, levels), iterator = plan(input),
    positions: number[][] = [[], [], []], normals: number[] = [], values: number[][] = [[], [], []], cells: number[][] = [[], [], []], levelIds: number[][] = [[], [], []],
    seen = new Set<string>();
  let floatBound = 0, total = 0;
  if (gpu) await gpu.routeReady;
  const kernel = gpu?.kernel(shader);
  try {
    let done = false;
    while (!done) {
      await pause(); options.signal?.throwIfAborted();
      const batch: Primitive[] = [], ends: number[] = [], isos: number[] = [];
      let visited = 0;
      while (ends.length / 8 < BATCH && visited++ < BATCH) {
        const step = iterator.next(); if (step.done) { done = true; break; }
        const item = step.value;
        if (!item) continue;
        const identity = `${item.level}:${item.edges.map(([a, b]) => input.pointData[a] === item.value ? `v${a}` : input.pointData[b] === item.value ? `v${b}` : `${a},${b}`).sort().join(';')}`;
        if (seen.has(identity)) continue; seen.add(identity);
        batch.push(item);
        for (const edge of item.edges) {
          const [a, b] = edge, va = input.pointData[a], vb = input.pointData[b];
          const scale = Math.max(1, ...edge.flatMap(id => Array.from(input.points.subarray(3 * id, 3 * id + 3))).map(Math.abs));
          // Division/subtractions and interpolation, including cancellation, have this absolute envelope.
          floatBound = Math.max(floatBound, 32 * 2 ** -23 * scale * (1 + (va === vb ? 0 : Math.max(Math.abs(va), Math.abs(vb), Math.abs(item.value)) / Math.abs(vb - va))));
          for (const id of edge) ends.push(...input.points.subarray(3 * id, 3 * id + 3), input.pointData[id]);
          isos.push(item.value);
        }
      }
      if (!batch.length) continue;
      total += isos.length;
      if (total > 10_000_000) throw rangeError('Contours exceed 10000000 output vertices; request fewer levels or a subset', 'sciviz');
      let output: Float32Array;
      if (gpu) {
        const owned: { dispose(): void }[] = [];
        try {
          const endpoints = gpu.array(new Float32Array(ends)); owned.push(endpoints);
          const levelArray = gpu.array(new Float32Array(isos)); owned.push(levelArray);
          const result = gpu.zeros(isos.length * 3); owned.push(result);
          kernel!.run({ endpoints, levels: levelArray, positions: result, params: { count: isos.length } }, { count: isos.length });
          output = await result.read({ signal: options.signal });
        } finally { for (const resource of owned.reverse()) resource.dispose(); }
      } else {
        output = new Float32Array(isos.length * 3);
        for (let i = 0; i < isos.length; i++) {
          const t = ends[8 * i + 7] === ends[8 * i + 3] ? 0 : Math.max(0, Math.min(1, (isos[i] - ends[8 * i + 3]) / (ends[8 * i + 7] - ends[8 * i + 3])));
          for (let k = 0; k < 3; k++) output[3 * i + k] = ends[8 * i + k] + t * (ends[8 * i + 4 + k] - ends[8 * i + k]);
        }
      }
      options.signal?.throwIfAborted();
      let at = 0;
      for (const item of batch) {
        const line = item.edges.length === 1 ? 2 : item.edges.length === 2 ? 1 : 0, count = item.edges.length;
        const p = Array.from({ length: count }, (_, k) => Array.from(output.subarray(at + 3 * k, at + 3 * k + 3)));
        // Winding uses the field gradient; it does not change the chosen diagonal.
        if (!line && dot3(cross3(sub3(p[1], p[0]), sub3(p[2], p[0])), item.normal) < 0) [p[1], p[2]] = [p[2], p[1]];
        for (const point of p) { positions[line].push(...point); values[line].push(item.value); if (!line) normals.push(...item.normal); }
        cells[line].push(item.cell); levelIds[line].push(item.level); at += count * 3;
      }
    }
  } finally { kernel?.dispose(); }
  const bounds = (p: number[]): Bounds => {
    const b = [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity];
    for (let i = 0; i < p.length; i++) { const a = i % 3; b[2 * a] = Math.min(b[2 * a], p[i]); b[2 * a + 1] = Math.max(b[2 * a + 1], p[i]); }
    return (p.length ? b : [0, 0, 0, 0, 0, 0]) as unknown as Bounds;
  };
  return { triangles: { positions: new Float32Array(positions[0]), normals: new Float32Array(normals), values: new Float32Array(values[0]), cells: new Uint32Array(cells[0]), bounds: bounds(positions[0]) },
    lines: { positions: new Float32Array(positions[1]), values: new Float32Array(values[1]), cells: new Uint32Array(cells[1]), bounds: bounds(positions[1]) },
    points: { positions: new Float32Array(positions[2]), values: new Float32Array(values[2]), cells: new Uint32Array(cells[2]), bounds: bounds(positions[2]) },
    triangleLevels: new Uint32Array(levelIds[0]), lineLevels: new Uint32Array(levelIds[1]), pointLevels: new Uint32Array(levelIds[2]), floatBound };
}

/** March point data on convex cells using a globally consistent piecewise-linear field. */
export function contourGrid(grid: ContourGrid, levels: readonly number[], options: ContourOptions = {}): Promise<GridContours> {
  return execute(grid, levels, options);
}
/** GPU intersection and bounded readback; topology and field normals are prepared on the CPU. Borrows context. */
export function contourGridGPU(gpu: ComputeContext, grid: ContourGrid, levels: readonly number[], options: ContourOptions = {}): Promise<GridContours> {
  return execute(grid, levels, options, gpu);
}
/** Register as a lazy pipeline filter. Params: `{ levels: number[] }`; first input is a grid. */
export function contourOperator(gpu?: ComputeContext): PipelineOperator {
  return { kind: 'filter', execute: context => {
    const params = context.params as { levels?: readonly number[] } | null;
    if (!params || !Array.isArray(params.levels)) throw rangeError('Contour pipeline params require levels', 'sciviz');
    return execute(context.inputs[0] as ContourGrid, params.levels, { signal: context.signal }, gpu);
  } };
}
