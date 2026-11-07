// Long routes on a tiled navmesh: HPA* (A. Botea, M. Mueller, J. Schaeffer, "Near optimal hierarchical path-finding",
// Journal of Game Development 1(1), 2004) on polygons in place of grid cells. Clusters are blocks of tiles; the crossings
// between two clusters group into entrances, each with transition points; the cost of walking between a cluster's
// transitions is cached. A query adds its two ends to that small graph, searches it, joins the cached corridors and
// pulls the result taut with the funnel.
import type { NavFilter, Vec3 } from './index.js';
import { CorridorSearch, copy, type Link, type NavRoute, point, routeThrough } from './search.js';
import type { TiledNavMesh } from './tiles.js';

/** Options of {@link NavHierarchy}. */
export interface NavHierarchyOptions {
  /** Tiles along a cluster's side. More tiles make a smaller coarse graph and dearer ends. Default 4. */
  clusterTiles?: number;
  /** Space between transitions on a wide entrance, world units. Default a quarter of a cluster's side. */
  spacing?: number;
  /** Cost per area number, as in `route`; a hierarchy plans for one filter, so make one per agent type. Default none. */
  filter?: NavFilter;
}

/** A step of the coarse graph: the corridor it stands for, in the search's link shape. */
interface Step extends Link {
  corridor: readonly Link[];
}
interface LocalLink extends Link {
  source: Link;
}
interface Node {
  id: number;
  cluster: Cluster;
  polygon: number;
  point: Vec3;
  /** Steps out of it across a cluster line; a rebuild keeps these while its border stands. */
  crossings: Step[];
}
interface Cluster {
  x: number;
  z: number;
  polygons: number[];
  /** Local number by polygon. */
  local: Map<number, number>;
  adjacency: LocalLink[][];
  costs: Float64Array;
  /** Connected part by local number. */
  parts: Int32Array;
  nodes: Set<Node>;
  /** Off-mesh ids inside, to see a link come or go. */
  signature: string;
}
/** A crossing between two clusters, either way. */
interface Crossing {
  from: number;
  link: Link;
}

const key = (x: number, z: number) => `${x},${z}`;
const middle = (link: Link): Vec3 =>
  [
    (link.left[0] + link.right[0]) / 2,
    (link.left[1] + link.right[1]) / 2,
    (link.left[2] + link.right[2]) / 2,
  ] as unknown as Vec3;
const flat = (p: Vec3) => `${Math.round(p[0] * 1e4)},${Math.round(p[2] * 1e4)}`;
const end = (p: Vec3) => `${flat(p)},${Math.round(p[1] * 1e2)}`;

/**
 * A coarse graph over a `TiledNavMesh`, so a route across a huge world searches clusters and not every polygon. Routes
 * are near the shortest, not always the shortest: `world.route` stays the exact answer. Whenever a route can be walked
 * this finds one. Tile rebuilds and off-mesh links are picked up by the next query or {@link NavHierarchy.update}, and
 * only clusters that touch what changed are worked out again.
 */
export class NavHierarchy {
  private readonly size: number;
  private readonly spacing: number;
  private readonly filter: NavFilter | undefined;
  private readonly local = new CorridorSearch();
  private readonly coarse = new CorridorSearch();
  private readonly clusterMap = new Map<string, Cluster>();
  private readonly borders = new Map<string, Node[]>();
  private readonly meshes = new Map<string, unknown>();
  // The coarse graph by node id; 0 and 1 are a query's two ends.
  private readonly steps: Step[][] = [[], []];
  private readonly nodeList: (Node | null)[] = [null, null];
  private readonly free: number[] = [];
  private ones = new Float64Array(1024).fill(1);
  private version = -1;
  private owners: readonly ({ x: number; z: number } | null)[] = [];

  /**
   * Works out the coarse graph.
   * @throws RangeError for invalid options.
   */
  constructor(
    private readonly world: TiledNavMesh,
    options: NavHierarchyOptions = {},
  ) {
    const { clusterTiles = 4, spacing, filter } = options ?? {};
    if (!Number.isInteger(clusterTiles) || clusterTiles < 1)
      throw new RangeError('Cluster size must be a whole number of tiles of 1 or more; pass a count.');
    const side = clusterTiles * world.tileSpan;
    if (spacing !== undefined && !(spacing > 0 && spacing < Infinity))
      throw new RangeError('Transition spacing must be finite and above 0; pass a distance.');
    this.size = clusterTiles;
    this.spacing = spacing ?? side / 4;
    this.filter = filter;
    this.update();
  }

