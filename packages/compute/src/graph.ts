/// <reference lib="esnext.disposable" preserve="true" />
// @margoengine/compute/graph: breadth-first search, shortest paths and connected components on sparse graphs. A graph is
// a CsrMatrix from @margoengine/compute/sparse: row r lists the edges out of vertex r, and each entry's value is its
// weight. Every algorithm is rounds over all edges at once, a gather of the sources and an atomic minimum into the
// targets, so it runs unchanged on WebGPU and on the CPU backend, reading back only every `checkEvery` rounds.
//
// Shortest paths relax every edge per round (R. Bellman, "On a routing problem", Quart. Appl. Math. 16, 1958; L. R. Ford,
// "Network flow theory", RAND P-923, 1956). Connected components hook roots onto smaller neighbours and halve paths by
// pointer jumping (Y. Shiloach and U. Vishkin, "An O(log n) parallel connectivity algorithm", J. Algorithms 3, 1982).
import { rangeError, typeError } from '../../shared/errors.js';
import type { GpuArray } from './array.js';
import { aborted, type ComputeContext, type WaitOptions } from './context.js';
import { where } from './expr.js';
import { CsrMatrix, coo } from './sparse.js';

// A distance nothing reaches. Far below the i32 limit, so adding 1 to it cannot wrap.
const UNSEEN = 1 << 30;

/** Options of every algorithm here. */
export interface GraphOptions extends WaitOptions {
  /** Rounds between read-backs of whether anything changed. Default 8. */
  readonly checkEvery?: number;
}

/** Edges of a graph by their ends. */
export interface GraphData {
  /** Number of vertices. */
  readonly vertices: number;
  /** Source vertex of each edge. */
  readonly sources: ArrayLike<number>;
  /** Target vertex of each edge. */
  readonly targets: ArrayLike<number>;
  /** Weight of each edge. Default 1 each. */
  readonly weights?: ArrayLike<number>;
  /** Edges run one way. With false, each also runs back. Default true. */
  readonly directed?: boolean;
}

/**
 * A graph as a CsrMatrix, built on the CPU from your arrays and uploaded. Edges between the same two vertices keep the
 * smallest weight, as a shortest path would. Dispose it when done.
 * @example const g = graph(gpu, { vertices: 3, sources: [0, 1], targets: [1, 2], directed: false });
 */
export function graph(gpu: ComputeContext, data: GraphData): CsrMatrix {
  const { vertices, sources, targets, weights } = data,
    count = sources?.length;
  if (!Number.isInteger(vertices) || vertices < 0 || vertices >= UNSEEN)
    throw rangeError(`graph vertices must be a whole number below ${UNSEEN}, got ${vertices}`, 'compute');
  if (targets?.length !== count || (weights && weights.length !== count))
    throw rangeError(
      `graph needs sources, targets and weights of one length, got ${count}, ${targets?.length}, ${weights?.length}`,
      'compute',
    );
  const from: number[] = [],
    to: number[] = [],
    cost: number[] = [];
  for (let k = 0; k < count; k++) {
    const s = sources[k],
      t = targets[k],
      w = weights ? weights[k] : 1;
    if (!Number.isInteger(s) || s < 0 || s >= vertices || !Number.isInteger(t) || t < 0 || t >= vertices)
      throw rangeError(`graph edge ${k} from ${s} to ${t} is outside the ${vertices} vertices`, 'compute');
    if (Number.isNaN(w)) throw rangeError(`graph edge ${k} has a NaN weight`, 'compute');
    from.push(s);
    to.push(t);
    cost.push(w);
    if (data.directed === false) {
      from.push(t);
      to.push(s);
      cost.push(w);
    }
  }
  const order = Array.from(from, (_, k) => k).sort((a, b) => from[a] - from[b] || to[a] - to[b] || cost[a] - cost[b]);
  const rows: number[] = [],
    cols: number[] = [],
    values: number[] = [];
  for (const k of order) {
    const last = rows.length - 1;
    if (last >= 0 && rows[last] === from[k] && cols[last] === to[k]) continue;
    rows.push(from[k]);
    cols.push(to[k]);
    values.push(cost[k]);
  }
  return coo(gpu, { rows, cols, values, shape: [vertices, vertices] });
}

