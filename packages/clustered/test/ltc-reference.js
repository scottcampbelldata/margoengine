// CPU references for @margoengine/clustered/area: `ltc` mirrors the WGSL (clusterAreaLighting in src/area.ts) line by line,
// `bruteForce` integrates the GGX + Lambert BRDF over the rectangle by quadrature (the ground truth LTC approximates).
// A packed light is 16 floats as AreaLights uploads it: centre + twoSided, half-width vector, half-height vector, radiance.
import { ltcSize, ltcTable } from '../src/ltc.ts';

const half = (h) =>
  (h & 0x8000 ? -1 : 1) *
  ((h >> 10) & 31 ? 2 ** (((h >> 10) & 31) - 15) * (1 + (h & 1023) / 1024) : 2 ** -14 * ((h & 1023) / 1024));
const table = Float32Array.from(ltcTable(), half),
  S = ltcSize;
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (a) => scale(a, 1 / Math.hypot(...a)),
  unit = (p) => scale(p, 1 / Math.sqrt(Math.max(dot(p, p), 1e-20)));
// Column-major 3x3 (like WGSL mat3x3f) and helpers.
const mul = (m, p) => [
  m[0] * p[0] + m[3] * p[1] + m[6] * p[2],
  m[1] * p[0] + m[4] * p[1] + m[7] * p[2],
  m[2] * p[0] + m[5] * p[1] + m[8] * p[2],
];
const matmul = (a, b) => [0, 1, 2].flatMap((c) => mul(a, b.slice(c * 3, c * 3 + 3)));

