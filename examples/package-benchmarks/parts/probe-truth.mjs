// Physical truth for the probes-gpu box projection check (check 4): what the room's metal floor shows, from first principles.
import { output } from './display.mjs';

const norm = (a) => {
    const l = Math.hypot(...a);
    return a.map((v) => v / l);
  },
  cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// The probes.html room: six walls on this box, each radiating exactly its linear colour.
export const room = { min: [-2, 0, -2], max: [2, 3, 2] };
export const wallAt = (p, d) => {
  let t = Infinity,
    wall = '';
  for (let i = 0; i < 3; i++) {
    if (!d[i]) continue;
    const ti = ((d[i] > 0 ? room.max[i] : room.min[i]) - p[i]) / d[i];
    if (ti < t) {
      t = ti;
      wall = (d[i] > 0 ? 'p' : 'n') + 'xyz'[i];
    }
  }
  return { t, wall, hit: p.map((v, i) => v + d[i] * t) };
};

// The split-sum weight of probeShade's analytic branch (packages/environment/src/probes.ts) with f90 = 1.
export const splitSum = (f0, nv, rough) => {
  const c = [-1, -0.0275, -0.572, 0.022].map((x, i) => rough * x + [1, 0.0425, 1.04, -0.04][i]),
    a = Math.min(c[0] * c[0], 2 ** (-9.28 * nv)) * c[0] + c[1];
  return f0.map((x) => x * (c[2] - 1.04 * a) + (c[3] + 1.04 * a));
};

// GGX prefilter of radiance(d) around r at roughness rough (alpha = rough^2), with n = v = r as the bake convolves its
// levels: half vectors stratified by the GGX distribution (an n x n grid), each light direction weighted by n.l.
export const ggxPrefiltered = (radiance, r, rough, n = 32) => {
  const a2 = rough ** 4,
    t = norm(cross(Math.abs(r[1]) < 0.999 ? [0, 1, 0] : [1, 0, 0], r)),
    b = cross(r, t),
    sum = [0, 0, 0];
  let total = 0;
  for (let i = 0; i < n; i++) {
    const u = (i + 0.5) / n,
      cos2 = (1 - u) / (1 + (a2 - 1) * u),
      cos = Math.sqrt(cos2),
      sin = Math.sqrt(1 - cos2),
      nl = 2 * cos2 - 1;
    if (nl <= 0) continue;
    for (let j = 0; j < n; j++) {
      const phi = (2 * Math.PI * (j + 0.5)) / n,
        h = [0, 1, 2].map((k) => sin * Math.cos(phi) * t[k] + sin * Math.sin(phi) * b[k] + cos * r[k]),
        l = h.map((x, k) => 2 * cos * x - r[k]),
        L = radiance(l);
      for (let ch = 0; ch < 3; ch++) sum[ch] += L[ch] * nl;
      total += nl;
    }
  }
  return sum.map((v) => v / total);
};

// What a white metal floor at point p shows along the reflected ray r (n.v = nv) at the material's real roughness: the
// room radiance seen from p, GGX-prefiltered around r, times the split-sum weight, through core's display line.
export const mirrorWallTruth = (colors, p, r, nv, rough) => {
  const L = ggxPrefiltered((d) => colors[wallAt(p, d).wall], r, rough),
    sw = splitSum([1, 1, 1], Math.min(1, Math.max(1e-4, nv)), rough);
  return output.core(L.map((v, k) => v * sw[k]));
};
