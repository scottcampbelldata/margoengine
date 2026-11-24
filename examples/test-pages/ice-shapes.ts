// Procedural ice shapes for the ice test page only (not a package API and never a model asset): a lumpy glacial berg,
// a pancake with a raised rim, a brash chunk and a floe slab, each from @margoengine/geometry primitives with their
// vertices moved and their normals rebuilt. Films load real berg models from the asset library instead.
import { cylinderGeometry, icosahedronGeometry, latheGeometry } from '@margoengine/geometry';

type Geometry = ReturnType<typeof icosahedronGeometry>;
const hash = (x: number, y: number, z: number) => {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return s - Math.floor(s);
};
// Smooth 3D value noise, 0..1.
function noise(x: number, y: number, z: number): number {
  const i = Math.floor(x),
    j = Math.floor(y),
    k = Math.floor(z),
    u = x - i,
    v = y - j,
    w = z - k;
  const f = (t: number) => t * t * (3 - 2 * t);
  const lerp = (a: number, b: number, t: number) => a + (b - a) * f(t);
  const c = (a: number, b: number, d: number) => hash(i + a, j + b, k + d);
  return lerp(lerp(lerp(c(0, 0, 0), c(1, 0, 0), u), lerp(c(0, 1, 0), c(1, 1, 0), u), v), lerp(lerp(c(0, 0, 1), c(1, 0, 1), u), lerp(c(0, 1, 1), c(1, 1, 1), u), v), w);
}
const fbm = (x: number, y: number, z: number) => noise(x, y, z) * 0.55 + noise(x * 2.1, y * 2.1, z * 2.1) * 0.3 + noise(x * 4.3, y * 4.3, z * 4.3) * 0.15;
/** Area-weighted vertex normals over the triangles, shared by every vertex at the same place (smooth across seams). */
function renormal(g: Geometry): Geometry {
  const p = g.positions,
    idx = g.indices,
    key = (q: number) => `${p[q].toFixed(4)},${p[q + 1].toFixed(4)},${p[q + 2].toFixed(4)}`,
    sums = new Map<string, number[]>();
  for (let t = 0; t < idx.length; t += 3) {
    const [a, b, c] = [idx[t] * 3, idx[t + 1] * 3, idx[t + 2] * 3];
    const ux = p[b] - p[a],
      uy = p[b + 1] - p[a + 1],
      uz = p[b + 2] - p[a + 2],
      vx = p[c] - p[a],
      vy = p[c + 1] - p[a + 1],
      vz = p[c + 2] - p[a + 2];
    const f = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    for (const q of [a, b, c]) {
      const s = sums.get(key(q)) ?? [0, 0, 0];
      for (let k = 0; k < 3; k++) s[k] += f[k];
      sums.set(key(q), s);
    }
  }
  const n = new Float32Array(p.length);
  for (let q = 0; q < n.length; q += 3) {
    const s = sums.get(key(q)) ?? [0, 1, 0],
      l = Math.hypot(s[0], s[1], s[2]) || 1;
    (n[q] = s[0] / l), (n[q + 1] = s[1] / l), (n[q + 2] = s[2] / l);
  }
  return { ...g, normals: n };
}
/**
 * A glacial berg `width` across: a lumpy block with cliff walls, a plateau top and a keel as deep as it is high, its origin at
 * its centre of volume. Star-shaped, so the triangles stay wound outward.
 */
export function bergShape(width = 80, height = 160, seed = 1): Geometry {
  const g = icosahedronGeometry(1, 6, true),
    p = g.positions;
  for (let q = 0; q < p.length; q += 3) {
    const x = p[q],
      y = p[q + 1],
      z = p[q + 2];
    // A blocky glacier berg: the sphere pushed toward a superellipsoid (cliffs and a plateau), then lumped.
    const block = 1 / Math.pow(x ** 8 + (y * 1.15) ** 8 + z ** 8, 0.125),
      lump = 0.82 + 0.36 * fbm(x * 1.8 + seed, y * 1.8, z * 1.8 - seed),
      r = block * lump;
    (p[q] = x * r * width * 0.5), (p[q + 1] = y * r * height * 0.5), (p[q + 2] = z * r * width * 0.7);
  }
  return renormal(g);
}
/** A pancake 1 m across and 1 m thick (SeaIce scales it): a flat disc with the raised rim collisions push up. */
export function pancakeShape(): Geometry {
  return latheGeometry(
    [
      [0, -0.5],
      [0.42, -0.5],
      [0.5, -0.2],
      [0.5, 0.3],
      [0.46, 0.5],
      [0.38, 0.35],
      [0, 0.3],
    ],
    28,
  );
}
/** A brash chunk 1 m across: a broken, jittered lump. */
export function brashShape(seed = 2): Geometry {
  const g = icosahedronGeometry(0.5, 1, false),
    p = g.positions;
  for (let q = 0; q < p.length; q += 3) {
    const k = 0.75 + 0.5 * hash(p[q] * 9 + seed, p[q + 1] * 9, p[q + 2] * 9);
    (p[q] *= k), (p[q + 1] *= k * 0.8), (p[q + 2] *= k);
  }
  return renormal(g);
}
/** A floe slab 1 m across and 1 m thick: a nine-sided plate with a ragged rim. */
export function floeShape(seed = 3): Geometry {
  const g = cylinderGeometry(0.5, 0.5, 1, 9, 1),
    p = g.positions;
  for (let q = 0; q < p.length; q += 3) {
    const a = Math.atan2(p[q + 2], p[q]),
      k = 0.8 + 0.35 * hash(Math.round(a * 10) + seed, 1, 2);
    (p[q] *= k), (p[q + 2] *= k);
  }
  return renormal(g);
}
