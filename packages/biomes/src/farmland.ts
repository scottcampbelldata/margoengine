// English lowland farmland (entry `@margoengine/biomes/farmland`): a quilt of hedged fields of mixed use (pasture,
// plough, stubble, meadow), hedgerows on the field lines with hedge trees standing in them, lanes that run along the
// field lines between the places they join and end only at a junction, the world's edge or a field gate, a gate into
// every field, and the biomes and ground looks that draw it (`lowlandFarmWorld`, `FARMLAND_MATERIALS`). Plain data, the
// same bytes on every machine: the layout uses only + - * / (correctly rounded in IEEE 754) and integer hashes.
// Sources: fields as a Voronoi tessellation of jittered seeds whose margins become hedgerows by a hedgerow share, after
// "Farm Size Matters: A Spatially Explicit Ecological-Economic Framework for Biodiversity and Pest Management", arXiv
// 2505.17687, 2025 (supplement: discrete Voronoi field pattern, field size, hedgerow and grassland shares); landscapes
// as 2D patches with 1D hedge elements on their shared margins, Zamberletti, Papaix, Gabriel and Opitz, "Markov random
// field models for vector-based representations of landscapes", Annals of Applied Statistics 15(4), 2021; parcels by
// subdividing blocks with their long axis kept, Vanegas, Kelly, Weber, Halatsch, Aliaga and Muller, "Procedural
// Generation of Parcels in Urban Modeling", Computer Graphics Forum 31(2), 2012 (the plough runs along a field's long
// side); the irregular, sinuous hedges and hedgerow oaks and ashes of the "ancient countryside" of piecemeal enclosure,
// Rackham, "The History of the Countryside", 1986, and Staffordshire County Council, "Planning for Landscape Change",
// SPG vol. 3, 2001 (irregular hedged fields, many over-mature hedgerow oaks); hedge sizes and gaps, Defra, "Hedgerow
// Survey Handbook", 2nd ed., 2007; lanes as least-cost paths over a graph whose step cost grows with the grade, Galin,
// Peytavie, Marechal and Guerin, "Procedural Generation of Roads", Computer Graphics Forum 2010, with Dijkstra's
// shortest paths, Numerische Mathematik 1959; clipping by half planes, Sutherland and Hodgman, CACM 1974. Our own
// layout from those descriptions.
import { rangeError, typeError } from '../../shared/errors.js';
import { hash3, hash4 } from './hash.js';
import type { BiomeDefinition } from './define.js';
import type { BiomeEdit } from './editor.js';
import type { MaterialLook } from './looks.js';
import type { Exclusion } from './placement.js';
import type { PresetWorld } from './presets.js';

/** What a field is used for. `none` is not farmland (a village, a wood, a works yard from `keep`). */
export type FieldUse = 'pasture' | 'plough' | 'stubble' | 'meadow' | 'none';
/** A hedge tree's species. */
export type HedgeTreeSpecies = 'oak' | 'ash' | 'holly';
type Pt = readonly [number, number];

/** The ground the farmland is laid on: its rectangle and heights (a `BiomeWorld` is one). */
export interface FarmlandWorld {
  /** World rectangle `[x0, z0, x1, z1]` in metres. */
  readonly bounds: readonly [number, number, number, number];
  /** Ground height in metres at `(x, z)`. */
  heightAt(x: number, z: number): number;
}

/** Settings of {@link layoutFarmland}. Every one has a default. */
export interface FarmlandOptions {
  /** Seed of the fields, hedges, trees and uses. Default 1. */
  readonly seed?: number;
  /** Rectangle `[x0, z0, x1, z1]` in metres to lay fields in. Default the world's bounds. */
  readonly rect?: readonly [number, number, number, number];
  /** Mean field area, m2, 2,500 to 400,000. Default 40,000 (4 ha, piecemeal enclosure in the Midlands). */
  readonly fieldSize?: number;
  /** How far the seeds stray from a regular grid, 0 to 1. Default 0.8. */
  readonly jitter?: number;
  /** Sideways wander of a hedge line as a share of the field width, 0 to 0.2. Default 0.06 (sinuous old hedges). */
  readonly wander?: number;
  /** Shares of the uses, any positive weights. Default pasture 0.55, plough 0.2, stubble 0.15, meadow 0.1. */
  readonly uses?: Readonly<Partial<Record<Exclude<FieldUse, 'none'>, number>>>;
  /** Share of field lines that carry a hedge, 0 to 1 (the rest are open or fenced). Default 0.92. */
  readonly hedgeShare?: number;
  /** Hedge height and width, metres. Default 2.2 and 2 (a trimmed farm hedge, Defra 2007). */
  readonly hedge?: { readonly height?: number; readonly width?: number };
  /** Mean metres between hedge trees along a hedge, 10 to 1,000. Default 45. */
  readonly treeSpacing?: number;
  /** Shares of the hedge tree species. Default oak 0.62, ash 0.28, holly 0.1. */
  readonly trees?: Readonly<Partial<Record<HedgeTreeSpecies, number>>>;
  /** Places the lanes join, `[x, z]` metres: villages, farms, a works gate, and points on the rect's edge for lanes
   * that leave the area. Two or more make lanes; fewer make none. Default none. */
  readonly connect?: readonly Pt[];
  /** Lane width, metres, 2 to 12. Default 4. */
  readonly laneWidth?: number;
  /** How much a lane avoids climbing: the step cost is length times 1 + grade times this. Default 12. */
  readonly gradeCost?: number;
  /** Field gate width, metres, 2 to 8. Default 3.6 (a twelve foot gate). */
  readonly gateWidth?: number;
  /** Closed polygons `[x, z]` that are not farmland (village, wood, yard, crater): their cells get `none`. */
  readonly keep?: readonly (readonly Pt[])[];
}

