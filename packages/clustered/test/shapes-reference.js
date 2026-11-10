// CPU references for @margoengine/clustered/shapes, shared by test/shapes.test.js and scripts/shape-lights-gpu-check.js.
// - coneVector(): the vector form factor of the elliptic cone from the origin over a disc seen through a 3x3 map.
// - discFormFactor(): that cone's form factor clipped to the horizon (closed form above it, the rim's arc across it).
// - shapes(): a float64 mirror of the WGSL clusterShapeLighting (frame and LUT of the rectangle lights, the disc, sphere
//   and tube constructions, horizon clipping).
// - ltcQuadrature(): quadrature of the LTC distribution itself over the shape (checks the cones, not the table's fit).
// - shapeBruteForce(): independent quadrature over the directions that hit the real shape (ray tests against the
//   sphere, the disc or the capsule) of the BRDF the LTC table approximates plus Lambert diffuse; no LTC, no cones.
// Lights are ShapeLights' packed 12-float records: a.xyz + kind (0 sphere, 1 disc, 2 tube), b.xyz + radius, radiance +
// twoSided. a is the centre (sphere, disc) or the tube start; b is the disc's unit normal or the tube end.
import { ltcSize } from '../src/ltc.ts';
import { edge, lookup } from './ltc-reference.js';

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  length = (a) => Math.hypot(...a),
  unit = (a) => scale(a, 1 / length(a));

/** Any two unit vectors that make an orthonormal frame with unit `n`. */
export function basis(n) {
  const t = unit(cross(n, Math.abs(n[0]) > 0.5 ? [0, 0, 1] : [1, 0, 0]));
  return [t, cross(n, t)];
}

/**
 * Vector form factor of the cone from the origin over the disc centre `c` with radius vectors `t1`, `t2` (orthogonal,
 * equal length), all mapped by `m` first: the cone is x^2/a^2 + y^2/b^2 <= z^2 in its own frame, and its form factor
 * along its axis is ab / sqrt((1 + a^2)(1 + b^2)) (the area of its projection on the unit disc, over pi). With the
 * quadric's eigenvalues l1, l2 > 0 > l3 that is sqrt(l3^2 / ((l1 - l3)(l2 - l3))).
 * The quadric is R^T J R (J = diag(1, 1, -1), R's rows r_i those of det(B) inverse(B), B = [v1 v2 k]); it shares its
 * eigenvalues with G J, G = R R^T the rows' Gram matrix, whose characteristic polynomial takes its coefficients from
 * dot and cross products of the rows (trace |r0|^2 + |r1|^2 - |r2|^2, principal minors |r0 x r1|^2 - |r0 x r2|^2 -
 * |r1 x r2|^2, determinant -(r0 . r1 x r2)^2) with no cancelling sums, so a far, small disc keeps its precision in
 * float32. The axis is B y for y the eigenvector of G J.
 */
export function coneVector(m, c, t1, t2) {
  const C = m(c),
    s = 1 / length(C),
    k = scale(C, s),
    v1 = scale(m(t1), s),
    v2 = scale(m(t2), s);
  let r0 = cross(v2, k),
    r1 = cross(k, v1),
    r2 = cross(v1, v2);
  const big = Math.max(length(r0), length(r1));
  if (!(big > 0)) return [0, 0, 0];
  [r0, r1, r2] = [r0, r1, r2].map((r) => scale(r, 1 / big));
  const det = dot(r0, cross(r1, r2));
  if (!(Math.abs(det) > 0)) return [0, 0, 0];
  const c01 = cross(r0, r1),
    c02 = cross(r0, r2),
    c12 = cross(r1, r2),
    T = dot(r0, r0) + dot(r1, r1) - dot(r2, r2),
    M = dot(c01, c01) - dot(c02, c02) - dot(c12, c12),
    D = -det * det,
    l = smallestRoot(T, M, D),
    rows = [
      [dot(r0, r0) - l, dot(r0, r1), -dot(r0, r2)],
      [dot(r1, r0), dot(r1, r1) - l, -dot(r1, r2)],
      [dot(r2, r0), dot(r2, r1), -dot(r2, r2) - l],
    ],
    pairs = [cross(rows[0], rows[1]), cross(rows[0], rows[2]), cross(rows[1], rows[2])],
    y = pairs.reduce((best, p) => (dot(p, p) > dot(best, best) ? p : best)),
    axis = add(add(scale(v1, y[0]), scale(v2, y[1])), scale(k, y[2])),
    magnitude = Math.sqrt((l * l) / Math.max(3 * l * l - 2 * T * l + M, 1e-30));
  return scale(unit(axis), dot(axis, k) < 0 ? -magnitude : magnitude);
}
// Smallest root of l^3 - T l^2 + M l - D (three real roots): the trigonometric solution of the depressed cubic, then
// two Newton steps, whose value near a small root is the difference of l M and D, both known to a few ulp.
function smallestRoot(T, M, D) {
  const p = M - (T * T) / 3,
    q = (-2 * T * T * T) / 27 + (T * M) / 3 - D;
  let l = T / 3;
  if (p < 0) {
    const r = Math.sqrt(-p / 3),
      phi = Math.acos(Math.min(Math.max(-q / 2 / (r * r * r), -1), 1));
    l = T / 3 + 2 * r * Math.cos((phi + 2 * Math.PI) / 3);
  }
  for (let i = 0; i < 2; i++) {
    const slope = 3 * l * l - 2 * T * l + M;
    if (slope !== 0) l -= (l * (l * (l - T) + M) - D) / slope;
  }
  return l;
}

