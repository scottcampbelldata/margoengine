// Lattice hash and value noise shared by the planet entries (no entry exports it).
// Wellons 2018's lowbias32 over a lattice point, to -1..1.
export function hash(x: number, y: number, z: number, seed: number): number {
  let h = Math.imul(x, 0x8da6b343) ^ Math.imul(y, 0xd8163841) ^ Math.imul(z, 0xcb1ab31f) ^ seed;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 2147483647.5 - 1;
}
/** Trilinear value noise with quintic fades, -1..1. */
export function valueNoise(x: number, y: number, z: number, seed: number): number {
  const xi = Math.floor(x),
    yi = Math.floor(y),
    zi = Math.floor(z),
    fx = x - xi,
    fy = y - yi,
    fz = z - zi,
    u = fx * fx * fx * (fx * (fx * 6 - 15) + 10),
    v = fy * fy * fy * (fy * (fy * 6 - 15) + 10),
    w = fz * fz * fz * (fz * (fz * 6 - 15) + 10),
    s = Math.imul(seed, 0x165667b1),
    a = hash(xi, yi, zi, s),
    b = hash(xi + 1, yi, zi, s),
    c = hash(xi, yi + 1, zi, s),
    d = hash(xi + 1, yi + 1, zi, s),
    e = hash(xi, yi, zi + 1, s),
    f = hash(xi + 1, yi, zi + 1, s),
    g = hash(xi, yi + 1, zi + 1, s),
    h = hash(xi + 1, yi + 1, zi + 1, s),
    y0 = a + (b - a) * u + (c + (d - c) * u - a - (b - a) * u) * v,
    y1 = e + (f - e) * u + (g + (h - g) * u - e - (f - e) * u) * v;
  return y0 + (y1 - y0) * w;
}
