// Spec-scoped comparison of hardware mip footprints (Scott's ruling of 2026-11-10; docs/known-bugs.md, "AMD D3D11
// compressed mip blend"). WebGPU 7.1.1 leaves the precise filtering behavior implementation-dependent, and the AMD
// D3D11 driver under ANGLE blends two mip levels with a compressed weight, clamp((frac - 0.1) / 0.8, 0, 1), where
// native WebGPU (D3D12) on the same GPU uses frac. A raw WebGL2 probe classifies the backend:
// - linear blend: the layer must still equal native bit for bit (the callers keep their exact assertions);
// - compressed blend: native and the layer must pick the same LOD (equal nearest-mip sweeps, compared exactly) and
//   every blended texel must be exactly what each side's own sampler returns at one LOD of the 1/256 grid: native
//   against native textureSampleLevel, the layer against raw WebGL2 textureLod at that same LOD.
// No tolerance is widened: every comparison here is of IEEE-754 bits.

/** LODs k/256 for k = 0..1024, as the blend probe in features.html renders them. */
export const PROBE_LODS = 1025;

/**
 * The backend's mip blend from a probe between a white level 0 and a black level 1 (the first 257 LODs of a
 * blendProbe([255, 0, 255, 0, 255]) result): 'linear' when every weight 1 - value is within 1/256 (one step of the
 * hardware's LOD fraction) of k/256, else 'compressed'. Also returns the worst weight seen.
 */
export function classifyBlend(whiteBlackBits) {
  const values = new Float32Array(Uint32Array.from(whiteBlackBits).buffer);
  let worst = { k: 0, weight: 0, error: 0 };
  for (let k = 0; k <= 256; k++) {
    const weight = 1 - values[k * 4];
    const error = Math.abs(weight - k / 256);
    if (error > worst.error) worst = { k, weight, error };
  }
  return { blend: worst.error > 1 / 256 ? 'compressed' : 'linear', worst };
}

const texel = (bits, i) => bits.slice(i * 4, i * 4 + 4);
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const f32 = (bits) => [...new Float32Array(Uint32Array.from(bits).buffer)].map((v) => +v.toPrecision(7));
/**
 * Failures (at most `limit`) of the compressed-blend comparison of one case: `rows` are the keys sampled with a
 * linear mip filter, each with the probe name its texture and filter use; `sweeps` are nearest-mip sweep keys (the
 * caller compares every other key with native as before). `probes[name]` is { native, gl } as blendProbe returns them; `floats` says
 * the rows are numbers rather than f32 bits.
 */
export function compressedFailures(native, compat, { rows, sweeps, probes, floats = false }, limit = 8) {
  // features.html returns implicitFootprint rows as f32 bits and mipFiltering rows as numbers.
  const bitsOf = (row) => (floats ? [...new Uint32Array(Float32Array.from(row).buffer)] : [...row]);
  const out = [];
  const push = (line) => out.length < limit && out.push(line);
  for (const key of sweeps) {
    if (!native[key] || !compat[key]) push(`${key}: sweep missing`);
    else if (!same(bitsOf(native[key]), bitsOf(compat[key]))) {
      const n = bitsOf(native[key]), c = bitsOf(compat[key]);
      const i = n.findIndex((v, j) => v !== c[j]) >> 2;
      push(`${key}[${i}]: nearest-mip LOD sweep differs (native ${f32(texel(n, i))[0]}, compat ${f32(texel(c, i))[0]}): another LOD`);
    } else if (new Set(bitsOf(native[key])).size < 2) push(`${key}: the sweep never changes level, so it proves nothing`);
  }
  for (const [key, probeName] of Object.entries(rows)) {
    const probe = probes[probeName];
    if (!native[key] || !compat[key]) {
      push(`${key}: missing`);
      continue;
    }
    const n = bitsOf(native[key]), c = bitsOf(compat[key]);
    if (n.length !== c.length) push(`${key}: length ${n.length} vs ${c.length}`);
    for (let i = 0; i < n.length / 4; i++) {
      const lods = [];
      for (let k = 0; k < PROBE_LODS; k++) if (same(texel(probe.native, k), texel(n, i))) lods.push(k);
      if (!lods.length) {
        push(`${key}[${i}]: native ${f32(texel(n, i))} is not its own textureSampleLevel at any LOD k/256`);
        continue;
      }
      if (!lods.some((k) => same(texel(probe.gl, k), texel(c, i)))) {
        const k = lods[0];
        push(`${key}[${i}]: compat ${f32(texel(c, i))} is not the driver's blend ${f32(texel(probe.gl, k))} at native's LOD ${k}/256` + (lods.length > 1 ? ` (or ${lods.length - 1} more)` : ''));
      }
    }
  }
  return out;
}
