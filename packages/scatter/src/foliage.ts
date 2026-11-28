// Foliage levels of detail (`@margoengine/scatter/foliage`): a leaf or needle mesh made lighter without thinning its
// crown (KB-SCATTER-TEX2). Edge collapse removes the area of needles: a scanned fir's 4,066,119 needle triangles cut to
// 76,892 kept 35.8 of its 367 m2 and a quarter of its silhouette, so the tree read as a skeleton. Here whole elements
// (the mesh's connected pieces) are removed instead and the survivors grow: the stochastic simplification of aggregate
// detail of Cook, Halstead, Planck and Ryu, SIGGRAPH 2007
// (https://graphics.pixar.com/library/StochasticSimplification/), widening thin elements before lengthening them (down
// to `slender`, so needles do not turn into square leaves). How
// far they grow is measured, not assumed: Cook et al. keep the total area and note that overlap changes what is seen,
// and pruning that keeps the projected coverage (Neubert, Pirk, Deussen and Dachsbacher, "Improved Model- and
// View-Dependent Pruning of Large Botanical Scenes", Computer Graphics Forum 30(6), 2011,
// https://diglib.eg.org/handle/10.1111/v30i6pp1708-1718) holds a crown's look: the one scale of a level is found so
// that its silhouettes along the three axes cover what the source's cover. Keeping area alone drew the fir's levels 12%
// to 46% fuller than the scan. The removal order steps along a Morton curve of the element centres by the golden ratio,
// a low-discrepancy sequence, so what remains covers the crown evenly, and each level's elements are a subset of the
// level before.
import { rangeError, typeError } from '../../shared/errors.js';

/** A triangle mesh of many small separate pieces (needles, leaves, leaf cards, twigs). */
export interface FoliageMesh {
  /** Three per vertex. */
  readonly positions: ArrayLike<number>;
  /** Three per vertex. */
  readonly normals: ArrayLike<number>;
  /** Three per triangle. Triangles that share a vertex index belong to one element. */
  readonly indices: ArrayLike<number>;
  /** Texture coordinates, two per vertex, kept with their vertices. */
  readonly uvs?: ArrayLike<number>;
}

/** Options of {@link foliageLODs}. */
export interface FoliageLODOptions {
  /** The most triangles of each level, largest first (up to eight levels), such as `[76000, 8000, 2000]`. */
  readonly triangles: readonly number[];
  /**
   * A surface area for every level to hold instead, in the mesh's own units squared (the source's area keeps the
   * lighting's optical depth, and draws a dense crown fuller). Default: each level grows until its silhouettes along
   * the x, y and z axes cover what the source's cover.
   */
  readonly area?: number;
  /**
   * How many times longer than wide a thin element stays while it grows: it widens to this first, then grows both ways.
   * 1 widens needles to squares; a large number scales every element evenly. 1 or more. Default 4.
   */
  readonly slender?: number;
  /** Which elements stay: an integer from 0 to 4294967295. Default 1. */
  readonly seed?: number;
}

/** One level: its own vertices, ready for a core `Geometry` and Scatter `textures.uvs`. */
export interface FoliageLevel {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly indices: Uint32Array;
  /** Present when the source has `uvs`. */
  readonly uvs?: Float32Array;
  readonly triangles: number;
  /** Elements kept. */
  readonly elements: number;
  /** Surface area of the level. */
  readonly area: number;
  /** The level's silhouette area over the source's, summed over views along x, y and z (1 matches). */
  readonly coverage: number;
}

const MOST_ELEMENTS = 2 ** 23;
// An element over this many times the median element area is not aggregate detail (a twig's stem among its needles).
const STEM = 8;
// Silhouette grid cells over the mesh's largest side, and cells around it that grown elements may reach.
const GRID = 512;
const MARGIN = 64;
const GOLDEN = 0.6180339887498949;
const bad = (message: string) => typeError(message, 'scatter');
const out = (message: string) => rangeError(message, 'scatter');

