// `@margoengine/physics/decomposition`: approximate convex decomposition of a closed triangle mesh, after Wei, Liu, Ling
// and Su, "Approximate Convex Decomposition for 3D Meshes with Collision-Aware Concavity and Tree Search", ACM TOG 41(4)
// 42, 2022 (arXiv 2205.02961). Algorithm 1: a queue of parts; a part whose concavity (Eq. 6) is under the threshold is
// done, any other is cut by the plane the tree search finds (section 6) and both halves go back; then adjacent parts
// merge while the merged part stays under the threshold (section 6.5).
//
// Its own entry so a game pays for it only when it imports it: the `convexDecomposition` collider takes the parts this
// returns. Build-time work: decompose once, keep the result, reuse it for every body.
import { createRandom } from '@margoengine/math/mathutils';
import { MargoError } from '@margoengine/math/errors';
import { geometryPositions, type ColliderGeometry } from './shapes.js';
import { concavity as concavityOf, cut, hullOf, Solid, type Plane, type Random } from './decomposition/mesh.js';
import { searchPlane, type SearchSettings } from './decomposition/search.js';

/**
 * Options of {@link convexDecomposition}. `concavity` and `maxConvexHulls` keep Rapier's `VHACDParameters` names; the
 * others are the paper's (Wei et al. 2022, appendix C) and have no V-HACD counterpart.
 */
export interface ConvexDecompositionOptions {
  /**
   * The most a part may differ from its convex hull, as a share of the mesh's largest side (default 0.05, the paper's):
   * the larger of the farthest gap between the two surfaces and 0.3 times the radius of a ball holding the volume the
   * hull adds. Lower gives more, tighter parts.
   */
  concavity?: number;
  /** The most parts (default 64). The search cuts the least convex part first, so a cap leaves the worst ones cut. */
  maxConvexHulls?: number;
  /** Candidate planes per axis for each cut (default 20). More find better cuts and cost more. */
  planes?: number;
  /** Tree search iterations for each cut (default 500). */
  iterations?: number;
  /** Cuts the search looks ahead (default 4). */
  depth?: number;
  /** Merge adjacent parts afterwards while they stay under `concavity` (default true). */
  merge?: boolean;
  /** Seed of the search and the surface samples (default 0): the same mesh, options and seed give the same parts, bit for bit. */
  seed?: number;
  /** Milliseconds before it stops with a `timeout` MargoError (default 60,000): it never returns a part-done result. */
  timeLimit?: number;
}

/** A decomposition: pass it as a collider, `body.addCollider(decomposition)`, on `@margoengine/physics/next` or the root entry. */
export interface ConvexDecomposition {
  shape: 'convexDecomposition';
  /** Each part as the points of its convex hull, in the mesh's own units and frame. */
  parts: { shape: 'convexHull'; points: Float32Array }[];
  /** Each part's concavity, in the units of the `concavity` option (a share of the mesh's largest side). */
  concavity: number[];
}

/** Surface samples per unit area of the unit-sized mesh (appendix C). */
const DENSITY = 3000;

function count(value: number | undefined, fallback: number, name: string, low: number): number {
  const n = value ?? fallback;
  if (!Number.isInteger(n) || n < low) throw new RangeError(`${name} must be a whole number of at least ${low} (got ${value}).`);
  return n;
}

/**
 * The mesh as a solid scaled to a largest side of 1 around its centre: as given when every directed edge has its
 * reverse, else with equal positions welded first (split UV seams); a mesh still open after that is refused.
 */
