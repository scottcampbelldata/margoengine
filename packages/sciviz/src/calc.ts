import type { ComputeContext } from '@margoengine/compute';
import { rangeError } from '../../shared/errors.js';
import type { AnalysisGrid } from './clip.js';
import type { PipelineOperator } from './pipeline.js';
import { checkComplex, cross3, dot3, sub3 } from './cell-complex.js';
import { expression, evaluate, emit, type Column } from './calc-expression.js';

/** Point or cell tuple association. */
export type CalcAssociation = 'point' | 'cell';
/** Serializable calculator and derived-array requests. Empty array name selects the default scalar. */
export type CalcOperation =
  | { readonly kind: 'expression'; readonly expression: string; readonly association?: CalcAssociation }
  | { readonly kind: 'gradient'; readonly array?: string; readonly association?: CalcAssociation }
  | { readonly kind: 'pointToCell' | 'cellToPoint'; readonly array?: string }
  | { readonly kind: 'centers' | 'connectivity' | 'quality' }
  | {
      readonly kind: 'elevation';
      readonly low: readonly [number, number, number];
      readonly high: readonly [number, number, number];
      readonly range?: readonly [number, number];
    };
/** Cooperative cancellation and optional named result attachment. */
export interface CalcOptions {
  readonly signal?: AbortSignal;
  readonly name?: string;
}
/** Owned float32 tuples. floatBound is an absolute CPU/GPU bound per output value on the shared f32 snapshot. */
export interface CalcResult {
  readonly values: Float32Array;
  readonly width: number;
  readonly association: CalcAssociation;
  readonly floatBound: Float64Array;
  /** Input topology and existing arrays are borrowed. Only the attached array is owned by this result. */
  readonly grid: AnalysisGrid;
}
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const point = (g: AnalysisGrid, id: number) => [g.points[3 * id], g.points[3 * id + 1], g.points[3 * id + 2]];
const bad = (message: string): never => {
  throw rangeError(`Calculator: ${message}`, 'sciviz');
};
const finite = (v: number) => Number.isFinite(v) && Number.isFinite(Math.fround(v));
const source = (g: AnalysisGrid, a: CalcAssociation, name = '') =>
  name === '' ? (a === 'point' ? g.pointData : g.cellData) : (a === 'point' ? g.pointArrays : g.cellArrays)?.[name];
const cells = (g: AnalysisGrid) =>
  Array.from(g.offsets, (end, c) =>
    Array.from({ length: end - (c ? g.offsets[c - 1] : 0) }, (_, k) => g.connectivity[(c ? g.offsets[c - 1] : 0) + k]),
  );
function snapshot(g: AnalysisGrid): AnalysisGrid {
  checkComplex(g, true);
  if (g.points.length / 3 > 1_000_000 || g.types.length > 1_000_000) bad('at most 1000000 points and cells');
  const arrays = (a: CalcAssociation) =>
    Object.fromEntries(
      Object.entries(a === 'point' ? (g.pointArrays ?? {}) : (g.cellArrays ?? {})).map(([name, data]) => {
        const count = a === 'point' ? g.points.length / 3 : g.types.length;
        if (
          !name ||
          !data ||
          (count
            ? data.length % count !== 0 || data.length / count < 1 || data.length / count > 64
            : data.length !== 0) ||
          Array.from(data).some((x) => !finite(x))
        )
          bad('named arrays need finite complete tuples of width 1 to 64 and nonempty names');
        return [name, Float32Array.from(data)];
      }),
    );
  if (
    Array.from(g.points).some((x) => !finite(x)) ||
    [g.pointData, g.cellData].some((a) => a && Array.from(a).some((x) => !finite(x)))
  )
    bad('coordinates and arrays must be finite float32');
  return {
    ...g,
    points: Float32Array.from(g.points),
    connectivity: Uint32Array.from(g.connectivity),
    offsets: Uint32Array.from(g.offsets),
    types: Uint8Array.from(g.types),
    pointData: g.pointData ? Float32Array.from(g.pointData) : undefined,
    cellData: g.cellData ? Float32Array.from(g.cellData) : undefined,
    pointArrays: arrays('point'),
    cellArrays: arrays('cell'),
  };
}