/** Spreads the low 10 bits of `v` three apart (a 3D Morton code, Morton 1966). */
function spread(v: number): number {
  let x = v & 1023;
  x = (x | (x << 16)) & 0x030000ff;
  x = (x | (x << 8)) & 0x0300f00f;
  x = (x | (x << 4)) & 0x030c30c3;
  x = (x | (x << 2)) & 0x09249249;
  return x >>> 0;
}

/** The area of the triangle whose corners start at offsets `a`, `b` and `c` of `p`. */
function triangleArea(p: ArrayLike<number>, a: number, b: number, c: number): number {
  const ux = p[b] - p[a],
    uy = p[b + 1] - p[a + 1],
    uz = p[b + 2] - p[a + 2],
    vx = p[c] - p[a],
    vy = p[c + 1] - p[a + 1],
    vz = p[c + 2] - p[a + 2];
  return 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
}

/**
 * Silhouette samples a mesh covers, seen along x, y and z: one sample at each centre of a grid of `GRID` cells over the
 * source's largest side (`low` its minimum corner). Point samples estimate the area without bias for triangles far
 * thinner than a cell.
 */
function covered(
  p: ArrayLike<number>,
  index: ArrayLike<number>,
  low: number[],
  cell: number,
  grids: Uint8Array,
): number {
  grids.fill(0);
  const size = GRID + 2 * MARGIN;
  let count = 0;
  for (let view = 0; view < 3; view++) {
    const i0 = view === 0 ? 2 : 0,
      i1 = view === 1 ? 2 : 1,
      base = view * size * size,
      ox = low[i0] - MARGIN * cell,
      oy = low[i1] - MARGIN * cell;
    for (let t = 0; t < index.length; t += 3) {
      const a = index[t] * 3,
        b = index[t + 1] * 3,
        c = index[t + 2] * 3,
        ax = (p[a + i0] - ox) / cell - 0.5,
        ay = (p[a + i1] - oy) / cell - 0.5,
        bx = (p[b + i0] - ox) / cell - 0.5,
        by = (p[b + i1] - oy) / cell - 0.5,
        cx = (p[c + i0] - ox) / cell - 0.5,
        cy = (p[c + i1] - oy) / cell - 0.5,
        d = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      if (!d) continue;
      const x0 = Math.max(0, Math.ceil(Math.min(ax, bx, cx))),
        x1 = Math.min(size - 1, Math.floor(Math.max(ax, bx, cx))),
        y0 = Math.max(0, Math.ceil(Math.min(ay, by, cy))),
        y1 = Math.min(size - 1, Math.floor(Math.max(ay, by, cy)));
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          const at = base + y * size + x;
          if (grids[at]) continue;
          const u = ((bx - x) * (cy - y) - (by - y) * (cx - x)) / d,
            v = ((cx - x) * (ay - y) - (cy - y) * (ax - x)) / d;
          if (u >= 0 && v >= 0 && u + v <= 1) {
            grids[at] = 1;
            count++;
          }
        }
    }
  }
  return count;
}

