// Jump links found from the level. The jump model is that of M. van de Kerkhof, "Automated generation of jump links for
// navigation meshes" (MSc thesis, Utrecht University, 2016): a fixed height h and distance d give one parabolic arc
// (Definition 4.3), a jump lands on the way down (Definition 4.4), and it is valid when it lands, touches nothing and
// lands within a fall of m below the apex (Definition 4.5). Margo samples the mesh edges, tests the agent's cylinder
// against the level's triangles exactly at each step, and keeps point to point links.
import type { NavMesh, NavSurface, Vec3 } from './index.js';
import { validate } from './pipeline.js';
import { distance } from './search.js';
import type { TiledNavMesh } from './tiles.js';

/** One jump an agent can make (van de Kerkhof, Definition 4.2), world units. */
export interface JumpSetting {
  /** How far it rises above where it left. */
  height: number;
  /** How far it travels before it is back at the height it left. */
  distance: number;
}

/** Options of {@link findJumpLinks}, world units. */
export interface JumpLinkOptions {
  /** Body radius. Default 0.5. */
  radius?: number;
  /** Body height. Default 2. */
  height?: number;
  /** Highest step the agent walks up. Near both ends of a jump the body clears the ground by this. Default 0.4. */
  climb?: number;
  /** The jumps it can make. Default a leap `{height: 1, distance: 4}` and a hop down `{height: 0.25, distance: 1.5}`. */
  jumps?: readonly JumpSetting[];
  /** Furthest it may fall, measured from the top of the arc. Default 6. */
  maxFall?: number;
  /** Space between takeoff samples along a mesh edge, and the size of the cells links are thinned in. Default 1. */
  spacing?: number;
  /** Directions tried at each sample, fanned 160 degrees around the way out of the mesh. Default 9. */
  directions?: number;
  /** What a jump costs on top of the distance it covers, as metres of walking. Default 1. */
  jumpCost?: number;
}

/** A jump found by {@link findJumpLinks}. */
export interface JumpLink {
  /** Where the agent leaves the ground. */
  start: Vec3;
  /** Where it lands. */
  end: Vec3;
  /** Route cost: the distance covered plus `jumpCost`. */
  cost: number;
  /** `across` keeps within `climb` of the height it left; `down` and `up` land lower or higher. */
  kind: 'across' | 'down' | 'up';
  /** The arc's {@link JumpSetting.height}. */
  height: number;
  /** The arc's {@link JumpSetting.distance}. */
  distance: number;
}

/** Items by the cells of an XZ grid of at most 256 cells a side. */
class Bins {
  private readonly size: number;
  private readonly columns: number;
  private readonly rows: number;
  private readonly cells: (number[] | undefined)[];
  constructor(
    private readonly x: number,
    private readonly z: number,
    x1: number,
    z1: number,
    smallest: number,
  ) {
    this.size = Math.max(smallest, Math.max(x1 - x, z1 - z) / 256);
    this.columns = Math.floor((x1 - x) / this.size) + 1;
    this.rows = Math.floor((z1 - z) / this.size) + 1;
    this.cells = new Array(this.columns * this.rows);
  }
  private column(x: number): number {
    return Math.min(this.columns - 1, Math.max(0, Math.floor((x - this.x) / this.size)));
  }
  private row(z: number): number {
    return Math.min(this.rows - 1, Math.max(0, Math.floor((z - this.z) / this.size)));
  }
  add(item: number, x0: number, z0: number, x1: number, z1: number): void {
    for (let r = this.row(z0), last = this.row(z1); r <= last; r++)
      for (let c = this.column(x0), end = this.column(x1); c <= end; c++)
        (this.cells[r * this.columns + c] ??= []).push(item);
  }
  /** Calls `visit` for what the box reaches, an item once per cell; stops when it returns true. */
  some(x0: number, z0: number, x1: number, z1: number, visit: (item: number) => boolean): boolean {
    for (let r = this.row(z0), last = this.row(z1); r <= last; r++)
      for (let c = this.column(x0), end = this.column(x1); c <= end; c++) {
        const cell = this.cells[r * this.columns + c];
        if (cell) for (const item of cell) if (visit(item)) return true;
      }
    return false;
  }
}