/**
 * Form factor (z) of a disc seen through the 3x3 map `m`, clipped to z >= 0: the closed-form cone while the whole
 * mapped disc is above the horizon, else the visible arc of its rim as polygons (K edges) closed along the horizon:
 * (the inscribed polygon + 2 x the circumscribed one) / 3, whose leading O(dt^2) errors cancel.
 */
export function discFormFactor(m, d, K = SEGMENTS) {
  const C = m(d.c),
    V1 = m(d.t1),
    V2 = m(d.t2),
    R = Math.hypot(V1[2], V2[2]);
  if (C[2] >= R) return Math.max(coneVector(m, d.c, d.t1, d.t2)[2], 0);
  if (C[2] <= -R) return 0;
  const u = scale(add(scale(V1, V1[2]), scale(V2, V2[2])), 1 / R),
    w = scale(sub(scale(V2, V1[2]), scale(V1, V2[2])), 1 / R),
    alpha = Math.acos(-C[2] / R),
    dt = (2 * alpha) / K,
    at = (t, s) => add(C, add(scale(u, Math.cos(t) * s), scale(w, Math.sin(t) * s))),
    ring = (points) => {
      let sum = 0;
      for (let i = 0; i < points.length; i++)
        sum += edge(unitOrZero(points[i]), unitOrZero(points[(i + 1) % points.length]));
      return Math.abs(sum);
    };
  const inner = [],
    outer = [at(-alpha, 1)];
  for (let i = 0; i <= K; i++) inner.push(at(i * dt - alpha, 1));
  for (let i = 0; i < K; i++) outer.push(at((i + 0.5) * dt - alpha, 1 / Math.cos(dt / 2)));
  outer.push(at(alpha, 1));
  return (ring(inner) + 2 * ring(outer)) / 3;
}
/** Rim edges of a clipped disc. */
export const SEGMENTS = 6;
const unitOrZero = (p) => scale(p, 1 / Math.sqrt(Math.max(dot(p, p), 1e-20)));

/**
 * The discs a light becomes, seen from `p` ([{ c, t1, t2, weight }], relative to p), or its silhouette `tube`. A sphere
 * is the disc of its silhouette circle; a disc is itself (none from behind unless twoSided); a tube is the convex hull
 * of its end spheres' silhouette discs (see hull), or seen end-on, the end cap it is beyond.
 */
