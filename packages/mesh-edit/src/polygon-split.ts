import type { MutableVec2, Vec3 } from '@margoengine/math';
import { polygonAreaVector, polygonGeometryError } from './polygon.js';
import type { PolygonFace } from './types.js';

/** Largest polygon loop the splitter accepts (ear clipping is quadratic in the corner count). */
const MAX_LOOP_CORNERS = 4096;

/** A plane basis (u, v) from the loop's Newell area vector, or null when the loop has no area. */
function loopBasis(points: readonly Vec3[]): { u: number[]; v: number[]; area: number } | null {
  const n = polygonAreaVector(points),
    length = Math.hypot(n[0], n[1], n[2]);
  if (!(length > 0)) return null;
  const z = [n[0] / length, n[1] / length, n[2] / length],
    helper = Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0],
    ux = helper[1] * z[2] - helper[2] * z[1],
    uy = helper[2] * z[0] - helper[0] * z[2],
    uz = helper[0] * z[1] - helper[1] * z[0],
    ul = Math.hypot(ux, uy, uz),
    u = [ux / ul, uy / ul, uz / ul],
    v = [z[1] * u[2] - z[2] * u[1], z[2] * u[0] - z[0] * u[2], z[0] * u[1] - z[1] * u[0]];
  return { u, v, area: length / 2 };
}

/** Project the loop onto its own plane basis, relative to the first corner (counter-clockwise by construction). */
export function projectLoop(points: readonly Vec3[]): number[][] | null {
  const basis = loopBasis(points);
  if (!basis) return null;
  const o = points[0];
  return points.map((p) => {
    const x = p[0] - o[0],
      y = p[1] - o[1],
      z = p[2] - o[2];
    return [x * basis.u[0] + y * basis.u[1] + z * basis.u[2], x * basis.v[0] + y * basis.v[1] + z * basis.v[2]];
  });
}

const turn = (a: number[], b: number[], c: number[]) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

/**
 * Ear-clip a simple polygon loop (concave allowed, collinear corners kept) into triangles of corner indices.
 * Returns null when the loop has no area, is not simple in its own plane, or no ear can be found.
 */
export function triangulateLoop(points: readonly Vec3[]): number[][] | null {
  const count = points.length;
  if (count < 3 || count > MAX_LOOP_CORNERS) return null;
  const flat = projectLoop(points);
  if (!flat) return null;
  let extent = 0;
  for (const p of flat) extent = Math.max(extent, Math.abs(p[0]), Math.abs(p[1]));
  const epsilon = extent * extent * 1e-12,
    remaining = flat.map((_, i) => i),
    triangles: number[][] = [];
  while (remaining.length > 3) {
    let best = -1,
      bestQuality = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const a = remaining[(i + remaining.length - 1) % remaining.length],
        b = remaining[i],
        c = remaining[(i + 1) % remaining.length],
        pa = flat[a],
        pb = flat[b],
        pc = flat[c],
        area = turn(pa, pb, pc);
      if (area <= epsilon) continue;
      let blocked = false;
      for (const w of remaining) {
        if (w === a || w === b || w === c) continue;
        const pw = flat[w];
        if (turn(pa, pb, pw) >= -epsilon && turn(pb, pc, pw) >= -epsilon && turn(pc, pa, pw) >= -epsilon) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      // Prefer the ear whose smallest angle is largest (fewer slivers); ties keep the first, so output is stable.
      const ab = Math.hypot(pb[0] - pa[0], pb[1] - pa[1]),
        bc = Math.hypot(pc[0] - pb[0], pc[1] - pb[1]),
        ca = Math.hypot(pa[0] - pc[0], pa[1] - pc[1]),
        quality = area / Math.max(ab * ab, bc * bc, ca * ca);
      if (quality > bestQuality) {
        bestQuality = quality;
        best = i;
      }
    }
    if (best < 0) return null;
    const i = best;
    triangles.push([
      remaining[(i + remaining.length - 1) % remaining.length],
      remaining[i],
      remaining[(i + 1) % remaining.length],
    ]);
    remaining.splice(i, 1);
  }
  if (turn(flat[remaining[0]], flat[remaining[1]], flat[remaining[2]]) <= epsilon) return null;
  triangles.push([...remaining]);
  // A self-crossing loop can still yield ears; the pieces of a simple loop tile exactly its signed area.
  let sum = 0;
  for (const [a, b, c] of triangles) sum += turn(flat[a], flat[b], flat[c]);
  let loopArea = 0;
  for (let i = 0; i < count; i++) {
    const p = flat[i],
      q = flat[(i + 1) % count];
    loopArea += p[0] * q[1] - p[1] * q[0];
  }
  if (Math.abs(sum - loopArea) > Math.max(epsilon * count, Math.abs(loopArea) * 1e-9)) return null;
  return triangles;
}

/**
 * Split a polygon loop into the fewest-greedy pieces that each pass {@link polygonGeometryError} (planar, simple,
 * convex, 3 to 64 corners): ear-clip, then remove diagonals while both sides stay valid (Hertel and Mehlhorn, 1983).
 * Nonplanar loops end as planar pieces (triangles where nothing larger is planar). Null when the loop cannot be
 * split (no area, self-crossing).
 */