/** The level's triangles, to test a standing cylinder against. */
class Solids {
  private readonly bins: Bins;
  // Scratch: the triangle cut to the cylinder's height, as x, y, z.
  private cut = new Float64Array(24);
  private next = new Float64Array(24);
  constructor(
    private readonly points: Float32Array,
    private readonly triangles: Uint32Array,
    min: ArrayLike<number>,
    max: ArrayLike<number>,
    cell: number,
  ) {
    this.bins = new Bins(min[0], min[2], max[0], max[2], cell);
    for (let t = 0; t < triangles.length; t += 3) {
      const a = triangles[t] * 3,
        b = triangles[t + 1] * 3,
        c = triangles[t + 2] * 3;
      this.bins.add(
        t,
        Math.min(points[a], points[b], points[c]),
        Math.min(points[a + 2], points[b + 2], points[c + 2]),
        Math.max(points[a], points[b], points[c]),
        Math.max(points[a + 2], points[b + 2], points[c + 2]),
      );
    }
  }
  /** Keeps the part of the `count` point polygon in `cut` on one side of the height `y`; returns its new count. */
  private clip(count: number, y: number, above: boolean): number {
    const from = this.cut,
      to = this.next;
    let size = 0;
    for (let i = 0; i < count; i++) {
      const a = i * 3,
        b = ((i + 1) % count) * 3,
        da = above ? from[a + 1] - y : y - from[a + 1],
        db = above ? from[b + 1] - y : y - from[b + 1];
      if (da >= 0) {
        to[size * 3] = from[a];
        to[size * 3 + 1] = from[a + 1];
        to[size * 3 + 2] = from[a + 2];
        size++;
      }
      if (da >= 0 !== db >= 0) {
        const f = da / (da - db);
        to[size * 3] = from[a] + (from[b] - from[a]) * f;
        to[size * 3 + 1] = y;
        to[size * 3 + 2] = from[a + 2] + (from[b + 2] - from[a + 2]) * f;
        size++;
      }
    }
    this.cut = to;
    this.next = from;
    return size;
  }
  /** Does the triangle at `t` reach the upright cylinder around (x, z) from `low` to `high`? */
  private touches(t: number, x: number, z: number, low: number, high: number, radius: number): boolean {
    const { points, triangles } = this;
    for (let k = 0; k < 3; k++) {
      const v = triangles[t + k] * 3;
      this.cut[k * 3] = points[v];
      this.cut[k * 3 + 1] = points[v + 1];
      this.cut[k * 3 + 2] = points[v + 2];
    }
    let count = this.clip(3, low, true);
    if (count) count = this.clip(count, high, false);
    if (!count) return false;
    const cut = this.cut;
    let positive = false,
      negative = false,
      nearest = Infinity;
    for (let i = 0; i < count; i++) {
      const ax = cut[i * 3],
        az = cut[i * 3 + 2],
        j = ((i + 1) % count) * 3,
        ex = cut[j] - ax,
        ez = cut[j + 2] - az,
        side = ex * (z - az) - ez * (x - ax),
        length = ex * ex + ez * ez,
        f = length > 0 ? Math.min(1, Math.max(0, ((x - ax) * ex + (z - az) * ez) / length)) : 0;
      if (side > 0) positive = true;
      else if (side < 0) negative = true;
      nearest = Math.min(nearest, (ax + ex * f - x) ** 2 + (az + ez * f - z) ** 2);
    }
    return positive !== negative || nearest <= radius * radius;
  }
  /** Does any triangle reach the upright cylinder around (x, z)? */
  hit(x: number, z: number, low: number, high: number, radius: number): boolean {
    return this.bins.some(x - radius, z - radius, x + radius, z + radius, (t) =>
      this.touches(t, x, z, low, high, radius),
    );
  }
}

interface Place {
  mesh: NavMesh;
  polygon: number;
  /** Corners as x, z. */
  corners: Float64Array;
  sign: number;
}

