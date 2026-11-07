// Convex hulls for the own solver, built from points: Quickhull (Barber, Dobkin and Huhdanpaa, "The Quickhull Algorithm
// for Convex Hulls", ACM TOMS 22(4), 1996), with the repairs Gregorius names in "Implementing Quickhull" (GDC 2014).
//
// Each unprocessed point waits in the outside set of one face it lies above, and a face's farthest point is added next:
// the faces it can see go, and a fan from it to their horizon takes their place (the paper's Theorem 2.1). Planes are fat
// (Gregorius): a point counts as above a face only past `fat`, so points within rounding of the hull never make slivers,
// and a face counts as seen unless the eye is clearly below it, so a new face meets its horizon neighbour at a clearly
// convex edge. The result is a hull of triangles. Triangles then merge into the polygons the kernel asks for (Gregorius
// 2015: large faces, no neighbours in one plane): the paper's merging of coplanar facets, done here by growing each face
// from the largest triangle left, whose plane supports every point, over the triangles that lie within `thin` of it. A
// convex surface under a supporting plane bounds a region within such a slab from below by its edge, so a region grown
// this way has no holes; a triangle that would touch the region only at a corner waits until it shares a second edge.
//
// On the add path, as a game can add colliders in its step: no `Math` but `abs`, so the hull is the same in every browser.

/** A hull as the kernel takes it: vertices, and faces of vertex indices counter-clockwise seen from outside. */
export interface HullFaces {
  vertices: [number, number, number][];
  faces: number[][];
}

/** The kernel's flatness, as a share of the hull's size (`FLAT` in kernel/src/hull.rs). */
const FLAT = 1e-4;
/** Neighbours closer than this cosine are one plane to the kernel (`COPLANAR` in kernel/src/hull.rs). */
const COPLANAR = 0.9999;
/** The most edges the kernel takes on one face (`MAX_FACE_EDGES` in kernel/src/layout.rs). */
export const MAX_FACE_EDGES = 256;
/** Points closer to the hull than this share of its size, 2^-20, are on it: well over f32 rounding, well under FLAT. */
const FAT = 1 / 1048576;
/** How far a merged face's corners may lie from its plane, as a share of FLAT, so the kernel's own test has room. */
const THIN = 0.25;
/** Neighbours within this share of FLAT of each other's plane merge: over the kernel's half, under what FLAT leaves. */
const MERGE = 0.6;

/** A square root from only + - * /, as `Math.sqrt` is not promised to round the same everywhere. */
export function root(value: number): number {
  if (!(value > 0)) return 0;
  // A start within a factor of 2 from the exponent, then Newton from above.
  let estimate = 1,
    scaled = value;
  while (scaled > 4) {
    scaled /= 4;
    estimate *= 2;
  }
  while (scaled < 1) {
    scaled *= 4;
    estimate /= 2;
  }
  estimate *= 2;
  for (let i = 0; i < 64; i++) {
    const next = (estimate + value / estimate) / 2;
    if (!(next < estimate)) break;
    estimate = next;
  }
  return estimate;
}

const degenerate = (): RangeError =>
  new RangeError(
    'The hull could not close because these points are nearly degenerate; remove near-duplicate points or pass fewer, wider-spread points.',
  );

/**
 * The convex hull of flat x, y, z numbers as kernel faces. Points inside, duplicates and points within rounding of a
 * face are dropped, and triangles in one plane merge into one face.
 * @throws RangeError for fewer than four points, points that are not finite, or points that span no volume.
 */