// Invert a tiny full-rank Gram matrix in a geometric orthonormal basis. Rank-deficient axes have zero derivative.
function weights(positions: number[][]): number[][] {
  const mean = [0, 1, 2].map((k) => positions.reduce((s, p) => s + p[k], 0) / positions.length),
    delta = positions.map((p) => sub3(p, mean));
  const basis: number[][] = [],
    scale = Math.max(0, ...delta.map((p) => Math.hypot(...p)));
  for (const p of delta) {
    let v = [...p];
    for (const q of basis) {
      const d = dot3(v, q);
      v = v.map((x, k) => x - d * q[k]);
    }
    const length = Math.hypot(...v);
    if (length > scale * 1e-12 && basis.length < 3) basis.push(v.map((x) => x / length));
  }
  const rank = basis.length;
  if (!rank) return positions.map(() => [0, 0, 0]);
  const x = delta.map((p) => basis.map((q) => dot3(p, q))),
    matrix = basis.map((_, i) => [
      ...basis.map((_, j) => x.reduce((s, row) => s + row[i] * row[j], 0)),
      ...basis.map((_, j) => (i === j ? 1 : 0)),
    ]);
  for (let k = 0; k < rank; k++) {
    let pivot = k;
    for (let j = k + 1; j < rank; j++) if (Math.abs(matrix[j][k]) > Math.abs(matrix[pivot][k])) pivot = j;
    [matrix[k], matrix[pivot]] = [matrix[pivot], matrix[k]];
    const d = matrix[k][k];
    if (!(Math.abs(d) > 0)) bad('singular least-squares cell');
    matrix[k] = matrix[k].map((v) => v / d);
    for (let j = 0; j < rank; j++)
      if (j !== k) {
        const f = matrix[j][k];
        matrix[j] = matrix[j].map((v, i) => v - f * matrix[k][i]);
      }
  }
  return x.map((row) =>
    [0, 1, 2].map((k) =>
      basis.reduce((s, q, i) => s + q[k] * matrix[i].slice(rank).reduce((t, v, j) => t + v * row[j], 0), 0),
    ),
  );
}

const reduceShader = `@group(0) @binding(0) var<storage,read> terms: array<vec2f>;
@group(0) @binding(1) var<storage,read> offsets: array<u32>;
@group(0) @binding(2) var<storage,read_write> result: array<f32>;
struct Params { count:u32 }; @group(0) @binding(3) var<uniform> params:Params;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){let i=id.x;if(i>=params.count){return;}var sum=0.0;for(var j=offsets[i];j<offsets[i+1u];j++){sum+=terms[j].x*terms[j].y;}result[i]=sum;}`;

async function reductions(rows: number[][], gpu: ComputeContext | undefined, signal?: AbortSignal) {
  const values = new Float32Array(rows.length),
    bound = new Float64Array(rows.length);
  for (let start = 0; start < rows.length; start += 4096) {
    await pause();
    signal?.throwIfAborted();
    const batch = rows.slice(start, start + 4096),
      offsets = [0],
      terms: number[] = [];
    for (let r = 0; r < batch.length; r++) {
      const row = batch[r];
      let sum = 0,
        absolute = 0;
      for (let k = 0; k < row.length; k += 2) {
        const a = Math.fround(row[k]),
          b = Math.fround(row[k + 1]);
        if (!finite(a) || !finite(b)) bad('reduction coefficients exceed float32');
        terms.push(a, b);
        sum += a * b;
        absolute += Math.abs(a * b);
      }
      offsets.push(terms.length / 2);
      values[start + r] = sum;
      const epsilon = (row.length + 4) * 2 ** -23;
      if (epsilon >= 0.5 || !finite(sum) || !Number.isFinite(absolute))
        bad('ill-conditioned or oversized reduction; subset or rescale');
      bound[start + r] = ((2 * epsilon) / (1 - epsilon)) * absolute + row.length * 2 ** -125;
    }
    if (gpu && batch.length) {
      const owned: { dispose(): void }[] = [];
      try {
        const input = gpu.array(new Float32Array(terms.length ? terms : [0, 0]));
        owned.push(input);
        const ends = gpu.array(new Uint32Array(offsets));
        owned.push(ends);
        const output = gpu.zeros(batch.length);
        owned.push(output);
        const kernel = gpu.kernel(reduceShader);
        owned.push(kernel);
        kernel.run(
          { terms: input, offsets: ends, result: output, params: { count: batch.length } },
          { count: batch.length },
        );
        values.set(await output.read({ signal }), start);
      } finally {
        for (const x of owned.reverse()) x.dispose();
      }
    }
  }
  return { values, bound };
}