  /** Clusters that hold polygons. */
  get clusterCount(): number {
    return this.clusterMap.size;
  }
  /** Transition points in the coarse graph. */
  get nodeCount(): number {
    return this.nodeList.length - 2 - this.free.length;
  }

  private allocate(cluster: Cluster, polygon: number, at: Vec3): Node {
    const id = this.free.length ? (this.free.pop() as number) : this.nodeList.length,
      node: Node = { id, cluster, polygon, point: at, crossings: [] };
    this.nodeList[id] = node;
    this.steps[id] = [];
    cluster.nodes.add(node);
    return node;
  }

  /** Cuts one cluster out of the polygon graph. */
  private carve(
    x: number,
    z: number,
    polygons: number[],
    nodes: Set<Node>,
    adjacency: readonly (readonly Link[])[],
    costs: ArrayLike<number>,
  ): Cluster {
    const local = new Map<number, number>();
    polygons.forEach((p, i) => local.set(p, i));
    const parts = new Int32Array(polygons.length).map((_, i) => i),
      find = (i: number): number => {
        while (parts[i] !== i) i = parts[i] = parts[parts[i]];
        return i;
      },
      inner: LocalLink[][] = [],
      rates = new Float64Array(polygons.length),
      off: number[] = [];
    polygons.forEach((p, i) => {
      rates[i] = costs[p];
      const out: LocalLink[] = [];
      for (const link of adjacency[p]) {
        if (link.offMesh !== undefined) off.push(link.offMesh);
        const to = local.get(link.to);
        if (to === undefined) continue;
        out.push({ ...link, to, source: link });
        if (costs[p] < Infinity && costs[link.to] < Infinity) parts[find(i)] = find(to);
      }
      inner.push(out);
    });
    for (let i = 0; i < parts.length; i++) parts[i] = find(i);
    return {
      x,
      z,
      polygons,
      local,
      adjacency: inner,
      costs: rates,
      parts,
      nodes,
      signature: off.sort((a, b) => a - b).join(),
    };
  }

  /** Links two nodes with a crossing: the corridor is one link, and it costs only what an off-mesh link says. */
  private cross(from: Node, to: Node, link: Link): void {
    from.crossings.push({
      to: to.id,
      left: from.point,
      right: from.point,
      start: from.point,
      end: to.point,
      cost: link.cost ?? 0,
      offMesh: 0,
      corridor: [link],
    });
  }

  /** Picks the transitions of the crossings between two clusters. */
  private connect(
    one: Cluster,
    two: Cluster,
    crossings: readonly Crossing[],
    adjacency: readonly (readonly Link[])[],
  ): Node[] {
    const nodes: Node[] = [],
      side = (polygon: number) => (one.local.has(polygon) ? one : two),
      part = (polygon: number) => {
        const cluster = side(polygon);
        return cluster.parts[cluster.local.get(polygon) as number];
      },
      pair = (from: number, link: Link) => {
        const a = this.allocate(side(from), from, link.start ?? middle(link)),
          b = this.allocate(side(link.to), link.to, link.end ?? middle(link));
        nodes.push(a, b);
        this.cross(a, b, link);
        return [a, b];
      };
    // Entrances: runs of portals end to end that join the same two connected parts, so no way across goes unused.
    const runs = new Map<string, Crossing[]>(),
      owner = new Map<string, Crossing[]>();
    for (const crossing of crossings) {
      const { from, link } = crossing;
      if (link.offMesh !== undefined) {
        pair(from, link);
        continue;
      }
      // One direction carries the entrance; the other is found again from it.
      if (!one.local.has(from)) continue;
      const parts = `${part(from)}:${part(link.to)}:`,
        a = parts + end(link.left),
        b = parts + end(link.right);
      let run = owner.get(a) ?? owner.get(b);
      const other = owner.get(a) && owner.get(b) && owner.get(a) !== owner.get(b) ? owner.get(b) : undefined;
      if (!run) {
        run = [];
        runs.set(a, run);
      }
      run.push(crossing);
      if (other) {
        run.push(...other);
        for (const [name, held] of owner) if (held === other) owner.set(name, run);
        for (const [name, held] of runs) if (held === other) runs.delete(name);
      }
      owner.set(a, run);
      owner.set(b, run);
    }
    for (const run of runs.values()) {
      const widths = run.map(({ link }) => Math.hypot(link.left[0] - link.right[0], link.left[2] - link.right[2])),
        // Along the cluster line: portals sit on one axis, so sorting by their middles walks the run.
        order = run
          .map((_, i) => i)
          .sort((a, b) => {
            const p = middle(run[a].link),
              q = middle(run[b].link);
            return p[0] + p[2] - q[0] - q[2];
          }),
        width = widths.reduce((sum, w) => sum + w, 0),
        count = Math.max(1, Math.ceil(width / this.spacing)),
        picked = new Set<number>();
      let along = 0,
        next = 0;
      for (const i of order) {
        along += widths[i];
        while (next < count && ((next + 0.5) / count) * width <= along + 1e-9) {
          picked.add(i);
          next++;
        }
      }
      for (const i of picked) {
        const { from, link } = run[i],
          [a, b] = pair(from, link),
          back = adjacency[link.to].find(
            (other) => other.to === from && other.offMesh === undefined && flat(middle(other)) === flat(middle(link)),
          );
        if (back) this.cross(b, a, back);
      }
    }
    return nodes;
  }