function check(mesh: FoliageMesh, options: FoliageLODOptions): void {
  const arrayLike = (a: unknown): a is ArrayLike<number> =>
    typeof a === 'object' && a !== null && Number.isInteger((a as ArrayLike<number>).length);
  if (!mesh || !arrayLike(mesh.positions) || !arrayLike(mesh.normals) || !arrayLike(mesh.indices))
    throw bad('foliageLODs takes a mesh of positions, normals and indices; pass the foliage part of your model');
  const n = mesh.positions.length;
  if (
    !n ||
    n % 3 ||
    mesh.normals.length !== n ||
    !mesh.indices.length ||
    mesh.indices.length % 3 ||
    (mesh.uvs !== undefined && (!arrayLike(mesh.uvs) || mesh.uvs.length !== (n / 3) * 2))
  )
    throw bad(
      'foliageLODs needs three positions and three normals a vertex, two uvs a vertex when given, and three indices a triangle',
    );
  if (!options || !Array.isArray(options.triangles))
    throw bad('foliageLODs options need triangles, one budget a level, such as { triangles: [76000, 8000, 2000] }');
  const budgets = options.triangles as number[];
  if (
    !budgets.length ||
    budgets.length > 8 ||
    budgets.some((b, i) => !(Number.isInteger(b) && b >= 1) || (i > 0 && b > budgets[i - 1]))
  )
    throw out('foliageLODs triangles are one to eight whole numbers of 1 or more, largest first');
  if (options.area !== undefined && !(options.area > 0 && Number.isFinite(options.area)))
    throw out('foliageLODs area must be a positive finite number; omit it to keep the source area');
  if (options.slender !== undefined && !(options.slender >= 1 && Number.isFinite(options.slender)))
    throw out('foliageLODs slender must be a finite number of 1 or more');
  const seed = options.seed ?? 1;
  if (!(Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff))
    throw out('foliageLODs seed must be an integer from 0 to 4294967295');
}

/**
 * Lighter levels of a foliage mesh that keep its crown: whole elements are removed in an even, seeded order and the
 * rest are widened (until `slender` times longer than wide) and then scaled up, about their own centres, until the level's silhouettes
 * cover what the source's cover (or until its surface area is `area`). Pieces over 8 times the median piece's area
 * (stems) keep their size. Texture coordinates stay with their vertices. A
 * level that holds every element is the source's triangles unchanged (without `area`). Give it foliage only (a trunk
 * is one element and cannot be pruned); weld a mesh whose leaves are split at seams first. Pure CPU work: linear in the
 * mesh apart from two sorts of the elements, and a few 640-cell-square silhouette rasters a level.
 * @throws TypeError for a malformed mesh or options; RangeError for budgets out of order or under the smallest element,
 *   an index or position out of range, a mesh with no area or more than 8,388,608 elements.
 * @example
 * const [near, middle, far] = foliageLODs(needles, { triangles: [76000, 8000, 2000] });
 */