/** The walkable polygons of every tile, to find the ground under a point. */
class Ground {
  private readonly bins: Bins;
  constructor(
    readonly places: readonly Place[],
    cell: number,
  ) {
    let x0 = Infinity,
      z0 = Infinity,
      x1 = -Infinity,
      z1 = -Infinity;
    const boxes = places.map(({ corners }) => {
      let a = Infinity,
        b = Infinity,
        c = -Infinity,
        d = -Infinity;
      for (let i = 0; i < corners.length; i += 2) {
        a = Math.min(a, corners[i]);
        b = Math.min(b, corners[i + 1]);
        c = Math.max(c, corners[i]);
        d = Math.max(d, corners[i + 1]);
      }
      x0 = Math.min(x0, a);
      z0 = Math.min(z0, b);
      x1 = Math.max(x1, c);
      z1 = Math.max(z1, d);
      return [a, b, c, d];
    });
    this.bins = new Bins(x0, z0, x1, z1, cell);
    boxes.forEach(([a, b, c, d], i) => this.bins.add(i, a, b, c, d));
  }
  /** The place under (x, z) vertically nearest to `y`, or -1. */
  under(x: number, y: number, z: number): number {
    let best = -1,
      gap = Infinity;
    this.bins.some(x, z, x, z, (i) => {
      const { corners, sign, mesh, polygon } = this.places[i];
      for (let a = 0, n = corners.length; a < n; a += 2) {
        const b = (a + 2) % n;
        if (
          ((corners[b] - corners[a]) * (z - corners[a + 1]) - (corners[b + 1] - corners[a + 1]) * (x - corners[a])) *
            sign <
          -1e-8
        )
          return false;
      }
      const delta = Math.abs(mesh.heightAt(polygon, x, z) - y);
      if (delta < gap) {
        gap = delta;
        best = i;
      }
      return false;
    });
    return best;
  }
  /** Height of the place `i` at (x, z). */
  height(i: number, x: number, z: number): number {
    const { mesh, polygon } = this.places[i];
    return mesh.heightAt(polygon, x, z);
  }
}

function placesOf(surface: NavMesh | TiledNavMesh): Place[] {
  const meshes: NavMesh[] = [];
  if ('tileList' in surface) {
    for (const { mesh } of surface.tileList()) if (mesh) meshes.push(mesh);
  } else meshes.push(surface);
  const places: Place[] = [];
  for (const mesh of meshes)
    for (let polygon = 0; polygon < mesh.polygonCount; polygon++) {
      const vertices = mesh.polygonVertices(polygon),
        corners = new Float64Array(vertices.length * 2);
      vertices.forEach((v, i) => {
        corners[i * 2] = mesh.vertices[v][0];
        corners[i * 2 + 1] = mesh.vertices[v][2];
      });
      let area = 0;
      for (let a = 0, n = corners.length; a < n; a += 2) {
        const b = (a + 2) % n;
        area += corners[a] * corners[b + 1] - corners[b] * corners[a + 1];
      }
      places.push({ mesh, polygon, corners, sign: area < 0 ? -1 : 1 });
    }
  return places;
}

function positive(value: number, name: string): void {
  if (!(value > 0 && value < Infinity)) throw new RangeError(`Jump ${name} must be finite and above 0; pass a length.`);
}

/**
 * Finds the jumps an agent can make from the level: across gaps, down ledges and up to what it can reach. Each is
 * checked with the agent's whole body along the arc, and a jump that saves no walking is dropped.
 * `positions` and `indices` are the level the mesh was built from; an agent's body is tested against them, so pass
 * anything else solid too. Run it again after a level change.
 * @param surface The mesh to link up.
 * @param positions Flat xyz positions (Y up).
 * @param indices Flat triangle indices into `positions`.
 * @throws RangeError for invalid geometry or options.
 */
