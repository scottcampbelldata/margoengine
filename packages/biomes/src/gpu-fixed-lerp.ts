// Clean-room Margo derivation, 2026-11-01. Primary source: W3C WGSL (2026-10-26),
// https://www.w3.org/TR/2026/CRD-WGSL-20261026/#integer-types (concrete integers wrap modulo 2^32),
// #bit-expr (u32 right shift inserts zeros; constant shift amounts must be below 32),
// #bitcast-builtin (reinterpret the same bits). No other engine source was used.
// Supported claim: exact a + floor((b-a)*f/65536), composed x then z for bilinear sampling, as in fixed.ts.
// Assumptions: Int32 corners, integer fractions in [0,65536] inclusive; the caller clamps coordinates.
// Biasing the sign bit orders signed corners as u32. For magnitude m = mh*65536 + ml,
// floor(m*f/65536) = mh*f + floor(ml*f/65536); ceil replaces ml*f with ml*f+65535.
// mh*f <= 4294901760, ml*f+65535 <= 4294967295, and either rounded sum <= m <= 4294967295.
// Thus all operations fit u32 even though the unsplit product can approach 2^48.
// Descending lerps subtract ceil, implementing floor of a negative difference. At f=65536 either path reaches b.
// The reference uses exact integer-valued JS doubles below 2^53, preserving the existing CPU rounding.

/** Internal integer-only WGSL primitives for future opt-in region fields; no package entry exports these. */
export const FIXED_LERP_WGSL = /* wgsl */ `
fn lerpQ16(a: i32, b: i32, f: u32) -> i32 {
  let ua = bitcast<u32>(a) ^ 0x80000000u;
  let ub = bitcast<u32>(b) ^ 0x80000000u;
  if (ub >= ua) {
    let m = ub - ua;
    let step = (m >> 16u) * f + (((m & 0xffffu) * f) >> 16u);
    return bitcast<i32>((ua + step) ^ 0x80000000u);
  }
  let m = ua - ub;
  let step = (m >> 16u) * f + (((m & 0xffffu) * f + 0xffffu) >> 16u);
  return bitcast<i32>((ua - step) ^ 0x80000000u);
}

fn bilinearQ16(c00: i32, c10: i32, c01: i32, c11: i32, fx: u32, fz: u32) -> i32 {
  return lerpQ16(lerpQ16(c00, c10, fx), lerpQ16(c01, c11, fx), fz);
}
`;

/** CPU reference for valid Int32 corners and an already-clamped inclusive Q16 fraction. */
export function lerpQ16Ref(a: number, b: number, f: number): number {
  return a + Math.floor(((b - a) * f) / 65536);
}

/** CPU reference with the same x-then-z rounding order as fixed.ts bilinear. */
export function bilinearQ16Ref(c00: number, c10: number, c01: number, c11: number, fx: number, fz: number): number {
  return lerpQ16Ref(lerpQ16Ref(c00, c10, fx), lerpQ16Ref(c01, c11, fx), fz);
}
