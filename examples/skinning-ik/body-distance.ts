import { hypot3Into } from './norm.ts';

export type Point = [number, number, number];
export type Support = (direction: Point) => Point;

/** Private demo storage: distance, overlap (0/1), then the contact normal. */
export const newDistance = () => new Float64Array(5);

/** The original GJK predicates and arithmetic, with fixed simplex/triangle storage. */
export class BodyDistance {
  private readonly simplex = new Float64Array(12);
  private readonly compact = new Float64Array(12);
  private readonly selected = new Int8Array(4);
  private readonly trianglePoint = new Float64Array(3);
  private readonly bestPoint = new Float64Array(3);
  private readonly bestSelected = new Int8Array(4);
  private readonly direction: Point = [0, 0, 0];
  private readonly near = new Float64Array(3);
  private readonly normal = new Float64Array(3);
  private count = 0;
  private selectedCount = 0;

  constructor(private readonly bodySupport: Support) {}

  private support(shape: Support, offset: number): void {
    const direction = this.direction;
    const point = shape(direction),
      px = point[0],
      py = point[1],
      pz = point[2];
    direction[0] = direction[0] * -1;
    direction[1] = direction[1] * -1;
    direction[2] = direction[2] * -1;
    const body = this.bodySupport(direction);
    this.simplex[offset] = px - body[0];
    this.simplex[offset + 1] = py - body[1];
    this.simplex[offset + 2] = pz - body[2];
  }

  /** Writes caller-owned output; no result or vector from this query escapes. */
  query(shape: Support, out: Float64Array): void {
    const points = this.simplex,
      near = this.near,
      normal = this.normal;
    this.count = 1;
    this.direction[0] = 1;
    this.direction[1] = this.direction[2] = 0;
    this.support(shape, 0);
    near[0] = points[0];
    near[1] = points[1];
    near[2] = points[2];
    normal[0] = 1;
    normal[1] = normal[2] = 0;
    for (let step = 0; step < 28; step++) {
      const squared = near[0] * near[0] + near[1] * near[1] + near[2] * near[2];
      if (squared < 1e-12) {
        this.finish(out, true);
        return;
      }
      const inverse = 1 / Math.sqrt(squared);
      normal[0] = near[0] * inverse;
      normal[1] = near[1] * inverse;
      normal[2] = near[2] * inverse;
      const offset = this.count * 3;
      this.direction[0] = near[0] * -1;
      this.direction[1] = near[1] * -1;
      this.direction[2] = near[2] * -1;
      this.support(shape, offset);
      const nx = points[offset],
        ny = points[offset + 1],
        nz = points[offset + 2];
      if (squared - (near[0] * nx + near[1] * ny + near[2] * nz) < 1e-9 * Math.max(squared, 1)) {
        this.finish(out, false);
        return;
      }
      for (let i = 0; i < this.count; i++) {
        const at = i * 3,
          x = points[at] - nx,
          y = points[at + 1] - ny,
          z = points[at + 2] - nz;
        if (x * x + y * y + z * z < 1e-18) {
          this.finish(out, false);
          return;
        }
      }
      this.count++;
      this.closest();
    }
    this.finish(out, near[0] * near[0] + near[1] * near[1] + near[2] * near[2] < 1e-10);
  }

  private finish(out: Float64Array, overlap: boolean): void {
    if (overlap) out[0] = 0;
    else hypot3Into(this.near, out);
    out[1] = overlap ? 1 : 0;
    out[2] = this.normal[0];
    out[3] = this.normal[1];
    out[4] = this.normal[2];
  }

  private vertex(index: number): void {
    const offset = index * 3;
    this.trianglePoint[0] = this.simplex[offset];
    this.trianglePoint[1] = this.simplex[offset + 1];
    this.trianglePoint[2] = this.simplex[offset + 2];
    this.selected[0] = index;
    this.selectedCount = 1;
  }