function solidOf(source: ColliderGeometry): { solid: Solid; center: number[]; size: number } {
  const positions = geometryPositions(source),
    raw = source.indices;
  if (!raw) throw new TypeError('A convex decomposition needs indices; pass indices or an indexed geometry.');
  if (!raw.length || raw.length % 3) throw new RangeError('A convex decomposition needs whole triangles: three indices each.');
  const vertexCount = positions.length / 3;
  for (let i = 0; i < raw.length; i++)
    if (!Number.isInteger(raw[i]) || raw[i] < 0 || raw[i] >= vertexCount)
      throw new RangeError(`Index ${raw[i]} at ${i} is outside the ${vertexCount} vertices; pass indices of existing vertices.`);
  for (let i = 0; i < positions.length; i++)
    if (!Number.isFinite(positions[i])) throw new RangeError('Convex decomposition vertices must be finite numbers.');
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i++) {
    const a = i % 3;
    if (positions[i] < min[a]) min[a] = positions[i];
    if (positions[i] > max[a]) max[a] = positions[i];
  }
  const center = [0, 1, 2].map((a) => (min[a] + max[a]) / 2),
    size = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  if (!(size > 0)) throw new RangeError('A convex decomposition needs a mesh that spans a volume.');
  const scaled = new Float64Array(positions.length);
  for (let i = 0; i < positions.length; i++) scaled[i] = (positions[i] - center[i % 3]) / size;
  let triangles = dropDegenerate(Uint32Array.from(raw));
  if (open(triangles, vertexCount)) {
    triangles = dropDegenerate(weld(scaled, triangles));
    if (open(triangles, vertexCount))
      throw new RangeError(
        'A convex decomposition needs a closed mesh: some edges have no triangle on their other side. Close the holes, or use a trimesh collider for a fixed body.',
      );
  }
  let solid = new Solid(scaled, triangles, new Int32Array(triangles.length / 3).fill(-1));
  // A mesh wound inside out (every triangle facing in) is turned the right way.
  if (solid.volume < 0) {
    for (let i = 0; i < triangles.length; i += 3) [triangles[i + 1], triangles[i + 2]] = [triangles[i + 2], triangles[i + 1]];
    solid = new Solid(scaled, triangles, solid.cap);
  }
  if (!(solid.volume > 0)) throw new RangeError('A convex decomposition needs a closed mesh that holds a volume; this one holds none.');
  return { solid, center, size };
}

function dropDegenerate(t: Uint32Array): Uint32Array {
  const kept: number[] = [];
  for (let i = 0; i < t.length; i += 3) if (t[i] !== t[i + 1] && t[i + 1] !== t[i + 2] && t[i] !== t[i + 2]) kept.push(t[i], t[i + 1], t[i + 2]);
  return Uint32Array.from(kept);
}

/** Whether some directed edge lacks its reverse as often as it appears. */
function open(t: Uint32Array, n: number): boolean {
  const edges = new Map<number, number>();
  for (let i = 0; i < t.length; i += 3)
    for (let k = 0; k < 3; k++) {
      const a = t[i + k],
        b = t[i + ((k + 1) % 3)];
      edges.set(a * n + b, (edges.get(a * n + b) ?? 0) + 1);
    }
  for (const [key, uses] of edges) {
    const a = Math.floor(key / n),
      b = key - a * n;
    if (edges.get(b * n + a) !== uses) return true;
  }
  return false;
}

/** Indices with every vertex replaced by the first one at the same position. */
function weld(p: Float64Array, t: Uint32Array): Uint32Array {
  const first = new Map<string, number>(),
    out = new Uint32Array(t.length);
  for (let i = 0; i < t.length; i++) {
    const v = t[i],
      key = `${p[v * 3]},${p[v * 3 + 1]},${p[v * 3 + 2]}`;
    let to = first.get(key);
    if (to === undefined) first.set(key, (to = v));
    out[i] = to;
  }
  return out;
}

/** A part waiting in the queue or done, with its concavity. */
interface Entry {
  solid: Solid;
  concavity: number;
}

/**
 * Splits a closed triangle mesh into convex parts (Wei, Liu, Ling and Su 2022), so a dynamic body gets a hollow cup, a
 * torus or a handle right where a single hull fills them in. The result is a collider:
 *
 * ```ts
 * import { convexDecomposition } from '@margoengine/physics/decomposition';
 * const cup = convexDecomposition({ vertices, indices });
 * physics.addBody(mesh, { colliders: cup });
 * ```
 *
 * @throws RangeError for a mesh that is open, flat or not a whole number of triangles, or for options out of range.
 * @throws MargoError `timeout` past `timeLimit`.
 */
