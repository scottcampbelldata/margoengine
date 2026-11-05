import { Vector3 } from './vector3.js';
import type { BoxLike, MatrixLike, PlaneLike, Vec3Like } from './types.js';

// sin² of the angle at corner `a` below which the triangle counts as degenerate (float rounding of the area term).
const DEGENERATE = 1e-14;

// Scratch for intersectsBox: corners relative to the box centre, the three edges, and the box's half sizes.
const v = new Float64Array(9),
  edge = new Float64Array(9),
  half = new Float64Array(3);

/** True when the corners and the box, projected on axis (x, y, z), have a gap between them. */
function separated(x: number, y: number, z: number): boolean {
  const p0 = v[0] * x + v[1] * y + v[2] * z,
    p1 = v[3] * x + v[4] * y + v[5] * z,
    p2 = v[6] * x + v[7] * y + v[8] * z,
    r = half[0] * Math.abs(x) + half[1] * Math.abs(y) + half[2] * Math.abs(z);
  return Math.min(p0, p1, p2) > r || Math.max(p0, p1, p2) < -r;
}
const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);

/**
 * Triangle with corners `a`, `b`, `c`; counter-clockwise corners face the viewer, so the normal is (b - a) x (c - a).
 * A degenerate triangle (corners in a line) has area 0, a zero normal and no barycentric coordinates; closest-point
 * queries still work on what is left of it. Methods that take an `out` write into it and return it; it may be an input.
 */
export class Triangle {
  constructor(
    public a = new Vector3(),
    public b = new Vector3(),
    public c = new Vector3(),
  ) {}

