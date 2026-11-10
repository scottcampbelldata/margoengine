// Plane arrangement decomposition of nonconvex cells, not a boundary-representation kernel.
// Naylor/Amanatides/Thibault (1990); Ju/Schaefer/Warren (2005), equations 10 and 11.
import { rangeError } from '../../shared/errors.js';
import { cross3, dot3, sub3 } from './cell-complex.js';

const bad = (message: string): never => {
  throw rangeError(`Polyhedron: ${message}; repair or subdivide the source cell`, 'sciviz');
};
const norm = (p: readonly number[]) => Math.hypot(...p);
const clamp = (x: number) => Math.max(-1, Math.min(1, x));
type Region = number[][][];
const centroid = (p: number[][]) => [0, 1, 2].map((a) => p.reduce((s, q) => s + q[a], 0) / p.length);
const unique = (p: number[][], eps: number) => p.filter((q, i) => p.findIndex((r) => norm(sub3(q, r)) <= eps) === i);

/** @internal Signed mean-value coordinates on a consistently oriented, closed triangular surface. */
export function polyhedronWeights(
  at: readonly number[],
  points: readonly number[][],
  facets: readonly (readonly number[])[],
  eps: number,
): number[] {
  const delta = points.map((p) => sub3(p, at)),
    distance = delta.map(norm),
    hit = distance.findIndex((d) => d <= eps),
    out = points.map(() => 0);
  if (hit >= 0) {
    out[hit] = 1;
    return out;
  }
  const unit = delta.map((p, i) => p.map((x) => x / distance[i]));
  for (const face of facets) {
    const u = face.map((i) => unit[i]),
      d = face.map((i) => distance[i]),
      angle = [0, 1, 2].map((i) => 2 * Math.asin(Math.min(1, norm(sub3(u[(i + 1) % 3], u[(i + 2) % 3])) / 2))),
      h = angle.reduce((a, b) => a + b, 0) / 2;
    if (Math.PI - h < 1e-10) {
      const w = angle.map((x, i) => Math.sin(x) * d[(i + 1) % 3] * d[(i + 2) % 3]),
        sum = w.reduce((a, b) => a + b, 0);
      out.fill(0);
      for (let i = 0; i < 3; i++) out[face[i]] = w[i] / sum;
      return out;
    }
    const cos = angle.map((x, i) =>
        clamp((2 * Math.sin(h) * Math.sin(h - x)) / (Math.sin(angle[(i + 1) % 3]) * Math.sin(angle[(i + 2) % 3])) - 1),
      ),
      sign = Math.sign(dot3(u[0], cross3(u[1], u[2]))),
      sin = cos.map((x) => sign * Math.sqrt(Math.max(0, 1 - x * x)));
    if (sin.some((x) => Math.abs(x) < 1e-12)) continue;
    for (let i = 0; i < 3; i++)
      out[face[i]] +=
        (angle[i] - cos[(i + 1) % 3] * angle[(i + 2) % 3] - cos[(i + 2) % 3] * angle[(i + 1) % 3]) /
        (d[i] * Math.sin(angle[(i + 1) % 3]) * sin[(i + 2) % 3]);
  }
  const sum = out.reduce((a, b) => a + b, 0);
  if (!Number.isFinite(sum) || sum === 0) bad('mean-value interpolation is singular');
  const weights = out.map((w) => w / sum),
    mapped = [0, 1, 2].map((a) => weights.reduce((s, w, i) => s + w * points[i][a], 0));
  if (norm(sub3(mapped, at)) > eps * 1024) bad('mean-value interpolation lost affine precision');
  return weights;
}

