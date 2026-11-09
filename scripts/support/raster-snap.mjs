// How far a rasterised value can sit from the analytic one at a pixel centre, for GPU checks that compare interpolated
// values with CPU ray casts (scripts/material-depth-distance-gpu-check.js).
//
// The rasteriser snaps vertex positions to fixed point before it interpolates. Eight fractional bits is the D3D12 rule
// (the backend on Windows) and WebGPU names no minimum, so each vertex can move by up to 2^-9 pixel per axis. The
// snapped and the exact triangle differ by an affine map, and a perspective-correct varying is linear in screen space
// once divided by w, so the snapped triangle's value at the pixel centre c is exactly the exact triangle's value at
// c' = c - sum(b_i * d_i), with b the snapped triangle's screen barycentrics of c and d_i the vertex offsets. Inside the
// triangle b is a convex mix, so c' is within 2^-9 pixel of c per axis, and a value whose screen slope is
// |dv/dx| + |dv/dy| per pixel can be off by up to that slope times 2^-9 (tests/raster-snap.test.js checks the map).

/** Fractional bits of vertex snapping assumed: the D3D12 rule. */
export const SNAP_BITS = 8;

/** Largest move of a pixel's interpolated point, per axis, in pixels: half a snapping step. */
export const SNAP = 2 ** -(SNAP_BITS + 1);

/**
 * Tolerance of a value packed in RGBA8 (24 bits and a fraction) whose analytic screen slope is `slope`
 * (|dv/dx| + |dv/dy| per pixel). 3e-6 covers float32 rounding and the packing, as before; a steep pixel adds the snap
 * on top (Radeon 680M, 2026-11-08: an error of 3.05e-6 at a slope of 2.1e-3 per pixel, a move of 1/690 pixel).
 */
export function packedTolerance(slope) {
  return Math.max(3e-6, slope * SNAP + 1e-6);
}