export function foliageLODs(mesh: FoliageMesh, options: FoliageLODOptions): FoliageLevel[] {
  check(mesh, options);
  const { positions: p, normals, indices, uvs } = mesh,
    vertices = p.length / 3,
    triangles = indices.length / 3;
  // Elements: the connected pieces by shared vertex index (union-find with path halving).
  const parent = new Int32Array(vertices);
  for (let v = 0; v < vertices; v++) parent[v] = v;
  const root = (v: number): number => {
    while (parent[v] !== v) v = parent[v] = parent[parent[v]];
    return v;
  };
  for (let t = 0; t < triangles; t++) {
    const a = indices[t * 3],
      b = indices[t * 3 + 1],
      c = indices[t * 3 + 2];
    for (const i of [a, b, c])
      if (!(i >= 0 && i < vertices && Number.isInteger(i)))
        throw out(`foliageLODs: index ${i} is outside the ${vertices} vertices`);
    let r = root(a);
    for (const i of [b, c]) {
      const s = root(i);
      if (s !== r) {
        parent[Math.max(r, s)] = Math.min(r, s);
        r = Math.min(r, s);
      }
    }
  }
  const idOf = new Int32Array(vertices).fill(-1),
    element = new Int32Array(triangles);
  let count = 0;
  for (let t = 0; t < triangles; t++) {
    const r = root(indices[t * 3]);
    if (idOf[r] < 0) idOf[r] = count++;
    element[t] = idOf[r];
  }
  if (count > MOST_ELEMENTS)
    throw out(`foliageLODs takes up to ${MOST_ELEMENTS} elements and the mesh has ${count}; split it`);
  const start = new Uint32Array(count + 1);
  for (let t = 0; t < triangles; t++) start[element[t] + 1]++;
  for (let e = 0; e < count; e++) start[e + 1] += start[e];
  const sorted = new Uint32Array(triangles),
    next = start.slice(0, count);
  for (let t = 0; t < triangles; t++) sorted[next[element[t]]++] = t;

  // Area and area-weighted centre of every element.
  const area = new Float64Array(count),
    centre = new Float64Array(count * 3);
  let total = 0;
  for (let t = 0; t < triangles; t++) {
    const a = indices[t * 3] * 3,
      b = indices[t * 3 + 1] * 3,
      c = indices[t * 3 + 2] * 3,
      size = triangleArea(p, a, b, c),
      e = element[t];
    if (!Number.isFinite(size)) throw out('foliageLODs: positions must be finite');
    area[e] += size;
    total += size;
    for (let k = 0; k < 3; k++) centre[e * 3 + k] += (size * (p[a + k] + p[b + k] + p[c + k])) / 3;
  }
  if (!(total > 0)) throw out('foliageLODs: the mesh has no surface area');
  const low = [Infinity, Infinity, Infinity],
    high = [-Infinity, -Infinity, -Infinity];
  let live = 0;
  for (let e = 0; e < count; e++) {
    if (!(area[e] > 0)) continue;
    live++;
    for (let k = 0; k < 3; k++) {
      centre[e * 3 + k] /= area[e];
      low[k] = Math.min(low[k], centre[e * 3 + k]);
      high[k] = Math.max(high[k], centre[e * 3 + k]);
    }
  }
  const span = Math.max(high[0] - low[0], high[1] - low[1], high[2] - low[2]) || 1;
  // Pieces far larger than the rest keep their size: grown with the needles, a twig stem becomes a long stick.
  const sizes = new Float64Array(live);
  for (let e = 0, i = 0; e < count; e++) if (area[e] > 0) sizes[i++] = area[e];
  const largest = STEM * sizes.sort()[live >> 1];
  // Keys of at most 53 bits (30 of order, 23 of element id) sort exactly as numbers.
  const curve = new Float64Array(live);
  for (let e = 0, i = 0; e < count; e++) {
    if (!(area[e] > 0)) continue;
    const q = [0, 1, 2].map((k) => Math.min(1023, Math.floor(((centre[e * 3 + k] - low[k]) / span) * 1024)));
    const code = (spread(q[0]) | (spread(q[1]) << 1) | (spread(q[2]) << 2)) >>> 0;
    curve[i++] = code * MOST_ELEMENTS + e;
  }
  curve.sort();
  const offset = ((options.seed ?? 1) * 0.7548776662466927) % 1,
    order = new Float64Array(live);
  for (let rank = 0; rank < live; rank++) {
    const key = (rank * GOLDEN + offset) % 1;
    order[rank] = Math.floor(key * 2 ** 30) * MOST_ELEMENTS + (curve[rank] % MOST_ELEMENTS);
  }
  order.sort();
  let list = new Int32Array(live);
  for (let i = 0; i < live; i++) list[i] = order[i] % MOST_ELEMENTS;

  // Each element's long axis (the principal axis of its surface, by power iteration on its second moment, which does
  // not depend on how the surface is triangulated) and its length over its width.
  const axis = new Float64Array(count * 3),
    aspect = new Float64Array(count);
  const frame = (e: number): void => {
    if (aspect[e]) return;
    let xx = 0,
      xy = 0,
      xz = 0,
      yy = 0,
      yz = 0,
      zz = 0;
    const cx = centre[e * 3],
      cy = centre[e * 3 + 1],
      cz = centre[e * 3 + 2];
    // The integral of d d^T over a triangle with corners d_i is area / 12 times the sum of d_i d_i^T plus s s^T,
    // s the sum of the corners.
    const add = (w: number, x: number, y: number, z: number) => {
      xx += w * x * x;
      xy += w * x * y;
      xz += w * x * z;
      yy += w * y * y;
      yz += w * y * z;
      zz += w * z * z;
    };
    for (let s = start[e]; s < start[e + 1]; s++) {
      const t = sorted[s],
        w = triangleArea(p, indices[t * 3] * 3, indices[t * 3 + 1] * 3, indices[t * 3 + 2] * 3) / 12;
      let sx = 0,
        sy = 0,
        sz = 0;
      for (let k = 0; k < 3; k++) {
        const v = indices[t * 3 + k] * 3,
          x = p[v] - cx,
          y = p[v + 1] - cy,
          z = p[v + 2] - cz;
        add(w, x, y, z);
        sx += x;
        sy += y;
        sz += z;
      }
      add(w, sx, sy, sz);
    }
    let [x, y, z] = xx >= yy && xx >= zz ? [xx, xy, xz] : yy >= zz ? [xy, yy, yz] : [xz, yz, zz];
    for (let i = 0; i < 24; i++) {
      const l = Math.hypot(x, y, z) || 1;
      x /= l;
      y /= l;
      z /= l;
      if (i === 23) break;
      [x, y, z] = [xx * x + xy * y + xz * z, xy * x + yy * y + yz * z, xz * x + yz * y + zz * z];
    }
    let from = Infinity,
      to = -Infinity,
      side = 0;
    for (let s = start[e]; s < start[e + 1]; s++)
      for (let k = 0; k < 3; k++) {
        const v = indices[sorted[s] * 3 + k] * 3,
          dx = p[v] - cx,
          dy = p[v + 1] - cy,
          dz = p[v + 2] - cz,
          t = dx * x + dy * y + dz * z;
        from = Math.min(from, t);
        to = Math.max(to, t);
        side = Math.max(side, Math.hypot(dx - t * x, dy - t * y, dz - t * z));
      }
    const length = to - from;
    axis.set([x, y, z], e * 3);
    aspect[e] = Math.max(1, length / Math.max(2 * side, length * 1e-6));
  };
  const slender = options.slender ?? 4;
  /** The factors along and across an element's axis that multiply its area by `s`: width first, down to `slender`. */
  const factors = (e: number, s: number): [number, number] => {
    if (area[e] > largest) return [1, 1];
    if (s <= 1) return [Math.sqrt(s), Math.sqrt(s)];
    const widen = Math.min(s, Math.max(1, aspect[e] / slender)),
      rest = Math.sqrt(s / widen);
    return [rest, widen * rest];
  };
  // The source's silhouettes, on a grid over its bounding box.
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (let t = 0; t < indices.length; t++)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], p[indices[t] * 3 + k]);
      max[k] = Math.max(max[k], p[indices[t] * 3 + k]);
    }
  const cell = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / GRID,
    grids = new Uint8Array(3 * (GRID + 2 * MARGIN) ** 2),
    silhouette = covered(p, indices, min, cell, grids);
  const remap = new Int32Array(vertices).fill(-1);
  const levels: FoliageLevel[] = [];
  for (const budget of options.triangles) {
    // The elements of the level before, in the same order, as many as fit this budget.
    const kept: number[] = [];
    let used = 0;
    for (let i = 0; i < list.length && used < budget; i++) {
      const e = list[i],
        n = start[e + 1] - start[e];
      if (used + n > budget) continue;
      kept.push(e);
      used += n;
    }
    if (!kept.length)
      throw out(`foliageLODs: no element fits ${budget} triangles; give every level at least one element's triangles`);
    list = Int32Array.from(kept);
    const ids = Int32Array.from(kept).sort();
    let keptArea = 0;
    for (const e of ids) {
      keptArea += area[e];
      frame(e);
    }
    // The first guess keeps the area: the given one, or the source's.
    let s = (options.area ?? total) / keptArea;
    if (Math.abs(s - 1) < 1e-9) s = 1;
    // Vertices of the kept elements, and each one's element.
    const source: number[] = [],
      owner: number[] = [],
      index = new Uint32Array(used * 3);
    let at = 0;
    for (const e of ids)
      for (let t = start[e]; t < start[e + 1]; t++)
        for (let k = 0; k < 3; k++) {
          const v = indices[sorted[t] * 3 + k];
          if (remap[v] < 0) {
            remap[v] = source.length;
            source.push(v);
            owner.push(e);
          }
          index[at++] = remap[v];
        }
    for (const v of source) remap[v] = -1;
    const position = new Float32Array(source.length * 3),
      normal = new Float32Array(source.length * 3);
    const place = (scale: number): number => {
      for (let i = 0; i < source.length; i++) {
        const v = source[i] * 3,
          e = owner[i],
          [along, across] = factors(e, scale),
          x = axis[e * 3],
          y = axis[e * 3 + 1],
          z = axis[e * 3 + 2],
          dx = p[v] - centre[e * 3],
          dy = p[v + 1] - centre[e * 3 + 1],
          dz = p[v + 2] - centre[e * 3 + 2],
          t = dx * x + dy * y + dz * z,
          // p' = c + along (d . u) u + across (d - (d . u) u); written as p plus the change, exact at factors of 1.
          g = (along - across) * t,
          h = across - 1;
        position[i * 3] = p[v] + h * dx + g * x;
        position[i * 3 + 1] = p[v + 1] + h * dy + g * y;
        position[i * 3 + 2] = p[v + 2] + h * dz + g * z;
        // Normals by the inverse transpose of that scale.
        const nx = normals[v],
          ny = normals[v + 1],
          nz = normals[v + 2],
          m = (nx * x + ny * y + nz * z) * (1 / along - 1 / across),
          qx = nx / across + m * x,
          qy = ny / across + m * y,
          qz = nz / across + m * z,
          l = Math.hypot(qx, qy, qz);
        normal[i * 3] = l ? qx / l : nx;
        normal[i * 3 + 1] = l ? qy / l : ny;
        normal[i * 3 + 2] = l ? qz / l : nz;
      }
      let sum = 0;
      for (let t = 0; t < index.length; t += 3)
        sum += triangleArea(position, index[t] * 3, index[t + 1] * 3, index[t + 2] * 3);
      return sum;
    };
    const see = () => (silhouette ? covered(position, index, min, cell, grids) / silhouette : 1);
    let made = place(s),
      seen = see();
    if (options.area !== undefined) {
      // Faces that do not hold the axis (a needle's end caps) grow by another factor: correct the one scale until the
      // level's area is the target within 0.1%.
      for (let i = 0; i < 8 && s !== 1 && Math.abs(made / options.area - 1) > 1e-3; i++) {
        s *= options.area / made;
        made = place(s);
        seen = see();
      }
    } else if (s !== 1) {
      // Coverage grows as a power below 1 of the scale (overlap): a secant search on the logarithms, to within 1%.
      let power = 0.7;
      for (let i = 0; i < 12 && Math.abs(seen - 1) > 0.01 && seen > 0; i++) {
        const before = s,
          then = seen;
        s *= Math.min(8, Math.max(1 / 8, seen ** (-1 / power)));
        made = place(s);
        seen = see();
        const slope = Math.log(seen / then) / Math.log(s / before);
        if (Number.isFinite(slope)) power = Math.min(1, Math.max(0.15, slope));
      }
    }
    let coords: Float32Array | undefined;
    if (uvs) {
      coords = new Float32Array(source.length * 2);
      for (let i = 0; i < source.length; i++) {
        coords[i * 2] = uvs[source[i] * 2];
        coords[i * 2 + 1] = uvs[source[i] * 2 + 1];
      }
    }
    levels.push({
      positions: position,
      normals: normal,
      indices: index,
      ...(coords ? { uvs: coords } : {}),
      triangles: used,
      elements: ids.length,
      area: made,
      coverage: seen,
    });
  }
  return levels;
}