async function expressions(
  columns: Map<string, Column>,
  code: string,
  count: number,
  gpu: ComputeContext | undefined,
  signal?: AbortSignal,
) {
  const ast = expression(code, columns),
    width = ast.length,
    totalWidth = [...columns.values()].reduce((n, c) => Math.max(n, c.offset + c.width), 0),
    values = new Float32Array(count * width),
    bound = new Float64Array(count * width);
  const lines: string[] = [],
    cache = new Map(),
    outputs = ast.map((n) => emit(n, lines, cache));
  const shader = `fn safeSqrt(a:f32)->f32{return sqrt(max(0.0,a));}
fn realPow(a:f32,b:f32)->f32{if(b==0.0){return 1.0;}if(a==0.0&&b>0.0){return 0.0;}if(a<0.0){return pow(-a,b)*select(1.0,-1.0,abs(b-2.0*floor(b/2.0))==1.0);}return pow(a,b);}
@group(0) @binding(0) var<storage,read> data:array<f32>; @group(0) @binding(1) var<storage,read_write> result:array<f32>;
struct Params{count:u32,width:u32};@group(0) @binding(2) var<uniform> params:Params;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){let i=id.x;if(i>=params.count){return;}${lines.join('')}${outputs.map((n, k) => `result[i*${width}u+${k}u]=${n};`).join('')}}`;
  for (let start = 0; start < count; start += 4096) {
    await pause();
    signal?.throwIfAborted();
    const n = Math.min(4096, count - start),
      data = new Float32Array(n * totalWidth);
    for (let i = 0; i < n; i++) {
      const row = new Array<number>(totalWidth);
      for (const c of columns.values())
        for (let k = 0; k < c.width; k++)
          row[c.offset + k] = data[i * totalWidth + c.offset + k] = c.values[(start + i) * c.width + k];
      const evaluated = new Map();
      for (let k = 0; k < width; k++) {
        const ref = evaluate(ast[k], row, evaluated);
        values[(start + i) * width + k] = ref.value;
        bound[(start + i) * width + k] = ref.error + 2 ** -23 * Math.abs(ref.value);
      }
    }
    if (gpu) {
      const owned: { dispose(): void }[] = [];
      try {
        const input = gpu.array(data.length ? data : new Float32Array(1));
        owned.push(input);
        const output = gpu.zeros(n * width);
        owned.push(output);
        const kernel = gpu.kernel(shader);
        owned.push(kernel);
        kernel.run({ data: input, result: output, params: { count: n, width: totalWidth } }, { count: n });
        values.set(await output.read({ signal }), start * width);
      } finally {
        for (const x of owned.reverse()) x.dispose();
      }
    }
  }
  return { values, bound, width };
}

