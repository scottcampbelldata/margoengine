/// <reference lib="esnext.disposable" preserve="true" />
// A navmesh cut into square tiles on one voxel lattice. Each tile runs the whole pipeline on its own cells plus a
// border wide enough for the filters and erosion to see past its edge, then keeps only its own cells, so the walkable
// area does not depend on the tiling and a change rebuilds only the tiles it reaches. Portals across a tile line are
// the overlaps of the polygon edges on it. Tiling a voxel build is the long-standing practice; the design here is
// our own, from the sources named in docs/clean-room.md.
import { MargoError } from '@margoengine/math/errors';
import type { NavFilter, NavLink, NavMesh, NavSurface, OffMeshLinkOptions, Vec3 } from './index.js';
import {
  failed,
  solve,
  validate,
  type Built,
  type Grid,
  type NavigationOptions,
  type NavObstacle,
} from './pipeline.js';
import {
  CorridorSearch,
  checkFilter,
  copy,
  cross,
  distance,
  point,
  routeThrough,
  type Link,
  type NavRoute,
} from './search.js';

/** Options of {@link TiledNavMesh}: the build settings of `./build`, and the tiling. */
export interface TiledNavMeshOptions extends NavigationOptions {
  /** Cells along a tile's side, 8 to 1024. Smaller tiles rebuild faster and make more polygons. Default 64. */
  tileSize?: number;
  /** Start with every tile waiting for {@link TiledNavMesh.update} instead of building them now. Default false. */
  deferred?: boolean;
  /**
   * Corner the tile lattice grows from, world units; lets a mesh start with no triangles (`new TiledNavMesh([], [],
   * {origin, deferred: true})`) and take geometry later. Default the level's lowest corner.
   */
  origin?: readonly [number, number, number];
}

/** @internal What `./codec` saves of a {@link TiledNavMesh}. */
export interface TiledState {
  settings: NavigationOptions & { tileSize: number };
  origin: readonly [number, number, number];
  nextId: number;
  tiles: { x: number; z: number; rise: number; mesh: NavMesh }[];
  /** Tiles waiting for `update`, by column and row. */
  pending: [number, number][];
  links: { id: number; start: Vec3; end: Vec3; cost: number; bidirectional: boolean }[];
  /** Null when the level was left out: the mesh loads fixed. */
  level: {
    obstacles: { id: number; box: NavObstacle }[];
    geometry: { id: number; points: Float32Array; triangles: Uint32Array }[];
  } | null;
}

/** One tile of a {@link TiledNavMesh}. */
export interface NavTile {
  /** Tile column and row. */
  x: number;
  z: number;
  /** The tile's polygons on their own, or null when nothing is walkable there. */
  mesh: NavMesh | null;
}

interface Geometry {
  points: Float32Array;
  triangles: Uint32Array;
  /** Triangles (by first index position) reaching each tile. */
  tiles: Map<Tile, number[]>;
}
interface Edge {
  polygon: number;
  a: Vec3;
  b: Vec3;
}
interface Tile {
  x: number;
  z: number;
  mesh: NavMesh | null;
  /** Polygon ids by local polygon index. */
  ids: Int32Array;
  rise: number;
  /** Polygon edges on the tile's four sides: west, east, south, north. */
  sides: Edge[][];
  geometry: Set<Geometry>;
}
interface OffMesh {
  start: Vec3;
  end: Vec3;
  bidirectional: boolean;
  cost: number;
  from: number;
  to: number;
}

const NONE = new Int32Array(0);
/** Sides of a tile: the neighbour's offset and the side it answers with. */
const SIDES = [
  [-1, 0, 1],
  [1, 0, 0],
  [0, -1, 3],
  [0, 1, 2],
] as const;

/**
 * A navmesh of tiles: past the 4,096 polygon limit of one {@link NavMesh}, and changed at run time. Add, move and
 * remove obstacles and whole meshes, then call {@link TiledNavMesh.update} to rebuild only the tiles they reach; the
 * routes stay valid on the old polygons until then. It answers the same queries as a `NavMesh`, so a `Crowd` walks on
 * it. Polygon numbers change when a tile rebuilds. `using` works.
 */
