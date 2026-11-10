import { Matrix4 as BaseMatrix4 } from './matrix4.js';
import { Vector3 as BaseVector3 } from './vector3.js';
import { Quaternion as BaseQuaternion } from './quaternion.js';
import { Plane as BasePlane } from './plane.js';
import { Ray as BaseRay } from './ray.js';
import { Box3 as BaseBox3 } from './box3.js';
import { Triangle } from './triangle.js';
import { Color as BaseColor } from './color.js';
import type { ColorLike } from './color.js';
import type { MatrixLike, Vec3Like, EulerOrder, ColorSpace } from './types.js';

/** Optional Matrix4 with the porting methods; base imports retain their original size. */
export class Matrix4 extends BaseMatrix4 {
  /** Returns an independent copy retaining the optional methods. */
  override clone(): Matrix4 {
    return new Matrix4().copy(this);
  }
  /** Copies only the translation column, leaving every other entry unchanged. */
  copyPosition(m: MatrixLike): this {
    const e = m.elements;
    return this.setPosition(e[12], e[13], e[14]);
  }
  /** Basis vectors become the first three columns; resets the remaining affine entries. */
  makeBasis(x: Vec3Like, y: Vec3Like, z: Vec3Like): this {
    return this.set(x.x, y.x, z.x, 0, x.y, y.y, z.y, 0, x.z, y.z, z.z, 0, 0, 0, 0, 1);
  }
  /** Copies the three basis columns into caller-owned vectors. */
  extractBasis(x: Vec3Like, y: Vec3Like, z: Vec3Like): this {
    const e = this.elements;
    const values = [e[0], e[1], e[2], e[4], e[5], e[6], e[8], e[9], e[10]];
    for (const [i, out] of [x, y, z].entries()) {
      out.x = values[i * 3];
      out.y = values[i * 3 + 1];
      out.z = values[i * 3 + 2];
    }
    return this;
  }
  /** Removes translation and independent column scales; shear is not orthogonalized. Zero columns stay zero. */
  extractRotation(m: MatrixLike): this {
    const e = m.elements;
    const values = [e[0], e[1], e[2], e[4], e[5], e[6], e[8], e[9], e[10]];
    this.identity();
    for (let c = 0; c < 3; c++) {
      const scale = Math.hypot(values[c * 3], values[c * 3 + 1], values[c * 3 + 2]) || 1;
      for (let r = 0; r < 3; r++) this.elements[c * 4 + r] = values[c * 3 + r] / scale;
    }
    return this;
  }
  /** Intrinsic Euler rotation in radians, in any of the six axis orders. */
  makeRotationFromEuler(euler: Vec3Like & { order: EulerOrder }): this {
    return this.makeRotationFromQuaternion(new Quaternion().setFromEuler(euler));
  }
  /** Six off-diagonal shear coefficients, ordered xy, xz, yx, yz, zx, zy. */
  makeShear(xy: number, xz: number, yx: number, yz: number, zx: number, zy: number): this {
    return this.set(1, yx, zx, 0, xy, 1, zy, 0, xz, yz, 1, 0, 0, 0, 0, 1);
  }
}

