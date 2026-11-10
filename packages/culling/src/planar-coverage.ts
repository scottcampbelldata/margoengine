import type { TriangleGeometry } from './software-depth.js';

// Float32 positions are dyadic. Integer units of 2^-149 make coplanarity and convexity exact,
// so a nearly planar folded pair cannot invent an occluding surface across its shared edge.
const bits = new DataView(new ArrayBuffer(4));
function integer(value: number): bigint {
  bits.setFloat32(0, value);
  const word = bits.getUint32(0),
    exponent = (word >>> 23) & 255;
  const mantissa = BigInt((word & 0x7fffff) | (exponent ? 0x800000 : 0));
  return (word >>> 31 ? -mantissa : mantissa) << BigInt(exponent ? exponent - 1 : 0);
}
function convexPair(v: Float32Array, polygon: number[]): boolean {
  const p = polygon.map((i) => [0, 1, 2].map((k) => integer(v[i * 6 + k])));
  const a = p[1].map((x, k) => x - p[0][k]),
    b = p[2].map((x, k) => x - p[0][k]),
    n = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  if (n.every((x) => x === 0n) || n.reduce((s, x, k) => s + x * (p[3][k] - p[0][k]), 0n) !== 0n) return false;
  const axis = n.findIndex((x) => x !== 0n),
    u = (axis + 1) % 3,
    w = (axis + 2) % 3;
  let sign = 0n;
  for (let i = 0; i < 4; i++) {
    const x = p[i],
      y = p[(i + 1) % 4],
      z = p[(i + 2) % 4],
      turn = (y[u] - x[u]) * (z[w] - y[w]) - (y[w] - x[w]) * (z[u] - y[u]);
    if (turn === 0n || (sign !== 0n && turn > 0n !== sign > 0n)) return false;
    sign = turn;
  }
  return true;
}

/** @internal Remove shared diagonals only between exactly coplanar, consistently wound convex triangle pairs. */
export function coveragePolygons({ vertices, indices }: TriangleGeometry): number[][] {
  const polygons: number[][] = [],
    edges = new Map<string, { polygon: number; a: number; b: number; c: number }>();
  for (let i = 0; i < indices.length; i += 3) {
    const tri = [indices[i], indices[i + 1], indices[i + 2]];
    let merged = false;
    for (let e = 0; e < 3 && !merged; e++) {
      const a = tri[e],
        b = tri[(e + 1) % 3],
        c = tri[(e + 2) % 3],
        other = edges.get(`${b}:${a}`);
      if (!other || polygons[other.polygon].length !== 3) continue;
      const quad = [a, other.c, b, c];
      if (convexPair(vertices, quad)) {
        polygons[other.polygon] = quad;
        merged = true;
      }
    }
    if (!merged) {
      const polygon = polygons.push(tri) - 1;
      for (let e = 0; e < 3; e++)
        edges.set(`${tri[e]}:${tri[(e + 1) % 3]}`, { polygon, a: tri[e], b: tri[(e + 1) % 3], c: tri[(e + 2) % 3] });
    }
  }
  return polygons;
}