export class TiledNavMesh implements NavSurface {
  /** Cells along a tile's side. */
  readonly tileSize: number;
  /** Extra cells a tile sees on each side. */
  protected readonly margin: number;
  /** World units along a tile's side. */
  protected readonly span: number;
  /** The build settings. */
  protected readonly config: Required<NavigationOptions>;
  /** Lattice origin, world units. */
  protected readonly origin: readonly [number, number, number];
  private readonly tiles = new Map<string, Tile>();
  private readonly dirty = new Set<Tile>();
  private readonly geometries = new Map<number, Geometry>();
  private readonly obstacles = new Map<number, NavObstacle>();
  private readonly offMesh = new Map<number, OffMesh>();
  private readonly search = new CorridorSearch();
  // Polygons by id. A freed id has no links, so no search reaches it.
  private readonly adjacency: Link[][] = [];
  private readonly centers: Vec3[] = [];
  private readonly owners: (Tile | null)[] = [];
  private locals = new Int32Array(1024);
  private costs = new Float64Array(1024).fill(1);
  private polygonAreas = new Uint8Array(1024);
  private filtered = new Float64Array(0);
  private readonly free: number[] = [];
  private count = 0;
  private linkTotal = 0;
  private changes = 0;
  private nextId = 1;
  private disposed = false;
  /** Loaded without its level: nothing can rebuild. */
  private fixed = false;

  /**
   * Cuts a level into tiles and builds them.
   * @param positions Flat xyz positions (Y up).
   * @param indices Flat triangle indices into `positions`.
   * @throws RangeError for invalid geometry or options (as `./build`, without its limit on a whole level's cells).
   * @throws MargoError `failed` when nothing is walkable, unless `deferred`.
   */
  constructor(positions: ArrayLike<number>, indices: ArrayLike<number>, options: TiledNavMeshOptions = {}) {
    const { tileSize = 64, deferred = false, origin, ...build } = options ?? {};
    if (!Number.isInteger(tileSize) || tileSize < 8 || tileSize > 1024)
      throw new RangeError('Tile size must be a whole number of cells from 8 to 1024');
    if (origin !== undefined && !(origin.length === 3 && origin.every((v) => Number.isFinite(v))))
      throw new RangeError('Tile origin must be finite [x, y, z]; pass three numbers.');
    const empty = origin !== undefined && positions?.length === 0 && indices?.length === 0,
      input = validate(empty ? [0, 0, 0, 1, 0, 0, 0, 0, 1] : positions, empty ? [0, 1, 2] : indices, build, false);
    this.tileSize = tileSize;
    this.config = input.config;
    this.origin = origin ? [origin[0], origin[1], origin[2]] : [input.min[0], input.min[1], input.min[2]];
    this.span = tileSize * input.config.cs;
    // The filters mark the grid's outer ring as a ledge, and erosion reaches walkableRadius + 1 cells in from it.
    this.margin = Math.ceil(input.config.walkableRadius) + 2;
    for (const box of input.config.obstacles) this.obstacles.set(this.nextId++, box);
    if (!empty) this.addParsed(input.points, input.triangles);
    if (deferred) return;
    this.update();
    if (!this.polygonCount) failed('no tile has a walkable polygon');
  }