/** One field: its outline (counter-clockwise), area, use, plough direction and gates. */
export interface Field {
  readonly id: number;
  readonly outline: readonly Pt[];
  /** Area, m2. */
  readonly area: number;
  readonly use: FieldUse;
  /** Direction of the furrows (along the field's longest side), radians from +x toward +z. */
  readonly furrow: number;
}

/** One hedge: a polyline, the fields on its two sides (-1 outside or a lane), its gaps and size. */
export interface Hedge {
  readonly points: readonly Pt[];
  readonly fields: readonly [number, number];
  /** Gaps along the hedge as `[from, to]` metres from its first point (the gates). */
  readonly gaps: readonly (readonly [number, number])[];
  readonly height: number;
  readonly width: number;
  /** True for a hedge beside a lane. */
  readonly lane: boolean;
}

/** One hedge tree. */
export interface HedgeTree {
  readonly at: Pt;
  readonly species: HedgeTreeSpecies;
  /** Height, metres. */
  readonly height: number;
  /** Turn about the vertical, radians. */
  readonly turn: number;
}

/** How a lane's end finishes. */
export type LaneEnd = 'junction' | 'edge' | 'gate';
/** One lane: its centre line, width and how its two ends finish. */
export interface Lane {
  readonly points: readonly Pt[];
  readonly width: number;
  readonly ends: readonly [LaneEnd, LaneEnd];
}

/** One field gate: where it stands, the hedge line's direction there, its width and the field it opens. */
export interface Gate {
  readonly at: Pt;
  /** Direction of the hedge line at the gate, radians from +x toward +z. */
  readonly along: number;
  readonly width: number;
  readonly field: number;
  /** Where the gate leads from: `lane`, or the id of the field it opens from. */
  readonly from: 'lane' | number;
}

/** The farmland from {@link layoutFarmland}. */
export interface Farmland {
  readonly fields: readonly Field[];
  readonly hedges: readonly Hedge[];
  readonly trees: readonly HedgeTree[];
  readonly lanes: readonly Lane[];
  readonly gates: readonly Gate[];
  /** Lanes and hedges as placement exclusions, so no stored tree or shrub stands in them. */
  readonly exclusions: readonly Exclusion[];
}

const USES: readonly Exclude<FieldUse, 'none'>[] = ['pasture', 'plough', 'stubble', 'meadow'];
const SPECIES: readonly HedgeTreeSpecies[] = ['oak', 'ash', 'holly'];
/** Height ranges, metres: hedgerow oaks 15 to 20 m, ashes 12 to 18 m, holly 5 to 9 m (reference bible, Rackham). */
const TREE_HEIGHT: Readonly<Record<HedgeTreeSpecies, Pt>> = { oak: [15, 20], ash: [12, 18], holly: [5, 9] };
const U32 = 4294967296;
const unit = (h: number) => h / U32;

const num = (v: unknown, name: string, lo: number, hi: number, d: number): number => {
  if (v === undefined) return d;
  if (typeof v !== 'number' || !(v >= lo && v <= hi))
    throw rangeError(`farmland: ${name} must be ${lo} to ${hi}`, 'biomes');
  return v;
};
const weights = <K extends string>(
  v: unknown,
  keys: readonly K[],
  d: Readonly<Record<K, number>>,
  name: string,
): number[] => {
  if (v === undefined) return keys.map((k) => d[k]);
  if (typeof v !== 'object' || v === null) throw typeError(`farmland: ${name} must be an object of weights`, 'biomes');
  const w = keys.map((k) => ((v as Record<string, unknown>)[k] === undefined ? 0 : (v as Record<string, number>)[k]));
  if (!w.every((x) => typeof x === 'number' && x >= 0 && Number.isFinite(x)) || !(w.reduce((a, b) => a + b, 0) > 0))
    throw rangeError(`farmland: ${name} weights must be 0 or more and not all 0`, 'biomes');
  return w;
};
const pick = (w: readonly number[], u: number): number => {
  const total = w.reduce((a, b) => a + b, 0);
  let acc = 0;
  for (let i = 0; i < w.length; i++) if (u * total < (acc += w[i])) return i;
  return w.length - 1;
};
const isPoint = (p: unknown): p is Pt =>
  Array.isArray(p) && p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);

/** True when `p` is inside the closed polygon (even-odd). */
export function insidePolygon(p: Pt, polygon: readonly Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [ax, az] = polygon[j],
      [bx, bz] = polygon[i];
    if (
      az > p[1] !== bz > p[1] &&
      (bz > az ? (p[0] - ax) * (bz - az) < (bx - ax) * (p[1] - az) : (p[0] - ax) * (bz - az) > (bx - ax) * (p[1] - az))
    )
      inside = !inside;
  }
  return inside;
}

/** Signed area of a closed polygon, m2 (positive when counter-clockwise in x right, z down... i.e. x to z). */
function area(poly: readonly Pt[]): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
  return a / 2;
}