export function pieces(light, p) {
  const a = light.slice(0, 3),
    kind = light[3],
    b = light.slice(4, 7),
    radius = light[7],
    twoSided = light[11] > 0.5;
  const sphere = (centre, weight) => {
    const c = sub(centre, p),
      d2 = Math.max(dot(c, c), radius * radius * 1.0001),
      keep = 1 - (radius * radius) / d2,
      [t1, t2] = basis(unit(c));
    return {
      c: scale(c, keep),
      t1: scale(t1, radius * Math.sqrt(keep)),
      t2: scale(t2, radius * Math.sqrt(keep)),
      weight,
    };
  };
  if (kind === 0) return { discs: [sphere(a, 1)] };
  if (kind === 1) {
    const c = sub(a, p);
    if (dot(b, c) > 0 && !twoSided) return { discs: [] };
    const [t1, t2] = basis(b);
    return { discs: [{ c, t1: scale(t1, radius), t2: scale(t2, radius), weight: 1 }] };
  }
  const span = sub(b, a),
    axis = unit(span),
    off = sub(sub(p, a), scale(axis, dot(sub(p, a), axis))),
    h = length(off);
  // Inside the tube's radius (end-on): only the end cap p is beyond is seen, whole.
  if (!(h > radius))
    return { discs: [sphere(a, dot(axis, sub(p, a)) < 0 ? 1 : 0), sphere(b, dot(axis, sub(p, b)) > 0 ? 1 : 0)] };
  const u = scale(off, 1 / h),
    w = cross(axis, u),
    cosine = radius / h,
    sine = Math.sqrt(1 - cosine * cosine),
    t0 = add(scale(u, radius * cosine), scale(w, radius * sine)),
    t1 = sub(scale(u, radius * cosine), scale(w, radius * sine));
  // The capsule's silhouette is the convex hull of its end spheres' silhouette discs: the two tangent segments and,
  // around each end, the arc of its disc beyond the chord between the tangent points (outward along the axis).
  const s = sub(a, p),
    e = sub(b, p),
    arc = (end, outward, from) => {
      const disc = sphere(end, 1),
        rho = length(disc.t1),
        normal = unit(disc.c),
        o = unit(sub(outward, scale(normal, dot(outward, normal)))),
        x = Math.min(Math.max(dot(sub(add(sub(end, p), scale(u, radius * cosine)), disc.c), o) / rho, -1), 1),
        f = sub(from, disc.c),
        y = scale(unit(sub(f, scale(o, dot(f, o)))), -1);
      return { c: disc.c, x: scale(o, rho), y: scale(y, rho), beta: Math.acos(x) };
    };
  return {
    tube: { s, e, t0, t1, end: arc(b, axis, add(e, t0)), start: arc(a, scale(axis, -1), add(s, t1)) },
    discs: [],
  };
}

/**
 * The tube's silhouette polygon: s+t0, e+t0, the arc around the end, e+t1, s+t1, the arc around the start. Each arc
 * has `k` steps; `grow` 1 puts its inner points on the rim (inscribed), 1 / cos(step / 2) at the tangents' crossings.
 */
export function hull(tube, k, outer) {
  const points = [add(tube.s, tube.t0), add(tube.e, tube.t0)],
    walk = (arc, last) => {
      const dt = (2 * arc.beta) / k,
        at = (t, g) => add(arc.c, add(scale(arc.x, Math.cos(t) * g), scale(arc.y, Math.sin(t) * g)));
      if (outer) for (let i = 0; i < k; i++) points.push(at(-arc.beta + (i + 0.5) * dt, 1 / Math.cos(dt / 2)));
      else for (let i = 1; i < k; i++) points.push(at(-arc.beta + i * dt, 1));
      points.push(last);
    };
  walk(tube.end, add(tube.e, tube.t1));
  points.push(add(tube.s, tube.t1));
  walk(tube.start, points[0]);
  points.pop();
  return points;
}

/** Form factor of a polygon (points relative to the receiver) seen through `m`, clipped to z >= 0. */
export function polygonFormFactor(m, points) {
  const q = points.map(m);
  let leave = [0, 0, 0],
    enter = [0, 0, 0],
    sum = 0;
  for (let i = 0; i < q.length; i++) {
    const s0 = q[i],
      e0 = q[(i + 1) % q.length];
    if (s0[2] < 0 && e0[2] < 0) continue;
    let s = s0,
      e = e0;
    const mix = (a, b, t) => add(a, scale(sub(b, a), t));
    if (s0[2] < 0) enter = s = mix(s0, e0, s0[2] / (s0[2] - e0[2]));
    else if (e0[2] < 0) leave = e = mix(s0, e0, s0[2] / (s0[2] - e0[2]));
    sum += edge(unitOrZero(s), unitOrZero(e));
  }
  return Math.abs(sum + edge(unitOrZero(leave), unitOrZero(enter)));
}
/** Arc steps around each end of a tube. */
export const ARC_SEGMENTS = 4;
const tubeForm = (m, tube) =>
  (polygonFormFactor(m, hull(tube, ARC_SEGMENTS, false)) + 2 * polygonFormFactor(m, hull(tube, ARC_SEGMENTS, true))) /
  3;