  /** Works out the steps between a cluster's transitions. */
  private solve(cluster: Cluster): void {
    const count = cluster.polygons.length,
      links = cluster.adjacency.reduce((sum, list) => sum + list.length, 0);
    this.local.reserve(count, links);
    for (const from of cluster.nodes) {
      const out = (this.steps[from.id] = from.crossings.slice());
      for (const to of cluster.nodes) {
        if (to === from) continue;
        const walked = this.walk(cluster, from.polygon, from.point, to.polygon, to.point);
        if (walked) out.push({ ...walked, to: to.id });
      }
    }
  }

  /** The cheapest way between two points of a cluster, as a step. */
  private walk(cluster: Cluster, from: number, start: Vec3, to: number, target: Vec3): Step | null {
    const a = cluster.local.get(from) as number,
      b = cluster.local.get(to) as number;
    if (!(cluster.costs[b] < Infinity)) return null;
    const corridor =
      a === b ? [] : this.local.find(a, b, start, target, cluster.polygons.length, cluster.adjacency, cluster.costs);
    if (!corridor) return null;
    const rate = cluster.costs[b] < Infinity ? cluster.costs[b] : 1;
    return {
      to: 0,
      left: start,
      right: start,
      start,
      end: target,
      cost:
        a === b ? Math.hypot(start[0] - target[0], start[1] - target[1], start[2] - target[2]) * rate : this.local.cost,
      offMesh: 0,
      corridor: corridor.map((link) => (link as LocalLink).source),
    };
  }

  /** Picks up tile rebuilds and link changes; returns how many clusters it worked out again. */
  update(): number {
    const world = this.world;
    if (world.version === this.version) return 0;
    this.version = world.version;
    const graph = world.graph(this.filter),
      size = this.size,
      owners = (this.owners = graph.owners),
      groups = new Map<string, { x: number; z: number; polygons: number[] }>(),
      clusterOf = new Map<number, string>();
    for (let p = 0; p < graph.count; p++) {
      const tile = owners[p];
      if (!tile) continue;
      const x = Math.floor(tile.x / size),
        z = Math.floor(tile.z / size),
        name = key(x, z);
      let group = groups.get(name);
      if (!group) groups.set(name, (group = { x, z, polygons: [] }));
      group.polygons.push(p);
      clusterOf.set(p, name);
    }
    // What changed: a tile with a new mesh, or a cluster that gained or lost a link.
    const dirty = new Set<string>(),
      seen = new Set<string>();
    for (const { x, z, mesh } of world.tileList()) {
      const name = key(x, z);
      seen.add(name);
      if (this.meshes.get(name) !== mesh) {
        this.meshes.set(name, mesh);
        dirty.add(key(Math.floor(x / size), Math.floor(z / size)));
      }
    }
    for (const name of this.meshes.keys())
      if (!seen.has(name)) {
        const [x, z] = name.split(',').map(Number);
        this.meshes.delete(name);
        dirty.add(key(Math.floor(x / size), Math.floor(z / size)));
      }
    const carved = new Map<string, Cluster>();
    for (const [name, { x, z, polygons }] of groups) {
      const old = this.clusterMap.get(name);
      if (old && !dirty.has(name)) {
        // Off-mesh links change no tile; compare what the polygons hold now.
        const now = this.carve(x, z, polygons, old.nodes, graph.adjacency, graph.costs);
        if (now.signature === old.signature) continue;
        dirty.add(name);
        carved.set(name, now);
      } else {
        dirty.add(name);
        carved.set(name, this.carve(x, z, polygons, old?.nodes ?? new Set(), graph.adjacency, graph.costs));
      }
    }
    for (const name of this.clusterMap.keys()) if (!groups.has(name)) dirty.add(name);
    if (!dirty.size) return 0;
    // Every border of a changed cluster goes, with its transitions.
    const touched = new Set<string>(dirty);
    for (const [name, nodes] of this.borders) {
      const [one, two] = name.split('|');
      if (!dirty.has(one) && !dirty.has(two)) continue;
      touched.add(one);
      touched.add(two);
      for (const node of nodes) {
        node.cluster.nodes.delete(node);
        this.nodeList[node.id] = null;
        this.steps[node.id] = [];
        this.free.push(node.id);
      }
      this.borders.delete(name);
    }
    for (const name of dirty) {
      const cluster = carved.get(name);
      if (cluster) this.clusterMap.set(name, cluster);
      else if (!groups.has(name)) this.clusterMap.delete(name);
    }
    // Links across cluster lines, for the borders that went.
    const crossings = new Map<string, Crossing[]>();
    for (const [p, name] of clusterOf)
      for (const link of graph.adjacency[p]) {
        const other = clusterOf.get(link.to);
        if (other === undefined || other === name) continue;
        if (!dirty.has(name) && !dirty.has(other)) continue;
        if (!(graph.costs[p] < Infinity && graph.costs[link.to] < Infinity)) continue;
        const border = name < other ? `${name}|${other}` : `${other}|${name}`;
        let list = crossings.get(border);
        if (!list) crossings.set(border, (list = []));
        list.push({ from: p, link });
      }
    for (const [border, list] of crossings) {
      const [one, two] = border.split('|');
      touched.add(one);
      touched.add(two);
      this.borders.set(
        border,
        this.connect(this.clusterMap.get(one) as Cluster, this.clusterMap.get(two) as Cluster, list, graph.adjacency),
      );
    }
    let done = 0;
    for (const name of touched) {
      const cluster = this.clusterMap.get(name);
      if (!cluster) continue;
      // A neighbour's local graph holds links the world has replaced; cut it again.
      if (!carved.has(name)) {
        const fresh = this.carve(cluster.x, cluster.z, cluster.polygons, cluster.nodes, graph.adjacency, graph.costs);
        for (const node of fresh.nodes) node.cluster = fresh;
        this.clusterMap.set(name, fresh);
        this.solve(fresh);
      } else {
        for (const node of cluster.nodes) node.cluster = cluster;
        this.solve(cluster);
      }
      done++;
    }
    let total = 0;
    for (const list of this.steps) total += list.length;
    if (this.ones.length < this.steps.length) this.ones = new Float64Array(this.steps.length * 2).fill(1);
    this.coarse.reserve(this.steps.length, total + 2 * this.nodeList.length);
    return done;
  }