const length = (pts: readonly Pt[]) => {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return s;
};
/** The point and direction `s` metres along a polyline. */
function along(pts: readonly Pt[], s: number): { at: Pt; dir: number } {
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i][0] - pts[i - 1][0],
      dz = pts[i][1] - pts[i - 1][1],
      l = Math.hypot(dx, dz);
    if (s <= l || i === pts.length - 1) {
      const t = l > 0 ? Math.min(1, s / l) : 0; // float division: CPU layout geometry, no WGSL twin
      return { at: [pts[i - 1][0] + dx * t, pts[i - 1][1] + dz * t], dir: Math.atan2(dz, dx) };
    }
    s -= l;
  }
  return { at: pts[0], dir: 0 };
}
/** A polyline moved `d` metres to its left (toward +z when it runs along +x... the side of (−dz, dx)). */
function offset(pts: readonly Pt[], d: number): Pt[] {
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)],
      b = pts[Math.min(pts.length - 1, i + 1)],
      dx = b[0] - a[0],
      dz = b[1] - a[1],
      l = Math.hypot(dx, dz) || 1;
    return [p[0] - (dz / l) * d, p[1] + (dx / l) * d] as Pt; // float division: CPU layout geometry, no WGSL twin
  });
}

/** A polyline with `a` metres cut off its start and `b` off its end (empty when nothing is left). */
function trim(pts: readonly Pt[], a: number, b: number): Pt[] {
  const l = length(pts);
  if (a + b >= l - 0.5) return [];
  const out: Pt[] = [along(pts, a).at];
  let s = 0;
  for (let i = 1; i < pts.length; i++) {
    s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (s > a && s < l - b) out.push(pts[i]);
  }
  out.push(along(pts, l - b).at);
  return out;
}

interface Edge {
  /** Cells on its two sides (-1 the rect's border). */
  readonly a: number;
  readonly b: number;
  readonly p: Pt;
  readonly q: Pt;
  /** Wandering polyline from p to q. */
  line: Pt[];
  lane: boolean;
}

/**
 * Lays out hedged fields, hedge trees, lanes and gates over a world. CPU only; the same world and options give the same
 * layout on every machine.
 * @throws TypeError or RangeError for bad options.
 * @example
 * const farm = layoutFarmland(world, { connect: [[-900, 0], [0, 0], [900, 300]] });
 * farm.fields.length; // about one field per 4 ha
 */