// Each corner's incident edges follow VTK vertex order. Metrics are defined on the original element, not its tetrahedral split.
const corners: Record<number, number[][]> = {
  1: [],
  3: [[0, 1]],
  5: [
    [0, 1, 2],
    [1, 2, 0],
    [2, 0, 1],
  ],
  9: [
    [0, 1, 3],
    [1, 2, 0],
    [2, 3, 1],
    [3, 0, 2],
  ],
  10: [
    [0, 1, 2, 3],
    [1, 0, 3, 2],
    [2, 0, 1, 3],
    [3, 0, 2, 1],
  ],
  12: [
    [0, 1, 3, 4],
    [1, 2, 0, 5],
    [2, 3, 1, 6],
    [3, 0, 2, 7],
    [4, 7, 5, 0],
    [5, 4, 6, 1],
    [6, 5, 7, 2],
    [7, 6, 4, 3],
  ],
  13: [
    [0, 1, 2, 3],
    [1, 2, 0, 4],
    [2, 0, 1, 5],
    [3, 5, 4, 0],
    [4, 3, 5, 1],
    [5, 4, 3, 2],
  ],
  14: [
    [0, 1, 3, 4],
    [1, 2, 0, 4],
    [2, 3, 1, 4],
    [3, 0, 2, 4],
    [4, 0, 2, 1],
    [4, 2, 0, 3],
  ],
};

