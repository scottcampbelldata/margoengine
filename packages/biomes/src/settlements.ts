// Villages, the roads between them and the lanes and houses inside them (entry `@margoengine/biomes/settlements`):
// sites on flat dry ground near water and below the heights, a road network that follows the terrain and the houses
// along each village's lanes, as plain data that /splines carves into the ground and paints, and placement exclusions
// that clear the trees and shrubs off them. Same world and options, same layout, on every machine: the decisions use
// only + - * / and square roots (correctly rounded in IEEE 754, so the same on every engine), integer hashes for the
// jitter, integer CORDIC for the lane angles and a heap that breaks every tie by cell index.
// Sources: roads as least-cost paths over a terrain grid whose step cost grows with the grade, with water crossings
// priced as bridges and existing roads cheaper to reuse, Galin, Peytavie, Marechal and Guerin, "Procedural Generation
// of Roads", Computer Graphics Forum (Eurographics) 2010; a network that joins settlements by a minimum spanning tree
// and adds a link where the tree's detour is long, after Galin, Peytavie, Guerin and Benes, "Authoring Hierarchical
// Road Networks", Computer Graphics Forum (Pacific Graphics) 2011; A* search, Hart, Nilsson and Raphael, IEEE
// Transactions on Systems Science and Cybernetics, 1968; Prim's spanning tree, Bell System Technical Journal, 1957;
// line simplification, Douglas and Peucker, The Canadian Cartographer, 1973; houses facing a street in lots along it,
// as in Parish and Muller, "Procedural Modeling of Cities", SIGGRAPH 2001. Our own layout from those descriptions.
import { rangeError, typeError } from '../../shared/errors.js';
import { hash2, hash3, sincos, TURN } from '@margoengine/biomes/toolkit';
import { pathExclusions, type PathOptions } from '@margoengine/biomes/splines';
import type { Exclusion } from './placement.js';

/** What {@link layoutSettlements} reads of a world. A `BiomeWorld` is one. */
export interface SettlementWorld {
  /** World rectangle `[x0, z0, x1, z1]` in metres. */
  readonly bounds: readonly [number, number, number, number];
  /** Ground height in metres at `(x, z)`. */
  heightAt(x: number, z: number): number;
  /** River centre lines in millimetres `[x0, z0, x1, z1, ...]` (`BiomeWorld.rivers`). Default none. */
  readonly rivers?: readonly Int32Array[];
  /** `climate.sea` is the sea level in millimetres (`BiomeWorld.climate`). Default 0. */
  readonly climate?: { readonly sea: number };
}

/** Settings of {@link layoutSettlements}. Every one has a default. */
export interface SettlementOptions {
  /** Seed of the site and house jitter, an integer 0..2^32-1. Default 1. */
  readonly seed?: number;
  /** Most villages, an integer 0..64. Fewer when the land has no more sites. Default 3. */
  readonly villages?: number;
  /**
   * Village centres `[x, z]` in metres, chosen by you instead of by the site search (snapped to the grid), up to 64,
   * each inside the world. Default none: the layout finds the sites.
   */
  readonly sites?: readonly (readonly [number, number])[];
  /** Least distance between village centres in metres, 50..100,000. Default 800. */
  readonly spacing?: number;
  /** Most houses a village, an integer 0..256. Default 16. */
  readonly houses?: number;
  /** Side of the terrain grid the sites and roads are found on, metres, 2..256. Default 16. */
  readonly cell?: number;
  /** Steepest grade a road takes without switchbacks, rise over run 0.02..1. Default 0.12. */
  readonly maxGrade?: number;
  /** Steepest grade under a village site or a house, rise over run 0.005..1. Default 0.08. */
  readonly siteGrade?: number;
  /** Cost of a road cell over a river, as a multiple of a dry one, 1..1,000: a bridge. Default 8. */
  readonly bridge?: number;
  /** A link outside the spanning tree is added where the tree's way is longer than this times the direct one, 1..100. Default 1.6. */
  readonly detour?: number;
  /** Path settings of the roads between villages (`points` aside). Default width 5, edge 3, Catmull-Rom, mask `'roads'`. */
  readonly road?: Omit<PathOptions, 'points'>;
  /** Path settings of the lanes inside a village. Default width 3, edge 1.5, polyline, mask `'roads'`. */
  readonly lane?: Omit<PathOptions, 'points'>;
  /** Yard kept clear around each house in metres, 0..100 (its exclusion verge). Default 4. */
  readonly yard?: number;
}