  private check(): void {
    if (this.disposed) throw new MargoError('disposed', 'TiledNavMesh is disposed; create a new one.');
  }
  /** {@link TiledNavMesh.check}, for what changes the level. */
  private checkLevel(): void {
    this.check();
    if (this.fixed)
      throw new MargoError('state', 'This mesh was baked without its level; bake it with geometry: true to change it.');
  }
  private tileAt(x: number, z: number): Tile | undefined {
    return this.tiles.get(`${x},${z}`);
  }
  /** The tile at (x, z), made when it does not exist. */
  protected ensureTile(x: number, z: number): Tile {
    let tile = this.tileAt(x, z);
    if (!tile) {
      tile = { x, z, mesh: null, ids: NONE, rise: 0, sides: [[], [], [], []], geometry: new Set() };
      this.tiles.set(`${x},${z}`, tile);
    }
    return tile;
  }
  /** Marks every existing tile that sees the XZ box for rebuilding. */
  protected touch(x0: number, z0: number, x1: number, z1: number): void {
    const reach = this.margin * this.config.cs,
      [ox, , oz] = this.origin,
      c0 = Math.floor((x0 - reach - ox) / this.span),
      c1 = Math.floor((x1 + reach - ox) / this.span),
      r0 = Math.floor((z0 - reach - oz) / this.span),
      r1 = Math.floor((z1 + reach - oz) / this.span);
    for (let r = r0; r <= r1; r++)
      for (let c = c0; c <= c1; c++) {
        const tile = this.tileAt(c, r);
        if (tile) this.dirty.add(tile);
      }
  }
  private addParsed(points: Float32Array, triangles: Uint32Array, id = this.nextId++): number {
    const geometry: Geometry = { points, triangles, tiles: new Map() },
      reach = this.margin * this.config.cs,
      [ox, , oz] = this.origin;
    for (let t = 0; t < triangles.length; t += 3) {
      let x0 = Infinity,
        x1 = -Infinity,
        z0 = Infinity,
        z1 = -Infinity;
      for (let k = 0; k < 3; k++) {
        const v = triangles[t + k] * 3;
        x0 = Math.min(x0, points[v]);
        x1 = Math.max(x1, points[v]);
        z0 = Math.min(z0, points[v + 2]);
        z1 = Math.max(z1, points[v + 2]);
      }
      const c0 = Math.floor((x0 - reach - ox) / this.span),
        c1 = Math.floor((x1 + reach - ox) / this.span),
        r0 = Math.floor((z0 - reach - oz) / this.span),
        r1 = Math.floor((z1 + reach - oz) / this.span);
      for (let r = r0; r <= r1; r++)
        for (let c = c0; c <= c1; c++) {
          const tile = this.ensureTile(c, r);
          let list = geometry.tiles.get(tile);
          if (!list) {
            geometry.tiles.set(tile, (list = []));
            tile.geometry.add(geometry);
            this.dirty.add(tile);
          }
          list.push(t);
        }
    }
    this.geometries.set(id, geometry);
    return id;
  }

  /**
   * Adds a mesh to the level (a built wall, a bridge) and returns its id for {@link TiledNavMesh.removeGeometry}. The
   * tiles it reaches rebuild on the next {@link TiledNavMesh.update}.
   * @throws RangeError for invalid geometry.
   */
  addGeometry(positions: ArrayLike<number>, indices: ArrayLike<number>): number {
    this.checkLevel();
    const { points, triangles } = validate(positions, indices, {}, false);
    return this.addParsed(points, triangles);
  }
  /** Removes a mesh by the id {@link TiledNavMesh.addGeometry} returned; false when there is none. */
  removeGeometry(id: number): boolean {
    this.checkLevel();
    const geometry = this.geometries.get(id);
    if (!geometry) return false;
    this.geometries.delete(id);
    for (const tile of geometry.tiles.keys()) {
      tile.geometry.delete(geometry);
      this.dirty.add(tile);
    }
    return true;
  }
  /**
   * Carves a box out of the walkable area (a closed door, a parked truck) and returns its id. Tiles it reaches
   * rebuild on the next {@link TiledNavMesh.update}.
   * @throws RangeError for a box that is not `{min, max}` with min <= max.
   */
  addObstacle(box: NavObstacle): number {
    this.checkLevel();
    validate([0, 0, 0, 1, 0, 0, 0, 0, 1], [0, 1, 2], { obstacles: [box] }, false);
    const id = this.nextId++;
    this.obstacles.set(id, box);
    this.touch(box.min[0], box.min[2], box.max[0], box.max[2]);
    return id;
  }
  /** Moves an obstacle; false when there is none. The tiles of both places rebuild. */
  moveObstacle(id: number, box: NavObstacle): boolean {
    this.checkLevel();
    if (!this.obstacles.has(id)) return false;
    validate([0, 0, 0, 1, 0, 0, 0, 0, 1], [0, 1, 2], { obstacles: [box] }, false);
    this.removeObstacle(id);
    this.obstacles.set(id, box);
    this.touch(box.min[0], box.min[2], box.max[0], box.max[2]);
    return true;
  }
  /** Removes an obstacle (an opened door); false when there is none. */
  removeObstacle(id: number): boolean {
    this.checkLevel();
    const box = this.obstacles.get(id);
    if (!box) return false;
    this.obstacles.delete(id);
    this.touch(box.min[0], box.min[2], box.max[0], box.max[2]);
    return true;
  }