/** Bilinear LTC table lookup: [x, y, z, w, magnitude, fresnel]. */
export function lookup(roughness, nv) {
  const st = [Math.min(Math.max(roughness, 0.045), 1) * (S - 1), Math.sqrt(1 - nv) * (S - 1)],
    i = st.map(Math.floor),
    j = i.map((v) => Math.min(v + 1, S - 1)),
    f = [st[0] - i[0], st[1] - i[1]];
  const cell = (x, y, k) => table[(y * S + x) * 6 + k],
    mix = (a, b, t) => a + (b - a) * t;
  return [0, 1, 2, 3, 4, 5].map((k) =>
    mix(mix(cell(i[0], i[1], k), cell(j[0], i[1], k), f[0]), mix(cell(i[0], j[1], k), cell(j[0], j[1], k), f[0]), f[1]),
  );
}
function edge(a, b) {
  const x = dot(a, b),
    y = Math.abs(x),
    v = (0.8543985 + (0.4965155 + 0.0145206 * y) * y) / (3.417594 + (4.1616724 + y) * y);
  return (a[0] * b[1] - a[1] * b[0]) * (x > 0 ? v : 0.5 / Math.sqrt(Math.max(1 - x * x, 1e-7)) - v);
}
function integral(m, quad) {
  const p = quad.map((q) => mul(m, q));
  let sum = 0,
    leave = [0, 0, 0],
    enter = [0, 0, 0];
  for (let i = 0; i < 4; i++) {
    let s = p[i],
      e = p[(i + 1) % 4];
    if (s[2] < 0 && e[2] < 0) continue;
    const at = (t) => add(s, scale(sub(e, s), t));
    if (s[2] < 0) {
      s = at(s[2] / (s[2] - e[2]));
      enter = s;
    } else if (e[2] < 0) {
      e = at(s[2] / (s[2] - e[2]));
      leave = e;
    }
    sum += edge(unit(s), unit(e));
  }
  return sum + edge(unit(leave), unit(enter)); // zero when nothing was clipped
}
/** Mirror of clusterAreaLighting for one packed light: {specular, diffuse} radiance (rgb), and their total. */
export function ltc(light, position, n, v, base, roughness, metal) {
  const nv = Math.min(Math.max(dot(n, v), 0.0001), 1),
    [x1, y1, z1, w1, magnitude, fresnel] = lookup(roughness, nv);
  let t = sub(v, scale(n, dot(n, v)));
  if (dot(t, t) < 1e-8) t = cross(n, Math.abs(n[0]) > 0.5 ? [0, 0, 1] : [1, 0, 0]);
  const x = normalize(t),
    y = cross(n, x),
    local = [x[0], y[0], n[0], x[1], y[1], n[1], x[2], y[2], n[2]];
  const lobe = matmul([x1, 0, y1, 0, 1, 0, z1, 0, w1], local);
  const c = sub(light.slice(0, 3), position),
    r = light.slice(4, 7),
    u = light.slice(8, 11),
    color = light.slice(12, 15);
  let side = 1;
  if (dot(cross(r, u), c) > 0) {
    if (light[3] < 0.5) return { specular: [0, 0, 0], diffuse: [0, 0, 0], total: [0, 0, 0] };
    side = -1;
  }
  const quad = [sub(sub(c, r), u), add(sub(c, r), u), add(add(c, r), u), sub(add(c, r), u)];
  const s = Math.max(side * integral(lobe, quad), 0),
    d = Math.max(side * integral(local, quad), 0);
  const specular = [0, 1, 2].map((k) => {
    const f0 = 0.04 + (base[k] - 0.04) * metal;
    return (f0 * magnitude + (1 - f0) * fresnel) * color[k] * s;
  });
  const diffuse = [0, 1, 2].map((k) => (1 - metal) * base[k] * color[k] * d);
  return { specular, diffuse, total: [0, 1, 2].map((k) => specular[k] + diffuse[k]) };
}
const lambda = (a2, c) => (Math.sqrt(1 + (a2 * (1 - c * c)) / (c * c)) - 1) / 2;
/** Midpoint quadrature (k x k) of GGX (height-correlated Smith, Schlick Fresnel; the BRDF the LTC table was fitted to) and Lambert over the rectangle. */
export function bruteForce(light, position, n, v, base, roughness, metal, k = 1024) {
  const a = Math.max(roughness, 0.045) ** 2,
    a2 = a * a,
    nv = Math.min(Math.max(dot(n, v), 0.0001), 1);
  const center = light.slice(0, 3),
    r = light.slice(4, 7),
    u = light.slice(8, 11),
    color = light.slice(12, 15),
    normal = normalize(cross(r, u));
  const area = (4 * Math.hypot(...r) * Math.hypot(...u)) / (k * k),
    f0 = base.map((b) => 0.04 + (b - 0.04) * metal);
  const specular = [0, 0, 0],
    diffuse = [0, 0, 0];
  for (let i = 0; i < k; i++)
    for (let j = 0; j < k; j++) {
      const p = add(center, add(scale(r, (2 * (i + 0.5)) / k - 1), scale(u, (2 * (j + 0.5)) / k - 1))),
        d = sub(p, position),
        d2 = dot(d, d),
        l = scale(d, 1 / Math.sqrt(d2));
      const nl = dot(n, l);
      if (nl <= 0) continue;
      let emit = -dot(normal, l);
      if (emit <= 0) {
        if (light[3] < 0.5) continue;
        emit = -emit;
      }
      const solid = (emit * area) / d2,
        h = normalize(add(v, l)),
        nh = dot(n, h),
        vh = Math.max(dot(v, h), 0);
      const D = a2 / (Math.PI * (nh * nh * (a2 - 1) + 1) ** 2),
        G = 1 / (1 + lambda(a2, nv) + lambda(a2, nl)),
        spec = ((D * G) / (4 * nv)) * solid,
        w = (1 - vh) ** 5;
      for (let c = 0; c < 3; c++) {
        specular[c] += (f0[c] + (1 - f0[c]) * w) * spec * color[c];
        diffuse[c] += (((1 - metal) * base[c]) / Math.PI) * nl * solid * color[c];
      }
    }
  return { specular, diffuse, total: [0, 1, 2].map((c) => specular[c] + diffuse[c]) };
}