/** The receiver's LTC frame: `local` (tangent frame, z = n) and `lobe` (the inverse LTC matrix after it), and the LUT's
 * magnitude and Fresnel terms; `m` is the inverse matrix as columns (x, 0, y), (0, 1, 0), (z, 0, w). */
export function frame(n, v, roughness) {
  const nv = Math.min(Math.max(dot(n, v), 0.0001), 1),
    st = [Math.min(Math.max(roughness, 0.045), 1) * (ltcSize - 1), Math.sqrt(1 - nv) * (ltcSize - 1)],
    [m0, m1] = lookup(st, 0),
    [m2, m3] = lookup(st, 1),
    [magnitude, fresnel] = lookup(st, 2);
  let t = sub(v, scale(n, dot(n, v)));
  if (dot(t, t) < 1e-8) t = cross(n, Math.abs(n[0]) > 0.5 ? [0, 0, 1] : [1, 0, 0]);
  const x = unit(t),
    y = cross(n, x),
    local = (q) => [dot(x, q), dot(y, q), dot(n, q)],
    lobe = (q) => {
      const [a, b, c] = local(q);
      return [a * m0 + c * m2, b, a * m1 + c * m3];
    };
  return { local, lobe, magnitude, fresnel, m: [m0, m1, m2, m3] };
}

/** float64 mirror of clusterShapeLighting for one light: { diffuse, specular, total } (RGB radiance). */
export function shapes(light, p, n, v, base, roughness, metal) {
  const { local, lobe, magnitude, fresnel } = frame(n, v, roughness);
  const { discs, tube } = pieces(light, p);
  let spec = 0,
    diff = 0;
  for (const disc of discs) {
    spec += disc.weight * discFormFactor(lobe, disc);
    diff += disc.weight * discFormFactor(local, disc);
  }
  if (tube) {
    spec += tubeForm(lobe, tube);
    diff += tubeForm(local, tube);
  }
  const color = light.slice(8, 11),
    diffuse = color.map((k, i) => k * diff * (1 - metal) * base[i]),
    specular = color.map((k, i) => {
      const f0 = 0.04 + (base[i] - 0.04) * metal;
      return k * spec * (f0 * magnitude + (1 - f0) * fresnel);
    });
  return { diffuse, specular, total: diffuse.map((d, i) => d + specular[i]) };
}

// Ray from the origin along unit d against the light (relative to the shading point): hit or not.
function hits(light, p, d) {
  const kind = light[3],
    a = sub(light.slice(0, 3), p),
    b = light.slice(4, 7),
    radius = light[7];
  const sphere = (c) => {
    const along = dot(c, d);
    return along > 0 && dot(c, c) - along * along <= radius * radius;
  };
  if (kind === 0) return sphere(a);
  if (kind === 1) {
    const denom = dot(b, d);
    if (denom === 0) return false;
    if (dot(b, a) > 0 && light[11] < 0.5) return false;
    const t = dot(b, a) / denom;
    if (!(t > 0)) return false;
    const q = sub(scale(d, t), a);
    return dot(q, q) <= radius * radius;
  }
  const e = sub(b, p);
  if (sphere(a) || sphere(e)) return true;
  // Infinite cylinder around the axis, then the hit must lie between the ends.
  const axis = unit(sub(e, a)),
    dp = sub(d, scale(axis, dot(d, axis))),
    ap = sub(scale(a, -1), scale(axis, dot(scale(a, -1), axis))),
    A = dot(dp, dp),
    B = 2 * dot(dp, ap),
    C = dot(ap, ap) - radius * radius,
    disc = B * B - 4 * A * C;
  if (A === 0 || disc < 0) return false;
  for (const t of [(-B - Math.sqrt(disc)) / (2 * A), (-B + Math.sqrt(disc)) / (2 * A)]) {
    if (!(t > 0)) continue;
    const along = dot(sub(scale(d, t), a), axis);
    if (along >= 0 && along <= length(sub(e, a))) return true;
  }
  return false;
}