export function layoutFarmland(world: FarmlandWorld, options: FarmlandOptions = {}): Farmland {
  if (
    typeof world !== 'object' ||
    world === null ||
    typeof world.heightAt !== 'function' ||
    !Array.isArray(world.bounds)
  )
    throw typeError('farmland: pass a world with bounds and heightAt (a BiomeWorld)', 'biomes');
  if (typeof options !== 'object' || options === null) throw typeError('farmland: options must be an object', 'biomes');
  const seed = num(options.seed, 'seed', 0, U32 - 1, 1) >>> 0,
    rect = options.rect ?? world.bounds;
  if (
    !Array.isArray(rect) ||
    rect.length !== 4 ||
    !rect.every(Number.isFinite) ||
    !(rect[2] > rect[0] && rect[3] > rect[1])
  )
    throw rangeError('farmland: rect is [x0, z0, x1, z1] with x1 > x0 and z1 > z0', 'biomes');
  const size = num(options.fieldSize, 'fieldSize', 2500, 400000, 40000),
    jitter = num(options.jitter, 'jitter', 0, 1, 0.8),
    wander = num(options.wander, 'wander', 0, 0.2, 0.06),
    useW = weights(options.uses, USES, { pasture: 0.55, plough: 0.2, stubble: 0.15, meadow: 0.1 }, 'uses'),
    hedgeShare = num(options.hedgeShare, 'hedgeShare', 0, 1, 0.92),
    hedgeHeight = num(options.hedge?.height, 'hedge.height', 0.5, 6, 2.2),
    hedgeWidth = num(options.hedge?.width, 'hedge.width', 0.5, 6, 2),
    spacing = num(options.treeSpacing, 'treeSpacing', 10, 1000, 45),
    treeW = weights(options.trees, SPECIES, { oak: 0.62, ash: 0.28, holly: 0.1 }, 'trees'),
    laneWidth = num(options.laneWidth, 'laneWidth', 2, 12, 4),
    gradeCost = num(options.gradeCost, 'gradeCost', 0, 1000, 12),
    gateWidth = num(options.gateWidth, 'gateWidth', 2, 8, 3.6),
    connect = options.connect ?? [],
    keep = options.keep ?? [];
  if (!Array.isArray(connect) || !connect.every(isPoint))
    throw typeError('farmland: connect is a list of [x, z] points', 'biomes');
  if (!Array.isArray(keep) || !keep.every((k) => Array.isArray(k) && k.length >= 3 && k.every(isPoint)))
    throw typeError('farmland: keep is a list of polygons of 3 or more [x, z] points', 'biomes');
  const [x0, z0, x1, z1] = rect,
    step = Math.sqrt(size),
    nx = Math.max(1, Math.round((x1 - x0) / step)), // float division: CPU layout geometry, no WGSL twin
    nz = Math.max(1, Math.round((z1 - z0) / step)), // float division: CPU layout geometry, no WGSL twin
    sx = (x1 - x0) / nx, // float division: CPU layout geometry, no WGSL twin
    sz = (z1 - z0) / nz; // float division: CPU layout geometry, no WGSL twin
  if (nx * nz > 40000) throw rangeError('farmland: more than 40,000 fields; raise fieldSize or shrink rect', 'biomes');
  // 1. Seeds: one per grid cell, jittered (hash of seed and cell).
  const seeds: Pt[] = [];
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) {
      const u = unit(hash4(seed, 1, i, j)) - 0.5,
        v = unit(hash4(seed, 2, i, j)) - 0.5;
      seeds.push([x0 + (i + 0.5 + u * jitter) * sx, z0 + (j + 0.5 + v * jitter) * sz]);
    }
  // 2. Voronoi cells: the rect clipped by the bisector with each neighbour within two grid cells (Sutherland-Hodgman),
  // each vertex remembering which neighbour's bisector made the edge that leaves it (-1 the rect).
  const cells: { pts: Pt[]; by: number[] }[] = [];
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) {
      const s = seeds[j * nx + i];
      let pts: Pt[] = [
          [x0, z0],
          [x0, z1],
          [x1, z1],
          [x1, z0],
        ],
        by = [-1, -1, -1, -1];
      for (let dj = -2; dj <= 2; dj++)
        for (let di = -2; di <= 2; di++) {
          const ii = i + di,
            jj = j + dj;
          if ((!di && !dj) || ii < 0 || jj < 0 || ii >= nx || jj >= nz) continue;
          const n = jj * nx + ii,
            o = seeds[n],
            mx = (s[0] + o[0]) / 2,
            mz = (s[1] + o[1]) / 2,
            dx = o[0] - s[0],
            dz = o[1] - s[1],
            side = (p: Pt) => (p[0] - mx) * dx + (p[1] - mz) * dz; // > 0 on the neighbour's side
          const np: Pt[] = [],
            nb: number[] = [];
          for (let k = 0; k < pts.length; k++) {
            const p = pts[k],
              q = pts[k + 1 < pts.length ? k + 1 : 0],
              fp = side(p),
              fq = side(q);
            // Each output vertex carries the label of the edge that leaves it: a kept vertex and an entry point keep
            // the old edge's; an exit point starts the new edge on the bisector.
            if (fp <= 0) {
              np.push(p);
              nb.push(by[k]);
            }
            if (fp <= 0 !== fq <= 0) {
              const t = fp / (fp - fq); // float division: CPU layout geometry, no WGSL twin
              np.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
              nb.push(fp <= 0 ? n : by[k]);
            }
          }
          pts = np;
          by = nb;
        }
      cells.push({ pts, by });
    }
  // 3. Unique edges: a cell's edge on the bisector with neighbour n is the edge of the pair (lower cell's copy kept);
  // the rect's edges are the cell's own. End points snap to one node within 5 cm (vertices met by three cells are
  // computed in each cell's own clipping order). Each edge wanders sideways, one line both fields share.
  const keepOf = seeds.map((s) => keep.some((k) => insidePolygon(s, k)));
  const grid = new Map<string, string[]>(),
    nodeAt = new Map<string, Pt>();
  const key = (p: Pt): string => {
    const gx = Math.floor(p[0]),
      gz = Math.floor(p[1]);
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++)
        for (const k of grid.get(`${gx + dx},${gz + dz}`) ?? []) {
          const q = nodeAt.get(k)!;
          if (Math.abs(q[0] - p[0]) < 0.05 && Math.abs(q[1] - p[1]) < 0.05) return k;
        }
    const k = `n${nodeAt.size}`;
    nodeAt.set(k, p);
    grid.set(`${gx},${gz}`, [...(grid.get(`${gx},${gz}`) ?? []), k]);
    return k;
  };
  const edges = new Map<string, Edge>();
  const cellEdges: { key: string; forward: boolean }[][] = cells.map(() => []);
  cells.forEach((c, ci) => {
    for (let k = 0; k < c.pts.length; k++) {
      const p = c.pts[k],
        q = c.pts[k + 1 < c.pts.length ? k + 1 : 0],
        n = c.by[k];
      if (Math.hypot(q[0] - p[0], q[1] - p[1]) < 0.01) continue;
      const ek = n < 0 ? `b${ci}.${k}` : `${Math.min(ci, n)}-${Math.max(ci, n)}`,
        e = edges.get(ek);
      if (e) cellEdges[ci].push({ key: ek, forward: key(p) === key(e.p) });
      else {
        key(p);
        key(q);
        edges.set(ek, {
          a: n < 0 ? ci : Math.min(ci, n),
          b: n < 0 ? -1 : Math.max(ci, n),
          p,
          q,
          line: [],
          lane: false,
        });
        cellEdges[ci].push({ key: ek, forward: true });
      }
    }
  });
  let edgeIndex = 0;
  for (const [ek, e] of edges) {
    const l = Math.hypot(e.q[0] - e.p[0], e.q[1] - e.p[1]),
      n = e.b === -1 ? 1 : Math.max(1, Math.round(l / 25)),
      amp = e.b === -1 ? 0 : wander * Math.min(sx, sz),
      nxl = -(e.q[1] - e.p[1]) / (l || 1), // float division: CPU layout geometry, no WGSL twin
      nzl = (e.q[0] - e.p[0]) / (l || 1), // float division: CPU layout geometry, no WGSL twin
      eh = hash3(seed, 3, edgeIndex++ + 0) ^ (ek.length * 2654435761);
    const line: Pt[] = [e.p];
    for (let s = 1; s < n; s++) {
      const t = s / n, // float division: CPU layout geometry, no WGSL twin
        // A smooth wander: two sine terms of hashed phase, zero at both ends.
        w =
          Math.sin(Math.PI * t) *
          (Math.sin(2 * Math.PI * (t + unit(hash3(eh, 4, 0)))) * 0.6 +
            Math.sin(5 * Math.PI * (t + unit(hash3(eh, 5, 0)))) * 0.4);
      line.push([e.p[0] + (e.q[0] - e.p[0]) * t + nxl * amp * w, e.p[1] + (e.q[1] - e.p[1]) * t + nzl * amp * w]);
    }
    line.push(e.q);
    e.line = line;
  }
  // 4. Lanes: shortest paths over the edge graph from each connect point to the lanes already made (Dijkstra).
  const nodeEdges = new Map<string, string[]>();
  for (const [ek, e] of edges)
    for (const p of [e.p, e.q]) {
      const k = key(p);
      nodeEdges.set(k, [...(nodeEdges.get(k) ?? []), ek]);
    }
  const nodePt = new Map<string, Pt>();
  for (const e of edges.values()) {
    nodePt.set(key(e.p), e.p);
    nodePt.set(key(e.q), e.q);
  }
  const nodes = [...nodePt.keys()].sort();
  const nearest = (p: Pt) => {
    let best = nodes[0],
      d = Infinity;
    for (const k of nodes) {
      const q = nodePt.get(k)!,
        dd = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2;
      if (dd < d) (d = dd), (best = k);
    }
    return best;
  };
  const cost = (e: Edge) => {
    const l = length(e.line),
      grade = Math.abs(world.heightAt(e.q[0], e.q[1]) - world.heightAt(e.p[0], e.p[1])) / (l || 1); // float division: CPU layout geometry, no WGSL twin
    // Lanes keep off the rect's border edges unless they must (a border edge leaves the farmland).
    return l * (1 + grade * gradeCost) * (e.b === -1 ? 4 : 1);
  };
  const laneNodes = new Set<string>(),
    ends: string[] = [];
  if (connect.length >= 2) {
    const first = nearest(connect[0]);
    laneNodes.add(first);
    ends.push(first);
    for (let c = 1; c < connect.length; c++) {
      const start = nearest(connect[c]);
      ends.push(start);
      if (laneNodes.has(start)) continue;
      const dist = new Map<string, number>([[start, 0]]),
        prev = new Map<string, string>(),
        done = new Set<string>();
      let found: string | undefined;
      for (;;) {
        let u: string | undefined,
          du = Infinity;
        for (const [k, d] of dist)
          if (!done.has(k) && (d < du || (d === du && u !== undefined && k < u))) (u = k), (du = d);
        if (u === undefined) break;
        if (laneNodes.has(u)) {
          found = u;
          break;
        }
        done.add(u);
        for (const ek of nodeEdges.get(u) ?? []) {
          const e = edges.get(ek)!,
            v = key(e.p) === u ? key(e.q) : key(e.p),
            nd = du + (e.lane ? 0.25 : 1) * cost(e);
          if (nd < (dist.get(v) ?? Infinity)) {
            dist.set(v, nd);
            prev.set(v, ek);
          }
        }
      }
      for (let v = found; v !== undefined && v !== start; ) {
        const ek = prev.get(v)!,
          e = edges.get(ek)!;
        e.lane = true;
        laneNodes.add(v);
        v = key(e.p) === v ? key(e.q) : key(e.p);
      }
      laneNodes.add(start);
    }
  }
  // Chain lane edges into polylines between nodes whose lane degree is not 2.
  const laneDeg = new Map<string, string[]>();
  for (const [ek, e] of edges)
    if (e.lane) for (const p of [e.p, e.q]) laneDeg.set(key(p), [...(laneDeg.get(key(p)) ?? []), ek]);
  const lanes: Lane[] = [],
    usedLane = new Set<string>(),
    onBorder = (p: Pt) =>
      Math.abs(p[0] - x0) < 0.01 ||
      Math.abs(p[0] - x1) < 0.01 ||
      Math.abs(p[1] - z0) < 0.01 ||
      Math.abs(p[1] - z1) < 0.01;
  const endOf = (k: string): LaneEnd => {
    const p = nodePt.get(k)!;
    return (laneDeg.get(k)?.length ?? 0) >= 3 ? 'junction' : onBorder(p) ? 'edge' : 'gate';
  };
  for (const start of [...laneDeg.keys()].sort())
    if (laneDeg.get(start)!.length !== 2)
      for (const first of laneDeg.get(start)!) {
        if (usedLane.has(first)) continue;
        let at = start,
          ek = first;
        const pts: Pt[] = [nodePt.get(start)!];
        for (;;) {
          usedLane.add(ek);
          const e = edges.get(ek)!,
            fwd = key(e.p) === at,
            line = fwd ? e.line : [...e.line].reverse();
          pts.push(...line.slice(1));
          at = fwd ? key(e.q) : key(e.p);
          const next = laneDeg.get(at)!;
          if (next.length !== 2) break;
          ek = next[0] === ek ? next[1] : next[0];
          if (usedLane.has(ek)) break;
        }
        lanes.push({ points: pts, width: laneWidth, ends: [endOf(start), endOf(at)] });
      }
  // 5. Fields: outlines from their edges' wandering lines, uses by hash, furrows along the longest side.
  const fields: Field[] = cells.map((c, ci) => {
    const outline: Pt[] = [];
    for (const { key: ek, forward } of cellEdges[ci]) {
      const l = edges.get(ek)!.line,
        seq = forward ? l : [...l].reverse();
      outline.push(...seq.slice(0, -1));
    }
    let longest = 0,
      furrow = 0;
    for (let k = 0; k < c.pts.length; k++) {
      const p = c.pts[k],
        q = c.pts[k + 1 < c.pts.length ? k + 1 : 0],
        l = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (l > longest) (longest = l), (furrow = Math.atan2(q[1] - p[1], q[0] - p[0]));
    }
    const use: FieldUse = keepOf[ci] ? 'none' : USES[pick(useW, unit(hash3(seed, 6, ci)))];
    return { id: ci, outline, area: Math.abs(area(outline)), use, furrow };
  });
  // 6. Gates: fields beside a lane open onto it; the rest open from a neighbour already reached (breadth first).
  const gates: Gate[] = [],
    gateOn = new Map<string, { s: number; side: number }[]>(),
    reached = new Set<number>(),
    queue: number[] = [];
  const addGate = (ek: string, field: number, from: 'lane' | number) => {
    const e = edges.get(ek)!,
      l = length(e.line);
    if (l < gateWidth + 4) return false;
    // Toward the end nearer the lane's start when on a lane, else the middle; hashed a little.
    const s = l * (0.3 + 0.4 * unit(hash3(seed, 7, field))),
      { at, dir } = along(e.line, s);
    gates.push({ at, along: dir, width: gateWidth, field, from });
    gateOn.set(ek, [...(gateOn.get(ek) ?? []), { s, side: field === e.a ? 1 : -1 }]);
    return true;
  };
  for (const f of fields) {
    if (f.use === 'none') continue;
    const laneEdge = cellEdges[f.id]
      .map((c) => c.key)
      .filter((ek) => edges.get(ek)!.lane)
      .sort((a, b) => length(edges.get(b)!.line) - length(edges.get(a)!.line))[0];
    if (laneEdge && addGate(laneEdge, f.id, 'lane')) {
      reached.add(f.id);
      queue.push(f.id);
    }
  }
  if (!queue.length) {
    const first = fields.find((f) => f.use !== 'none');
    if (first) {
      reached.add(first.id);
      queue.push(first.id);
    }
  }
  for (let qi = 0; qi < queue.length || reached.size < fields.filter((f) => f.use !== 'none').length; qi++) {
    if (qi >= queue.length) {
      // A pocket cut off by kept ground: open it from the nearest reached field through any shared line.
      const f = fields.find((g) => g.use !== 'none' && !reached.has(g.id))!;
      reached.add(f.id);
      queue.push(f.id);
      continue;
    }
    const f = queue[qi];
    for (const { key: ek } of cellEdges[f]) {
      const e = edges.get(ek)!,
        n = e.a === f ? e.b : e.a;
      if (n < 0 || reached.has(n) || fields[n].use === 'none' || e.lane) continue;
      if (addGate(ek, n, f)) {
        reached.add(n);
        queue.push(n);
      }
    }
  }
  // A lane that ends at neither a junction nor the edge ends at a gate into the field it reaches.
  for (const lane of lanes)
    for (const [i, end] of lane.ends.entries())
      if (end === 'gate') {
        const p = i === 0 ? lane.points[0] : lane.points[lane.points.length - 1],
          q = i === 0 ? lane.points[1] : lane.points[lane.points.length - 2],
          dir = Math.atan2(p[1] - q[1], p[0] - q[0]);
        let field = fields.findIndex(
          (f) => f.use !== 'none' && insidePolygon([p[0] + Math.cos(dir) * 3, p[1] + Math.sin(dir) * 3], f.outline),
        );
        if (field < 0)
          field = fields.findIndex((f) =>
            insidePolygon([p[0] + Math.cos(dir) * 3, p[1] + Math.sin(dir) * 3], f.outline),
          );
        gates.push({
          at: p,
          along: dir + Math.PI / 2,
          width: Math.max(gateWidth, laneWidth),
          field: Math.max(0, field),
          from: 'lane',
        });
      }
  // 7. Hedges on the field lines (by share, always round kept ground and along lanes), with gaps at the gates.
  const hedges: Hedge[] = [];
  let hi = 0;
  // Hedges stop short of a lane they meet: at a node on a lane, cut back clear of the lane and its own hedges.
  const clear = laneWidth / 2 + hedgeWidth + 0.5,
    cutAt = (p: Pt, own: boolean) => {
      const n = laneDeg.get(key(p))?.length ?? 0;
      return own ? (n >= 3 ? clear : 0) : n ? clear : 0;
    },
    shift = (gaps: readonly (readonly [number, number])[], a: number, l: number) =>
      gaps
        .map(([g0, g1]) => [Math.max(0, g0 - a), Math.max(0, Math.min(l, g1 - a))] as const)
        .filter(([g0, g1]) => g1 > g0);
  for (const [ek, e] of edges) {
    hi++;
    const fa = e.a,
      fb = e.b,
      noneA = fa < 0 || fields[fa].use === 'none',
      noneB = fb < 0 || fields[fb].use === 'none';
    if (fb < 0 && noneA) continue;
    if (noneA && noneB) continue;
    const l = length(e.line),
      gaps = (gateOn.get(ek) ?? []).map(
        (g) => [Math.max(0, g.s - gateWidth / 2), Math.min(l, g.s + gateWidth / 2)] as const,
      );
    if (e.lane) {
      // Hedges both sides of a lane, set back by half the lane and half the hedge.
      const d = laneWidth / 2 + hedgeWidth / 2 + 0.3,
        a = cutAt(e.p, true),
        b = cutAt(e.q, true);
      for (const side of [1, -1]) {
        const field = side === 1 ? fa : fb,
          points = trim(offset(e.line, side * d), a, b);
        if (points.length < 2) continue;
        hedges.push({
          points,
          fields: [field, -1],
          gaps: shift(
            (gateOn.get(ek) ?? [])
              .filter((g) => g.side === side)
              .map((g) => [g.s - gateWidth / 2, g.s + gateWidth / 2] as const),
            a,
            l - a - b,
          ),
          height: hedgeHeight,
          width: hedgeWidth,
          lane: true,
        });
      }
      continue;
    }
    if (!(noneA || noneB) && fb >= 0 && unit(hash3(seed, 8, hi)) >= hedgeShare) continue;
    const a = cutAt(e.p, false),
      b = cutAt(e.q, false),
      points = trim(e.line, a, b);
    if (points.length < 2) continue;
    hedges.push({
      points,
      fields: [fa, fb],
      gaps: shift(gaps, a, l - a - b),
      height: hedgeHeight,
      width: hedgeWidth,
      lane: false,
    });
  }
  // 8. Hedge trees along each hedge, spaced by an exponential draw about the mean, kept off gaps and line ends.
  const trees: HedgeTree[] = [];
  hedges.forEach((h, k) => {
    const l = length(h.points);
    let s = spacing * (0.3 + unit(hash3(seed, 9, k)));
    for (let n = 0; s < l - 4; n++) {
      if (s > 4 && !h.gaps.some(([a, b]) => s > a - 5 && s < b + 5)) {
        const { at } = along(h.points, s),
          sp = SPECIES[pick(treeW, unit(hash4(seed, 10, k, n)))],
          [lo, hiH] = TREE_HEIGHT[sp];
        trees.push({
          at,
          species: sp,
          height: lo + (hiH - lo) * unit(hash4(seed, 11, k, n)),
          turn: 2 * Math.PI * unit(hash4(seed, 12, k, n)),
        });
      }
      // Exponential gap about the mean (a Poisson process along the hedge), at least 8 m.
      s += Math.max(8, -spacing * Math.log(1 - 0.98 * unit(hash4(seed, 13, k, n))));
    }
  });
  const exclusions: Exclusion[] = [
    ...lanes.map((l) => ({ kind: 'line' as const, points: l.points, width: l.width, verge: 1 })),
    ...hedges.map((h) => ({ kind: 'line' as const, points: h.points, width: h.width, verge: 0.5 })),
  ];
  return { fields, hedges, trees, lanes, gates, exclusions };
}