  /** Tiles waiting for {@link TiledNavMesh.update}. */
  get pendingTiles(): number {
    return this.dirty.size;
  }
  /**
   * Rebuilds up to `maxTiles` waiting tiles, oldest first, and returns how many it rebuilt. Spread a big change over
   * frames with a small `maxTiles`; a tile still waiting keeps its old polygons.
   */
  update(maxTiles = Infinity): number {
    this.check();
    if (!(maxTiles >= 0)) throw new RangeError('update needs a tile count of 0 or more');
    let done = 0;
    const links = [...this.offMesh.entries()];
    for (const tile of this.dirty) {
      if (done >= maxTiles) break;
      this.dirty.delete(tile);
      if (!done) for (const [id, link] of links) this.detach(id, link);
      this.rebuild(tile);
      done++;
    }
    if (done) {
      for (const [id, link] of links) this.attach(id, link);
      this.search.reserve(this.count, this.linkTotal);
      this.changes++;
    }
    return done;
  }
  /** What a tile's cells hold: the polygons, or null. A subclass may take them from elsewhere. */
  protected solveTile(tile: Tile): Built | null {
    let size = 0;
    for (const geometry of tile.geometry) size += (geometry.tiles.get(tile) as number[]).length;
    if (!size) return null;
    const points = new Float32Array(size * 9),
      triangles = new Uint32Array(size * 3);
    let at = 0;
    for (const geometry of tile.geometry)
      for (const t of geometry.tiles.get(tile) as number[])
        for (let k = 0; k < 3; k++, at++) {
          const v = geometry.triangles[t + k] * 3;
          points[at * 3] = geometry.points[v];
          points[at * 3 + 1] = geometry.points[v + 1];
          points[at * 3 + 2] = geometry.points[v + 2];
          triangles[at] = at;
        }
    const grid = this.gridOf(tile),
      x0 = this.origin[0] + grid.cx * this.config.cs,
      z0 = this.origin[2] + grid.cz * this.config.cs,
      x1 = x0 + grid.width * this.config.cs,
      z1 = z0 + grid.depth * this.config.cs,
      obstacles = [...this.obstacles.values()].filter(
        (box) => box.max[0] >= x0 && box.min[0] <= x1 && box.max[2] >= z0 && box.min[2] <= z1,
      ),
      built = solve(points, triangles, { ...this.config, obstacles }, grid);
    return typeof built === 'string' ? null : built;
  }
  /** The voxel grid of a tile: its cells and the margin around them. */
  protected gridOf(tile: { x: number; z: number }): Grid {
    const size = this.tileSize,
      margin = this.margin;
    return {
      width: size + 2 * margin,
      depth: size + 2 * margin,
      ox: this.origin[0],
      oy: this.origin[1],
      oz: this.origin[2],
      cx: tile.x * size - margin,
      cz: tile.z * size - margin,
      keep: [margin, margin, margin + size - 1, margin + size - 1],
      floor: -Infinity,
    };
  }
  private rebuild(tile: Tile): void {
    this.clear(tile);
    const built = this.solveTile(tile);
    if (built) this.install(tile, built.mesh, built.maxRise);
    else if (!tile.geometry.size) this.tiles.delete(`${tile.x},${tile.z}`);
  }
  /** Takes a tile's polygons out of the graph. */
  private clear(tile: Tile): void {
    for (const [dx, dz] of SIDES) {
      const other = this.tileAt(tile.x + dx, tile.z + dz);
      if (!other) continue;
      for (const id of other.ids) {
        const links = this.adjacency[id],
          kept = links.filter((link) => this.owners[link.to] !== tile);
        this.linkTotal -= links.length - kept.length;
        this.adjacency[id] = kept;
      }
    }
    for (const id of tile.ids) {
      this.linkTotal -= this.adjacency[id].length;
      this.adjacency[id] = [];
      this.owners[id] = null;
      this.free.push(id);
    }
    tile.ids = NONE;
    tile.mesh = null;
    tile.sides = [[], [], [], []];
  }
  private allocate(): number {
    const id = this.free.length ? (this.free.pop() as number) : this.count++;
    if (id >= this.locals.length) {
      const locals = new Int32Array(id * 2),
        costs = new Float64Array(id * 2).fill(1),
        areas = new Uint8Array(id * 2);
      locals.set(this.locals);
      costs.set(this.costs);
      areas.set(this.polygonAreas);
      this.locals = locals;
      this.costs = costs;
      this.polygonAreas = areas;
    }
    return id;
  }
  /** Puts a tile's polygons into the graph and links them to the tiles around it. */
  protected install(tile: Tile, mesh: NavMesh, rise: number): void {
    const count = mesh.polygonCount,
      ids = new Int32Array(count),
      { cs } = this.config,
      x0 = this.origin[0] + tile.x * this.tileSize * cs,
      x1 = this.origin[0] + (tile.x + 1) * this.tileSize * cs,
      z0 = this.origin[2] + tile.z * this.tileSize * cs,
      z1 = this.origin[2] + (tile.z + 1) * this.tileSize * cs;
    for (let p = 0; p < count; p++) {
      const id = (ids[p] = this.allocate());
      this.owners[id] = tile;
      this.locals[id] = p;
      this.polygonAreas[id] = mesh.polygonArea(p);
      this.centers[id] = mesh.polygonCenter(p);
    }
    for (let p = 0; p < count; p++) {
      const links = mesh.polygonLinks(p).map((link: NavLink) => ({ ...link, to: ids[link.to] }));
      this.adjacency[ids[p]] = links;
      this.linkTotal += links.length;
      const vertices = mesh.polygonVertices(p);
      for (let i = 0; i < vertices.length; i++) {
        const a = mesh.vertices[vertices[i]],
          b = mesh.vertices[vertices[(i + 1) % vertices.length]],
          edge = { polygon: ids[p], a, b };
        if (a[0] === x0 && b[0] === x0) tile.sides[0].push(edge);
        else if (a[0] === x1 && b[0] === x1) tile.sides[1].push(edge);
        else if (a[2] === z0 && b[2] === z0) tile.sides[2].push(edge);
        else if (a[2] === z1 && b[2] === z1) tile.sides[3].push(edge);
      }
    }
    tile.mesh = mesh;
    tile.ids = ids;
    tile.rise = rise;
    SIDES.forEach(([dx, dz, answer], side) => {
      const other = this.tileAt(tile.x + dx, tile.z + dz);
      if (other?.mesh) this.stitch(tile.sides[side], other.sides[answer], dx !== 0 ? 2 : 0, tile.rise, other.rise);
    });
  }
  /** Links every pair of edges on one tile line that overlap along `axis` at walkable heights. */
  private stitch(mine: Edge[], theirs: Edge[], axis: number, rise: number, otherRise: number): void {
    const { walkableClimb, ch } = this.config,
      step = (walkableClimb + Math.max(rise, otherRise) + 1) * ch,
      height = (edge: Edge, at: number) =>
        edge.a[1] + ((at - edge.a[axis]) / (edge.b[axis] - edge.a[axis])) * (edge.b[1] - edge.a[1]),
      place = (edge: Edge, at: number): Vec3 => {
        const p: [number, number, number] = [edge.a[0], height(edge, at), edge.a[2]];
        p[axis] = at;
        return p;
      };
    for (const one of mine)
      for (const two of theirs) {
        const low = Math.max(Math.min(one.a[axis], one.b[axis]), Math.min(two.a[axis], two.b[axis])),
          high = Math.min(Math.max(one.a[axis], one.b[axis]), Math.max(two.a[axis], two.b[axis]));
        if (high - low < 1e-9) continue;
        if (Math.abs(height(one, low) - height(two, low)) > step) continue;
        if (Math.abs(height(one, high) - height(two, high)) > step) continue;
        for (const [from, to] of [
          [one, two],
          [two, one],
        ]) {
          const p = place(from, low),
            q = place(from, high),
            leftFirst = cross(this.centers[from.polygon], p, q) < 0;
          this.adjacency[from.polygon].push({
            to: to.polygon,
            left: leftFirst ? p : q,
            right: leftFirst ? q : p,
          });
          this.linkTotal++;
        }
      }
  }