export function convexLoopPieces(points: readonly Vec3[]): number[][] | null {
  if (points.length <= 64 && polygonGeometryError(points) === null) return [points.map((_, i) => i)];
  const triangles = triangulateLoop(points);
  if (!triangles) return null;
  const pieces: (number[] | null)[] = triangles.map((t) => [...t]),
    corners: Vec3[] = [];
  const valid = (piece: number[]) => {
    corners.length = piece.length;
    for (let i = 0; i < piece.length; i++) corners[i] = points[piece[i]];
    return piece.length <= 64 && polygonGeometryError(corners) === null;
  };
  for (const piece of pieces) if (!valid(piece!)) return null;
  // Diagonal (a -> b) inside piece p, keyed so the neighbor that holds (b -> a) can be found.
  let merged = true;
  while (merged) {
    merged = false;
    const owner = new Map<string, number>();
    pieces.forEach((piece, p) => {
      if (piece) piece.forEach((a, i) => owner.set(`${a}>${piece[(i + 1) % piece.length]}`, p));
    });
    for (let p = 0; p < pieces.length && !merged; p++) {
      const piece = pieces[p];
      if (!piece) continue;
      for (let i = 0; i < piece.length; i++) {
        const a = piece[i],
          b = piece[(i + 1) % piece.length],
          q = owner.get(`${b}>${a}`);
        if (q === undefined || q === p) continue;
        const other = pieces[q]!,
          start = (i + 1) % piece.length,
          rotated = [...piece.slice(start), ...piece.slice(0, start)], // b ... a
          j = other.indexOf(a),
          otherRotated = [...other.slice(j), ...other.slice(0, j)], // a ... b
          candidate = [...rotated, ...otherRotated.slice(1, -1)];
        if (!valid(candidate)) continue;
        pieces[p] = candidate;
        pieces[q] = null;
        merged = true;
        break;
      }
    }
  }
  return pieces.filter((piece): piece is number[] => piece !== null);
}

/**
 * Faces covering one rebuilt loop: the first piece keeps `id`, the rest take generated IDs. Each corner keeps its
 * loop UV. Null when the loop cannot be split.
 */
export function loopFaces(
  vertices: readonly Vec3[],
  loop: readonly number[],
  uv: readonly (readonly number[])[],
  id: string,
  createId: () => string,
): PolygonFace[] | null {
  const pieces = convexLoopPieces(loop.map((index) => vertices[index]));
  if (!pieces) return null;
  return pieces.map((piece, index) => ({
    id: index === 0 ? id : createId(),
    vertices: piece.map((corner) => loop[corner]),
    uv: piece.map((corner) => [uv[corner][0], uv[corner][1]] as MutableVec2),
  }));
}

/**
 * UV at point `p` from the face's own affine UV map, fitted by least squares to its corners in their plane.
 * Exact for triangles and parallelogram-mapped faces. Null for a face without area.
 */
export function faceUVAt(points: readonly Vec3[], uvs: readonly (readonly number[])[], p: Vec3): MutableVec2 | null {
  const flat = projectLoop([...points, p]);
  if (!flat) return null;
  // Solve the normal equations for uv = A [x, y, 1] (3x3, symmetric).
  const m = [0, 0, 0, 0, 0, 0, 0, 0, 0],
    r = [
      [0, 0, 0],
      [0, 0, 0],
    ];
  for (let i = 0; i < points.length; i++) {
    const row = [flat[i][0], flat[i][1], 1];
    for (let a = 0; a < 3; a++) {
      for (let b = 0; b < 3; b++) m[a * 3 + b] += row[a] * row[b];
      r[0][a] += row[a] * uvs[i][0];
      r[1][a] += row[a] * uvs[i][1];
    }
  }
  const det =
    m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
  if (!(Math.abs(det) > 1e-300)) return null;
  const solve = (rhs: number[]) => {
    const out = [0, 0, 0];
    for (let col = 0; col < 3; col++) {
      const c = [...m];
      for (let row = 0; row < 3; row++) c[row * 3 + col] = rhs[row];
      out[col] =
        (c[0] * (c[4] * c[8] - c[5] * c[7]) - c[1] * (c[3] * c[8] - c[5] * c[6]) + c[2] * (c[3] * c[7] - c[4] * c[6])) /
        det;
    }
    return out;
  };
  const q = flat[points.length],
    a = solve(r[0]),
    b = solve(r[1]);
  return [a[0] * q[0] + a[1] * q[1] + a[2], b[0] * q[0] + b[1] * q[1] + b[2]];
}

/** Clamp a UV pair into the normalized atlas. Returns whether it moved. */
export function clampUV(uv: MutableVec2): boolean {
  let moved = false;
  for (let axis = 0; axis < 2; axis++) {
    const value = Math.min(1, Math.max(0, uv[axis]));
    if (value !== uv[axis]) moved = true;
    uv[axis] = value;
  }
  return moved;
}