async function execute(
  input: AnalysisGrid,
  op: CalcOperation,
  options: CalcOptions,
  gpu?: ComputeContext,
): Promise<CalcResult> {
  options.signal?.throwIfAborted();
  const g = snapshot(input),
    ids = cells(g),
    np = g.points.length / 3,
    nc = g.types.length;
  let association: CalcAssociation = 'cell',
    width = 1,
    values: Float32Array,
    bound: Float64Array;
  const centers = () =>
    Float32Array.from(
      ids.flatMap((cell) => [0, 1, 2].map((k) => cell.reduce((s, id) => s + g.points[3 * id + k], 0) / cell.length)),
    );
  if (op.kind === 'expression' || op.kind === 'elevation') {
    association = op.kind === 'expression' ? (op.association ?? 'point') : 'point';
    if (!['point', 'cell'].includes(association)) bad('invalid association');
    const count = association === 'point' ? np : nc,
      columns = new Map<string, Column>();
    let offset = 0;
    const add = (name: string, data: ArrayLike<number>, w: number) => {
      columns.set(name, { values: Float32Array.from(data), width: w, offset });
      offset += w;
    };
    for (const [name, data] of Object.entries(association === 'point' ? (g.pointArrays ?? {}) : (g.cellArrays ?? {})))
      add(name, data, count ? data.length / count : 1);
    const defaults = source(g, association);
    if (defaults) add('value', defaults, 1);
    const coords = association === 'point' ? g.points : centers();
    add('coords', coords, 3);
    for (let k = 0; k < 3; k++)
      add(
        ['x', 'y', 'z'][k],
        Float32Array.from({ length: count }, (_, i) => coords[3 * i + k]),
        1,
      );
    let code = op.kind === 'expression' ? op.expression : '';
    if (op.kind === 'elevation') {
      if (
        op.low?.length !== 3 ||
        op.high?.length !== 3 ||
        ![...op.low, ...op.high, ...(op.range ?? [0, 1])].every(finite) ||
        (op.range && op.range.length !== 2)
      )
        bad('elevation requires finite endpoints and a two-value range');
      const d = sub3(op.high, op.low),
        den = dot3(d, d),
        r = op.range ?? [0, 1];
      if (!(den > 0)) bad('elevation endpoints must differ');
      code = `${r[0]}+(${r[1]}-(${r[0]}))*clamp(dot(coords-vec(${op.low.join(',')}),vec(${d.join(',')}))/(${den}),0,1)`;
    }
    const result = await expressions(columns, code, count, gpu, options.signal);
    ({ values, bound, width } = result);
  } else if (op.kind === 'quality') {
    const cols = new Map<string, Column>(),
      packed: number[][] = Array.from({ length: 9 }, () => []),
      owners: number[] = [];
    for (let c = 0; c < nc; c++)
      for (const corner of corners[g.types[c]]) {
        const p = point(g, ids[c][corner[0]]),
          edges = corner.slice(1).map((k) => sub3(point(g, ids[c][k]), p));
        const dimension = edges.length;
        if (edges.length === 1) edges.push([...edges[0]]);
        if (edges.length === 2) {
          const n = cross3(edges[0], edges[1]),
            length = Math.hypot(...n);
          edges.push(length ? n.map((v) => v / length) : [0, 0, 0]);
        }
        for (let turn = 0; turn < (dimension === 3 ? 3 : 1); turn++) {
          [0, 1, 2].flatMap((k) => edges[(k + turn) % 3]).forEach((v, k) => packed[k].push(v));
          owners.push(c);
        }
      }
    for (let k = 0; k < 3; k++)
      cols.set(['a', 'b', 'c'][k], {
        values: Float32Array.from(
          owners.flatMap((_, i) => [packed[3 * k][i], packed[3 * k + 1][i], packed[3 * k + 2][i]]),
        ),
        width: 3,
        offset: 3 * k,
      });
    // lengths and dot products are GPU numerical work; topology and final min/max selection are CPU work.
    const result = await expressions(
      cols,
      'vec(mag(a),dot(a,b)/(mag(a)*mag(b)),dot(a,cross(b,c)))',
      owners.length,
      gpu,
      options.signal,
    );
    values = new Float32Array(nc * 3);
    bound = new Float64Array(nc * 3);
    width = 3;
    const longest = new Float64Array(nc),
      shortest = new Float64Array(nc).fill(Infinity),
      longLow = new Float64Array(nc),
      longHigh = new Float64Array(nc),
      shortLow = new Float64Array(nc).fill(Infinity),
      shortHigh = new Float64Array(nc).fill(Infinity);
    values.fill(0);
    for (let c = 0; c < nc; c++) values[c * 3 + 2] = Infinity;
    for (let i = 0; i < owners.length; i++) {
      const c = owners[i],
        length = result.values[3 * i],
        cos = result.values[3 * i + 1],
        jac = result.values[3 * i + 2],
        ideal = g.types[c] === 5 || g.types[c] === 10 ? 0.5 : 0;
      longest[c] = Math.max(longest[c], length);
      shortest[c] = Math.min(shortest[c], length);
      values[c * 3 + 1] = Math.max(values[c * 3 + 1], Math.abs(cos - ideal));
      values[c * 3 + 2] = Math.min(values[c * 3 + 2], jac);
      const e = result.bound[3 * i];
      longLow[c] = Math.max(longLow[c], length - e);
      longHigh[c] = Math.max(longHigh[c], length + e);
      shortLow[c] = Math.min(shortLow[c], length - e);
      shortHigh[c] = Math.min(shortHigh[c], length + e);
      for (let k = 0; k < 3; k++) bound[c * 3 + k] = Math.max(bound[c * 3 + k], result.bound[3 * i + k]);
    }
    for (let c = 0; c < nc; c++) {
      if (g.types[c] === 1 || g.types[c] === 3) {
        values.set([1, 0, 0], c * 3);
        continue;
      }
      values[c * 3] = longest[c] / shortest[c];
      bound[c * 3] =
        shortLow[c] > 0
          ? Math.max(longHigh[c] / shortLow[c] - values[c * 3], values[c * 3] - longLow[c] / shortHigh[c]) +
            2 ** -22 * Math.abs(values[c * 3])
          : Infinity;
      if (!Number.isFinite(bound[c * 3])) bad(`quality is unbounded for cell ${c}; rescale or remove degenerate cells`);
    }
  } else {
    const rows: number[][] = [];
    if (op.kind === 'centers') {
      width = 3;
      for (const cell of ids)
        for (let k = 0; k < 3; k++) rows.push(cell.flatMap((id) => [g.points[3 * id + k], 1 / cell.length]));
    } else if (op.kind === 'connectivity') {
      const parent = Array.from({ length: nc }, (_, i) => i),
        first = new Int32Array(np).fill(-1),
        root = (i: number): number => {
          while (parent[i] !== i) {
            parent[i] = parent[parent[i]];
            i = parent[i];
          }
          return i;
        };
      ids.forEach((cell, c) =>
        cell.forEach((id) => {
          if (first[id] < 0) first[id] = c;
          else {
            const a = root(c),
              b = root(first[id]);
            parent[Math.max(a, b)] = Math.min(a, b);
          }
        }),
      );
      const labels = new Map<number, number>();
      for (let c = 0; c < nc; c++) {
        const r = root(c);
        if (!labels.has(r)) labels.set(r, labels.size);
        rows.push([labels.get(r)!, 1]);
      }
    } else if (op.kind === 'pointToCell' || op.kind === 'cellToPoint' || op.kind === 'gradient') {
      const from: CalcAssociation =
          op.kind === 'pointToCell'
            ? 'point'
            : op.kind === 'cellToPoint'
              ? 'cell'
              : (('association' in op ? op.association : undefined) ?? 'point'),
        data = source(g, from, op.array),
        count = from === 'point' ? np : nc;
      if (!['point', 'cell'].includes(from) || !data) bad('selected array is missing');
      width = count ? data!.length / count : 1;
      if (op.kind === 'gradient') {
        const adjacency = from === 'cell' ? incident(ids, np) : [];
        const lists =
          from === 'point'
            ? ids
            : ids.map((cell, c) => {
                const set = new Set([c]);
                for (const id of cell) for (const other of adjacency[id]) set.add(other);
                return [...set].sort((a, b) => a - b);
              });
        const coords = from === 'point' ? g.points : centers();
        for (const list of lists) {
          const w = weights(list.map((id) => [coords[3 * id], coords[3 * id + 1], coords[3 * id + 2]]));
          for (let k = 0; k < width; k++)
            for (let a = 0; a < 3; a++) rows.push(list.flatMap((id, i) => [data![id * width + k], w[i][a]]));
        }
        width *= 3;
      } else {
        association = op.kind === 'pointToCell' ? 'cell' : 'point';
        for (const list of association === 'cell' ? ids : incident(ids, np))
          for (let k = 0; k < width; k++) rows.push(list.flatMap((id) => [data![id * width + k], 1 / list.length]));
      }
    } else bad('unknown operation');
    ({ values, bound } = await reductions(rows, gpu, options.signal));
  }
  options.signal?.throwIfAborted();
  if (options.name !== undefined && !options.name) bad('result name must be nonempty');
  const grid = options.name
    ? {
        ...input,
        ...(association === 'point'
          ? { pointArrays: { ...input.pointArrays, [options.name]: values } }
          : { cellArrays: { ...input.cellArrays, [options.name]: values } }),
      }
    : input;
  return { values, width, association, floatBound: bound, grid };
}
function incident(ids: number[][], count: number): number[][] {
  const lists: number[][] = Array.from({ length: count }, () => []);
  ids.forEach((cell, c) => cell.forEach((id) => lists[id].push(c)));
  return lists;
}
/** Calculate expressions or derived tuples on convex VTK vertex, line, triangle, quad, tetra, hex, wedge and pyramid grids. */
export function calcGrid(grid: AnalysisGrid, operation: CalcOperation, options: CalcOptions = {}): Promise<CalcResult> {
  return execute(grid, operation, options);
}
/** Compute numeric expressions/reductions on the borrowed GPU context. Topology, least-squares weights and quality extrema are CPU prepared. */
export function calcGridGPU(
  gpu: ComputeContext,
  grid: AnalysisGrid,
  operation: CalcOperation,
  options: CalcOptions = {},
): Promise<CalcResult> {
  return execute(grid, operation, options, gpu);
}
/** Pipeline params are CalcOperation plus optional name. First input is an AnalysisGrid. */
export function calcOperator(gpu?: ComputeContext): PipelineOperator {
  return {
    kind: 'filter',
    execute: (context) =>
      execute(
        context.inputs[0] as AnalysisGrid,
        context.params as unknown as CalcOperation,
        { signal: context.signal, name: (context.params as { name?: string })?.name },
        gpu,
      ),
  };
}
