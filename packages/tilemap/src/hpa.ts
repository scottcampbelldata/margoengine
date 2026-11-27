// Hierarchical pathfinding on a cost grid, after HPA* (A. Botea, M. Mueller and J. Schaeffer, "Near Optimal
// Hierarchical Path-Finding", Journal of Game Development 1(1), 2004,
// https://webdocs.cs.ualberta.ca/~mmueller/ps/hpastar.pdf). The grid is cut into square clusters; a few of the steps
// that cross each border become transitions, whose two cells are the nodes of a small graph, and the cheapest ways
// between the nodes of one cluster are kept as its edges. A query joins the start and the goal to their clusters' nodes,
// searches the small graph, fills each of its edges in with a search inside one cluster, and then shortens the path.
// The choice of transitions is Margo's own and gives a bound: every crossing step lies within `detour` steps of a
// transition, walked on both sides without leaving the two clusters. So a cheapest path can be rerouted through
// transitions at no more than (2 detour + 1) of the dearest steps per cluster border it crosses, and with a detour of 0
// every crossing step is a transition and the cost is exactly the cheapest one.
import { check, type Diagonal, estimator, Heap, index, open, SQRT2, steps } from './grid-search.js';
import type { CostGrid, GridPath, PathOptions } from './path.js';

/** Settings of {@link PathHierarchy}. */
export interface HierarchyOptions {
  /** Corner steps, as `findPath` takes them. Default `'no-corners'`. */
  diagonal?: PathOptions['diagonal'];
  /** Stops one `findPath` call after this many expanded cells and nodes. Default 1,000,000. */
  maxCells?: number;
  /** Cells along a cluster's side, a whole number of 2 or more. Default 16. */
  cluster?: number;
  /**
   * How many steps any border crossing may lie from a transition, a whole number of 0 or more. 0 makes every crossing a
   * transition, for exact costs and the largest graph; higher values make a smaller graph. Default 3.
   */
  detour?: number;
}

/** A transition: the step from cell `a` to cell `b` of a neighbouring cluster (and back), of length 1 or sqrt(2). */
interface Step {
  readonly a: number;
  readonly b: number;
  readonly length: number;
}

interface Cluster {
  /** The cluster's nodes: its cells that end a transition. */
  nodes: number[];
  /** Each node's cheapest ways to the others without leaving the cluster. */
  edges: Map<number, { to: number[]; cost: number[] }>;
}

/**
 * Long paths over a large grid for the price of short ones: build once, then {@link PathHierarchy.findPath} searches a
 * graph of cluster borders and fills in only the clusters the path crosses. Change `grid.cost`, tell
 * {@link PathHierarchy.update} which cells changed, and only the clusters around them are rebuilt.
 */
export class PathHierarchy {
  /** The grid searched; change its costs in place, then call {@link update}. */
  readonly grid: CostGrid;
  readonly cluster: number;
  readonly detour: number;
  private readonly diagonal: Diagonal;
  private readonly square: boolean;
  private readonly max: number;
  private readonly across: number;
  private readonly down: number;
  private low = Number.POSITIVE_INFINITY;
  private readonly clusters: Cluster[];
  /** The transitions between two clusters, under `first * count + second`. */
  private readonly borders = new Map<number, Step[]>();
  /** Each node's transitions, both ways. */
  private readonly links = new Map<number, Step[]>();
  private readonly dirty = new Set<number>();
  // Scratch for the searches inside a region: `seen[c] === stamp` means this search wrote the cell.
  private readonly dist: Float64Array;
  private readonly came: Int32Array;
  private readonly seen: Uint32Array;
  private readonly done: Uint32Array;
  private stamp = 0;
  private expanded = 0;

  constructor(grid: CostGrid, options: HierarchyOptions = {}) {
    const { diagonal, max, square } = check(grid, options),
      cluster = options.cluster ?? 16,
      detour = options.detour ?? 3;
    if (!Number.isInteger(cluster) || cluster < 2)
      throw new RangeError(`cluster must be a whole number of 2 or more, got ${cluster}.`);
    if (!Number.isInteger(detour) || detour < 0)
      throw new RangeError(`detour must be a whole number of 0 or more, got ${detour}.`);
    this.grid = grid;
    this.diagonal = diagonal;
    this.square = square;
    this.max = max;
    this.cluster = cluster;
    this.detour = detour;
    this.across = Math.ceil(grid.width / cluster);
    this.down = Math.ceil(grid.height / cluster);
    this.clusters = Array.from({ length: this.across * this.down }, () => ({ nodes: [], edges: new Map() }));
    const size = grid.cost.length;
    this.dist = new Float64Array(size);
    this.came = new Int32Array(size);
    this.seen = new Uint32Array(size);
    this.done = new Uint32Array(size);
    for (let i = 0; i < size; i++) if (open(grid.cost[i]) && grid.cost[i] < this.low) this.low = grid.cost[i];
    for (let i = 0; i < this.clusters.length; i++) this.dirty.add(i);
    this.rebuild();
  }

