// CPU references for @margoengine/clustered/area, shared by test/area.test.js and
// examples/package-benchmarks/area-lights-gpu.mjs.
// - edge(): the exact edge term of the polygon form factor in float64.
// - ltc(): a float64 mirror of the WGSL clusterAreaLighting (frame, LUT lookup, horizon clipping, edge sum).
// - bruteForce(): independent midpoint quadrature over the rectangle of the BRDF the LTC table approximates (GGX D,
//   height-correlated Smith G2, Schlick Fresnel) plus Lambert diffuse, with no LTC or polygon integration at all.
// Lights are AreaLights' packed 16-float records: centre xyz + twoSided, right half-extent, up half-extent, radiance.
import { ltcSize, ltcTable } from '../src/ltc.ts';

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  mix = (a, b, t) => add(a, scale(sub(b, a), t));

/** Edge (a, b) of the vector form factor, z component: (a x b).z * theta / sin(theta) / (2 pi), theta = angle(a, b). */
export function edge(a, b) {
  const n = cross(a, b),
    s = Math.hypot(...n);
  if (s === 0) return 0;
  return ((n[2] / s) * Math.atan2(s, dot(a, b))) / (2 * Math.PI);
}

/** Exact cosine-weighted solid angle / pi of a polygon of points (any distance) above z = 0, counter-clockwise from +z. */
export function formFactor(points) {
  const unit = (p) => scale(p, 1 / Math.hypot(...p));
  let sum = 0;
  for (let i = 0; i < points.length; i++) sum += edge(unit(points[i]), unit(points[(i + 1) % points.length]));
  return sum;
}

// IEEE half to number.
function half(bits) {
  const sign = bits & 0x8000 ? -1 : 1,
    exponent = (bits >> 10) & 31,
    mantissa = bits & 1023;
  if (exponent === 0) return sign * mantissa * 2 ** -24;
  if (exponent === 31) return mantissa ? Number.NaN : sign * Infinity;
  return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
}
let table;
const cell = (x, y, k) => {
  table ??= ltcTable();
  const at = (y * ltcSize + x) * 6 + k * 2;
  return [half(table[at]), half(table[at + 1])];
};
/** Bilinear LUT lookup at table coordinates st, pair k (0: matrix x y, 1: matrix z w, 2: magnitude, Fresnel). */
function lookup(st, k) {
  const i = [Math.floor(st[0]), Math.floor(st[1])],
    j = [Math.min(i[0] + 1, ltcSize - 1), Math.min(i[1] + 1, ltcSize - 1)],
    f = [st[0] - i[0], st[1] - i[1]];
  const lerp = (p, q, t) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
  return lerp(
    lerp(cell(i[0], i[1], k), cell(j[0], i[1], k), f[0]),
    lerp(cell(i[0], j[1], k), cell(j[0], j[1], k), f[0]),
    f[1],
  );
}

const unitOrZero = (p) => scale(p, 1 / Math.sqrt(Math.max(dot(p, p), 1e-20)));
// Quad seen through the 3x3 transform `m` (a function), clipped to z >= 0, closed along the horizon.
function integral(m, corners) {
  const p = corners.map(m);
  let leave = [0, 0, 0],
    enter = [0, 0, 0],
    sum = 0;
  for (let i = 0; i < 4; i++) {
    const s0 = p[i],
      e0 = p[(i + 1) % 4];
    if (s0[2] < 0 && e0[2] < 0) continue;
    let s = s0,
      e = e0;
    if (s0[2] < 0) enter = s = mix(s0, e0, s0[2] / (s0[2] - e0[2]));
    else if (e0[2] < 0) leave = e = mix(s0, e0, s0[2] / (s0[2] - e0[2]));
    sum += edge(unitOrZero(s), unitOrZero(e));
  }
  return sum + edge(unitOrZero(leave), unitOrZero(enter));
}

const light = (l) => ({
  center: l.slice(0, 3),
  twoSided: l[3] > 0.5,
  right: l.slice(4, 7),
  up: l.slice(8, 11),
  color: l.slice(12, 15),
});

