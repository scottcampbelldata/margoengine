import { invalidLoad } from './errors.js';

type Visit = (a: number, b: number, weight: number, protectedFace: boolean) => void;
interface Graph {
  readonly size: number;
  readonly nx: number;
  readonly nz: number;
  /** Left-to-right, then forward, then down. Dry cells have no coordinate. */
  coordinate(i: number): number;
  anchors(i: number): number;
  faces(visit: Visit): void;
}

export const QUAY_SWEEP = 2 / 3;
const DIRECT_LIMIT = 128;

/** Pair cells from the ends, leaving an odd central strip symmetric. */
function coarsenAxis(cells: number): Uint32Array {
  const first = cells % 2 === 0 ? cells : 4 * Math.floor(cells / 4);
  const centre = cells - first,
    before = first / 2;
  return Uint32Array.from({ length: cells }, (_, i) => {
    if (i < before) return Math.floor(i / 2);
    if (i < before + centre) return before / 2 + i - before;
    return before + centre - 1 - Math.floor((cells - 1 - i) / 2);
  });
}

/** Compact positive-edge list. A protected face may carry zero conductance. */
class CoarseGraph implements Graph {
  readonly size: number;
  constructor(
    readonly nx: number,
    readonly nz: number,
    readonly coordinates: Int32Array,
    readonly ground: Uint32Array,
    readonly from: Int32Array,
    readonly to: Int32Array,
    readonly weights: Float64Array,
    readonly barriers: Uint8Array,
  ) {
    this.size = coordinates.length;
  }

  coordinate(i: number): number {
    return this.coordinates[i]!;
  }

  anchors(i: number): number {
    return this.ground[i]!;
  }

  faces(visit: Visit): void {
    for (let i = 0; i < this.from.length; i++)
      visit(this.from[i]!, this.to[i]!, this.weights[i]!, this.barriers[i] !== 0);
  }
}

// Galerkin aggregation follows Vaněk, Mandel and Brezina (1996), doi:10.1007/BF02238511.
// Keeping the depth bands and protected face endpoints separate preserves a submerged aperture.
/** P is constant on each wet component in a 2×2 horizontal block at one depth. */
function contract(fine: Graph): { graph: CoarseGraph; labels: Int32Array } {
  const xBins = coarsenAxis(fine.nx),
    zBins = coarsenAxis(fine.nz);
  const nx = xBins[fine.nx - 1]! + 1,
    nz = zBins[fine.nz - 1]! + 1,
    plane = fine.nx * fine.nz,
    coarsePlane = nx * nz,
    n = fine.size;
  const bins = new Int32Array(n).fill(-1);
  const parent = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const key = fine.coordinate(i);
    if (key < 0) continue;
    const square = key % plane;
    bins[i] =
      xBins[square % fine.nx]! + nx * zBins[Math.floor(square / fine.nx)]! + coarsePlane * Math.floor(key / plane);
    parent[i] = i;
  }
  function root(i: number): number {
    while (i !== parent[i]) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  }
  fine.faces((a, b, weight, protectedFace) => {
    if (!protectedFace && weight > 0 && bins[a] === bins[b]) parent[root(a)] = root(b);
  });
  const split = new Uint8Array(n);
  fine.faces((a, b, _, protectedFace) => {
    if (protectedFace && root(a) === root(b)) split[root(a)] = 1;
  });

  const coordinates: number[] = [];
  const ground: number[] = [];
  const labels = new Int32Array(n).fill(-1);
  const representatives = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    if (parent[i] === -1) continue;
    const representative = root(i);
    const member = split[representative] ? i : representative;
    if (representatives[member] === -1) {
      representatives[member] = coordinates.length;
      coordinates.push(bins[i]!);
      ground.push(0);
    }
    const coarse = representatives[member]!;
    labels[i] = coarse;
    ground[coarse]! += fine.anchors(i);
  }

  // Sum Galerkin edges in their original order. The small adjacency lists avoid
  // representing an edge by a floating-point product of two potentially large IDs.
  const head = new Int32Array(coordinates.length).fill(-1),
    from: number[] = [],
    to: number[] = [],
    next: number[] = [],
    weights: number[] = [],
    barriers: number[] = [];
  fine.faces((left, right, weight, protectedFace) => {
    const a = Math.min(labels[left]!, labels[right]!),
      b = Math.max(labels[left]!, labels[right]!);
    if (a === b) return;
    let edge = head[a]!;
    while (edge !== -1 && to[edge] !== b) edge = next[edge]!;
    if (edge === -1) {
      edge = from.length;
      next.push(head[a]!);
      head[a] = edge;
      from.push(a);
      to.push(b);
      weights.push(0);
      barriers.push(0);
    }
    weights[edge]! += weight;
    if (protectedFace) barriers[edge] = 1;
  });
  return {
    graph: new CoarseGraph(
      nx,
      nz,
      Int32Array.from(coordinates),
      Uint32Array.from(ground),
      Int32Array.from(from),
      Int32Array.from(to),
      Float64Array.from(weights),
      Uint8Array.from(barriers),
    ),
    labels,
  };
}

function requirePivot(pivot: number): void {
  if (!(pivot > 0 && Number.isFinite(pivot)))
    throw invalidLoad('Use finite conductances and connect each wet region to the surface for the coarse quay solve.');
}