  set(a: Vec3Like, b: Vec3Like, c: Vec3Like): this {
    this.a.copy(a);
    this.b.copy(b);
    this.c.copy(c);
    return this;
  }
  /** Reads corners `ia`, `ib`, `ic` (vertex numbers) from packed positions, e.g. a geometry `positions` array. */
  setFromPositions(positions: ArrayLike<number>, ia: number, ib: number, ic: number): this {
    this.a.fromArray(positions, ia * 3);
    this.b.fromArray(positions, ib * 3);
    this.c.fromArray(positions, ic * 3);
    return this;
  }
  copy(triangle: Triangle): this {
    return this.set(triangle.a, triangle.b, triangle.c);
  }
  clone(): Triangle {
    return new Triangle().copy(this);
  }
  /** Area; 0 when degenerate. */
  getArea(): number {
    const { a, b, c } = this,
      ux = b.x - a.x,
      uy = b.y - a.y,
      uz = b.z - a.z,
      vx = c.x - a.x,
      vy = c.y - a.y,
      vz = c.z - a.z;
    return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
  }
  /** The centroid. */
  getMidpoint<T extends Vec3Like>(out: T): T {
    const { a, b, c } = this,
      x = (a.x + b.x + c.x) / 3,
      y = (a.y + b.y + c.y) / 3,
      z = (a.z + b.z + c.z) / 3;
    out.x = x;
    out.y = y;
    out.z = z;
    return out;
  }
  /** Unit normal; the zero vector when degenerate. */
  getNormal<T extends Vec3Like>(out: T): T {
    const { a, b, c } = this,
      ux = b.x - a.x,
      uy = b.y - a.y,
      uz = b.z - a.z,
      vx = c.x - a.x,
      vy = c.y - a.y,
      vz = c.z - a.z,
      x = uy * vz - uz * vy,
      y = uz * vx - ux * vz,
      z = ux * vy - uy * vx,
      length = Math.hypot(x, y, z),
      scale = length > 0 ? 1 / length : 0;
    out.x = x * scale;
    out.y = y * scale;
    out.z = z * scale;
    return out;
  }
  /** The triangle's plane, normal as {@link Triangle.getNormal}; a zero normal when degenerate. */
  getPlane<T extends PlaneLike>(out: T): T {
    const n = this.getNormal(out.normal);
    out.constant = -(n.x * this.a.x + n.y * this.a.y + n.z * this.a.z);
    return out;
  }
  /**
   * Barycentric weights of `p` for corners a, b, c in `out.x`, `out.y`, `out.z`, summing to 1. A point off the plane
   * gets the weights of its projection on it. Returns null (leaving `out` as it was) for a degenerate triangle.
   */
  getBarycoord<T extends Vec3Like>(p: Vec3Like, out: T): T | null {
    const { a, b, c } = this,
      ux = b.x - a.x,
      uy = b.y - a.y,
      uz = b.z - a.z,
      vx = c.x - a.x,
      vy = c.y - a.y,
      vz = c.z - a.z,
      wx = p.x - a.x,
      wy = p.y - a.y,
      wz = p.z - a.z,
      uu = ux * ux + uy * uy + uz * uz,
      uv = ux * vx + uy * vy + uz * vz,
      vv = vx * vx + vy * vy + vz * vz,
      uw = ux * wx + uy * wy + uz * wz,
      vw = vx * wx + vy * wy + vz * wz,
      denominator = uu * vv - uv * uv;
    if (!(denominator > DEGENERATE * uu * vv)) return null;
    const weightB = (vv * uw - uv * vw) / denominator,
      weightC = (uu * vw - uv * uw) / denominator;
    out.x = 1 - weightB - weightC;
    out.y = weightB;
    out.z = weightC;
    return out;
  }
  /**
   * True when `p` projects inside the triangle or on its edges, each weight allowed to fall `epsilon` below 0 (raise
   * it for points that were computed on an edge). The distance off the plane is not checked. False when degenerate.
   */
  containsPoint(p: Vec3Like, epsilon = 0): boolean {
    const w = this.getBarycoord(p, { x: 0, y: 0, z: 0 });
    return w !== null && w.x >= -epsilon && w.y >= -epsilon && w.z >= -epsilon;
  }
  /**
   * Blends the corner values `va`, `vb`, `vc` (normals, colours, UVs in x and y) at `p` into `out`, by the weights of
   * {@link Triangle.getBarycoord}. Returns null (leaving `out` as it was) for a degenerate triangle.
   */
  getInterpolation<T extends Vec3Like>(p: Vec3Like, va: Vec3Like, vb: Vec3Like, vc: Vec3Like, out: T): T | null {
    const w = this.getBarycoord(p, { x: 0, y: 0, z: 0 });
    if (!w) return null;
    const x = va.x * w.x + vb.x * w.y + vc.x * w.z,
      y = va.y * w.x + vb.y * w.y + vc.y * w.z,
      z = va.z * w.x + vb.z * w.y + vc.z * w.z;
    out.x = x;
    out.y = y;
    out.z = z;
    return out;
  }
  /** True when a viewer looking along `direction` sees the counter-clockwise side. False when degenerate. */
  isFrontFacing(direction: Vec3Like): boolean {
    const n = this.getNormal({ x: 0, y: 0, z: 0 });
    return n.x * direction.x + n.y * direction.y + n.z * direction.z < 0;
  }
  /** The point of the triangle nearest `p`. Degenerate triangles answer for the segment or point they collapse to. */
  closestPointToPoint<T extends Vec3Like>(p: Vec3Like, out: T): T {
    const { a, b, c } = this,
      abx = b.x - a.x,
      aby = b.y - a.y,
      abz = b.z - a.z,
      acx = c.x - a.x,
      acy = c.y - a.y,
      acz = c.z - a.z,
      apx = p.x - a.x,
      apy = p.y - a.y,
      apz = p.z - a.z,
      uu = abx * abx + aby * aby + abz * abz,
      uv = abx * acx + aby * acy + abz * acz,
      vv = acx * acx + acy * acy + acz * acz,
      d1 = abx * apx + aby * apy + abz * apz,
      d2 = acx * apx + acy * apy + acz * apz,
      denominator = uu * vv - uv * uv;
    // Weights of b and c at the point's projection, when that lands inside.
    if (denominator > DEGENERATE * uu * vv) {
      const wb = (vv * d1 - uv * d2) / denominator,
        wc = (uu * d2 - uv * d1) / denominator;
      if (wb >= 0 && wc >= 0 && wb + wc <= 1) return this.blend(wb, wc, out);
    }
    // Outside (or degenerate): the nearest of the three edges holds the answer.
    const bcx = c.x - b.x,
      bcy = c.y - b.y,
      bcz = c.z - b.z,
      bc2 = bcx * bcx + bcy * bcy + bcz * bcz,
      bpx = p.x - b.x,
      bpy = p.y - b.y,
      bpz = p.z - b.z,
      tab = uu > 0 ? clamp01(d1 / uu) : 0,
      tac = vv > 0 ? clamp01(d2 / vv) : 0,
      tbc = bc2 > 0 ? clamp01((bpx * bcx + bpy * bcy + bpz * bcz) / bc2) : 0,
      dab = (apx - abx * tab) ** 2 + (apy - aby * tab) ** 2 + (apz - abz * tab) ** 2,
      dac = (apx - acx * tac) ** 2 + (apy - acy * tac) ** 2 + (apz - acz * tac) ** 2,
      dbc = (bpx - bcx * tbc) ** 2 + (bpy - bcy * tbc) ** 2 + (bpz - bcz * tbc) ** 2;
    if (dab <= dac && dab <= dbc) return this.blend(tab, 0, out);
    return dac <= dbc ? this.blend(0, tac, out) : this.blend(1 - tbc, tbc, out);
  }
  private blend<T extends Vec3Like>(wb: number, wc: number, out: T): T {
    const { a, b, c } = this,
      wa = 1 - wb - wc,
      x = a.x * wa + b.x * wb + c.x * wc,
      y = a.y * wa + b.y * wb + c.y * wc,
      z = a.z * wa + b.z * wb + c.z * wc;
    out.x = x;
    out.y = y;
    out.z = z;
    return out;
  }
  /** Distance from `p` to the triangle. */
  distanceToPoint(p: Vec3Like): number {
    const q = this.closestPointToPoint(p, { x: 0, y: 0, z: 0 });
    return Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z);
  }
  /**
   * True when the triangle and an axis-aligned box share a point (separating-axis test: the box faces, the triangle's
   * plane and the nine edge pairs). Touching counts. An empty box (`max` below `min`) meets nothing.
   */
  intersectsBox(box: BoxLike): boolean {
    const { min, max } = box;
    if (max.x < min.x || max.y < min.y || max.z < min.z) return false;
    const cx = (min.x + max.x) / 2,
      cy = (min.y + max.y) / 2,
      cz = (min.z + max.z) / 2,
      { a, b, c } = this;
    half[0] = (max.x - min.x) / 2;
    half[1] = (max.y - min.y) / 2;
    half[2] = (max.z - min.z) / 2;
    v[0] = a.x - cx;
    v[1] = a.y - cy;
    v[2] = a.z - cz;
    v[3] = b.x - cx;
    v[4] = b.y - cy;
    v[5] = b.z - cz;
    v[6] = c.x - cx;
    v[7] = c.y - cy;
    v[8] = c.z - cz;
    if (separated(1, 0, 0) || separated(0, 1, 0) || separated(0, 0, 1)) return false;
    for (let i = 0; i < 3; i++) {
      const from = i * 3,
        to = ((i + 1) % 3) * 3;
      edge[from] = v[to] - v[from];
      edge[from + 1] = v[to + 1] - v[from + 1];
      edge[from + 2] = v[to + 2] - v[from + 2];
    }
    const nx = edge[1] * edge[5] - edge[2] * edge[4],
      ny = edge[2] * edge[3] - edge[0] * edge[5],
      nz = edge[0] * edge[4] - edge[1] * edge[3];
    if (separated(nx, ny, nz)) return false;
    for (let i = 0; i < 9; i += 3) {
      const ex = edge[i],
        ey = edge[i + 1],
        ez = edge[i + 2];
      // Edge x each box axis.
      if (separated(0, -ez, ey) || separated(ez, 0, -ex) || separated(-ey, ex, 0)) return false;
    }
    return true;
  }
  applyMatrix4(m: MatrixLike): this {
    this.a.applyMatrix4(m);
    this.b.applyMatrix4(m);
    this.c.applyMatrix4(m);
    return this;
  }
  equals(triangle: Triangle, epsilon = 0): boolean {
    return (
      this.a.equals(triangle.a, epsilon) && this.b.equals(triangle.b, epsilon) && this.c.equals(triangle.c, epsilon)
    );
  }
}