/** A house: a rectangle facing its lane. */
export interface House {
  /** Centre `[x, z]` in metres. */
  readonly centre: readonly [number, number];
  /** Width along the lane and depth away from it, metres. */
  readonly size: readonly [number, number];
  /** Unit direction `[x, z]` of the lane the house faces along (its width axis). */
  readonly along: readonly [number, number];
  /** Ground height under the centre, metres: where its floor goes. */
  readonly floor: number;
  /** The four corners `[x, z]` in metres, counter-clockwise seen from above. */
  readonly corners: readonly (readonly [number, number])[];
}

/** A village: a site, its lanes and its houses. */
export interface Village {
  /** Centre `[x, z]` in metres, on the site grid. */
  readonly centre: readonly [number, number];
  /** Ground height at the centre, metres. */
  readonly height: number;
  /** Radius its houses keep within, metres. */
  readonly radius: number;
  readonly houses: readonly House[];
}

/** A settlement layout: plain data. */
export interface Settlements {
  readonly villages: readonly Village[];
  /** Roads between villages, centre to centre, as /splines paths. */
  readonly roads: readonly PathOptions[];
  /** Lanes from each village centre out along its houses. */
  readonly lanes: readonly PathOptions[];
  /** Roads then lanes: for `carvePaths`, `paintPaths` and `pathEdits` (`@margoengine/biomes/splines`). */
  readonly paths: readonly PathOptions[];
  /** Roads, lanes (their edges as verges) and houses (their yards as verges) for `BiomePlacement.attach`. */
  readonly exclusions: readonly Exclusion[];
}