// The edges as i32 index arrays, which take and scatter read directly.
function edgesOf(A: CsrMatrix): { from: GpuArray; to: GpuArray; dispose(): void } {
  if (!(A instanceof CsrMatrix)) throw typeError('Graph algorithms take a CsrMatrix; make one with graph()', 'compute');
  if (A.shape[0] !== A.shape[1])
    throw rangeError(`A graph's matrix is square, got ${A.shape[0]} x ${A.shape[1]}`, 'compute');
  const from = A.rowIdx.astype('i32').eval(),
    to = A.colIdx.astype('i32').eval();
  return {
    from,
    to,
    dispose() {
      from.dispose();
      to.dispose();
    },
  };
}

const startsOf = (A: CsrMatrix, sources: number | readonly number[]): readonly number[] => {
  const list = typeof sources === 'number' ? [sources] : sources,
    n = A.shape[0];
  if (!list?.length) throw rangeError('Give at least one source vertex', 'compute');
  for (const s of list)
    if (!Number.isInteger(s) || s < 0 || s >= n)
      throw rangeError(`Source vertex ${s} is outside the ${n} vertices`, 'compute');
  return list;
};

const every = (options: GraphOptions): number => {
  const k = options.checkEvery ?? 8;
  if (!Number.isInteger(k) || k < 1) throw rangeError(`checkEvery must be a whole number from 1, got ${k}`, 'compute');
  return k;
};

/**
 * Runs `round` in blocks of `checkEvery` until a block changes nothing in `state` or `limit` rounds have run. Resolves
 * the rounds run and whether it settled.
 */
async function settle(
  state: () => GpuArray,
  round: () => void,
  limit: number,
  options: GraphOptions,
): Promise<{ rounds: number; settled: boolean }> {
  const block = every(options);
  let rounds = 0;
  while (rounds < limit) {
    aborted(options.signal);
    using before = state().eval();
    for (let k = 0; k < block && rounds < limit; k++, rounds++) round();
    using moved = state().ne(before).sum();
    if (!(await moved.item(options))) return { rounds, settled: true };
  }
  return { rounds, settled: false };
}

// Each vertex's smallest neighbour along `on` edges, or -1: the tree a search grew.
function parents(gpu: ComputeContext, from: GpuArray, to: GpuArray, on: GpuArray, n: number, starts: readonly number[]) {
  const tree = gpu.array(new Int32Array(n).fill(UNSEEN));
  gpu.scatter(tree, to, where(on, from, UNSEEN), { op: 'min' });
  const out = where(tree.eq(UNSEEN), -1, tree).eval() as GpuArray<'i32'>;
  tree.dispose();
  for (const s of starts) out.write([-1], s);
  return out;
}

/** What {@link bfs} resolves. */
export interface BfsResult {
  /** Edges from the nearest source to each vertex (i32); -1 where no path leads. */
  readonly distances: GpuArray<'i32'>;
  /** The vertex before each one on a shortest path (i32), the smallest if several; -1 at sources and unreached ones. */
  readonly predecessors: GpuArray<'i32'>;
  /** Rounds run. */
  readonly iterations: number;
}

/**
 * Breadth-first search from one source or several, following edges forward and ignoring weights.
 * @example const { distances } = await bfs(g, 0); await distances.read();
 */
export async function bfs(
  A: CsrMatrix,
  sources: number | readonly number[],
  options: GraphOptions = {},
): Promise<BfsResult> {
  const edges = edgesOf(A),
    { from, to } = edges,
    gpu = A.context,
    n = A.shape[0],
    starts = startsOf(A, sources),
    first = new Int32Array(n).fill(UNSEEN);
  for (const s of starts) first[s] = 0;
  const reached = gpu.array(first);
  const round = () => {
    const near = gpu.take(reached, from);
    gpu.scatter(reached, to, near.add(1).minimum(UNSEEN), { op: 'min' });
    near.dispose();
  };
  try {
    const { rounds } = A.nnz ? await settle(() => reached, round, n, options) : { rounds: 0 };
    const a = gpu.take(reached, from),
      b = gpu.take(reached, to),
      on = a.lt(UNSEEN).and(a.add(1).eq(b)).eval(),
      predecessors = parents(gpu, from, to, on, n, starts),
      distances = where(reached.eq(UNSEEN), -1, reached).eval() as GpuArray<'i32'>;
    for (const t of [a, b, on]) t.dispose();
    return { distances, predecessors, iterations: rounds };
  } finally {
    reached.dispose();
    edges.dispose();
  }
}