export function findJumpLinks(
  surface: NavMesh | TiledNavMesh,
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  options: JumpLinkOptions = {},
): JumpLink[] {
  const {
    radius = 0.5,
    height = 2,
    climb = 0.4,
    jumps = [
      { height: 1, distance: 4 },
      { height: 0.25, distance: 1.5 },
    ],
    maxFall = 6,
    spacing = 1,
    directions = 9,
    jumpCost = 1,
  } = options ?? {};
  positive(radius, 'radius');
  positive(height, 'height');
  positive(maxFall, 'maxFall');
  positive(spacing, 'spacing');
  if (!(climb >= 0 && climb < Infinity))
    throw new RangeError('Jump climb must be finite and 0 or more; pass a height.');
  if (!(jumpCost >= 0 && jumpCost < Infinity))
    throw new RangeError('Jump cost must be finite and 0 or more; pass a distance of walking.');
  if (!Number.isInteger(directions) || directions < 1 || directions > 64)
    throw new RangeError('Jump directions must be a whole number from 1 to 64; pass a count.');
  if (!jumps.length) throw new RangeError('Jump settings must not be empty; pass at least one {height, distance}.');
  for (const jump of jumps) {
    positive(jump.height, 'height');
    positive(jump.distance, 'distance');
  }
  const { points, triangles, min, max } = validate(positions, indices, {}, false),
    solids = new Solids(points, triangles, min, max, radius * 4),
    ground = new Ground(placesOf(surface), spacing),
    lift = Math.max(climb, 1e-3),
    probe = Math.min(radius, spacing) / 8,
    found = new Map<string, JumpLink>();

  /** Is the body clear all along the arc from takeoff to `end` along it? */
  const clear = (s: Vec3, dx: number, dz: number, arc: (t: number) => number, end: number, step: number) => {
    for (let t = step; ; t += step) {
      const at = Math.min(t, end),
        y = arc(at),
        low = at < radius * 2 || end - at < radius * 2 ? y + lift : y;
      if (solids.hit(s[0] + dx * at, s[2] + dz * at, low, y + height, radius)) return false;
      if (at === end) return true;
    }
  };

  /** Follows one jump from `s` to where it lands (Definition 4.4) and files it when it is valid (Definition 4.5). */
  const leap = (s: Vec3, dx: number, dz: number, jump: JumpSetting, cell: string) => {
    const { height: h, distance: d } = jump,
      reach = (d / 2) * (1 + Math.sqrt(maxFall / h)),
      step = Math.min(radius / 2, d / 16),
      arc = (t: number) => s[1] + ((4 * h) / (d * d)) * (d * t - t * t);
    for (let t = d / 2; ; t += step) {
      const at = Math.min(t, reach),
        x = s[0] + dx * at,
        z = s[2] + dz * at,
        y = arc(at),
        place = ground.under(x, y, z),
        floor = place < 0 ? y - 1 : ground.height(place, x, z);
      if (place >= 0 && y <= floor && floor <= s[1] + h && floor - y <= Math.max(climb, arc(at - step) - y)) {
        // The arc crossed this ground within the step: find where, from Equation 1.
        const exact = (d / 2) * (1 + Math.sqrt(Math.max(0, 1 - (floor - s[1]) / h))),
          ex = s[0] + dx * exact,
          ez = s[2] + dz * exact,
          again = exact > at - step && exact <= at ? ground.under(ex, floor, ez) : -1,
          land = again >= 0 ? exact : at,
          spot = again >= 0 ? again : place,
          lx = s[0] + dx * land,
          lz = s[2] + dz * land,
          end = [lx, ground.height(spot, lx, lz), lz] as unknown as Vec3;
        if (land <= reach && clear(s, dx, dz, arc, land, step)) {
          const rise = end[1] - s[1],
            kind = rise > climb ? 'up' : rise < -climb ? 'down' : 'across',
            cost = distance(s, end) + jumpCost,
            key = `${cell},${spot},${kind}`,
            known = found.get(key);
          if (!known || cost < known.cost) found.set(key, { start: s, end, cost, kind, height: h, distance: d });
        }
        return;
      }
      if (at === reach) return;
    }
  };

  for (const { mesh, polygon, corners } of ground.places) {
    const center = mesh.polygonCenter(polygon);
    for (let a = 0, n = corners.length; a < n; a += 2) {
      const b = (a + 2) % n,
        ax = corners[a],
        az = corners[a + 1],
        ex = corners[b] - ax,
        ez = corners[b + 1] - az,
        length = Math.hypot(ex, ez);
      if (!length) continue;
      // The way out of the mesh: square to the edge and away from the polygon's middle.
      const flip = ez * (center[0] - ax) - ex * (center[2] - az) > 0 ? -1 : 1,
        ox = (ez / length) * flip,
        oz = (-ex / length) * flip,
        samples = Math.ceil(length / spacing);
      for (let i = 0; i < samples; i++) {
        const f = (i + 0.5) / samples,
          px = ax + ex * f,
          pz = az + ez * f,
          sx = px - ox * 1e-3,
          sz = pz - oz * 1e-3,
          start = [sx, mesh.heightAt(polygon, sx, sz), sz] as unknown as Vec3,
          beyond = ground.under(px + ox * probe, start[1], pz + oz * probe);
        // An edge with ground beyond it at this height is a seam between polygons, not a way off the mesh.
        if (beyond >= 0 && Math.abs(ground.height(beyond, px + ox * probe, pz + oz * probe) - start[1]) <= climb)
          continue;
        const cell = `${Math.floor(px / spacing)},${Math.floor(pz / spacing)}`;
        // A body pressed against a wall cannot rise past it, so a jump up needs a run: try from further back too.
        for (const jump of jumps)
          for (const back of [0, jump.distance / 4, jump.distance / 2]) {
            const bx = sx - ox * back,
              bz = sz - oz * back,
              place = back ? ground.under(bx, start[1], bz) : -1,
              from = back ? ([bx, place < 0 ? 0 : ground.height(place, bx, bz), bz] as unknown as Vec3) : start;
            if (back && (place < 0 || Math.abs(from[1] - start[1]) > climb)) continue;
            for (let k = 0; k < directions; k++) {
              const turn = directions > 1 ? ((k / (directions - 1) - 0.5) * 160 * Math.PI) / 180 : 0,
                cos = Math.cos(turn),
                sin = Math.sin(turn);
              leap(from, ox * cos - oz * sin, ox * sin + oz * cos, jump, cell);
            }
          }
      }
    }
  }

  const kept: JumpLink[] = [];
  for (const link of found.values()) {
    if (surface.locate(link.start) < 0 || surface.locate(link.end) < 0) continue;
    const walk = surface.route(link.start, link.end)?.points;
    let length = walk ? 0 : Infinity;
    if (walk) for (let i = 1; i < walk.length; i++) length += distance(walk[i - 1], walk[i]);
    if (length > link.cost) kept.push(link);
  }
  return kept;
}