/** The shader's result for one packed light at point p, unit normal n and unit view v: {diffuse, specular, total}. */
export function ltc(l, p, n, v, base, roughness, metal) {
  const { center, twoSided, right, up, color } = light(l),
    nv = Math.min(Math.max(dot(n, v), 0.0001), 1),
    st = [Math.min(Math.max(roughness, 0.045), 1) * (ltcSize - 1), Math.sqrt(1 - nv) * (ltcSize - 1)],
    [m0, m1] = lookup(st, 0),
    [m2, m3] = lookup(st, 1),
    [magnitude, fresnel] = lookup(st, 2);
  let t = sub(v, scale(n, dot(n, v)));
  if (dot(t, t) < 1e-8) t = cross(n, Math.abs(n[0]) > 0.5 ? [0, 0, 1] : [1, 0, 0]);
  const x = scale(t, 1 / Math.hypot(...t)),
    y = cross(n, x),
    local = (q) => [dot(x, q), dot(y, q), dot(n, q)],
    lobe = (q) => {
      const [a, b, c] = local(q);
      return [a * m0 + c * m2, b, a * m1 + c * m3];
    };
  const c = sub(center, p);
  let side = 1;
  const zero = { diffuse: [0, 0, 0], specular: [0, 0, 0], total: [0, 0, 0] };
  if (dot(cross(right, up), c) > 0) {
    if (!twoSided) return zero;
    side = -1;
  }
  const corners = [sub(sub(c, right), up), add(sub(c, right), up), add(add(c, right), up), sub(add(c, right), up)],
    spec = Math.max(side * integral(lobe, corners), 0),
    diff = Math.max(side * integral(local, corners), 0);
  const diffuse = color.map((k, i) => k * diff * (1 - metal) * base[i]),
    specular = color.map((k, i) => {
      const f0 = 0.04 + (base[i] - 0.04) * metal;
      return k * spec * (f0 * magnitude + (1 - f0) * fresnel);
    });
  return { diffuse, specular, total: diffuse.map((d, i) => d + specular[i]) };
}

/**
 * Midpoint quadrature over a k x k grid on the rectangle of radiance x BRDF x n.l x d(omega), with
 * d(omega) = |cos at the light| dA / r^2. BRDF: (1 - metal) base / pi + D G2 F / (4 n.l n.v), GGX with alpha =
 * roughness^2 (roughness clamped to 0.045 as the shader does), height-correlated Smith G2 = 1 / (1 + Lambda(v) +
 * Lambda(l)), Schlick F with f0 = mix(0.04, base, metal). Returns {diffuse, specular, total}.
 */
export function bruteForce(l, p, n, v, base, roughness, metal, k = 256) {
  const { center, twoSided, right, up, color } = light(l),
    normal = cross(right, up),
    area = 4 * Math.hypot(...normal),
    facing = scale(normal, 1 / Math.hypot(...normal)),
    alpha = Math.min(Math.max(roughness, 0.045), 1) ** 2,
    a2 = alpha * alpha,
    nv = Math.min(Math.max(dot(n, v), 0.0001), 1),
    lambda = (c) => (Math.sqrt(1 + (a2 * (1 - c * c)) / (c * c)) - 1) / 2;
  const diffuse = [0, 0, 0],
    specular = [0, 0, 0];
  if (dot(facing, sub(center, p)) > 0 && !twoSided) return { diffuse, specular, total: [0, 0, 0] };
  for (let i = 0; i < k; i++)
    for (let j = 0; j < k; j++) {
      const q = add(add(center, scale(right, (2 * i + 1) / k - 1)), scale(up, (2 * j + 1) / k - 1)),
        w = sub(q, p),
        r2 = dot(w, w),
        r = Math.sqrt(r2),
        dir = scale(w, 1 / r),
        nl = dot(n, dir);
      if (!(nl > 0)) continue;
      const solid = (Math.abs(dot(facing, dir)) * area) / (k * k) / r2;
      let h = add(v, dir);
      h = scale(h, 1 / Math.hypot(...h));
      const nh = dot(n, h),
        vh = Math.max(dot(v, h), 0),
        t = nh * nh * (a2 - 1) + 1,
        D = nh > 0 ? a2 / (Math.PI * t * t) : 0,
        G2 = 1 / (1 + lambda(nv) + lambda(nl)),
        weight = (1 - vh) ** 5;
      for (let c = 0; c < 3; c++) {
        const f0 = 0.04 + (base[c] - 0.04) * metal,
          F = f0 + (1 - f0) * weight;
        diffuse[c] += (color[c] * (1 - metal) * base[c] * nl * solid) / Math.PI;
        specular[c] += color[c] * ((D * G2 * F) / (4 * nl * nv)) * nl * solid;
      }
    }
  return { diffuse, specular, total: diffuse.map((d, i) => d + specular[i]) };
}