/** What {@link shortestPaths} resolves. */
export interface ShortestPathsResult {
  /** Summed weight from the nearest source to each vertex (f32); Infinity where no path leads. */
  readonly distances: GpuArray<'f32'>;
  /**
   * The vertex before each one on a shortest path (i32), the smallest if several; -1 at sources and unreached ones.
   * Edges of weight 0 can tie into a loop here; `distances` still holds.
   */
  readonly predecessors: GpuArray<'i32'>;
  /** Rounds run. */
  readonly iterations: number;
  /** True when a cycle of negative total weight can be reached: then no shortest path exists and `distances` mean nothing. */
  readonly negativeCycle: boolean;
}

/**
 * Shortest paths from one source or several by edge weights, which may be negative. Sums are f32.
 * @example const { distances, predecessors } = await shortestPaths(g, 0);
 */
export async function shortestPaths(
  A: CsrMatrix,
  sources: number | readonly number[],
  options: GraphOptions = {},
): Promise<ShortestPathsResult> {
  const edges = edgesOf(A),
    { from, to } = edges,
    gpu = A.context,
    n = A.shape[0],
    starts = startsOf(A, sources),
    first = new Float32Array(n).fill(Infinity);
  for (const s of starts) first[s] = 0;
  const reached = gpu.array(first);
  const round = () => {
    const near = gpu.take(reached, from);
    gpu.scatter(reached, to, where(near.isfinite(), near.add(A.values), near), { op: 'min' });
    near.dispose();
  };
  try {
    let rounds = 0,
      negativeCycle = false;
    if (A.nnz) {
      const run = await settle(() => reached, round, n, options);
      rounds = run.rounds;
      // n rounds settle every path of up to n edges; one that still improves goes round a cycle.
      if (!run.settled) {
        const again = await settle(() => reached, round, 1, { ...options, checkEvery: 1 });
        rounds += again.rounds;
        negativeCycle = !again.settled;
      }
    }
    const a = gpu.take(reached, from),
      b = gpu.take(reached, to),
      on = a.isfinite().and(a.add(A.values).eq(b)).eval(),
      predecessors = parents(gpu, from, to, on, n, starts);
    for (const t of [a, b, on]) t.dispose();
    return { distances: reached.eval() as GpuArray<'f32'>, predecessors, iterations: rounds, negativeCycle };
  } finally {
    reached.dispose();
    edges.dispose();
  }
}

/** What {@link connectedComponents} resolves. */
export interface ComponentsResult {
  /** Each vertex's component (i32), numbered from 0 in the order of each component's smallest vertex. */
  readonly labels: GpuArray<'i32'>;
  /** How many components there are. */
  readonly count: number;
  /** Rounds run. */
  readonly iterations: number;
}

/**
 * Connected components, taking every edge as running both ways (weakly connected components of a directed graph).
 * @example const { labels, count } = await connectedComponents(g);
 */
export async function connectedComponents(A: CsrMatrix, options: GraphOptions = {}): Promise<ComponentsResult> {
  const edges = edgesOf(A),
    { from, to } = edges,
    gpu = A.context,
    n = A.shape[0];
  if (!n) {
    edges.dispose();
    return { labels: gpu.zeros(0, 'i32'), count: 0, iterations: 0 };
  }
  let parent = gpu.arange(0, n, 1, 'i32') as GpuArray;
  const round = () => {
    const a = gpu.take(parent, from),
      b = gpu.take(parent, to);
    gpu.scatter(parent, a, b, { op: 'min' });
    gpu.scatter(parent, b, a, { op: 'min' });
    a.dispose();
    b.dispose();
    const jumped = gpu.take(parent, parent);
    parent.dispose();
    parent = jumped;
  };
  try {
    let rounds = 0;
    // Parents only fall and stay inside a component, so this ends, and only with every component on its smallest vertex.
    if (A.nnz) ({ rounds } = await settle(() => parent, round, Infinity, options));
    using index = gpu.arange(0, n, 1, 'i32');
    using roots = parent.eq(index).astype('i32').eval();
    using numbers = gpu.cumsum(roots);
    using numbered = gpu.take(numbers, parent);
    using total = roots.sum();
    const count = await total.item(options);
    return { labels: numbered.sub(1).eval() as GpuArray<'i32'>, count, iterations: rounds };
  } finally {
    parent.dispose();
    edges.dispose();
  }
}
