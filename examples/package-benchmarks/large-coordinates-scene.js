// Shared by large-coordinates.mjs (Node, CPU emulation) and large-coordinates.html (real GPU).
// A 10 mm flange (annulus, 2 mm thick) with four 1 mm bolt heads as child meshes, placed `distance` metres from the
// world origin along DIRECTION; the camera orbits and dollies 50 mm away. Units: metres.
export const DISTANCES = [0, 1e3, 1e5, 6e6];
export const DIRECTION = [0.48, 0.6, 0.64];
export const ROTATION = [0.3, 0.5, 0];
export const BOLTS = [
  [0.0035, 0.0015, 0],
  [-0.0035, 0.0015, 0],
  [0, 0.0015, 0.0035],
  [0, 0.0015, -0.0035],
];
export const FRAMES = 40;
export const CAMERA = { fov: 50, near: 0.001, far: 1000 };
export const WIDTH = 640,
  HEIGHT = 360;

/** Camera offset from the flange centre in frame k: orbit 0.25° per frame, dolly 0.2% per frame, from 50 mm. */
export function cameraOffset(k) {
  const az = ((45 + 0.25 * k) * Math.PI) / 180,
    el = (30 * Math.PI) / 180,
    r = 0.05 * 1.002 ** k;
  return [r * Math.cos(el) * Math.sin(az), r * Math.sin(el), r * Math.cos(el) * Math.cos(az)];
}
// Sub-metre offset so no coordinate is a float32-exact round number (real survey coordinates are not).
export const FRACTION = [0.123456, 0.654321, 0.314159];
export const position = (distance) => DIRECTION.map((v, i) => v * distance + FRACTION[i]);

/** Annulus R 5 mm / r 2 mm, 2 mm thick: positions, normals, indices (flat-shaded). */
export function flange(segments = 48, outer = 0.005, inner = 0.002, half = 0.001) {
  const positions = [],
    normals = [],
    indices = [];
  const quad = (a, b, c, d, n) => {
    const s = positions.length / 3;
    for (const p of [a, b, c, d]) {
      positions.push(...p);
      normals.push(...n);
    }
    indices.push(s, s + 1, s + 2, s, s + 2, s + 3);
  };
  for (let i = 0; i < segments; i++) {
    const t0 = (i / segments) * Math.PI * 2,
      t1 = ((i + 1) / segments) * Math.PI * 2,
      c0 = Math.cos(t0),
      s0 = Math.sin(t0),
      c1 = Math.cos(t1),
      s1 = Math.sin(t1);
    const p = (r, c, s, y) => [r * c, y, r * s],
      tm = (t0 + t1) / 2;
    quad(p(inner, c0, s0, half), p(inner, c1, s1, half), p(outer, c1, s1, half), p(outer, c0, s0, half), [0, 1, 0]);
    quad(
      p(outer, c0, s0, -half),
      p(outer, c1, s1, -half),
      p(inner, c1, s1, -half),
      p(inner, c0, s0, -half),
      [0, -1, 0],
    );
    quad(p(outer, c0, s0, half), p(outer, c1, s1, half), p(outer, c1, s1, -half), p(outer, c0, s0, -half), [
      Math.cos(tm),
      0,
      Math.sin(tm),
    ]);
    quad(p(inner, c0, s0, -half), p(inner, c1, s1, -half), p(inner, c1, s1, half), p(inner, c0, s0, half), [
      -Math.cos(tm),
      0,
      -Math.sin(tm),
    ]);
  }
  return { positions, normals, indices };
}