export function buildHull(input: ArrayLike<number>): HullFaces {
  if (input.length % 3)
    throw new RangeError(`A convex hull got ${input.length} numbers; pass three (x, y, z) per point.`);
  const count = input.length / 3;
  if (count < 4) throw new RangeError(`A convex hull got ${count} points; pass at least four that span a volume.`);
  const low = [Infinity, Infinity, Infinity],
    high = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < input.length; i++) {
    const value = input[i];
    if (typeof value !== 'number' || !(value - value === 0))
      throw new RangeError(`Convex hull point ${(i / 3) | 0} is not finite; pass finite coordinates.`);
    const axis = i % 3;
    if (value < low[axis]) low[axis] = value;
    if (value > high[axis]) high[axis] = value;
  }
  // Centred, so the tolerances follow the cloud's size and not its distance from the origin.
  const p = new Float64Array(input.length);
  for (let i = 0; i < input.length; i++) p[i] = input[i] - (low[i % 3] + high[i % 3]) / 2;
  const span = [high[0] - low[0], high[1] - low[1], high[2] - low[2]],
    size = root(span[0] * span[0] + span[1] * span[1] + span[2] * span[2]),
    fat = size * FAT,
    thin = size * FLAT * THIN;

  // Faces: three vertices counter-clockwise from outside, the face across each edge k (from corner k to k + 1), a unit
  // normal and offset, twice the area, and the points waiting above it.
  const corner: number[] = [],
    across: number[] = [],
    normal: number[] = [],
    offset: number[] = [],
    area: number[] = [],
    alive: boolean[] = [],
    outside: number[][] = [],
    seen: number[] = [];
  const height = (f: number, i: number): number =>
    normal[f * 3] * p[i * 3] + normal[f * 3 + 1] * p[i * 3 + 1] + normal[f * 3 + 2] * p[i * 3 + 2] - offset[f];
  const addFace = (a: number, b: number, c: number): number => {
    const f = alive.length,
      ux = p[b * 3] - p[a * 3],
      uy = p[b * 3 + 1] - p[a * 3 + 1],
      uz = p[b * 3 + 2] - p[a * 3 + 2],
      vx = p[c * 3] - p[a * 3],
      vy = p[c * 3 + 1] - p[a * 3 + 1],
      vz = p[c * 3 + 2] - p[a * 3 + 2],
      nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx,
      length = root(nx * nx + ny * ny + nz * nz);
    if (!(length > 0)) throw degenerate();
    corner.push(a, b, c);
    across.push(-1, -1, -1);
    normal.push(nx / length, ny / length, nz / length);
    // Through the centroid, which rounds better than through one corner.
    offset.push(
      ((nx / length) * (p[a * 3] + p[b * 3] + p[c * 3]) +
        (ny / length) * (p[a * 3 + 1] + p[b * 3 + 1] + p[c * 3 + 1]) +
        (nz / length) * (p[a * 3 + 2] + p[b * 3 + 2] + p[c * 3 + 2])) /
        3,
    );
    area.push(length);
    alive.push(true);
    outside.push([]);
    seen.push(-1);
    return f;
  };
  /** The edge of face `g` that runs from `to` to `from`, the twin of `from` to `to`. */
  const edgeOf = (g: number, from: number, to: number): number => {
    for (let k = 0; k < 3; k++) if (corner[g * 3 + k] === to && corner[g * 3 + ((k + 1) % 3)] === from) return k;
    throw degenerate();
  };
  const link = (f: number, k: number, g: number, l: number): void => {
    across[f * 3 + k] = g;
    across[g * 3 + l] = f;
  };
  const assign = (faces: readonly number[], i: number): void => {
    let owner = -1,
      far = fat;
    for (const f of faces) {
      const d = height(f, i);
      if (d > far) {
        far = d;
        owner = f;
      }
    }
    if (owner >= 0) outside[owner].push(i);
  };

  // The first tetrahedron: the farthest apart pair of axis extremes, the point farthest from their line, then from their
  // plane (the paper picks points of largest or smallest coordinate where it can).
  const extremes: number[] = [];
  for (let axis = 0; axis < 3; axis++) {
    let least = 0,
      most = 0;
    for (let i = 1; i < count; i++) {
      if (p[i * 3 + axis] < p[least * 3 + axis]) least = i;
      if (p[i * 3 + axis] > p[most * 3 + axis]) most = i;
    }
    extremes.push(least, most);
  }
  let v0 = 0,
    v1 = 0,
    best = fat * fat;
  for (let i = 0; i < extremes.length; i++)
    for (let j = i + 1; j < extremes.length; j++) {
      const a = extremes[i] * 3,
        b = extremes[j] * 3,
        x = p[a] - p[b],
        y = p[a + 1] - p[b + 1],
        z = p[a + 2] - p[b + 2],
        d = x * x + y * y + z * z;
      if (d > best) [best, v0, v1] = [d, extremes[i], extremes[j]];
    }
  if (v0 === v1) throw new RangeError('The convex hull points all coincide; pass points that span a volume.');
  const dx = p[v1 * 3] - p[v0 * 3],
    dy = p[v1 * 3 + 1] - p[v0 * 3 + 1],
    dz = p[v1 * 3 + 2] - p[v0 * 3 + 2];
  let v2 = -1;
  best = fat * fat * (dx * dx + dy * dy + dz * dz);
  for (let i = 0; i < count; i++) {
    const x = p[i * 3] - p[v0 * 3],
      y = p[i * 3 + 1] - p[v0 * 3 + 1],
      z = p[i * 3 + 2] - p[v0 * 3 + 2],
      cx = y * dz - z * dy,
      cy = z * dx - x * dz,
      cz = x * dy - y * dx,
      d = cx * cx + cy * cy + cz * cz;
    if (d > best) [best, v2] = [d, i];
  }
  if (v2 < 0) throw new RangeError('The convex hull points all lie on one line; pass points that span a volume.');
  const base = addFace(v0, v1, v2);
  let v3 = -1;
  best = fat;
  for (let i = 0; i < count; i++) {
    const d = height(base, i);
    if (d > best || -d > best) [best, v3] = [d > 0 ? d : -d, i];
  }
  if (v3 < 0) throw new RangeError('The convex hull points all lie in one plane; pass points that span a volume.');
  // Start again with the base turned so the fourth point is behind it.
  if (height(base, v3) > 0) [v1, v2] = [v2, v1];
  corner.length = across.length = normal.length = offset.length = area.length = 0;
  alive.length = outside.length = seen.length = 0;
  const start = [addFace(v0, v1, v2), addFace(v3, v1, v0), addFace(v3, v2, v1), addFace(v3, v0, v2)];
  for (const f of start)
    for (let k = 0; k < 3; k++)
      if (across[f * 3 + k] < 0) {
        const from = corner[f * 3 + k],
          to = corner[f * 3 + ((k + 1) % 3)];
        for (const g of start)
          if (g !== f) {
            for (let l = 0; l < 3; l++)
              if (corner[g * 3 + l] === to && corner[g * 3 + ((l + 1) % 3)] === from) link(f, k, g, l);
          }
      }
  for (let i = 0; i < count; i++) if (i !== v0 && i !== v1 && i !== v2 && i !== v3) assign(start, i);

  // Faces gain points only when made, so one pass over the growing list reaches every face that has any.
  const horizon: number[] = [],
    visible: number[] = [],
    stack: number[] = [];
  for (let current = 0; current < alive.length; current++) {
    if (!alive[current] || !outside[current].length) continue;
    let eye = -1,
      far = -Infinity;
    for (const i of outside[current]) {
      const d = height(current, i);
      if (d > far) [far, eye] = [d, i];
    }
    // Depth first over the faces the eye sees; each frame is a face, the edge it was entered by, and how many of its
    // edges are done, so the horizon comes out as one counter-clockwise loop (Gregorius 2014).
    horizon.length = visible.length = stack.length = 0;
    seen[current] = eye;
    visible.push(current);
    stack.push(current, 0, 0);
    while (stack.length) {
      const top = stack.length - 3,
        f = stack[top],
        entry = stack[top + 1],
        done = stack[top + 2];
      if (done === (f === current ? 3 : 2)) {
        stack.length = top;
        continue;
      }
      stack[top + 2] = done + 1;
      const k = (entry + done + (f === current ? 0 : 1)) % 3,
        g = across[f * 3 + k];
      if (seen[g] === eye) continue;
      if (height(g, eye) > -fat) {
        seen[g] = eye;
        visible.push(g);
        stack.push(g, edgeOf(g, corner[f * 3 + k], corner[f * 3 + ((k + 1) % 3)]), 0);
      } else horizon.push(f, k);
    }
    const loop = horizon.length / 2;
    for (let h = 0; h < loop; h++) {
      const [f, k] = [horizon[h * 2], horizon[h * 2 + 1]],
        [g, l] = [horizon[((h + 1) % loop) * 2], horizon[((h + 1) % loop) * 2 + 1]];
      if (corner[f * 3 + ((k + 1) % 3)] !== corner[g * 3 + l]) throw degenerate();
    }
    const made: number[] = [];
    for (let h = 0; h < loop; h++) {
      const f = horizon[h * 2],
        k = horizon[h * 2 + 1],
        a = corner[f * 3 + k],
        b = corner[f * 3 + ((k + 1) % 3)],
        g = across[f * 3 + k],
        n = addFace(a, b, eye);
      link(n, 0, g, edgeOf(g, a, b));
      made.push(n);
    }
    for (let h = 0; h < loop; h++) link(made[h], 1, made[(h + 1) % loop], 2);
    for (const f of visible) {
      alive[f] = false;
      for (const i of outside[f]) if (i !== eye) assign(made, i);
      outside[f] = [];
    }
  }

  // Merge into polygons, largest triangle first, each growing over neighbours within `thin` of its plane.
  const faces: number[] = [];
  for (let f = 0; f < alive.length; f++) if (alive[f]) faces.push(f);
  faces.sort((a, b) => area[b] - area[a] || a - b);
  const region = new Int32Array(alive.length).fill(-1),
    inside = new Int32Array(count),
    degree = new Int32Array(count);
  for (const f of faces) for (let k = 0; k < 3; k++) degree[corner[f * 3 + k]]++;
  const groups: number[][] = [],
    queue: number[] = [];
  for (const seed of faces) {
    if (region[seed] >= 0) continue;
    const id = groups.length,
      members: number[] = [];
    const take = (f: number): void => {
      region[f] = id;
      members.push(f);
      for (let k = 0; k < 3; k++) {
        inside[corner[f * 3 + k]]++;
        queue.push(across[f * 3 + k]);
      }
    };
    take(seed);
    while (queue.length) {
      const t = queue.pop()!;
      if (region[t] >= 0) continue;
      if (
        normal[t * 3] * normal[seed * 3] + normal[t * 3 + 1] * normal[seed * 3 + 1] + normal[t * 3 + 2] * normal[seed * 3 + 2] <=
        0.5
      )
        continue;
      let shared = 0,
        edge = -1;
      for (let k = 0; k < 3; k++) {
        const d = height(seed, corner[t * 3 + k]);
        if (d > thin || -d > thin) {
          shared = -1;
          break;
        }
        if (region[across[t * 3 + k]] === id) {
          shared++;
          edge = k;
        }
      }
      if (shared < 1) continue;
      // One shared edge: the corner across it must be new to the region, or the region would pinch there. It waits for
      // a second shared edge. Two or three shared edges close a notch of a disk, which stays a disk.
      if (shared === 1 && inside[corner[t * 3 + ((edge + 2) % 3)]] > 0) continue;
      take(t);
    }
    for (const f of members) for (let k = 0; k < 3; k++) inside[corner[f * 3 + k]]--;
    groups.push(members);
  }

  // Each group's outline: each boundary half-edge leads from a corner to the next, once.
  const outline = (id: number): number[] => {
    const next = new Map<number, number>();
    let first = -1,
      edges = 0;
    for (const f of groups[id])
      for (let k = 0; k < 3; k++)
        if (region[across[f * 3 + k]] !== id) {
          const a = corner[f * 3 + k];
          if (next.has(a)) throw degenerate();
          next.set(a, corner[f * 3 + ((k + 1) % 3)]);
          if (first < 0) first = a;
          edges++;
        }
    const polygon = [first];
    for (let v = next.get(first)!; v !== first; v = next.get(v)!) {
      if (polygon.length > edges) throw degenerate();
      polygon.push(v);
    }
    if (polygon.length !== edges || edges < 3) throw degenerate();
    return polygon;
  };
  // A polygon's plane as the kernel finds it: Newell's normal, through the corners' mean.
  const plane = (polygon: readonly number[]): number[] => {
    let x = 0,
      y = 0,
      z = 0,
      mx = 0,
      my = 0,
      mz = 0;
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i] * 3,
        b = polygon[(i + 1) % polygon.length] * 3;
      x += (p[a + 1] - p[b + 1]) * (p[a + 2] + p[b + 2]);
      y += (p[a + 2] - p[b + 2]) * (p[a] + p[b]);
      z += (p[a] - p[b]) * (p[a + 1] + p[b + 1]);
      mx += p[a];
      my += p[a + 1];
      mz += p[a + 2];
    }
    const length = root(x * x + y * y + z * z);
    x /= length;
    y /= length;
    z /= length;
    return [x, y, z, (x * mx + y * my + z * mz) / polygon.length];
  };
  const within = (polygon: readonly number[], of: readonly number[]): boolean =>
    polygon.every((v) => {
      const d = of[0] * p[v * 3] + of[1] * p[v * 3 + 1] + of[2] * p[v * 3 + 2] - of[3];
      return d <= wide && -d <= wide;
    });

  // Neighbours the kernel would call one plane split in two (COPLANAR in kernel/src/hull.rs) merge, wider than its band so
  // rounding to f32 cannot leave one behind; what merges stays within the kernel's FLAT.
  const wide = size * FLAT * MERGE;
  let polygons: number[][];
  for (;;) {
    const live = groups.map((members, id) => (members.length ? id : -1)).filter((id) => id >= 0);
    polygons = [];
    const planes: number[][] = [],
      owner = new Map<number, number>(),
      ids: number[] = [];
    for (const id of live) {
      const polygon = outline(id),
        f = polygons.length;
      polygons.push(polygon);
      planes.push(plane(polygon));
      ids.push(id);
      for (let i = 0; i < polygon.length; i++) owner.set(polygon[i] * count + polygon[(i + 1) % polygon.length], f);
    }
    // The paper's independent sets of merges, sorted by angle: each pass joins pairs that share no face, closest first.
    const pairs: number[][] = [];
    for (let f = 0; f < polygons.length; f++) {
      const polygon = polygons[f];
      for (let i = 0; i < polygon.length; i++) {
        const g = owner.get(polygon[(i + 1) % polygon.length] * count + polygon[i]);
        if (g === undefined) throw degenerate();
        if (g < f) continue;
        const [a, b] = [planes[f], planes[g]],
          cosine = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
        if (cosine > COPLANAR && within(polygons[g], a) && within(polygon, b)) pairs.push([cosine, f, g]);
      }
    }
    pairs.sort((x, y) => y[0] - x[0] || x[1] - y[1] || x[2] - y[2]);
    const used = new Set<number>();
    let merged = false;
    for (const [, f, g] of pairs) {
      if (used.has(f) || used.has(g)) continue;
      used.add(f).add(g);
      for (const t of groups[ids[g]]) region[t] = ids[f];
      groups[ids[f]].push(...groups[ids[g]]);
      groups[ids[g]] = [];
      merged = true;
    }
    if (!merged) break;
  }
  for (const polygon of polygons)
    if (polygon.length > MAX_FACE_EDGES)
      throw new RangeError(
        `A face of this convex hull has ${polygon.length} corners and the solver takes ${MAX_FACE_EDGES}; pass fewer points around that face.`,
      );

  // Keep the vertices the faces use, in the order first used, at the coordinates given.
  const place = new Int32Array(count).fill(-1),
    vertices: [number, number, number][] = [];
  const out = polygons.map((polygon) =>
    polygon.map((v) => {
      if (place[v] < 0) {
        place[v] = vertices.length;
        vertices.push([input[v * 3], input[v * 3 + 1], input[v * 3 + 2]]);
      }
      return place[v];
    }),
  );
  return { vertices, faces: out };
}
