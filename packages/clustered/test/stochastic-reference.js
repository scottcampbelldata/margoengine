// Float64 mirror of the stochastic light loop of @margoengine/clustered/stochastic, for one pixel whose shadowed lights
// have unshadowed radiance `radiance` and visibility `visibility`. `quad` pixels with the same lights share N and D,
// as the WGSL's quad sum does. `lookups.count` counts the shadow lookups this pixel makes.
const LUMINANCE = [0.2126, 0.7152, 0.0722];
const lum = (c) => LUMINANCE[0] * c[0] + LUMINANCE[1] * c[1] + LUMINANCE[2] * c[2];

function pixel(lights, samples, random, lookups) {
  const sum = [0, 0, 0],
    picks = new Array(samples).fill(-1),
    kept = [];
  let total = 0;
  lights.forEach(({ radiance }, i) => {
    const w = lum(radiance);
    if (!(w > 0)) return;
    if (kept.length < samples) kept.push(i);
    total += w;
    for (let k = 0; k < 3; k++) sum[k] += radiance[k];
    for (let r = 0; r < samples; r++) if (random() * total < w) picks[r] = i;
  });
  const n = [0, 0, 0],
    d = [0, 0, 0];
  if (kept.length === lights.filter((l) => lum(l.radiance) > 0).length) {
    const exact = [0, 0, 0];
    for (const i of kept) {
      if (lookups) lookups.count++;
      for (let k = 0; k < 3; k++) exact[k] += lights[i].radiance[k] * lights[i].visibility;
    }
    return { exact, n, d, sum };
  }
  for (const i of picks) {
    if (lookups) lookups.count++;
    const w = lum(lights[i].radiance);
    for (let k = 0; k < 3; k++) {
      d[k] += lights[i].radiance[k] / w;
      n[k] += (lights[i].radiance[k] / w) * lights[i].visibility;
    }
  }
  return { n, d, sum };
}
// clusterStochasticRatio: per channel N / D, or the luminance ratio where a channel has no picks.
function ratio(n, d) {
  const dl = lum(d),
    mean = dl > 0 ? lum(n) / dl : 1;
  return [0, 1, 2].map((k) => (d[k] > 1e-20 ? n[k] / d[k] : mean));
}
/** The pixel's shadowed light: `[r, g, b]` with `picked` (the D sums, 0 for a channel no pick lights). */
export function estimate(lights, samples, random, quad = 1, lookups) {
  const own = pixel(lights, samples, random, lookups);
  if (own.exact) return Object.assign(own.exact, { picked: [1, 1, 1] });
  const n = [...own.n],
    d = [...own.d];
  for (let q = 1; q < quad; q++) {
    const other = pixel(lights, samples, random);
    for (let k = 0; k < 3; k++) {
      n[k] += other.n[k];
      d[k] += other.d[k];
    }
  }
  const r = ratio(n, d);
  return Object.assign(
    own.sum.map((v, k) => v * r[k]),
    { picked: d },
  );
}
/** The exact shadowed sum. */
export const exact = (lights) => [0, 1, 2].map((k) => lights.reduce((s, l) => s + l.radiance[k] * l.visibility, 0));
/** A seeded linear congruential generator in [0, 1). */
export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