/** Optional Vector3 with the porting methods; base imports retain their original size. */
export class Vector3 extends BaseVector3 {
  /** Returns an independent copy retaining the optional methods. */
  override clone(): Vector3 {
    return new Vector3().copy(this);
  }
  /** Applies an intrinsic Euler rotation in radians. */
  applyEuler(euler: Vec3Like & { order: EulerOrder }): this {
    return this.applyQuaternion(new Quaternion().setFromEuler(euler));
  }
  /** Rotates around a unit axis by angle radians. */
  applyAxisAngle(axis: Vec3Like, angle: number): this {
    return this.applyQuaternion(new Quaternion().setFromAxisAngle(axis, angle));
  }
  /** World to NDC, including perspective divide. Accepts a native combined matrix or separate camera matrices. */
  project(
    camera: { matrix: ArrayLike<number> } | { matrixWorldInverse: MatrixLike; projectionMatrix: MatrixLike },
  ): this {
    if ('matrixWorldInverse' in camera)
      return this.applyMatrix4(camera.matrixWorldInverse).applyMatrix4(camera.projectionMatrix);
    return this.applyMatrix4({ elements: camera.matrix });
  }
  /** NDC to world. @throws RangeError for a singular native camera matrix; update the camera before calling. */
  unproject(
    camera: { matrix: ArrayLike<number> } | { projectionMatrixInverse: MatrixLike; matrixWorld: MatrixLike },
  ): this {
    if ('projectionMatrixInverse' in camera)
      return this.applyMatrix4(camera.projectionMatrixInverse).applyMatrix4(camera.matrixWorld);
    const m = new Matrix4().fromArray(camera.matrix);
    if (m.determinant() === 0) throw new RangeError('Camera matrix is singular; update the camera before unprojecting');
    return this.applyMatrix4(m.invert());
  }
}

/** Optional Quaternion with the porting methods; base imports retain their original size. */
export class Quaternion extends BaseQuaternion {
  /** Returns an independent copy retaining the optional methods. */
  override clone(): Quaternion {
    return new Quaternion().copy(this);
  }
  /** Writes a unit axis (default +X at identity) and returns angle radians in [0, 2*pi]. Does not mutate this. */
  toAxisAngle<T extends Vec3Like>(axis: T): number {
    const length = this.length();
    const w = length ? Math.max(-1, Math.min(1, this.w / length)) : 1;
    const sine = Math.hypot(this.x, this.y, this.z);
    axis.x = sine ? this.x / sine : 1;
    axis.y = sine ? this.y / sine : 0;
    axis.z = sine ? this.z / sine : 0;
    return 2 * Math.atan2(length ? sine / length : 0, w);
  }
}

/** Optional Plane with the porting methods; base imports retain their original size. */
export class Plane extends BasePlane {
  /** Returns an independent copy retaining the optional methods. */
  override clone(): Plane {
    return new Plane().copy(this);
  }
  /** Intersects a closed start/end segment; a coplanar segment returns its start. A miss leaves out unchanged. */
  intersectLine<T extends Vec3Like>(line: { start: Vec3Like; end: Vec3Like }, out: T): T | null {
    const { start, end } = line,
      dx = end.x - start.x,
      dy = end.y - start.y,
      dz = end.z - start.z;
    const denominator = this.normal.x * dx + this.normal.y * dy + this.normal.z * dz;
    const distance = this.distanceToPoint(start);
    if (denominator === 0) {
      if (distance !== 0) return null;
      out.x = start.x;
      out.y = start.y;
      out.z = start.z;
      return out;
    }
    const t = -distance / denominator;
    if (t < 0 || t > 1) return null;
    out.x = start.x + t * dx;
    out.y = start.y + t * dy;
    out.z = start.z + t * dz;
    return out;
  }
}

/** Optional Ray with the porting methods; base imports retain their original size. */
export class Ray extends BaseRay {
  /** Returns an independent copy retaining the optional methods. */
  override clone(): Ray {
    return new Ray().copy(this);
  }

