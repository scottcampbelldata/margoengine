// Float64 oracle for ParticleLiquid whitewater, written from M. Ihmsen, N. Akinci, G. Akinci, M. Teschner, Unified
// spray, foam and air bubbles for particle-based fluids, The Visual Computer 28(6-8) 2012 (equations 1 to 8) and the
// choices docs/water-liquid.md records (surface test, stochastic rounding with the PCG hash of Jarzynski and Olano,
// JCGT 2020). Brute-force neighbours, no grid, so it checks the GPU's bucket grid as well as its arithmetic.

/** PCG hash on u32. */
export const pcg = (v) => {
  const s = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0;
  const t = Math.imul(((s >>> ((s >>> 28) + 4)) ^ s) >>> 0, 277803737) >>> 0;
  return ((t >>> 22) ^ t) >>> 0;
};
/** The shader's rand(a, b) for a step and seed, in [0, 1). */
export const rand = (a, b, step, seed) =>
  (pcg((a ^ pcg((b ^ pcg((step ^ pcg(seed)) >>> 0)) >>> 0)) >>> 0) >>> 8) / 16777216;

/** The paper's clamping function, equation 1. */
export const phi = (i, lo, hi) => (Math.min(i, hi) - Math.min(i, lo)) / (hi - lo);

/** Defaults as ParticleLiquid applies them for fluid radius `radius`. */
export function settings(radius, o = {}) {
  return {
    h: o.support ?? 4 * radius,
    dt: o.timeStep ?? 1 / 60,
    surface: o.surfaceThreshold ?? 0.25,
    ta: o.trappedAir ?? [5, 20],
    wc: o.waveCrest ?? [2, 8],
    ke: o.kineticEnergy ?? [5, 50],
    kta: o.trappedAirRate ?? 100,
    kwc: o.waveCrestRate ?? 100,
    mass: o.particleMass ?? 1000 * (2 * radius) ** 3,
    seed: o.seed ?? 0,
  };
}

/**
 * Normals, potentials and emission counts of every particle for one step.
 * @param {ArrayLike<number>} x positions, 3 per particle
 * @param {ArrayLike<number>} v velocities, 3 per particle
 */
export function potentials(x, v, s, step = 0) {
  const n = x.length / 3,
    h = s.h;
  const near = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const r = [x[3 * i] - x[3 * j], x[3 * i + 1] - x[3 * j + 1], x[3 * i + 2] - x[3 * j + 2]];
      const d = Math.hypot(...r);
      if (d > 0 && d < h) near[i].push({ j, r: r.map((c) => c / d), w: 1 - d / h });
    }
  const normals = near.map((list) => {
    const sum = [0, 0, 0];
    let total = 0;
    for (const { r, w } of list) {
      for (let k = 0; k < 3; k++) sum[k] += r[k] * w;
      total += w;
    }
    const len = Math.hypot(...sum);
    return len > 0 && len >= s.surface * total ? sum.map((c) => c / len) : undefined;
  });
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return near.map((list, i) => {
    const vi = [v[3 * i], v[3 * i + 1], v[3 * i + 2]];
    const ni = normals[i];
    let trapped = 0,
      curvature = 0;
    for (const { j, r, w } of list) {
      const vij = [vi[0] - v[3 * j], vi[1] - v[3 * j + 1], vi[2] - v[3 * j + 2]];
      const vl = Math.hypot(...vij);
      if (vl > 0) trapped += vl * (1 - dot(vij, r) / vl) * w;
      const nj = normals[j];
      if (ni && nj && -dot(r, ni) < 0) curvature += (1 - dot(ni, nj)) * w;
    }
    const speed = Math.hypot(...vi);
    const moving = !!ni && speed > 0 && dot(vi, ni) / speed >= 0.6;
    const ita = phi(trapped, ...s.ta),
      iwc = phi(moving ? curvature : 0, ...s.wc),
      ik = phi(0.5 * s.mass * speed * speed, ...s.ke);
    const rate = ik * (s.kta * ita + s.kwc * iwc);
    const count = Math.max(0, Math.min(255, Math.floor(rate * s.dt + rand(i, 0xffffffff, step, s.seed))));
    return { trapped, curvature, moving, surface: !!ni, ita, iwc, ik, rate, count };
  });
}
