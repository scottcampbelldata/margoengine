// An f32 reference of `lens_field` in src/lens.ts (lensWGSL): every WGSL operation rounded once to f32 as written, with
// the inputs lensSettings packs. The long-time parity case compares the GPU with this model at its unchanged 1e-4 bound
// (KB0362, coordinator ruling 2026-11-11): a correctly rounded f32 evaluation of the shipped shader itself is 1.36e-4
// from the f64 lensField at time 123456.75, so an f64 truth cannot hold any GPU that rounds each operation.
const f = Math.fround;
const pcg = (v) => {
  const s = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0,
    x = Math.imul(((s >>> ((s >>> 28) + 4)) ^ s) >>> 0, 277803737) >>> 0;
  return ((x >>> 22) ^ x) >>> 0;
};
const lattice = (cx, cy, shift, layer) =>
  f(f(pcg((pcg(cx | 0) ^ (((cy | 0) - shift) >>> 0) ^ (Math.imul(layer, 0x9e3779b9) >>> 0)) >>> 0) >>> 8) * f(5.9604645e-8));
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const smoothstep = (e0, e1, x) => {
  const t = f(clamp01(f(f(x - e0) / f(e1 - e0))));
  return f(f(t * t) * f(3 - f(2 * t)));
};
/** lens_field(p, a, b) in f32; a and b are the two vec4 settings (b[3] as its u32 bits). Returns [slope x, slope y, mask]. */
export function lensFieldF32(px, py, a, b) {
  const [ax, ay, az, aw] = Array.from(a, f),
    bits = new Uint32Array(new Float32Array([b[3]]).buffer)[0];
  let rx = 0,
    ry = 0,
    rz = 0;
  const spacing = f(6 * az);
  for (let layer = 0; layer < 2; layer++) {
    const qx = f(px),
      qy = f(py - (layer === 1 ? f(ay * aw) : 0));
    const cellx = Math.floor(f(qx / spacing)),
      celly = Math.floor(f(qy / spacing));
    const k = ((f(b[2]) >>> 0) + layer * 3) >>> 0,
      n = layer === 1 ? bits : 0;
    for (let j = -1; j <= 1; j++)
      for (let i = -1; i <= 1; i++) {
        const cx = f(cellx + i),
          cy = f(celly + j);
        const random = lattice(cx, cy, n, k);
        const activation = smoothstep(random, f(random + f(0.12)), ax);
        const r = f(f(az * f(f(0.55) + f(f(0.45) * lattice(cx, cy, n, k + 1)))) * (layer === 1 ? 1 : f(0.55)));
        // fma(-c, spacing, q): one rounding (the f64 product of two f32 values is exact).
        const lx = f(-cx * spacing + qx),
          ly = f(-cy * spacing + qy);
        const centrex = f(f(f(0.2) + f(f(0.6) * lattice(cx, cy, n, k + 2))) * spacing),
          centrey = f(f(f(0.2) + f(f(0.6) * lattice(f(cx + 17), cy, n, k + 2))) * spacing);
        const vx = f(f(lx - centrex) / r),
          vy = f(f(ly - centrey) / r);
        const dome = Math.max(0, f(1 - f(f(vx * vx) + f(vy * vy)))),
          head = smoothstep(0, f(0.18), dome),
          length = f(f(b[1]) * 4);
        let trail = 0;
        if (layer === 1 && vy < 0 && vy > f(-1 - length))
          trail = f(f(1 - smoothstep(f(0.08), f(0.22), Math.abs(vx))) * smoothstep(f(-1 - length), f(f(-0.8) - length), vy));
        const root = f(Math.sqrt(dome));
        rx = f(rx + f(f(f(f(f(vx * root) * head)) + f(vx * trail)) * activation));
        ry = f(ry + f(f(f(vy * root) * head) * activation));
        rz = Math.max(rz, f(Math.max(head, trail) * activation));
      }
  }
  return [rx, ry, rz];
}