export function convexDecomposition(mesh: ColliderGeometry, options: ConvexDecompositionOptions = {}): ConvexDecomposition {
  const threshold = options.concavity ?? 0.05;
  if (!(threshold > 0) || !Number.isFinite(threshold))
    throw new RangeError(`concavity must be a positive share of the mesh size, such as 0.05 (got ${options.concavity}).`);
  const maxParts = count(options.maxConvexHulls, 64, 'maxConvexHulls', 1),
    timeLimit = options.timeLimit ?? 60000;
  if (!(timeLimit > 0)) throw new RangeError(`timeLimit must be a positive number of milliseconds (got ${options.timeLimit}).`);
  const start = Date.now(),
    random: Random = createRandom(options.seed ?? 0),
    settings: SearchSettings = {
      planes: count(options.planes, 20, 'planes', 1),
      iterations: count(options.iterations, 500, 'iterations', 1),
      depth: count(options.depth, 4, 'depth', 1),
      random,
      check: () => {
        if (Date.now() - start > timeLimit)
          throw new MargoError(
            'timeout',
            `Convex decomposition passed its time limit of ${timeLimit} ms; raise timeLimit, or lower iterations, planes or depth.`,
          );
      },
    };
  const { solid, center, size } = solidOf(mesh),
    queue: Entry[] = [{ solid, concavity: concavityOf(solid, DENSITY, random) }],
    done: Entry[] = [];
  let planeId = 0;
  // Algorithm 1, the least convex part first, so `maxConvexHulls` stops with the worst parts cut.
  while (queue.length) {
    let pick = 0;
    for (let i = 1; i < queue.length; i++) if (queue[i].concavity > queue[pick].concavity) pick = i;
    const [entry] = queue.splice(pick, 1);
    if (entry.concavity < threshold || done.length + queue.length + 2 > maxParts) {
      done.push(entry);
      continue;
    }
    const plane = searchPlane(entry.solid, entry.concavity, settings),
      halves = plane ? cut(entry.solid, plane, planeId++) : null;
    if (!halves || !halves[0].hull() || !halves[1].hull()) {
      done.push(entry);
      continue;
    }
    for (const half of halves) queue.push({ solid: half, concavity: concavityOf(half, DENSITY, random) });
  }
  const parts = options.merge === false ? done : merge(done, threshold, random, settings.check);
  return {
    shape: 'convexDecomposition',
    parts: parts.map(({ solid }) => {
      const hull = solid.hull()!,
        points = new Float32Array(hull.points.length);
      for (let i = 0; i < points.length; i++) points[i] = hull.points[i] * size + center[i % 3];
      return { shape: 'convexHull' as const, points };
    }),
    concavity: parts.map((part) => part.concavity),
  };
}

/**
 * The paper's score of a decomposition (Eq. 10): the largest concavity (Eq. 6) of the mesh clipped to each part's hull,
 * in the units of the `concavity` option. It measures any set of convex parts against the mesh, Rapier's V-HACD
 * parts included, so settings and methods compare on one scale.
 * @throws RangeError for a mesh that `convexDecomposition` would refuse.
 */
export function decompositionConcavity(
  mesh: ColliderGeometry,
  parts: readonly { readonly points: ArrayLike<number> }[],
  options: { seed?: number } = {},
): number {
  const { solid, center, size } = solidOf(mesh),
    random = createRandom(options.seed ?? 0);
  let worst = 0;
  for (const part of parts) {
    const scaled = Float64Array.from(part.points, (v, i) => (v - center[i % 3]) / size),
      hull = hullOf(scaled);
    if (!hull) continue;
    let piece: Solid | null = solid;
    for (let f = 0; f < hull.planes.length && piece; f += 4) {
      const plane: Plane = { normal: [hull.planes[f], hull.planes[f + 1], hull.planes[f + 2]], offset: hull.planes[f + 3] },
        halves = cut(piece, plane, CLIP);
      // No split: the piece lies wholly inside this face's plane, or wholly outside it, by its first vertex.
      if (halves) piece = halves[0];
      else if (plane.normal[0] * piece.positions[0] + plane.normal[1] * piece.positions[1] + plane.normal[2] * piece.positions[2] >= plane.offset)
        piece = null;
    }
    if (piece && piece.volume > 0) {
      const value = concavityOf(piece, DENSITY, random);
      if (value > worst) worst = value;
    }
  }
  return worst;
}

/** The plane id of clipping cuts, which keep no caps for merging. */
const CLIP = 0x3ffffffe;