/**
 * Midpoint quadrature over the cone of directions bounding the light (k x k cells, uniform in solid angle) of
 * `kernel(dir)` times the solid angle, over the directions that hit the light.
 */
export function shapeQuadrature(light, p, kernel, k = 400) {
  const kind = light[3],
    radius = light[7],
    a = light.slice(0, 3),
    centre = kind === 2 ? scale(add(a, light.slice(4, 7)), 0.5) : a,
    bound = kind === 2 ? length(sub(light.slice(4, 7), a)) / 2 + radius : radius,
    toCentre = sub(centre, p),
    distance = length(toCentre),
    axis = scale(toCentre, 1 / distance),
    cosMax = distance > bound ? Math.sqrt(1 - (bound / distance) ** 2) : -1,
    [b1, b2] = basis(axis),
    solid = (2 * Math.PI * (1 - cosMax)) / (k * k);
  let sum = 0;
  for (let i = 0; i < k; i++) {
    const ct = 1 - ((i + 0.5) / k) * (1 - cosMax),
      stheta = Math.sqrt(Math.max(0, 1 - ct * ct));
    for (let j = 0; j < k; j++) {
      const phi = ((j + 0.5) / k) * 2 * Math.PI,
        dir = add(scale(axis, ct), add(scale(b1, stheta * Math.cos(phi)), scale(b2, stheta * Math.sin(phi))));
      if (hits(light, p, dir)) sum += kernel(dir) * solid;
    }
  }
  return sum;
}

/**
 * The LTC distribution's own integral over the light, by quadrature: D(w) = max(u.z, 0) / pi |det M^-1| / |M^-1 w|^3
 * with u = M^-1 w / |M^-1 w| (Heitz et al. 2016, eq. 1), M^-1 the receiver's `lobe`. clusterShapeLighting's specular
 * cone integral must equal it whatever the LTC table's fit to GGX.
 */
export function ltcQuadrature(light, p, n, v, roughness, k = 400) {
  const { lobe, m } = frame(n, v, roughness),
    det = Math.abs(m[0] * m[3] - m[1] * m[2]);
  return shapeQuadrature(
    light,
    p,
    (dir) => {
      const w = lobe(dir),
        l = length(w);
      return w[2] > 0 ? (w[2] / l / Math.PI) * (det / (l * l * l)) : 0;
    },
    k,
  );
}

/** Quadrature of Lambert diffuse and GGX specular (height-correlated Smith G2, Schlick Fresnel) over the light. */
export function shapeBruteForce(light, p, n, v, base, roughness, metal, k = 400) {
  const alpha = Math.min(Math.max(roughness, 0.045), 1) ** 2,
    a2 = alpha * alpha,
    nv = Math.min(Math.max(dot(n, v), 0.0001), 1),
    lambda = (c) => (Math.sqrt(1 + (a2 * (1 - c * c)) / (c * c)) - 1) / 2,
    color = light.slice(8, 11);
  const form = shapeQuadrature(light, p, (dir) => Math.max(dot(n, dir), 0) / Math.PI, k),
    lobes = new Map();
  const channel = (c) => {
    const f0 = 0.04 + (base[c] - 0.04) * metal;
    const diffuse = form * (1 - metal) * base[c];
    if (!lobes.has(f0))
      lobes.set(
        f0,
        shapeQuadrature(
          light,
          p,
          (dir) => {
            const nl = dot(n, dir);
            if (!(nl > 0)) return 0;
            const h = unit(add(v, dir)),
              nh = dot(n, h),
              vh = Math.max(dot(v, h), 0),
              t = nh * nh * (a2 - 1) + 1,
              D = nh > 0 ? a2 / (Math.PI * t * t) : 0,
              G2 = 1 / (1 + lambda(nv) + lambda(nl));
            return ((D * G2 * (f0 + (1 - f0) * (1 - vh) ** 5)) / (4 * nl * nv)) * nl;
          },
          k,
        ),
      );
    return [color[c] * diffuse, color[c] * lobes.get(f0)];
  };
  const rgb = [0, 1, 2].map(channel),
    diffuse = rgb.map((c) => c[0]),
    specular = rgb.map((c) => c[1]);
  return { diffuse, specular, total: diffuse.map((d, i) => d + specular[i]) };
}