/** The field under `(x, z)`, or undefined off the farmland. */
export function fieldAt(farm: Farmland, x: number, z: number): Field | undefined {
  return farm.fields.find((f) => insidePolygon([x, z], f.outline));
}

/**
 * Biome edits that paint each field's use and each lane as the biomes of {@link lowlandFarmWorld} (or yours):
 * `polygon` fills for the fields and for `woods` (outlines painted as `farm-wood`), and `path` edits for the lanes. Apply them with `BiomeEditor` (load
 * `@margoengine/biomes/splines` first for the lanes). Fields of use `none` are left alone.
 */
export function farmlandEdits(
  farm: Farmland,
  biomes: Readonly<Partial<Record<Exclude<FieldUse, 'none'> | 'lane' | 'wood' | 'hedge', string>>> = {},
  woods: readonly (readonly Pt[])[] = [],
): BiomeEdit[] {
  const id = (k: Exclude<FieldUse, 'none'> | 'lane' | 'wood' | 'hedge') =>
    biomes[k] ?? (k === 'lane' ? 'farm-lane' : k === 'wood' ? 'farm-wood' : k === 'hedge' ? 'hedgerow' : k);
  // A hedge's runs between its gaps (the gates stay open ground).
  const runs = (h: Hedge): Pt[][] => {
    const out: Pt[][] = [];
    const open = (d: number) => h.gaps.some(([a, b]) => d >= a && d <= b);
    let run: Pt[] = open(0) ? [] : [h.points[0]],
      along = 0;
    for (let i = 1; i < h.points.length; i++) {
      const [ax, az] = h.points[i - 1],
        [bx, bz] = h.points[i],
        l = Math.hypot(bx - ax, bz - az),
        steps = Math.max(1, Math.ceil(l / 2));
      for (let k = 1; k <= steps; k++) {
        // Points along the hedge line in metres (steps is at least 1), not a placement decision.
        const p: Pt = [ax + ((bx - ax) * k) / steps, az + ((bz - az) * k) / steps], // float division
          d = along + (l * k) / steps; // float division
        if (open(d)) {
          if (run.length > 1) out.push(run);
          run = [];
        } else run.push(p);
      }
      along += l;
    }
    if (run.length > 1) out.push(run);
    return out;
  };
  return [
    ...farm.fields
      .filter((f) => f.use !== 'none')
      .map(
        (f): BiomeEdit => ({
          kind: 'polygon',
          layer: `paint/${id(f.use as Exclude<FieldUse, 'none'>)}`,
          points: f.outline,
          strength: 1,
          mode: 'set',
          falloff: 'constant',
        }),
      ),
    // Hedges as narrow painted strips of the hedgerow biome: its shrubs and hedge trees grow along them, drawn by the
    // view with the rest of its plants (LOD rings, far impostors, shadows and wind), never cut off at one radius.
    ...farm.hedges.flatMap((h) =>
      runs(h).map(
        (points): BiomeEdit => ({
          kind: 'path',
          layer: `paint/${id('hedge')}`,
          path: { points, width: h.width, edge: 0.5 },
          strength: 1,
          mode: 'set',
          falloff: 'constant',
        }),
      ),
    ),
    ...woods.map(
      (points): BiomeEdit => ({
        kind: 'polygon',
        layer: `paint/${id('wood')}`,
        points,
        strength: 1,
        mode: 'set',
        falloff: 'constant',
      }),
    ),
    ...farm.lanes.map(
      (l): BiomeEdit => ({
        kind: 'path',
        layer: `paint/${id('lane')}`,
        path: { points: l.points, width: l.width, edge: 1 },
        strength: 1,
        mode: 'set',
        falloff: 'smooth',
      }),
    ),
  ];
}