/** The area and centroid of a solid's cap triangles with one tag. */
function capFace(solid: Solid, tag: number): number[] {
  const p = solid.positions,
    t = solid.triangles;
  let area = 0,
    x = 0,
    y = 0,
    z = 0;
  for (let f = 0; f < solid.cap.length; f++) {
    if (solid.cap[f] !== tag) continue;
    const a = t[f * 3] * 3,
      b = t[f * 3 + 1] * 3,
      c = t[f * 3 + 2] * 3;
    const ux = p[b] - p[a],
      uy = p[b + 1] - p[a + 1],
      uz = p[b + 2] - p[a + 2],
      vx = p[c] - p[a],
      vy = p[c + 1] - p[a + 1],
      vz = p[c + 2] - p[a + 2];
    // Twice the area as the length of the cross product, along the plane's normal for a cap: its largest component.
    const cx = uy * vz - uz * vy,
      cy = uz * vx - ux * vz,
      cz = ux * vy - uy * vx,
      twice = Math.max(cx < 0 ? -cx : cx, cy < 0 ? -cy : cy, cz < 0 ? -cz : cz);
    area += twice;
    x += (twice * (p[a] + p[b] + p[c])) / 3;
    y += (twice * (p[a + 1] + p[b + 1] + p[c + 1])) / 3;
    z += (twice * (p[a + 2] + p[b + 2] + p[c + 2])) / 3;
  }
  return area > 0 ? [area, x / area, y / area, z / area] : [0, 0, 0, 0];
}

/**
 * The cut face two parts share, when one's cap and the other's opposite cap on one plane cover the same region: the
 * same area and centroid. Parts that touch over only some of a cut face are not joined.
 */
function shared(a: Solid, b: Solid): number {
  const tags = new Set<number>();
  for (const tag of a.cap) if (tag >= 0) tags.add(tag);
  for (const tag of tags) {
    const other = tag ^ 1;
    if (!b.cap.includes(other)) continue;
    const fa = capFace(a, tag),
      fb = capFace(b, other),
      scale = fa[0] > fb[0] ? fa[0] : fb[0];
    let same = scale > 0;
    for (let i = 0; i < 4 && same; i++) {
      const d = fa[i] - fb[i];
      same = (d < 0 ? -d : d) <= 1e-9 * (i ? 1 : scale);
    }
    if (same) return tag >> 1;
  }
  return -1;
}

/** Two parts as one, without the cut face between them. */
function joined(a: Solid, b: Solid, plane: number): Solid {
  const positions = new Float64Array(a.positions.length + b.positions.length);
  positions.set(a.positions);
  positions.set(b.positions, a.positions.length);
  const offset = a.positions.length / 3,
    triangles: number[] = [],
    cap: number[] = [];
  for (const [solid, base] of [
    [a, 0],
    [b, offset],
  ] as const)
    for (let f = 0; f < solid.cap.length; f++) {
      if (solid.cap[f] >= 0 && solid.cap[f] >> 1 === plane) continue;
      triangles.push(solid.triangles[f * 3] + base, solid.triangles[f * 3 + 1] + base, solid.triangles[f * 3 + 2] + base);
      cap.push(solid.cap[f]);
    }
  return new Solid(positions, Uint32Array.from(triangles), Int32Array.from(cap), a.volume + b.volume);
}

/** Section 6.5: join the adjacent pair with the lowest merged concavity under the threshold, until none is left. */
function merge(parts: Entry[], threshold: number, random: Random, check: () => void): Entry[] {
  const list = [...parts],
    cache = new Map<Entry, Map<Entry, Entry | null>>();
  for (;;) {
    let best: [number, number, Entry] | null = null;
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        let row = cache.get(list[i]);
        if (!row) cache.set(list[i], (row = new Map()));
        if (!row.has(list[j])) {
          check();
          const plane = shared(list[i].solid, list[j].solid);
          let entry: Entry | null = null;
          if (plane >= 0) {
            const solid = joined(list[i].solid, list[j].solid, plane);
            entry = { solid, concavity: concavityOf(solid, DENSITY, random) };
          }
          row.set(list[j], entry);
        }
        const entry = row.get(list[j]);
        if (entry && entry.concavity < threshold && (!best || entry.concavity < best[2].concavity)) best = [i, j, entry];
      }
    if (!best) return list;
    const [i, j, entry] = best;
    list.splice(j, 1);
    list.splice(i, 1, entry);
  }
}