  /** The nodes of the abstract graph, as cells, for drawing and for judging the size `cluster` and `detour` give. */
  get nodes(): [number, number][] {
    this.rebuild();
    const { width } = this.grid;
    return this.clusters.flatMap((c) => c.nodes.map((n): [number, number] => [n % width, Math.floor(n / width)]));
  }

  /**
   * Tells the hierarchy which cells' costs changed since the last call; the clusters around them are rebuilt before the
   * next query. Every changed cell must be listed.
   */
  update(cells: Iterable<readonly [number, number]>): this {
    const { grid } = this;
    for (const cell of cells) {
      const c = index(grid, cell, 'cell'),
        [x, y] = cell;
      if (open(grid.cost[c]) && grid.cost[c] < this.low) this.low = grid.cost[c];
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++)
          if (x + dx >= 0 && y + dy >= 0 && x + dx < grid.width && y + dy < grid.height)
            this.dirty.add(this.clusterOf(c + dy * grid.width + dx));
    }
    return this;
  }

  /**
   * A path from `start` to `goal`, or null when there is no way (or `maxCells` ran out). It finds a way whenever one
   * exists. Its cost is the cheapest one with a `detour` of 0, and otherwise above it by at most
   * `(2 * detour + 1) * L * highest` for each cluster border a cheapest path crosses, where `highest` is the dearest open
   * cell and `L` is sqrt(2) with corner steps and 1 without them (and on hexagonal and staggered maps). `smooth`
   * (default true) searches the path again in short stretches and keeps what is cheaper.
   */
  findPath(
    start: readonly [number, number],
    goal: readonly [number, number],
    { smooth = true }: { smooth?: boolean } = {},
  ): GridPath | null {
    const { grid } = this,
      { cost, width } = grid,
      from = index(grid, start, 'start'),
      to = index(grid, goal, 'goal');
    if (!open(cost[from]) || !open(cost[to])) return null;
    this.rebuild();
    this.expanded = 0;
    const first = this.clusterOf(from),
      final = this.clusterOf(to),
      estimate = estimator(grid, this.square, this.diagonal, this.low);
    // The start's ways to its cluster's nodes (and to a goal in the same cluster), and the nodes' ways to the goal.
    this.explore(from, this.inside(first), -1, false);
    const leave = this.reached([...this.clusters[first].nodes, ...(first === final ? [to] : [])]);
    this.explore(to, this.inside(final), -1, true);
    const arrive = this.reached(this.clusters[final].nodes);
    // A* over the nodes.
    const spent = new Map([[from, 0]]),
      came = new Map<number, number>(),
      closed = new Set<number>(),
      heap = new Heap();
    heap.push(from, estimate(from, to));
    while (heap.size) {
      const node = heap.pop();
      if (closed.has(node)) continue;
      closed.add(node);
      if (node === to) break;
      if (++this.expanded > this.max) return null;
      const here = spent.get(node)!,
        visit = (next: number, price: number) => {
          const total = here + price;
          if (total < (spent.get(next) ?? Number.POSITIVE_INFINITY)) {
            spent.set(next, total);
            came.set(next, node);
            heap.push(next, total + estimate(next, to));
          }
        };
      if (node === from) for (const [next, price] of leave) visit(next, price);
      const at = this.clusterOf(node),
        edges = this.clusters[at].edges.get(node);
      if (edges) for (let i = 0; i < edges.to.length; i++) visit(edges.to[i], edges.cost[i]);
      for (const link of this.links.get(node) ?? []) {
        const next = link.a === node ? link.b : link.a;
        visit(next, cost[next] * link.length);
      }
      const home = at === final ? arrive.get(node) : undefined;
      if (home !== undefined) visit(to, home);
    }
    if (!closed.has(to)) return null;
    const abstract: number[] = [to];
    while (abstract[abstract.length - 1] !== from) abstract.push(came.get(abstract[abstract.length - 1])!);
    abstract.reverse();
    // Fill in each edge: a step between clusters is one cell, a way inside a cluster is searched there.
    let path = [from];
    for (let i = 1; i < abstract.length; i++) {
      const a = abstract[i - 1],
        b = abstract[i],
        at = this.clusterOf(a);
      if (this.clusterOf(b) !== at) path.push(b);
      else {
        if (!this.explore(a, this.inside(at), b, false)) return null;
        const part = this.trace(b);
        for (let j = 1; j < part.length; j++) path.push(part[j]);
      }
    }
    path = loopless(path);
    if (smooth) path = loopless(this.shorten(path));
    if (this.expanded > this.max) return null;
    let total = 0;
    for (let i = 1; i < path.length; i++) total += this.price(path[i - 1], path[i]);
    return {
      cells: path.map((c): [number, number] => [c % width, Math.floor(c / width)]),
      cost: total,
      searched: this.expanded,
      scanned: 0,
    };
  }

  private clusterOf(cell: number): number {
    const x = cell % this.grid.width,
      y = (cell - x) / this.grid.width;
    return Math.floor(y / this.cluster) * this.across + Math.floor(x / this.cluster);
  }

  private inside(cluster: number): (cell: number) => boolean {
    return (cell) => this.clusterOf(cell) === cluster;
  }

  /** The cost of the step from `a` to its neighbour `b`. */
  private price(a: number, b: number): number {
    const { width, cost } = this.grid,
      corner = this.square && a % width !== b % width && Math.floor(a / width) !== Math.floor(b / width);
    return cost[b] * (corner ? SQRT2 : 1);
  }

  /**
   * Searches from `from` over the cells `allowed` accepts: to `target` by A*, or everywhere (-1). With `reverse` each
   * distance is the cost of walking from the cell to `from`. True when the target was reached (or there is none).
   */
  private explore(from: number, allowed: (cell: number) => boolean, target: number, reverse: boolean): boolean {
    const { grid, dist, came, seen, done } = this,
      { cost } = grid,
      stamp = ++this.stamp,
      estimate = target < 0 ? undefined : estimator(grid, this.square, this.diagonal, this.low),
      heap = new Heap();
    seen[from] = stamp;
    dist[from] = 0;
    came[from] = -1;
    heap.push(from, 0);
    while (heap.size) {
      const cell = heap.pop();
      if (done[cell] === stamp) continue;
      done[cell] = stamp;
      if (cell === target) return true;
      this.expanded++;
      steps(grid, this.square, this.diagonal, cell, (next, length) => {
        if (done[next] === stamp || !allowed(next)) return;
        const total = dist[cell] + cost[reverse ? cell : next] * length;
        if (seen[next] !== stamp || total < dist[next]) {
          seen[next] = stamp;
          dist[next] = total;
          came[next] = cell;
          heap.push(next, estimate ? total + estimate(next, target) : total);
        }
      });
    }
    return target < 0;
  }

  /** The distances the last search found to those of `cells` it reached. */
  private reached(cells: readonly number[]): Map<number, number> {
    const out = new Map<number, number>();
    for (const c of cells) if (this.done[c] === this.stamp) out.set(c, this.dist[c]);
    return out;
  }

  /** The last search's way to `cell`, from its start. */
  private trace(cell: number): number[] {
    const out: number[] = [];
    for (let c = cell; c !== -1; c = this.came[c]) out.push(c);
    return out.reverse();
  }

  /**
   * Searches stretches of the path again, each a cluster side long and overlapping the next by half, inside the stretch's
   * bounds widened by half a cluster, and takes the new way where it is cheaper.
   */
  private shorten(path: number[]): number[] {
    const { width } = this.grid,
      reach = this.cluster,
      half = reach >> 1 || 1;
    for (let i = 0; i + 2 < path.length; i += half) {
      const j = Math.min(path.length - 1, i + reach);
      let x0 = width,
        y0 = this.grid.height,
        x1 = 0,
        y1 = 0,
        old = 0;
      for (let k = i; k <= j; k++) {
        const x = path[k] % width,
          y = (path[k] - x) / width;
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
        if (k > i) old += this.price(path[k - 1], path[k]);
      }
      const allowed = (c: number) => {
        const x = c % width,
          y = (c - x) / width;
        return x >= x0 - half && x <= x1 + half && y >= y0 - half && y <= y1 + half;
      };
      if (this.expanded > this.max) break;
      if (this.explore(path[i], allowed, path[j], false) && this.dist[path[j]] < old - old * 1e-9) {
        const part = this.trace(path[j]);
        path = path.slice(0, i).concat(part, path.slice(j + 1));
      }
    }
    return path;
  }

  /** Chooses the transitions of the borders of every dirty cluster again, then the ways inside the clusters they end in. */
  private rebuild(): void {
    if (!this.dirty.size) return;
    const { across, down, clusters, borders, links } = this,
      pairs = new Set<number>(),
      stale = new Set(this.dirty);
    for (const c of this.dirty) {
      const x = c % across,
        y = (c - x) / across;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if ((!dx && !dy) || x + dx < 0 || y + dy < 0 || x + dx >= across || y + dy >= down) continue;
          const other = c + dy * across + dx;
          pairs.add(Math.min(c, other) * clusters.length + Math.max(c, other));
        }
    }
    for (const pair of pairs) {
      const b = pair % clusters.length,
        a = (pair - b) / clusters.length,
        before = borders.get(pair) ?? [],
        after = this.transitions(a, b);
      if (before.length === after.length && before.every((s, i) => s.a === after[i].a && s.b === after[i].b)) continue;
      for (const step of before)
        for (const node of [step.a, step.b]) {
          const list = links.get(node)!.filter((s) => s !== step);
          if (list.length) links.set(node, list);
          else links.delete(node);
        }
      for (const step of after)
        for (const node of [step.a, step.b]) links.set(node, [...(links.get(node) ?? []), step]);
      borders.set(pair, after);
      stale.add(a);
      stale.add(b);
    }
    for (const c of stale) {
      const x = c % across,
        y = (c - x) / across,
        nodes = new Set<number>();
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if ((!dx && !dy) || x + dx < 0 || y + dy < 0 || x + dx >= across || y + dy >= down) continue;
          const other = c + dy * across + dx;
          for (const step of borders.get(Math.min(c, other) * clusters.length + Math.max(c, other)) ?? [])
            nodes.add(c < other ? step.a : step.b);
        }
      const cluster = clusters[c];
      cluster.nodes = [...nodes].sort((a, b) => a - b);
      cluster.edges = new Map();
      for (const node of cluster.nodes) {
        this.explore(node, this.inside(c), -1, false);
        const found = this.reached(cluster.nodes);
        found.delete(node);
        cluster.edges.set(node, { to: [...found.keys()], cost: [...found.values()] });
      }
    }
    this.dirty.clear();
  }

  /**
   * The transitions from cluster `a` to cluster `b`: enough of the steps between them that every such step is within
   * `detour` hops of one. A hop moves each end by at most one step inside its own cluster.
   */
  private transitions(a: number, b: number): Step[] {
    const { grid, across, cluster, detour } = this,
      { width, height, cost } = grid,
      x0 = (a % across) * cluster,
      y0 = Math.floor(a / across) * cluster,
      x1 = Math.min(width, x0 + cluster) - 1,
      y1 = Math.min(height, y0 + cluster) - 1,
      all: Step[] = [],
      from = new Map<number, number[]>();
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x += y === y0 || y === y1 || x === x1 ? 1 : x1 - x0) {
        const u = y * width + x;
        if (!open(cost[u])) continue;
        steps(grid, this.square, this.diagonal, u, (v, length) => {
          if (this.clusterOf(v) !== b) return;
          const list = from.get(u);
          if (list) list.push(all.length);
          else from.set(u, [all.length]);
          all.push({ a: u, b: v, length });
        });
      }
    if (!detour || all.length < 2) return all;
    // A cell and the cells one step from it inside its cluster.
    const near = (cell: number, home: number) => {
      const out = new Set([cell]);
      steps(grid, this.square, this.diagonal, cell, (n) => {
        if (this.clusterOf(n) === home) out.add(n);
      });
      return out;
    };
    const joined: (number[] | undefined)[] = [];
    const beside = (i: number): number[] => {
      let list = joined[i];
      if (list) return list;
      list = [];
      const other = near(all[i].b, b);
      for (const u of near(all[i].a, a))
        for (const j of from.get(u) ?? []) if (j !== i && other.has(all[j].b)) list.push(j);
      joined[i] = list;
      return list;
    };
    /** The crossings within `detour` hops of crossing `i`, each with its hops. */
    const around = (i: number): Map<number, number> => {
      const found = new Map([[i, 0]]);
      // A Map keeps the order its entries came in, so this walks outward as it grows.
      for (const [j, hops] of found)
        if (hops < detour) for (const k of beside(j)) if (!found.has(k)) found.set(k, hops + 1);
      return found;
    };
    const covered = new Uint8Array(all.length),
      chosen: Step[] = [];
    for (let i = 0; i < all.length; i++) {
      if (covered[i]) continue;
      // Of the crossings that would cover this one, take the one covering most others; then a straight step, then the
      // one nearest the middle of what it covers.
      let best: Map<number, number> | undefined,
        pick = i,
        most = -1,
        far = 0;
      for (const j of around(i).keys()) {
        const found = around(j);
        let count = 0,
          total = 0;
        for (const [k, hops] of found)
          if (!covered[k]) {
            count++;
            total += hops;
          }
        const shorter = all[j].length - all[pick].length;
        if (count > most || (count === most && (shorter < 0 || (shorter === 0 && total < far)))) {
          best = found;
          pick = j;
          most = count;
          far = total;
        }
      }
      for (const k of best!.keys()) covered[k] = 1;
      chosen.push(all[pick]);
    }
    return chosen;
  }
}

/** The path with every loop cut out: a cell met again drops what came between. */
const loopless = (path: number[]): number[] => {
  const at = new Map<number, number>(),
    out: number[] = [];
  for (const cell of path) {
    const seen = at.get(cell);
    if (seen === undefined) {
      at.set(cell, out.length);
      out.push(cell);
    } else for (const gone of out.splice(seen + 1)) at.delete(gone);
  }
  return out;
};