  /** Number of polygons in all tiles. */
  get polygonCount(): number {
    return this.count - this.free.length;
  }
  /** Counts changes that can change a route (rebuilt tiles, off-mesh links), so a crowd knows to plan again. */
  get version(): number {
    return this.changes;
  }
  /** The tiles that exist, in no set order. */
  *tileList(): IterableIterator<NavTile> {
    for (const { x, z, mesh } of this.tiles.values()) yield { x, z, mesh };
  }
  /** Tile at column `x`, row `z`, or null. */
  tile(x: number, z: number): NavTile | null {
    const tile = this.tileAt(x, z);
    return tile ? { x, z, mesh: tile.mesh } : null;
  }
  private owner(index: number): Tile {
    const tile = Number.isInteger(index) ? this.owners[index] : null;
    if (!tile) throw new RangeError(`Polygon ${index} does not exist; find a current one with locate.`);
    return tile;
  }
  /** Centre of polygon `index`. */
  polygonCenter(index: number): Vec3 {
    this.owner(index);
    return copy(this.centers[index]);
  }
  /** The ways out of polygon `index`, across tile lines too. Read only. */
  polygonLinks(index: number): readonly NavLink[] {
    this.owner(index);
    return this.adjacency[index];
  }
  /** Area number of polygon `index`, for route filters. */
  polygonArea(index: number): number {
    this.owner(index);
    return this.polygonAreas[index];
  }
  /** Height of polygon `index`'s plane at (x, z). */
  heightAt(index: number, x: number, z: number): number {
    return (this.owner(index).mesh as NavMesh).heightAt(this.locals[index], x, z);
  }
  /**
   * Polygon containing `position` in XZ, the vertically nearest when several overlap, or -1.
   * @throws RangeError when `position` is not a finite 3D point.
   */
  locate(position: Vec3): number {
    point(position);
    const fx = (position[0] - this.origin[0]) / this.span,
      fz = (position[2] - this.origin[2]) / this.span;
    let best = -1,
      gap = Infinity;
    // A point on a tile line may stand in either tile.
    for (let z = Math.floor(fz - 1e-9); z <= Math.floor(fz + 1e-9); z++)
      for (let x = Math.floor(fx - 1e-9); x <= Math.floor(fx + 1e-9); x++) {
        const tile = this.tileAt(x, z),
          local = tile?.mesh ? tile.mesh.locate(position) : -1;
        if (local < 0) continue;
        const delta = Math.abs((tile as Tile).mesh!.heightAt(local, position[0], position[2]) - position[1]);
        if (delta < gap) {
          gap = delta;
          best = (tile as Tile).ids[local];
        }
      }
    return best;
  }
  /**
   * The point of the mesh nearest to `position` (by XZ distance, then height), with its polygon. Null for an empty
   * mesh. Tiles are searched outward in rings from the one under the point.
   */
  closestPoint(position: Vec3): { point: Vec3; polygon: number } | null {
    const inside = this.locate(position);
    if (inside >= 0)
      return { point: [position[0], this.heightAt(inside, position[0], position[2]), position[2]], polygon: inside };
    const cx = Math.floor((position[0] - this.origin[0]) / this.span),
      cz = Math.floor((position[2] - this.origin[2]) / this.span);
    let far = 0;
    for (const tile of this.tiles.values())
      if (tile.mesh) far = Math.max(far, Math.abs(tile.x - cx), Math.abs(tile.z - cz));
    let best: { point: Vec3; polygon: number } | null = null,
      bestDistance = Infinity;
    const visit = (x: number, z: number) => {
      const tile = this.tileAt(x, z),
        found = tile?.mesh?.closestPoint(position);
      if (!found) return;
      const d =
        (found.point[0] - position[0]) ** 2 +
        (found.point[2] - position[2]) ** 2 +
        1e-6 * (found.point[1] - position[1]) ** 2;
      if (d < bestDistance) {
        bestDistance = d;
        best = { point: found.point, polygon: (tile as Tile).ids[found.polygon] };
      }
    };
    for (let ring = 0; ring <= far; ring++) {
      if (best && ((ring - 1) * this.span) ** 2 > bestDistance) break;
      for (let i = -ring; i <= ring; i++) {
        visit(cx + i, cz - ring);
        if (ring) visit(cx + i, cz + ring);
      }
      for (let i = 1 - ring; i < ring; i++) {
        visit(cx - ring, cz + i);
        visit(cx + ring, cz + i);
      }
    }
    return best;
  }
  /** Waypoints from `start` to `end`, including both, or null when an end is off the mesh or no route connects them. */
  path(start: Vec3, end: Vec3, filter?: NavFilter): Vec3[] | null {
    return this.route(start, end, filter)?.points ?? null;
  }
  /** {@link TiledNavMesh.path} with the off-mesh crossings marked, as `NavMesh.route`. */
  route(start: Vec3, end: Vec3, filter?: NavFilter): NavRoute | null {
    this.check();
    const from = this.locate(start),
      to = this.locate(end),
      costs = filter ? this.applyFilter(filter) : this.costs;
    if (from < 0 || to < 0 || !(costs[to] < Infinity)) return null;
    if (from === to) return { points: [copy(start), copy(end)], offMesh: [] };
    const corridor = this.search.find(from, to, start, end, this.count, this.adjacency, costs);
    return corridor && routeThrough(corridor, start, end);
  }
  private applyFilter(filter: NavFilter): Float64Array {
    checkFilter(filter);
    if (this.filtered.length < this.count) this.filtered = new Float64Array(this.costs.length);
    const costs = this.filtered,
      areas = this.polygonAreas;
    for (let p = 0; p < this.count; p++) costs[p] = this.costs[p] * (filter[areas[p]] ?? 1);
    return costs;
  }
  /**
   * Adds an off-mesh link (a jump, a ladder); it is put back after a tile under it rebuilds, and sleeps while an end
   * has no polygon. Returns its id.
   * @throws RangeError when an end is not above or below a polygon now, or the cost is negative.
   */
  addOffMeshLink(start: Vec3, end: Vec3, options: OffMeshLinkOptions = {}): number {
    this.check();
    const cost = options.cost ?? distance(start, end);
    if (this.locate(start) < 0 || this.locate(end) < 0)
      throw new RangeError('Off-mesh link ends must be on the navmesh; move start and end onto walkable polygons.');
    if (!(cost >= 0 && cost < Infinity))
      throw new RangeError('Off-mesh link cost must be a finite number of 0 or more.');
    const id = this.nextId++,
      link: OffMesh = {
        start: copy(start),
        end: copy(end),
        bidirectional: options.bidirectional ?? true,
        cost,
        from: -1,
        to: -1,
      };
    this.offMesh.set(id, link);
    this.attach(id, link);
    this.search.reserve(this.count, this.linkTotal);
    this.changes++;
    return id;
  }
  /** Removes an off-mesh link; false when there is none. */
  removeOffMeshLink(id: number): boolean {
    this.check();
    const link = this.offMesh.get(id);
    if (!link) return false;
    this.detach(id, link);
    this.offMesh.delete(id);
    this.changes++;
    return true;
  }
  private attach(id: number, link: OffMesh): void {
    link.from = this.locate(link.start);
    link.to = this.locate(link.end);
    if (link.from < 0 || link.to < 0) {
      link.from = link.to = -1;
      return;
    }
    const add = (a: number, b: number, s: Vec3, e: Vec3) => {
      this.adjacency[a].push({
        to: b,
        left: copy(s),
        right: copy(s),
        cost: link.cost,
        offMesh: id,
        start: copy(s),
        end: copy(e),
      });
      this.linkTotal++;
    };
    add(link.from, link.to, link.start, link.end);
    if (link.bidirectional) add(link.to, link.from, link.end, link.start);
  }
  private detach(id: number, link: OffMesh): void {
    if (link.from < 0) return;
    for (const polygon of [link.from, link.to]) {
      const links = this.adjacency[polygon],
        kept = links.filter((item) => item.offMesh !== id);
      this.linkTotal -= links.length - kept.length;
      this.adjacency[polygon] = kept;
    }
    link.from = link.to = -1;
  }
  /** World units along a tile's side. */
  get tileSpan(): number {
    return this.span;
  }
  /** @internal The polygon graph, for `./hierarchy` and `./debug`; live arrays, read only. */
  graph(filter?: NavFilter): {
    count: number;
    adjacency: readonly (readonly Link[])[];
    costs: ArrayLike<number>;
    owners: readonly ({ x: number; z: number } | null)[];
  } {
    this.check();
    return {
      count: this.count,
      adjacency: this.adjacency,
      costs: filter ? this.applyFilter(filter) : this.costs,
      owners: this.owners,
    };
  }
  /** @internal Everything `./codec` saves, with the level when `level` is set. */
  snapshot(level: boolean): TiledState {
    this.check();
    const { obstacles: _, ...settings } = this.config,
      tiles: TiledState['tiles'] = [];
    for (const { x, z, mesh, rise } of this.tiles.values()) if (mesh) tiles.push({ x, z, rise, mesh });
    return {
      settings: { ...settings, tileSize: this.tileSize },
      origin: this.origin,
      nextId: this.nextId,
      tiles,
      pending: [...this.dirty].map((tile) => [tile.x, tile.z]),
      links: [...this.offMesh].map(([id, { start, end, cost, bidirectional }]) => ({
        id,
        start,
        end,
        cost,
        bidirectional,
      })),
      level: level
        ? {
            obstacles: [...this.obstacles].map(([id, box]) => ({ id, box })),
            geometry: [...this.geometries].map(([id, { points, triangles }]) => ({ id, points, triangles })),
          }
        : null,
    };
  }
  /** @internal Fills a mesh made empty from a {@link TiledNavMesh.snapshot}; ids stay as they were. */
  restore(state: TiledState): void {
    if (state.level) {
      for (const { id, box } of state.level.obstacles) this.obstacles.set(id, box);
      for (const { id, points, triangles } of state.level.geometry) this.addParsed(points, triangles, id);
      this.dirty.clear();
    } else this.fixed = true;
    for (const { x, z, mesh, rise } of state.tiles) this.install(this.ensureTile(x, z), mesh, rise);
    if (state.level)
      for (const [x, z] of state.pending) {
        const tile = this.tileAt(x, z);
        if (tile) this.dirty.add(tile);
      }
    for (const { id, start, end, cost, bidirectional } of state.links) {
      const link: OffMesh = { start, end, bidirectional, cost, from: -1, to: -1 };
      this.offMesh.set(id, link);
      this.attach(id, link);
    }
    this.nextId = state.nextId;
    this.search.reserve(this.count, this.linkTotal);
    this.changes++;
  }
  /** Drops the tiles. Idempotent. */
  dispose(): void {
    this.disposed = true;
    this.tiles.clear();
    this.dirty.clear();
    this.geometries.clear();
    this.adjacency.length = 0;
    this.centers.length = 0;
    this.owners.length = 0;
    this.free.length = 0;
    this.count = 0;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