/**
 * Ground looks of the farmland biomes, to pass as `BiomeView` `materials`: winter pasture (dull green), ploughed
 * Mercia Mudstone clay (the red-brown soils round Hanbury), stubble, rough meadow and a mud and gravel lane.
 */
export const FARMLAND_MATERIALS: Readonly<Record<string, MaterialLook>> = Object.freeze({
  'winter-pasture': { color: [0.36, 0.45, 0.22], detail: 0.4, bump: 0.3, macro: 0.4 },
  plough: { color: [0.43, 0.28, 0.19], detail: 0.55, bump: 0.7, macro: 0.35 },
  stubble: { color: [0.66, 0.58, 0.37], detail: 0.5, bump: 0.35, macro: 0.3 },
  'rough-meadow': { color: [0.48, 0.5, 0.27], detail: 0.45, bump: 0.35, macro: 0.4 },
  'lane-gravel': { color: [0.47, 0.41, 0.33], detail: 0.4, bump: 0.4, macro: 0.25 },
});

const NEVER = [100000, null] as const;
const farmBiome = (id: string, material: string, details: BiomeDefinition['details'] = []): BiomeDefinition =>
  Object.freeze({
    id,
    // Painted only: an envelope no ground meets, so the paint layer alone places it.
    climate: { height: NEVER },
    ground: [{ material }, { material: 'mud', moisture: [0.85, null] }],
    details,
  } as BiomeDefinition);