  private triangle(a: number, b: number, c: number): void {
    const p = this.simplex,
      ai = a * 3,
      bi = b * 3,
      ci = c * 3,
      ax = p[ai],
      ay = p[ai + 1],
      az = p[ai + 2],
      bx = p[bi],
      by = p[bi + 1],
      bz = p[bi + 2],
      cx = p[ci],
      cy = p[ci + 1],
      cz = p[ci + 2],
      abx = bx - ax,
      aby = by - ay,
      abz = bz - az,
      acx = cx - ax,
      acy = cy - ay,
      acz = cz - az,
      apx = ax * -1,
      apy = ay * -1,
      apz = az * -1,
      d1 = abx * apx + aby * apy + abz * apz,
      d2 = acx * apx + acy * apy + acz * apz;
    if (d1 <= 0 && d2 <= 0) {
      this.vertex(a);
      return;
    }
    const bpx = bx * -1,
      bpy = by * -1,
      bpz = bz * -1,
      d3 = abx * bpx + aby * bpy + abz * bpz,
      d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) {
      this.vertex(b);
      return;
    }
    const vc = d1 * d4 - d3 * d2,
      out = this.trianglePoint;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) {
      const scale = d1 / (d1 - d3);
      out[0] = ax + abx * scale;
      out[1] = ay + aby * scale;
      out[2] = az + abz * scale;
      this.selected[0] = a;
      this.selected[1] = b;
      this.selectedCount = 2;
      return;
    }
    const cpx = cx * -1,
      cpy = cy * -1,
      cpz = cz * -1,
      d5 = abx * cpx + aby * cpy + abz * cpz,
      d6 = acx * cpx + acy * cpy + acz * cpz;
    if (d6 >= 0 && d5 <= d6) {
      this.vertex(c);
      return;
    }
    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) {
      const scale = d2 / (d2 - d6);
      out[0] = ax + acx * scale;
      out[1] = ay + acy * scale;
      out[2] = az + acz * scale;
      this.selected[0] = a;
      this.selected[1] = c;
      this.selectedCount = 2;
      return;
    }
    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
      const scale = (d4 - d3) / (d4 - d3 + (d5 - d6));
      out[0] = bx + (cx - bx) * scale;
      out[1] = by + (cy - by) * scale;
      out[2] = bz + (cz - bz) * scale;
      this.selected[0] = b;
      this.selected[1] = c;
      this.selectedCount = 2;
      return;
    }
    const denominator = va + vb + vc;
    if (Math.abs(denominator) < 1e-24) {
      this.vertex(a);
      return;
    }
    const v = vb / denominator,
      w = vc / denominator;
    out[0] = ax + (abx * v + acx * w);
    out[1] = ay + (aby * v + acy * w);
    out[2] = az + (abz * v + acz * w);
    this.selected[0] = a;
    this.selected[1] = b;
    this.selected[2] = c;
    this.selectedCount = 3;
  }

  private closest(): void {
    const p = this.simplex,
      near = this.near;
    if (this.count === 2) {
      const x = p[3] - p[0],
        y = p[4] - p[1],
        z = p[5] - p[2],
        t = Math.max(0, Math.min(1, -(p[0] * x + p[1] * y + p[2] * z) / (x * x + y * y + z * z)));
      near[0] = p[0] + x * t;
      near[1] = p[1] + y * t;
      near[2] = p[2] + z * t;
      if (t === 0) {
        this.selected[0] = 0;
        this.selectedCount = 1;
      } else if (t === 1) {
        this.selected[0] = 1;
        this.selectedCount = 1;
      } else {
        this.selected[0] = 0;
        this.selected[1] = 1;
        this.selectedCount = 2;
      }
      this.compactSimplex();
      return;
    }
    if (this.count === 3) {
      this.triangle(0, 1, 2);
      near.set(this.trianglePoint);
      this.compactSimplex();
      return;
    }
    const abx = p[3] - p[0],
      aby = p[4] - p[1],
      abz = p[5] - p[2],
      acx = p[6] - p[0],
      acy = p[7] - p[1],
      acz = p[8] - p[2],
      adx = p[9] - p[0],
      ady = p[10] - p[1],
      adz = p[11] - p[2],
      aox = p[0] * -1,
      aoy = p[1] * -1,
      aoz = p[2] * -1,
      crossX = acy * adz - acz * ady,
      crossY = acz * adx - acx * adz,
      crossZ = acx * ady - acy * adx,
      determinant = abx * crossX + aby * crossY + abz * crossZ;
    if (Math.abs(determinant) > 1e-18) {
      const u = (aox * crossX + aoy * crossY + aoz * crossZ) / determinant,
        v =
          (abx * (aoy * adz - aoz * ady) + aby * (aoz * adx - aox * adz) + abz * (aox * ady - aoy * adx)) / determinant,
        w =
          (abx * (acy * aoz - acz * aoy) + aby * (acz * aox - acx * aoz) + abz * (acx * aoy - acy * aox)) / determinant;
      if (u >= -1e-9 && v >= -1e-9 && w >= -1e-9 && u + v + w <= 1 + 1e-9) {
        near[0] = near[1] = near[2] = 0;
        return;
      }
    }
    let best = Infinity,
      bestCount = 0;
    for (let face = 0; face < 4; face++) {
      if (face === 0) this.triangle(0, 1, 2);
      else if (face === 1) this.triangle(0, 1, 3);
      else if (face === 2) this.triangle(0, 2, 3);
      else this.triangle(1, 2, 3);
      const point = this.trianglePoint,
        squared = point[0] * point[0] + point[1] * point[1] + point[2] * point[2];
      if (face === 0 || squared < best) {
        best = squared;
        bestCount = this.selectedCount;
        this.bestPoint.set(point);
        for (let i = 0; i < bestCount; i++) this.bestSelected[i] = this.selected[i];
      }
    }
    near.set(this.bestPoint);
    this.selectedCount = bestCount;
    for (let i = 0; i < bestCount; i++) this.selected[i] = this.bestSelected[i];
    this.compactSimplex();
  }

  private compactSimplex(): void {
    for (let i = 0; i < this.selectedCount; i++) {
      const from = this.selected[i] * 3,
        to = i * 3;
      this.compact[to] = this.simplex[from];
      this.compact[to + 1] = this.simplex[from + 1];
      this.compact[to + 2] = this.simplex[from + 2];
    }
    this.count = this.selectedCount;
    for (let i = 0; i < this.count * 3; i++) this.simplex[i] = this.compact[i];
  }
}