/** @internal Split a convex closed region by a plane; the cap is sorted in that plane. */
function half(region: Region, n: number[], offset: number, eps: number): Region {
  const faces: Region = [],
    cap: number[][] = [];
  for (const face of region) {
    const out: number[][] = [];
    for (let i = 0; i < face.length; i++) {
      const a = face[i],
        b = face[(i + 1) % face.length],
        fa = dot3(n, a) + offset,
        fb = dot3(n, b) + offset,
        ina = fa >= -eps,
        inb = fb >= -eps;
      if (ina) out.push(a);
      if ((fa > eps && fb < -eps) || (fb > eps && fa < -eps)) {
        const t = fa / (fa - fb),
          p = a.map((v, k) => v + t * (b[k] - v));
        out.push(p);
        cap.push(p);
      }
      if (Math.abs(fa) <= eps) cap.push(a);
      if (ina !== inb && Math.abs(fa) <= eps && Math.abs(fb) <= eps) bad('ambiguous plane classification');
    }
    const clean = unique(out, eps);
    if (clean.length >= 3) faces.push(clean);
  }
  const ring = unique(cap, eps);
  if (ring.length >= 3) {
    const center = centroid(ring),
      axis = Math.abs(n[0]) < 0.8 ? [1, 0, 0] : [0, 1, 0],
      u = cross3(n, axis),
      v = cross3(n, u);
    ring.sort(
      (a, b) =>
        Math.atan2(dot3(sub3(a, center), v), dot3(sub3(a, center), u)) -
        Math.atan2(dot3(sub3(b, center), v), dot3(sub3(b, center), u)),
    );
    faces.push(ring);
  }
  return faces;
}
function inside(p: readonly number[], points: readonly number[][], facets: readonly (readonly number[])[]): boolean {
  let angle = 0;
  for (const tri of facets) {
    const [a, b, c] = tri.map((i) => sub3(points[i], p)),
      da = norm(a),
      db = norm(b),
      dc = norm(c);
    angle += 2 * Math.atan2(dot3(a, cross3(b, c)), da * db * dc + dot3(a, b) * dc + dot3(b, c) * da + dot3(c, a) * db);
  }
  return Math.abs(angle) > 2 * Math.PI;
}

/** @internal Exact face-plane arrangement in float64; classification by oriented solid angle.
 * Every retained region is convex and is fanned to its interior centroid. No overlapping signed tetrahedra.
 */
export function decomposePolyhedron(
  points: readonly number[][],
  facets: readonly (readonly number[])[],
  insert: (weights: readonly number[]) => number,
  emit: (ids: readonly number[]) => void,
): void {
  const bounds = [0, 1, 2].map((a) => [Math.min(...points.map((p) => p[a])), Math.max(...points.map((p) => p[a]))]),
    scale = norm(bounds.map((b) => b[1] - b[0]));
  if (!scale) bad('zero volume');
  const eps = scale * 128 * Number.EPSILON;
  const box = Array.from({ length: 8 }, (_, i) => [bounds[0][i & 1], bounds[1][(i >> 1) & 1], bounds[2][(i >> 2) & 1]]);
  let regions: Region[] = [
    [
      [0, 2, 3, 1],
      [4, 5, 7, 6],
      [0, 1, 5, 4],
      [2, 6, 7, 3],
      [0, 4, 6, 2],
      [1, 3, 7, 5],
    ].map((f) => f.map((i) => box[i])),
  ];
  const planes: { n: number[]; offset: number }[] = [];
  for (const tri of facets) {
    const [a, b, c] = tri.map((i) => points[i]),
      raw = cross3(sub3(b, a), sub3(c, a)),
      length = norm(raw);
    if (!length) bad('degenerate surface triangle');
    const n = raw.map((x) => x / length),
      offset = -dot3(n, a);
    if (
      !planes.some(
        (p) =>
          Math.abs(Math.abs(dot3(p.n, n)) - 1) < 1e-12 && Math.abs(p.offset - Math.sign(dot3(p.n, n)) * offset) < eps,
      )
    )
      planes.push({ n, offset });
  }
  for (const { n, offset } of planes) {
    const next: Region[] = [];
    for (const region of regions) {
      const f = region.flat().map((p) => dot3(n, p) + offset);
      if (Math.min(...f) < -eps && Math.max(...f) > eps) {
        next.push(
          half(region, n, offset, eps),
          half(
            region,
            n.map((x) => -x),
            -offset,
            eps,
          ),
        );
      } else next.push(region);
    }
    regions = next;
    if (regions.length > 4096) bad('face-plane arrangement exceeds 4096 regions');
  }
  const positions: number[][] = [],
    ids: number[] = [];
  const add = (p: number[]) => {
    const found = positions.findIndex((q) => norm(sub3(p, q)) <= eps);
    if (found >= 0) return ids[found];
    const id = insert(polyhedronWeights(p, points, facets, eps));
    positions.push(p);
    ids.push(id);
    return id;
  };
  let emitted = 0;
  for (const region of regions) {
    const center = centroid(unique(region.flat(), eps));
    if (!inside(center, points, facets)) continue;
    const apex = add(center);
    for (const face of region)
      for (let i = 1; i < face.length - 1; i++) {
        const tri = [face[0], face[i], face[i + 1]],
          det = dot3(sub3(tri[0], center), cross3(sub3(tri[1], center), sub3(tri[2], center)));
        if (Math.abs(det) <= eps ** 3) continue;
        const ids = tri.map(add);
        if (det < 0) [ids[1], ids[2]] = [ids[2], ids[1]];
        emit([apex, ...ids]);
        emitted++;
      }
  }
  if (!emitted) bad('no closed interior found');
}