/**
 * The English lowland farm world: a cool, wet temperate climate (52.8 N, about 730 mm of rain), rolling clay hills, and
 * its biomes: `pasture` (the base biome where nothing is painted), `farm-wood` (oak, ash, birch, holly and hazel over
 * ferns, mesh keys `library:<species>` and `library:fern` for the view's `meshes` registry; painted),
 * `plough`, `stubble`, `meadow` and `farm-lane` (painted by {@link farmlandEdits}). Paint each with
 * `paint: FARMLAND_PAINT` in `BiomeWorld.create`.
 */
export const lowlandFarmWorld: PresetWorld & { readonly biomes: readonly BiomeDefinition[] } = Object.freeze({
  climate: { latitude: 52.8, rainfall: 730 },
  relief: { relief: 90, base: 60 },
  biomes: Object.freeze([
    Object.freeze({
      id: 'farm-wood',
      // Painted only (woods, the wooded crater today): the base biome is pasture.
      climate: { height: NEVER },
      ground: [{ material: 'leaf-litter' }, { material: 'moss', moisture: [0.7, null] }],
      plants: [
        { id: 'oak', mesh: 'library:oak', density: 120, radius: 5, shade: 0.4 },
        { id: 'ash', mesh: 'library:ash', density: 90, radius: 4.5, shade: 0.5 },
        { id: 'birch', mesh: 'library:birch', density: 50, radius: 3, shade: 0.3 },
        { id: 'holly', mesh: 'library:holly', density: 40, radius: 1.5, shade: 0.8 },
        { id: 'hazel', mesh: 'library:hazel', density: 300, radius: 1.4, shade: 0.6 },
      ],
      details: [{ id: 'fern', mesh: 'library:fern', density: 6, light: [0, 0.6] }],
    } as BiomeDefinition),
    // Hedgerows (painted along the hedges by farmlandEdits): hawthorn and blackthorn shrubs about 1.2 m apart, the
    // hedgerow oaks and ashes of the Staffordshire claylands about 12 and 6 a kilometre, holly the one evergreen.
    Object.freeze({
      id: 'hedgerow',
      climate: { height: NEVER },
      ground: [{ material: 'rough-meadow' }, { material: 'mud', moisture: [0.85, null] }],
      plants: [
        { id: 'hawthorn', mesh: 'library:hawthorn', density: 2600, radius: 0.8, shade: 0.5 },
        { id: 'blackthorn', mesh: 'library:blackthorn', density: 900, radius: 0.8, shade: 0.4 },
        { id: 'hedge-oak', mesh: 'library:oak', density: 60, radius: 5, shade: 0.4 },
        { id: 'hedge-ash', mesh: 'library:ash', density: 30, radius: 4.5, shade: 0.5 },
        { id: 'hedge-holly', mesh: 'library:holly', density: 40, radius: 1.5, shade: 0.8 },
      ],
    } as BiomeDefinition),
    // The base biome: pasture wherever nothing else is painted (kept ground such as a village or a yard included).
    Object.freeze({
      id: 'pasture',
      climate: {},
      ground: [{ material: 'winter-pasture' }, { material: 'mud', moisture: [0.85, null] }],
    } as BiomeDefinition),
    farmBiome('plough', 'plough'),
    farmBiome('stubble', 'stubble'),
    farmBiome('meadow', 'rough-meadow'),
    farmBiome('farm-lane', 'lane-gravel'),
  ]),
});

/** The paint layers of the farm biomes, for `BiomeWorld.create({ paint })`. */
export const FARMLAND_PAINT = Object.freeze(
  ['pasture', 'plough', 'stubble', 'meadow', 'farm-lane', 'farm-wood', 'hedgerow'].map((biome) =>
    Object.freeze({ biome }),
  ),
);