const MOST_CELLS = 1 << 22;
const SQRT2 = Math.SQRT2;
// Grade cost: a step costs its length times 1 + (grade / maxGrade)^2, and 20 times that past maxGrade (a switchback).
const STEEP = 20;
// A cell on a road already built costs this share: later roads join earlier ones.
const REUSE = 0.5;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const inRange = (v: unknown, lo: number, hi: number) => finite(v) && v >= lo && v <= hi;
const int = (v: unknown, lo: number, hi: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;

/** A binary heap of cells by cost, ties by the lower cell index, so every search visits cells in one order. */
class Heap {
  readonly cost: number[] = [];
  readonly cell: number[] = [];
  #less(i: number, j: number) {
    const a = this.cost[i],
      b = this.cost[j];
    return a < b || (a === b && this.cell[i] < this.cell[j]);
  }
  #swap(i: number, j: number) {
    [this.cost[i], this.cost[j]] = [this.cost[j], this.cost[i]];
    [this.cell[i], this.cell[j]] = [this.cell[j], this.cell[i]];
  }
  get size() {
    return this.cost.length;
  }
  push(cost: number, cell: number) {
    this.cost.push(cost);
    this.cell.push(cell);
    for (let i = this.cost.length - 1; i > 0; ) {
      const p = (i - 1) >> 1;
      if (!this.#less(i, p)) break;
      this.#swap(i, p);
      i = p;
    }
  }
  pop(): number {
    const top = this.cell[0],
      last = this.cost.length - 1;
    this.#swap(0, last);
    this.cost.pop();
    this.cell.pop();
    for (let i = 0; ; ) {
      const l = 2 * i + 1,
        r = l + 1;
      let m = i;
      if (l < last && this.#less(l, m)) m = l;
      if (r < last && this.#less(r, m)) m = r;
      if (m === i) break;
      this.#swap(i, m);
      i = m;
    }
    return top;
  }
}

function check(world: SettlementWorld, o: SettlementOptions) {
  if (!world || typeof world.heightAt !== 'function' || !Array.isArray(world.bounds) || world.bounds.length !== 4)
    throw typeError(
      'layoutSettlements needs a world with bounds [x0, z0, x1, z1] and heightAt(x, z), such as a BiomeWorld',
      'biomes',
    );
  const [x0, z0, x1, z1] = world.bounds;
  if (![x0, z0, x1, z1].every(finite) || !(x1 > x0) || !(z1 > z0))
    throw rangeError('layoutSettlements needs finite world bounds with x1 > x0 and z1 > z0', 'biomes');
  if (o === null || typeof o !== 'object') throw typeError('layoutSettlements options must be an object', 'biomes');
  const bad = (name: string, rule: string) => rangeError(`A settlement ${name} must be ${rule}`, 'biomes');
  if (o.seed !== undefined && !int(o.seed, 0, 4294967295)) throw bad('seed', 'an integer 0..2^32-1');
  if (o.villages !== undefined && !int(o.villages, 0, 64)) throw bad('villages count', 'an integer 0..64');
  if (
    o.sites !== undefined &&
    (!Array.isArray(o.sites) ||
      o.sites.length > 64 ||
      !o.sites.every((p) => Array.isArray(p) && p.length === 2 && inRange(p[0], x0, x1) && inRange(p[1], z0, z1)))
  )
    throw bad('sites list', 'up to 64 [x, z] points in metres inside the world bounds');
  if (o.spacing !== undefined && !inRange(o.spacing, 50, 100000))
    throw bad('spacing', 'a number of metres, 50..100,000');
  if (o.houses !== undefined && !int(o.houses, 0, 256)) throw bad('houses count', 'an integer 0..256');
  if (o.cell !== undefined && !inRange(o.cell, 2, 256)) throw bad('cell', 'a number of metres, 2..256');
  if (o.maxGrade !== undefined && !inRange(o.maxGrade, 0.02, 1)) throw bad('maxGrade', 'a rise over run, 0.02..1');
  if (o.siteGrade !== undefined && !inRange(o.siteGrade, 0.005, 1)) throw bad('siteGrade', 'a rise over run, 0.005..1');
  if (o.bridge !== undefined && !inRange(o.bridge, 1, 1000)) throw bad('bridge cost', 'a multiple 1..1,000');
  if (o.detour !== undefined && !inRange(o.detour, 1, 100)) throw bad('detour', 'a ratio 1..100');
  if (o.yard !== undefined && !inRange(o.yard, 0, 100)) throw bad('yard', 'a number of metres, 0..100');
  for (const k of ['road', 'lane'] as const)
    if (o[k] !== undefined && (o[k] === null || typeof o[k] !== 'object' || 'points' in o[k]!))
      throw typeError(`A settlement ${k} is path settings without points (the layout finds them)`, 'biomes');
}

/** Douglas-Peucker: keeps the points that stand more than `tolerance` off the line through their run's ends. */
function simplify(p: readonly (readonly [number, number])[], tolerance: number): [number, number][] {
  const keep = new Uint8Array(p.length);
  keep[0] = keep[p.length - 1] = 1;
  const stack = [0, p.length - 1];
  while (stack.length) {
    const b = stack.pop()!,
      a = stack.pop()!;
    const [ax, az] = p[a],
      dx = p[b][0] - ax,
      dz = p[b][1] - az,
      len = Math.sqrt(dx * dx + dz * dz);
    let far = -1,
      most = tolerance;
    for (let i = a + 1; i < b; i++) {
      const ex = p[i][0] - ax,
        ez = p[i][1] - az;
      const d = len > 0 ? Math.abs(ex * dz - ez * dx) / len : Math.sqrt(ex * ex + ez * ez); // float division: metres
      if (d > most) {
        most = d;
        far = i;
      }
    }
    if (far >= 0) {
      keep[far] = 1;
      stack.push(a, far, far, b);
    }
  }
  return p.filter((_, i) => keep[i]).map(([x, z]) => [x, z]);
}

/** Squared distance from `(x, z)` to the segment `a`-`b`. */
function segment2(x: number, z: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax,
    dz = bz - az,
    l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0; // float division: metres
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = x - ax - t * dx,
    ez = z - az - t * dz;
  return ex * ex + ez * ez;
}

/**
 * Lays out villages, roads, lanes and houses on a world. Sites are grid points on dry land (above sea level, off the
 * rivers) whose ground and its eight neighbours stay under `siteGrade`, scored by flatness, nearness to water (best
 * 30 to 400 m from a river or the coast) and lowness, with a small seeded jitter; the best ones at least `spacing`
 * apart become villages. The villages are joined by a minimum spanning tree plus the links whose tree detour passes
 * `detour`, shortest first, each one an A* least-cost path over the grid: a step costs its length times 1 +
 * (grade / maxGrade)^2, 20 times that past `maxGrade`, `bridge` times over a river, half on a road already built; the
 * sea is impassable. Each village's lanes leave along its roads and between them, and its houses take lots on both
 * sides of them, on ground under `siteGrade`, clear of water, the roads and each other.
 * @throws TypeError for a world without bounds and heightAt or bad path settings; RangeError for an option out of range
 * or a grid over 4,194,304 cells.
 * @example
 * const probe = await BiomeWorld.create();
 * const town = layoutSettlements(probe, { villages: 3 });
 * const world = await BiomeWorld.create({ height: carvePaths(town.paths) }); // roads flattened into the ground
 * const placement = BiomePlacement.attach(world, { exclusions: town.exclusions }); // no tree on a road or a house
 */
export function layoutSettlements(world: SettlementWorld, options: SettlementOptions = {}): Settlements {
  check(world, options);
  const seed = options.seed ?? 1,
    most = options.villages ?? 3,
    spacing = options.spacing ?? 800,
    perVillage = options.houses ?? 16,
    cell = options.cell ?? 16,
    maxGrade = options.maxGrade ?? 0.12,
    siteGrade = options.siteGrade ?? 0.08,
    bridge = options.bridge ?? 8,
    detour = options.detour ?? 1.6,
    yard = options.yard ?? 4;
  const road: Omit<PathOptions, 'points'> = { width: 5, edge: 3, curve: 'catmull-rom', mask: 'roads', ...options.road };
  const lane: Omit<PathOptions, 'points'> = { width: 3, edge: 1.5, mask: 'roads', ...options.lane };
  const [x0, z0, x1, z1] = world.bounds,
    sea = (world.climate?.sea ?? 0) / 1000; // float division: mm to metres
  const nx = Math.floor((x1 - x0) / cell) + 1, // float division: metres to cells
    nz = Math.floor((z1 - z0) / cell) + 1; // float division: metres to cells
  if (nx * nz > MOST_CELLS)
    throw rangeError(`A settlement grid of ${nx} x ${nz} cells is over 4,194,304; pass a larger cell`, 'biomes');
  const n = nx * nz,
    X = (i: number) => x0 + (i % nx) * cell, // float division: none, cell index to column
    Z = (i: number) => z0 + Math.floor(i / nx) * cell; // float division: cell index to row
  const h = new Float64Array(n);
  for (let i = 0; i < n; i++) h[i] = world.heightAt(Math.min(X(i), x1), Math.min(Z(i), z1));
  // Water: 1 sea, 2 river. Rivers are drawn onto the grid at half-cell steps along each line.
  const water = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (h[i] <= sea) water[i] = 1;
  const at = (x: number, z: number) => {
    const ix = Math.round((x - x0) / cell), // float division: metres to cells
      iz = Math.round((z - z0) / cell); // float division: metres to cells
    return ix < 0 || iz < 0 || ix >= nx || iz >= nz ? -1 : iz * nx + ix;
  };
  for (const line of world.rivers ?? [])
    for (let k = 0; k + 3 < line.length; k += 2) {
      const ax = line[k] / 1000, // float division: mm to metres
        az = line[k + 1] / 1000, // float division: mm to metres
        bx = line[k + 2] / 1000, // float division: mm to metres
        bz = line[k + 3] / 1000, // float division: mm to metres
        steps = Math.ceil((2 * Math.sqrt((bx - ax) ** 2 + (bz - az) ** 2)) / cell) + 1; // float division: samples
      for (let s = 0; s <= steps; s++) {
        const i = at(ax + ((bx - ax) * s) / steps, az + ((bz - az) * s) / steps); // float division: a share of a piece
        if (i >= 0 && water[i] === 0) water[i] = 2;
      }
    }
  // Distance to water in cells (two-pass chamfer 3-4, Borgefors 1986), capped.
  const far = 1 << 20,
    dist = new Int32Array(n).fill(far);
  for (let i = 0; i < n; i++) if (water[i]) dist[i] = 0;
  for (let pass = 0; pass < 2; pass++)
    for (let k = 0; k < n; k++) {
      const i = pass ? n - 1 - k : k,
        ix = i % nx, // float division: none, cell index to column
        s = pass ? 1 : -1;
      let d = dist[i];
      const row = i + s * nx;
      if (row >= 0 && row < n) d = Math.min(d, dist[row] + 3);
      if (ix + s >= 0 && ix + s < nx) {
        d = Math.min(d, dist[i + s] + 3);
        if (row >= 0 && row < n) d = Math.min(d, dist[row + s] + 4);
      }
      if (ix - s >= 0 && ix - s < nx && row >= 0 && row < n) d = Math.min(d, dist[row - s] + 4);
      dist[i] = d;
    }
  // Grade at a grid point: the steepest of its four axis neighbours.
  const grade = (i: number) => {
    const ix = i % nx, // float division: none, cell index to column
      iz = Math.floor(i / nx); // float division: cell index to row
    let g = 0;
    if (ix > 0) g = Math.max(g, Math.abs(h[i] - h[i - 1]));
    if (ix < nx - 1) g = Math.max(g, Math.abs(h[i] - h[i + 1]));
    if (iz > 0) g = Math.max(g, Math.abs(h[i] - h[i - nx]));
    if (iz < nz - 1) g = Math.max(g, Math.abs(h[i] - h[i + nx]));
    return g / cell; // float division: rise over run
  };
  let top = sea;
  for (let i = 0; i < n; i++) if (h[i] > top) top = h[i];
  const margin = Math.max(2, Math.ceil(40 / cell)); // float division: metres to cells
  const sites: { i: number; score: number }[] = [];
  for (let i = 0; i < n; i++) {
    const ix = i % nx, // float division: none, cell index to column
      iz = Math.floor(i / nx); // float division: cell index to row
    if (ix < margin || iz < margin || ix >= nx - margin || iz >= nz - margin || water[i]) continue;
    let flat = 0,
      ok = true;
    for (let dz = -1; dz <= 1 && ok; dz++)
      for (let dx = -1; dx <= 1; dx++) {
        const j = i + dz * nx + dx,
          g = grade(j);
        if (water[j] || g > siteGrade) {
          ok = false;
          break;
        }
        flat += g;
      }
    if (!ok) continue;
    const metres = (dist[i] * cell) / 3; // float division: chamfer units to metres
    if (metres < 30) continue; // floods
    const near = metres <= 400 ? 1 - metres / 400 : 0; // float division: a share of 400 m
    const low = top > sea ? (h[i] - sea) / (top - sea) : 0; // float division: a share of the relief
    const jitter = (hash2(seed, i) & 1023) / 1024; // float division: a share
    sites.push({ i, score: 3 * near - 2 * low - (flat / 9 / siteGrade) * 2 + 0.25 * jitter }); // float division: mean grade over its limit
  }
  sites.sort((a, b) => b.score - a.score || a.i - b.i);
  const chosen: number[] = [];
  for (const [x, z] of options.sites ?? []) {
    const i = at(x, z);
    if (!chosen.includes(i)) chosen.push(i);
  }
  for (const s of options.sites ? [] : sites) {
    if (chosen.length >= most) break;
    const x = X(s.i),
      z = Z(s.i);
    if (chosen.every((c) => (X(c) - x) ** 2 + (Z(c) - z) ** 2 >= spacing * spacing)) chosen.push(s.i);
  }
  // Network: Prim's tree over straight distances, then the shortest pairs whose tree way passes `detour`.
  const v = chosen.length,
    d2 = (a: number, b: number) => Math.sqrt((X(chosen[a]) - X(chosen[b])) ** 2 + (Z(chosen[a]) - Z(chosen[b])) ** 2);
  const links: [number, number][] = [];
  if (v > 1) {
    const inTree = new Uint8Array(v),
      best = new Float64Array(v).fill(Infinity),
      from = new Int32Array(v).fill(-1);
    best[0] = 0;
    for (let k = 0; k < v; k++) {
      let u = -1;
      for (let j = 0; j < v; j++) if (!inTree[j] && (u < 0 || best[j] < best[u])) u = j;
      inTree[u] = 1;
      if (from[u] >= 0) links.push([from[u], u]);
      for (let j = 0; j < v; j++)
        if (!inTree[j] && d2(u, j) < best[j]) {
          best[j] = d2(u, j);
          from[j] = u;
        }
    }
    // Tree way between every pair (Floyd-Warshall over at most 64 villages).
    const way = new Float64Array(v * v).fill(Infinity);
    for (let a = 0; a < v; a++) way[a * v + a] = 0;
    for (const [a, b] of links) way[a * v + b] = way[b * v + a] = d2(a, b);
    for (let k = 0; k < v; k++)
      for (let a = 0; a < v; a++)
        for (let b = 0; b < v; b++)
          if (way[a * v + k] + way[k * v + b] < way[a * v + b]) way[a * v + b] = way[a * v + k] + way[k * v + b];
    const pairs: [number, number][] = [];
    for (let a = 0; a < v; a++) for (let b = a + 1; b < v; b++) pairs.push([a, b]);
    pairs.sort((p, q) => d2(p[0], p[1]) - d2(q[0], q[1]) || p[0] - q[0] || p[1] - q[1]);
    for (const [a, b] of pairs)
      if (way[a * v + b] > detour * d2(a, b) + 1e-9) {
        links.push([a, b]);
        for (let s = 0; s < v; s++)
          for (let t = 0; t < v; t++) {
            const via = Math.min(
              way[s * v + a] + d2(a, b) + way[b * v + t],
              way[s * v + b] + d2(a, b) + way[a * v + t],
            );
            if (via < way[s * v + t]) way[s * v + t] = via;
          }
      }
    links.sort((p, q) => d2(p[0], p[1]) - d2(q[0], q[1]) || p[0] - q[0] || p[1] - q[1]);
  }
  const onRoad = new Uint8Array(n);
  const step = (a: number, b: number, length: number) => {
    if (water[b] === 1 || water[a] === 1) return Infinity;
    const g = Math.abs(h[b] - h[a]) / length, // float division: rise over run
      r = g / maxGrade; // float division: a share of the steepest grade
    let c = length * (1 + r * r);
    if (g > maxGrade) c *= STEEP;
    if (water[b] === 2) c *= bridge;
    if (onRoad[b]) c *= REUSE;
    return c;
  };
  const cost = new Float64Array(n),
    back = new Int32Array(n);
  const roads: PathOptions[] = [];
  const roadLines: [number, number][][] = [];
  for (const [a, b] of links) {
    const start = chosen[a],
      goal = chosen[b],
      gx = X(goal),
      gz = Z(goal);
    cost.fill(Infinity);
    back.fill(-1);
    const open = new Heap();
    cost[start] = 0;
    // A*: the remaining straight distance times the cheapest cost a metre (a reused flat road) never overestimates.
    const guess = (i: number) => REUSE * Math.sqrt((X(i) - gx) ** 2 + (Z(i) - gz) ** 2);
    open.push(guess(start), start);
    while (open.size) {
      const i = open.pop();
      if (i === goal) break;
      const ix = i % nx, // float division: none, cell index to column
        iz = Math.floor(i / nx); // float division: cell index to row
      for (let dz = -1; dz <= 1; dz++)
        for (let dx = -1; dx <= 1; dx++) {
          if ((dx === 0 && dz === 0) || ix + dx < 0 || ix + dx >= nx || iz + dz < 0 || iz + dz >= nz) continue;
          const j = i + dz * nx + dx,
            c = cost[i] + step(i, j, dx && dz ? cell * SQRT2 : cell);
          if (c < cost[j]) {
            cost[j] = c;
            back[j] = i;
            open.push(c + guess(j), j);
          }
        }
    }
    if (!Number.isFinite(cost[goal])) continue; // across the sea: no road
    const cells: number[] = [];
    for (let i = goal; i >= 0; i = back[i]) {
      cells.push(i);
      onRoad[i] = 1;
    }
    cells.reverse();
    const points = simplify(
      cells.map((i) => [X(i), Z(i)] as const),
      cell * 0.75,
    );
    roadLines.push(points);
    roads.push({ ...road, points });
  }
  // Houses along lanes. Lanes leave along each road that meets the village, then fill the gaps up to six.
  const villages: Village[] = [],
    lanes: PathOptions[] = [],
    houses: House[] = [],
    sc = [0, 0];
  const radius = 14 + 7 * Math.sqrt(perVillage);
  const clear = (road.width ?? 5) / 2 + (road.edge ?? 3);
  const laneClear = (lane.width ?? 3) / 2 + 1;
  const dry = (x: number, z: number) => {
    const i = at(x, z);
    return i >= 0 && water[i] === 0 && x >= x0 && x <= x1 && z >= z0 && z <= z1;
  };
  chosen.forEach((c) => {
    const cx = X(c),
      cz = Z(c),
      dirs: [number, number][] = [];
    for (const line of roadLines) {
      const ends = [line[0], line[line.length - 1]];
      for (let e = 0; e < 2; e++)
        if (ends[e][0] === cx && ends[e][1] === cz) {
          const next = e === 0 ? line[1] : line[line.length - 2],
            dx = next[0] - cx,
            dz = next[1] - cz,
            l = Math.sqrt(dx * dx + dz * dz);
          if (l > 0) dirs.push([dx / l, dz / l]); // float division: a unit direction
        }
    }
    const wanted = Math.min(6, Math.max(1, Math.round(perVillage / 6))); // float division: lanes for the houses
    const base = hash2(seed, c) >>> 0;
    for (let s = 0; dirs.length < wanted && s < 64; s++) {
      sincos((base + Math.floor((s * TURN) / 7)) % TURN, sc); // float division: an angle of a seventh of a turn
      const l = Math.sqrt(sc[0] * sc[0] + sc[1] * sc[1]),
        d: [number, number] = [sc[0] / l, sc[1] / l]; // float division: a unit direction
      if (dirs.every(([px, pz]) => px * d[0] + pz * d[1] < 0.5)) dirs.push(d);
    }
    const mine: House[] = [];
    // Each lane's ray from the centre, for keeping other lanes' houses off it; a lane along a road keeps the road's
    // clearance, the others their own.
    const rays = dirs.map(([ux, uz]) => {
      const along = roadLines.some((l) => dirsMatch(l, cx, cz, ux, uz));
      return { ux, uz, along, keep: along ? clear : laneClear };
    });
    const off = (x: number, z: number, keep: number, skip: number) =>
      roadLines.every((line) => {
        for (let q = 0; q + 1 < line.length; q++)
          if (segment2(x, z, line[q][0], line[q][1], line[q + 1][0], line[q + 1][1]) < clear * clear) return false;
        return true;
      }) &&
      rays.every(
        (ray, j) =>
          j === skip || ray.along || segment2(x, z, cx, cz, cx + ray.ux * radius, cz + ray.uz * radius) >= keep * keep,
      );
    rays.forEach(({ ux, uz, along, keep }, j) => {
      let end = 0;
      for (let t = 12; t + 4 <= radius && mine.length < perVillage; t += 13)
        for (const side of [1, -1]) {
          if (mine.length >= perVillage) break;
          const r = hash3(seed, c, Math.round(t * 16) * 2 + (side > 0 ? 1 : 0) + j * 4096);
          const w = 7 + (r & 3),
            depth = 6 + ((r >>> 2) & 3),
            gap = keep + 1 + depth / 2,
            hx = cx + ux * t - uz * gap * side,
            hz = cz + uz * t + ux * gap * side,
            ax = ux * (w / 2),
            az = uz * (w / 2),
            bx = -uz * (depth / 2),
            bz = ux * (depth / 2);
          const corners: [number, number][] = [
            [hx - ax - bx, hz - az - bz],
            [hx + ax - bx, hz + az - bz],
            [hx + ax + bx, hz + az + bz],
            [hx - ax + bx, hz - az + bz],
          ];
          if (!dry(hx, hz) || !corners.every(([x, z]) => dry(x, z) && off(x, z, laneClear, j))) continue;
          if (!off(hx, hz, laneClear, j)) continue;
          const ys = corners.map(([x, z]) => world.heightAt(x, z)),
            floor = world.heightAt(hx, hz);
          if ((Math.max(...ys, floor) - Math.min(...ys, floor)) / Math.max(w, depth) > siteGrade) continue; // float division: grade over the lot
          const reach = Math.sqrt(w * w + depth * depth) / 2 + 1;
          if (
            houses.some(
              (o) =>
                (o.centre[0] - hx) ** 2 + (o.centre[1] - hz) ** 2 <
                (reach + Math.sqrt(o.size[0] ** 2 + o.size[1] ** 2) / 2) ** 2,
            )
          )
            continue;
          const house: House = { centre: [hx, hz], size: [w, depth], along: [ux, uz], floor, corners };
          mine.push(house);
          houses.push(house);
          end = t + w / 2;
        }
      // A lane along a road is the road itself; the others run from the centre past their last house.
      if (end > 0 && !along)
        lanes.push({
          ...lane,
          points: [
            [cx, cz],
            [cx + ux * (end + 4), cz + uz * (end + 4)],
          ],
        });
    });
    villages.push({ centre: [cx, cz], height: h[c], radius, houses: mine });
  });
  const paths = [...roads, ...lanes];
  const exclusions: Exclusion[] = [
    ...pathExclusions(paths),
    ...houses.map((o) => ({ kind: 'polygon' as const, points: o.corners, verge: yard })),
  ];
  return { villages, roads, lanes, paths, exclusions };
}

/** Whether a road line leaves the village `(cx, cz)` in the direction `(ux, uz)`. */
function dirsMatch(
  line: readonly (readonly [number, number])[],
  cx: number,
  cz: number,
  ux: number,
  uz: number,
): boolean {
  for (const [e, next] of [
    [line[0], line[1]],
    [line[line.length - 1], line[line.length - 2]],
  ] as const) {
    if (e[0] !== cx || e[1] !== cz) continue;
    const dx = next[0] - cx,
      dz = next[1] - cz,
      l = Math.sqrt(dx * dx + dz * dz);
    if (l > 0 && Math.abs((dx * ux + dz * uz) / l - 1) < 1e-12) return true; // float division: a cosine
  }
  return false;
}
