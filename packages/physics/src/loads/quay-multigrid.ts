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
const MAX_EDGE_PAGE = 8192;

interface CoarseEdges {
  readonly from: Int32Array;
  readonly to: Int32Array;
  readonly weights: Float64Array;
  readonly barriers: Uint8Array;
}

function edgePage(size: number): CoarseEdges {
  return {
    from: new Int32Array(size),
    to: new Int32Array(size),
    weights: new Float64Array(size),
    barriers: new Uint8Array(size),
  };
}

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
    readonly edgePages: readonly CoarseEdges[],
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
    for (const { from, to, weights, barriers } of this.edgePages)
      for (let i = 0; i < from.length; i++) visit(from[i]!, to[i]!, weights[i]!, barriers[i] !== 0);
  }
}

// Galerkin aggregation follows Vaněk, Mandel and Brezina (1996), doi:10.1007/BF02238511.
// Keeping the depth bands and protected face endpoints separate preserves a submerged aperture.
/** P is constant on each wet component in a 2×2 horizontal block at one depth. */
function aggregate(fine: Graph) {
  const xBins = coarsenAxis(fine.nx),
    zBins = coarsenAxis(fine.nz);
  const nx = xBins[fine.nx - 1]! + 1,
    nz = zBins[fine.nz - 1]! + 1,
    plane = fine.nx * fine.nz,
    coarsePlane = nx * nz,
    n = fine.size;
  const bins = new Int32Array(n).fill(-1);
  const parent = new Int32Array(n).fill(-1);
  function bin(key: number): number {
    const square = key % plane;
    return xBins[square % fine.nx]! + nx * zBins[Math.floor(square / fine.nx)]! + coarsePlane * Math.floor(key / plane);
  }
  for (let i = 0; i < n; i++) {
    const key = fine.coordinate(i);
    if (key < 0) continue;
    bins[i] = bin(key);
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
  // Flatten before reusing the two dense work arrays. Each row can now read its
  // final root without following a pointer through a row already relabelled.
  for (let i = 0; i < n; i++) if (parent[i] !== -1) parent[i] = root(i);
  const split = new Uint8Array(n);
  fine.faces((a, b, _, protectedFace) => {
    if (protectedFace && parent[a] === parent[b]) split[parent[a]!] = 1;
  });

  const representatives = bins.fill(-1);
  let size = 0;
  for (let i = 0; i < n; i++) {
    const representative = parent[i]!;
    if (representative === -1) continue;
    const member = split[representative] ? i : representative;
    if (representatives[member] === -1) representatives[member] = size++;
    parent[i] = representatives[member]!;
  }
  const labels = parent;
  const coordinates = new Int32Array(size).fill(-1);
  const ground = new Uint32Array(size);
  for (let i = 0; i < n; i++) {
    const coarse = labels[i]!;
    if (coarse < 0) continue;
    if (coordinates[coarse] === -1) coordinates[coarse] = bin(fine.coordinate(i));
    ground[coarse]! += fine.anchors(i);
  }
  return { nx, nz, coordinates, ground, labels };
}

function contract(fine: Graph): { graph: CoarseGraph; labels: Int32Array } {
  const { nx, nz, coordinates, ground, labels } = aggregate(fine);
  const head = new Int32Array(coordinates.length).fill(-1);
  const pageSize = Math.min(MAX_EDGE_PAGE, Math.max(16, coordinates.length));
  const pages: CoarseEdges[] = [];
  const links: Int32Array[] = [];
  let size = 0;
  // Visit and sum Galerkin edges in original face order. Pages avoid growing and
  // then copying a large array for each attribute. Only the links are temporary.
  fine.faces((left, right, weight, protectedFace) => {
    const a = Math.min(labels[left]!, labels[right]!),
      b = Math.max(labels[left]!, labels[right]!);
    if (a === b) return;
    let edge = head[a]!;
    let page = Math.floor(edge / pageSize);
    let slot = edge % pageSize;
    while (edge !== -1 && pages[page]!.to[slot] !== b) {
      edge = links[page]![slot]!;
      page = Math.floor(edge / pageSize);
      slot = edge % pageSize;
    }
    if (edge === -1) {
      page = Math.floor(size / pageSize);
      slot = size % pageSize;
      if (slot === 0) {
        pages.push(edgePage(pageSize));
        links.push(new Int32Array(pageSize));
      }
      links[page]![slot] = head[a]!;
      head[a] = size++;
      pages[page]!.from[slot] = a;
      pages[page]!.to[slot] = b;
    }
    const { weights, barriers } = pages[page]!;
    weights[slot]! += weight;
    if (protectedFace) barriers[slot] = 1;
  });
  const tail = size % pageSize;
  if (tail) {
    const { from, to, weights, barriers } = pages.at(-1)!;
    pages[pages.length - 1] = {
      from: from.slice(0, tail),
      to: to.slice(0, tail),
      weights: weights.slice(0, tail),
      barriers: barriers.slice(0, tail),
    };
  }
  return { graph: new CoarseGraph(nx, nz, coordinates, ground, pages), labels };
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

  add(fineResidual: Float64Array, correction: Float64Array, active?: Uint32Array): void {
    const { labels, rhs, solution } = this;
    rhs.fill(0);
    const visits = active?.length ?? labels.length;
    for (let at = 0; at < visits; at++) {
      const i = active ? active[at]! : at;
      const group = labels[i]!;
      if (group >= 0) rhs[group]! += fineResidual[i]!;
    }
    this.solve();
    for (let at = 0; at < visits; at++) {
      const i = active ? active[at]! : at;
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