  /** Waypoints from `start` to `end`, including both, or null when an end is off the mesh or no route connects them. */
  path(start: Vec3, end: Vec3): Vec3[] | null {
    return this.route(start, end)?.points ?? null;
  }

  /**
   * {@link NavHierarchy.path} with the off-mesh crossings marked, as `route` of the mesh.
   * @throws RangeError when a point is not a finite 3D point.
   */
  route(start: Vec3, end: Vec3): NavRoute | null {
    point(start);
    point(end);
    this.update();
    const world = this.world,
      from = world.locate(start),
      to = world.locate(end);
    if (from < 0 || to < 0) return null;
    if (from === to) return { points: [copy(start), copy(end)], offMesh: [] };
    const first = this.clusterHolding(from),
      last = this.clusterHolding(to);
    if (!first || !last) return null;
    const out: Step[] = (this.steps[0] = []),
      added: Node[] = [],
      none = this.nodeList.length;
    if (first === last) {
      const direct = this.walk(first, from, start, to, end);
      if (direct) out.push({ ...direct, to: 1 });
    }
    this.local.reserve(Math.max(first.polygons.length, last.polygons.length), this.linksOf(first) + this.linksOf(last));
    for (const node of first.nodes) {
      const step = this.walk(first, from, start, node.polygon, node.point);
      if (step) out.push({ ...step, to: node.id });
    }
    for (const node of last.nodes) {
      const step = this.walk(last, node.polygon, node.point, to, end);
      if (step) {
        this.steps[node.id].push({ ...step, to: 1 });
        added.push(node);
      }
    }
    const found = this.coarse.find(0, 1, start, end, none, this.steps, this.ones);
    for (const node of added) this.steps[node.id].pop();
    if (!found) return null;
    const corridor: Link[] = [];
    for (const step of found) corridor.push(...(step as Step).corridor);
    return routeThrough(corridor, start, end);
  }

  private linksOf(cluster: Cluster): number {
    return cluster.adjacency.reduce((sum, list) => sum + list.length, 0);
  }
  private clusterHolding(polygon: number): Cluster | null {
    const tile = this.owners[polygon];
    return tile
      ? (this.clusterMap.get(key(Math.floor(tile.x / this.size), Math.floor(tile.z / this.size))) ?? null)
      : null;
  }
}