/** Adds links from {@link findJumpLinks} to the mesh, each one way, and returns their ids. */
export function addJumpLinks(
  surface: Pick<NavSurfaceWithLinks, 'addOffMeshLink'>,
  links: readonly JumpLink[],
): number[] {
  return links.map(({ start, end, cost }) => surface.addOffMeshLink(start, end, { cost, bidirectional: false }));
}

/** What {@link addJumpLinks} needs of a mesh. */
export interface NavSurfaceWithLinks extends NavSurface {
  addOffMeshLink(start: Vec3, end: Vec3, options?: { cost?: number; bidirectional?: boolean }): number;
}

/**
 * Where the agent is on a link's arc, `amount` 0 at the start to 1 at the landing: for playing the jump. The arc is the
 * parabola of the link's setting (van de Kerkhof, Equation 1).
 */
export function jumpPoint(link: JumpLink, amount: number): Vec3 {
  const { start, end, height: h, distance: d } = link,
    span = Math.hypot(end[0] - start[0], end[2] - start[2]),
    t = span * amount,
    rise = (span: number) => ((4 * h) / (d * d)) * (d * span - span * span),
    // Landing on a slope or within a step ends the arc a hair off the ground; closed linearly, so both ends are exact.
    miss = end[1] - start[1] - rise(span);
  return [
    start[0] + (end[0] - start[0]) * amount,
    start[1] + rise(t) + miss * amount,
    start[2] + (end[2] - start[2]) * amount,
  ] as unknown as Vec3;
}