/** Symmetric, pre/post-smoothed Galerkin solve. Fine-system residuals remain in QuayPotential. */
export class QuayCoarseCorrection {
  readonly labels: Int32Array;
  private readonly graph: CoarseGraph;
  private readonly child?: QuayCoarseCorrection;
  private readonly rhs: Float64Array;
  private readonly solution: Float64Array;
  private readonly work: Float64Array;
  private readonly diagonal: Float64Array;
  private readonly inverse: Float64Array;
  private readonly upper: Int32Array;
  private readonly lower: Int32Array;
  private readonly line: Float64Array;
  private readonly factor?: Float64Array;
  private top = NaN;

  constructor(fine: Graph) {
    const { graph, labels } = contract(fine);
    const { size: n, nx, nz } = graph;
    this.labels = labels;
    this.graph = graph;
    this.rhs = new Float64Array(n);
    this.solution = new Float64Array(n);
    this.work = new Float64Array(n);
    this.diagonal = new Float64Array(n);
    this.inverse = new Float64Array(n);
    this.upper = new Int32Array(n).fill(-1);
    this.lower = new Int32Array(n).fill(-1);
    this.line = new Float64Array(n);
    if (n <= DIRECT_LIMIT) this.factor = new Float64Array(n * n);
    else if (n < fine.size && (nx > 1 || nz > 1)) this.child = new QuayCoarseCorrection(graph);

    // Coarse columns can branch at a split aggregate. Factor only unbranched
    // vertical segments and leave the other faces in the full operator.
    graph.faces((a, b, g) => {
      this.diagonal[a]! += g;
      this.diagonal[b]! += g;
      if (g === 0 || graph.coordinate(b) - graph.coordinate(a) !== nx * nz) return;
      this.lower[a] = this.lower[a] === -1 ? b : -2;
      this.upper[b] = this.upper[b] === -1 ? a : -2;
    });
    graph.faces((a, b, g) => {
      if (g > 0 && this.lower[a] === b && this.upper[b] === a) this.line[b] = g;
    });
    for (let i = 0; i < n; i++) {
      if (!this.line[i]) this.upper[i] = -1;
      if (this.lower[i]! < 0 || !this.line[this.lower[i]!]) this.lower[i] = -1;
    }
  }

  prepare(top: number): void {
    if (this.top === top) return;
    const { graph, inverse, upper, line, factor, diagonal } = this;
    const n = graph.size;
    if (factor) {
      factor.fill(0);
      graph.faces((a, b, g) => {
        factor[b * n + a] = -g;
      });
      for (let i = 0; i < n; i++) {
        factor[i * n + i] = diagonal[i]! + top * graph.anchors(i);
        for (let j = 0; j <= i; j++) {
          let value = factor[i * n + j]!;
          for (let k = 0; k < j; k++) value -= factor[i * n + k]! * factor[j * n + k]!;
          if (i === j) requirePivot(value);
          factor[i * n + j] = i === j ? Math.sqrt(value) : value / factor[j * n + j]!;
        }
      }
    } else {
      for (let i = 0; i < n; i++) {
        const before = upper[i]!;
        const pivot = diagonal[i]! + top * graph.anchors(i) - (before < 0 ? 0 : line[i]! ** 2 * inverse[before]!);
        requirePivot(pivot);
        inverse[i] = 1 / pivot;
      }
      this.child?.prepare(top);
    }
    this.top = top;
  }

  add(fineResidual: Float64Array, correction: Float64Array): void {
    const { labels, rhs, solution } = this;
    rhs.fill(0);
    for (let i = 0; i < labels.length; i++) {
      const group = labels[i]!;
      if (group >= 0) rhs[group]! += fineResidual[i]!;
    }
    this.solve();
    for (let i = 0; i < labels.length; i++) {
      const group = labels[i]!;
      if (group >= 0) correction[i]! += solution[group]!;
    }
  }

  private solve(): void {
    const { graph, rhs, solution, work, factor, child } = this;
    const n = graph.size;
    if (factor) {
      for (let i = 0; i < n; i++) {
        let value = rhs[i]!;
        for (let j = 0; j < i; j++) value -= factor[i * n + j]! * solution[j]!;
        solution[i] = value / factor[i * n + i]!;
      }
      for (let i = n - 1; i >= 0; i--) {
        let value = solution[i]!;
        for (let j = i + 1; j < n; j++) value -= factor[j * n + i]! * solution[j]!;
        solution[i] = value / factor[i * n + i]!;
      }
      return;
    }
    this.column(rhs, solution);
    if (!child) return;
    for (let i = 0; i < n; i++) solution[i]! *= QUAY_SWEEP;
    this.residual();
    child.add(work, solution);
    this.residual();
    this.column(work, work);
    for (let i = 0; i < n; i++) solution[i]! += QUAY_SWEEP * work[i]!;
  }

  private column(rhs: Float64Array, out: Float64Array): void {
    const { upper, lower, line, inverse } = this;
    for (let i = 0; i < out.length; i++) {
      const j = upper[i]!;
      out[i] = rhs[i]! + (j < 0 ? 0 : line[i]! * inverse[j]! * out[j]!);
    }
    for (let i = out.length - 1; i >= 0; i--) {
      const j = lower[i]!;
      out[i] = inverse[i]! * (out[i]! + (j < 0 ? 0 : line[j]! * out[j]!));
    }
  }

  private residual(): void {
    const { graph, rhs, solution, work, top } = this;
    for (let i = 0; i < work.length; i++) work[i] = rhs[i]! - top * graph.anchors(i) * solution[i]!;
    graph.faces((a, b, g) => {
      const flux = g * (solution[a]! - solution[b]!);
      work[a]! -= flux;
      work[b]! += flux;
    });
  }
}