  /** Squared closest distance to a closed segment, with optional closest points on ray and segment. Degenerate inputs are points. */
  distanceSqToSegment(v0: Vec3Like, v1: Vec3Like, pointOnRay?: Vec3Like, pointOnSegment?: Vec3Like): number {
    const o = this.origin,
      d = this.direction,
      ex = v1.x - v0.x,
      ey = v1.y - v0.y,
      ez = v1.z - v0.z;
    const wx = o.x - v0.x,
      wy = o.y - v0.y,
      wz = o.z - v0.z;
    const a = d.lengthSq(),
      b = d.x * ex + d.y * ey + d.z * ez,
      c = ex * ex + ey * ey + ez * ez;
    const p = d.x * wx + d.y * wy + d.z * wz,
      q = ex * wx + ey * wy + ez * wz;
    let best = Infinity,
      bs = 0,
      bt = 0;
    const candidate = (s: number, t: number): void => {
      const x = wx + s * d.x - t * ex,
        y = wy + s * d.y - t * ey,
        z = wz + s * d.z - t * ez;
      const distance = x * x + y * y + z * z;
      if (distance < best) {
        best = distance;
        bs = s;
        bt = t;
      }
    };
    candidate(0, c ? Math.max(0, Math.min(1, q / c)) : 0);
    if (a) {
      candidate(Math.max(0, -p / a), 0);
      candidate(Math.max(0, (b - p) / a), 1);
      const nx = d.y * ez - d.z * ey,
        ny = d.z * ex - d.x * ez,
        nz = d.x * ey - d.y * ex;
      const det = nx * nx + ny * ny + nz * nz;
      if (det) {
        const s = -((wy * ez - wz * ey) * nx + (wz * ex - wx * ez) * ny + (wx * ey - wy * ex) * nz) / det;
        const t = (q + b * s) / c;
        if (s >= 0 && t >= 0 && t <= 1) candidate(s, t);
      }
    }
    const rx = o.x + bs * d.x,
      ry = o.y + bs * d.y,
      rz = o.z + bs * d.z;
    const sx = v0.x + bt * ex,
      sy = v0.y + bt * ey,
      sz = v0.z + bt * ez;
    if (pointOnRay) Object.assign(pointOnRay, { x: rx, y: ry, z: rz });
    if (pointOnSegment) Object.assign(pointOnSegment, { x: sx, y: sy, z: sz });
    return best;
  }
}

/** Optional Box3 with the porting methods; base imports retain their original size. */
export class Box3 extends BaseBox3 {
  /** Returns an independent copy retaining the optional methods. */
  override clone(): Box3 {
    return new Box3().copy(this);
  }
  /** Closed triangle overlap using all 13 separating axes (Triangle.intersectsBox). Degenerate triangles reduce to segments or points. */
  intersectsTriangle(triangle: { a: Vec3Like; b: Vec3Like; c: Vec3Like }): boolean {
    return Triangle.prototype.intersectsBox.call(triangle as Triangle, this);
  }
}

/** Optional Color with the porting methods; base imports retain their original size. */
export class Color extends BaseColor {
  /** Returns an independent copy retaining the optional methods. */
  override clone(): Color {
    return new Color().copy(this);
  }
  /** CSS representation in srgb (default) or a supported CSS color() space. Display channels are clamped for rgb(). */
  getStyle(colorSpace: ColorSpace = 'srgb'): string {
    const channels = this.getRGB([0, 0, 0], colorSpace);
    if (colorSpace === 'srgb')
      return `rgb(${channels.map((c) => Math.round(Math.max(0, Math.min(1, c)) * 255)).join(',')})`;
    return `color(${colorSpace} ${channels.map((c) => c.toFixed(3)).join(' ')})`;
  }
  /** Adds HSL offsets in working linear sRGB by default; hue wraps, saturation/lightness clamp. */
  offsetHSL(h: number, s: number, l: number, colorSpace: ColorSpace = 'srgb-linear'): this {
    const v = this.getHSL({ h: 0, s: 0, l: 0 }, colorSpace);
    return this.setHSL(v.h + h, v.s + s, v.l + l, colorSpace);
  }
  /** Componentwise HSL interpolation (direct hue path), in working linear sRGB by default. */
  lerpHSL(color: ColorLike, t: number, colorSpace: ColorSpace = 'srgb-linear'): this {
    const a = this.getHSL({ h: 0, s: 0, l: 0 }, colorSpace);
    const b = new Color().copy(color).getHSL({ h: 0, s: 0, l: 0 }, colorSpace);
    return this.setHSL(a.h + (b.h - a.h) * t, a.s + (b.s - a.s) * t, a.l + (b.l - a.l) * t, colorSpace);
  }
}
