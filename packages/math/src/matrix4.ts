import type {MatrixLike, NumberArray, Vec3Like, Vec4Like} from './types.js';

let scratch: Float64Array | undefined;

/**
 * 4x4 matrix. `elements` is a column-major Float64Array, the same layout as core `camera.matrix` and the world matrices
 * from `meshRuntime(mesh).matrix` (`@margoengine/core/extension`, Float32Array), so `fromArray` and `toArray(float32Buffer)` copy straight across.
 * `set()` takes row-major arguments like three.js.
 */
export class Matrix4 {
  readonly elements = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

  set(
    n11: number, n12: number, n13: number, n14: number, n21: number, n22: number, n23: number, n24: number,
    n31: number, n32: number, n33: number, n34: number, n41: number, n42: number, n43: number, n44: number,
  ): this {
    const e = this.elements;
    e[0] = n11; e[4] = n12; e[8] = n13; e[12] = n14;
    e[1] = n21; e[5] = n22; e[9] = n23; e[13] = n24;
    e[2] = n31; e[6] = n32; e[10] = n33; e[14] = n34;
    e[3] = n41; e[7] = n42; e[11] = n43; e[15] = n44;
    return this;
  }
  identity(): this { return this.set(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1); }
  copy(m: MatrixLike): this { return this.fromArray(m.elements); }
  clone(): Matrix4 { return new Matrix4().copy(this); }

  multiply(m: MatrixLike): this { return this.multiplyMatrices(this, m); }
  premultiply(m: MatrixLike): this { return this.multiplyMatrices(m, this); }
  multiplyMatrices(a: MatrixLike, b: MatrixLike): this {
    const x = a.elements, y = b.elements, out = scratch ??= new Float64Array(16);
    for (let column = 0; column < 4; column++) {
      const b0 = y[column * 4], b1 = y[column * 4 + 1], b2 = y[column * 4 + 2], b3 = y[column * 4 + 3];
      for (let row = 0; row < 4; row++) out[column * 4 + row] = x[row] * b0 + x[4 + row] * b1 + x[8 + row] * b2 + x[12 + row] * b3;
    }
    this.elements.set(out);
    return this;
  }
  multiplyScalar(s: number): this { const e = this.elements; for (let i = 0; i < 16; i++) e[i] *= s; return this; }
  determinant(): number { return this.invertInto(false); }
  /** Inverse; a singular matrix becomes all zeros. */
  invert(): this { this.invertInto(true); return this; }
  private invertInto(write: boolean): number {
    const e = this.elements;
    const a00 = e[0], a01 = e[4], a02 = e[8], a03 = e[12], a10 = e[1], a11 = e[5], a12 = e[9], a13 = e[13];
    const a20 = e[2], a21 = e[6], a22 = e[10], a23 = e[14], a30 = e[3], a31 = e[7], a32 = e[11], a33 = e[15];
    // 2x2 minors of the top two rows (s) and bottom two rows (c).
    const s0 = a00 * a11 - a10 * a01, s1 = a00 * a12 - a10 * a02, s2 = a00 * a13 - a10 * a03;
    const s3 = a01 * a12 - a11 * a02, s4 = a01 * a13 - a11 * a03, s5 = a02 * a13 - a12 * a03;
    const c0 = a20 * a31 - a30 * a21, c1 = a20 * a32 - a30 * a22, c2 = a20 * a33 - a30 * a23;
    const c3 = a21 * a32 - a31 * a22, c4 = a21 * a33 - a31 * a23, c5 = a22 * a33 - a32 * a23;
    const det = s0 * c5 - s1 * c4 + s2 * c3 + s3 * c2 - s4 * c1 + s5 * c0;
    if (!write) return det;
    if (det === 0) { e.fill(0); return det; }
    const d = 1 / det;
    this.set(
      (a11 * c5 - a12 * c4 + a13 * c3) * d, (-a01 * c5 + a02 * c4 - a03 * c3) * d, (a31 * s5 - a32 * s4 + a33 * s3) * d, (-a21 * s5 + a22 * s4 - a23 * s3) * d,
      (-a10 * c5 + a12 * c2 - a13 * c1) * d, (a00 * c5 - a02 * c2 + a03 * c1) * d, (-a30 * s5 + a32 * s2 - a33 * s1) * d, (a20 * s5 - a22 * s2 + a23 * s1) * d,
      (a10 * c4 - a11 * c2 + a13 * c0) * d, (-a00 * c4 + a01 * c2 - a03 * c0) * d, (a30 * s4 - a31 * s2 + a33 * s0) * d, (-a20 * s4 + a21 * s2 - a23 * s0) * d,
      (-a10 * c3 + a11 * c1 - a12 * c0) * d, (a00 * c3 - a01 * c1 + a02 * c0) * d, (-a30 * s3 + a31 * s1 - a32 * s0) * d, (a20 * s3 - a21 * s1 + a22 * s0) * d,
    );
    return det;
  }
  transpose(): this {
    const e = this.elements;
    for (let row = 0; row < 4; row++) for (let column = row + 1; column < 4; column++) {
      const t = e[column * 4 + row]; e[column * 4 + row] = e[row * 4 + column]; e[row * 4 + column] = t;
    }
    return this;
  }

  setPosition(x: number | Vec3Like, y = 0, z = 0): this {
    const e = this.elements;
    if (typeof x === 'number') { e[12] = x; e[13] = y; e[14] = z; } else { e[12] = x.x; e[13] = x.y; e[14] = x.z; }
    return this;
  }
  makeTranslation(x: number, y: number, z: number): this { return this.set(1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1); }
  makeScale(x: number, y: number, z: number): this { return this.set(x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1); }
  makeRotationX(theta: number): this { const c = Math.cos(theta), s = Math.sin(theta); return this.set(1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0, 0, 0, 0, 1); }
  makeRotationY(theta: number): this { const c = Math.cos(theta), s = Math.sin(theta); return this.set(c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, 0, 0, 0, 1); }
  makeRotationZ(theta: number): this { const c = Math.cos(theta), s = Math.sin(theta); return this.set(c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1); }
  /** Rotation of `angle` radians about the unit `axis`. */
  makeRotationAxis(axis: Vec3Like, angle: number): this {
    const c = Math.cos(angle), s = Math.sin(angle), t = 1 - c, {x, y, z} = axis;
    return this.set(
      t * x * x + c, t * x * y - s * z, t * x * z + s * y, 0,
      t * x * y + s * z, t * y * y + c, t * y * z - s * x, 0,
      t * x * z - s * y, t * y * z + s * x, t * z * z + c, 0,
      0, 0, 0, 1,
    );
  }
  makeRotationFromQuaternion(q: Vec4Like): this { return this.composeComponents(0, 0, 0, q.x, q.y, q.z, q.w, 1, 1, 1); }
  /** this = T(position) * R(quaternion) * S(scale), the order core and three.js use. */
  compose(position: Vec3Like, quaternion: Vec4Like, scale: Vec3Like): this {
    return this.composeComponents(position.x, position.y, position.z, quaternion.x, quaternion.y, quaternion.z, quaternion.w, scale.x, scale.y, scale.z);
  }
  private composeComponents(px: number, py: number, pz: number, x: number, y: number, z: number, w: number, sx: number, sy: number, sz: number): this {
    const xx = 2 * x * x, yy = 2 * y * y, zz = 2 * z * z, xy = 2 * x * y, xz = 2 * x * z, yz = 2 * y * z, wx = 2 * w * x, wy = 2 * w * y, wz = 2 * w * z;
    return this.set(
      (1 - yy - zz) * sx, (xy - wz) * sy, (xz + wy) * sz, px,
      (xy + wz) * sx, (1 - xx - zz) * sy, (yz - wx) * sz, py,
      (xz - wy) * sx, (yz + wx) * sy, (1 - xx - yy) * sz, pz,
      0, 0, 0, 1,
    );
  }
  /** Splits an affine TRS matrix back into its parts (negative determinant flips scale.x). Shear is not recovered. */
  decompose(position: Vec3Like, quaternion: {setFromRotationMatrix(m: MatrixLike): unknown}, scale: Vec3Like): this {
    const e = this.elements, r = scratch ??= new Float64Array(16);
    let sx = Math.hypot(e[0], e[1], e[2]);
    const sy = Math.hypot(e[4], e[5], e[6]), sz = Math.hypot(e[8], e[9], e[10]);
    if (this.determinant() < 0) sx = -sx;
    position.x = e[12]; position.y = e[13]; position.z = e[14];
    r.set(e);
    const ix = sx ? 1 / sx : 0, iy = sy ? 1 / sy : 0, iz = sz ? 1 / sz : 0;
    r[0] *= ix; r[1] *= ix; r[2] *= ix; r[4] *= iy; r[5] *= iy; r[6] *= iy; r[8] *= iz; r[9] *= iz; r[10] *= iz;
    quaternion.setFromRotationMatrix({elements: r});
    scale.x = sx; scale.y = sy; scale.z = sz;
    return this;
  }
  /** Rotation that points the object's +z from `target` toward `eye` (cameras look down -z). Translation is unchanged. */
  lookAt(eye: Vec3Like, target: Vec3Like, up: Vec3Like): this {
    let zx = eye.x - target.x, zy = eye.y - target.y, zz = eye.z - target.z;
    if (zx === 0 && zy === 0 && zz === 0) zz = 1;
    let l = Math.hypot(zx, zy, zz); zx /= l; zy /= l; zz /= l;
    let xx = up.y * zz - up.z * zy, xy = up.z * zx - up.x * zz, xz = up.x * zy - up.y * zx;
    if (xx === 0 && xy === 0 && xz === 0) {
      // up is parallel to the view direction: nudge the direction and retry.
      if (Math.abs(up.z) === 1) zx += 1e-4; else zz += 1e-4;
      l = Math.hypot(zx, zy, zz); zx /= l; zy /= l; zz /= l;
      xx = up.y * zz - up.z * zy; xy = up.z * zx - up.x * zz; xz = up.x * zy - up.y * zx;
    }
    l = Math.hypot(xx, xy, xz); xx /= l; xy /= l; xz /= l;
    const e = this.elements;
    e[0] = xx; e[1] = xy; e[2] = xz;
    e[4] = zy * xz - zz * xy; e[5] = zz * xx - zx * xz; e[6] = zx * xy - zy * xx;
    e[8] = zx; e[9] = zy; e[10] = zz;
    return this;
  }
  /** Off-axis perspective projection. `zeroToOne` (default, WebGPU) maps depth to [0, 1]; pass false for WebGL [-1, 1]. */
  makePerspective(left: number, right: number, top: number, bottom: number, near: number, far: number, zeroToOne = true): this {
    const c = zeroToOne ? -far / (far - near) : -(far + near) / (far - near), d = zeroToOne ? -far * near / (far - near) : -2 * far * near / (far - near);
    return this.set(
      2 * near / (right - left), 0, (right + left) / (right - left), 0,
      0, 2 * near / (top - bottom), (top + bottom) / (top - bottom), 0,
      0, 0, c, d,
      0, 0, -1, 0,
    );
  }
  makeOrthographic(left: number, right: number, top: number, bottom: number, near: number, far: number, zeroToOne = true): this {
    const w = 1 / (right - left), h = 1 / (top - bottom), p = 1 / (far - near);
    return this.set(
      2 * w, 0, 0, -(right + left) * w,
      0, 2 * h, 0, -(top + bottom) * h,
      0, 0, zeroToOne ? -p : -2 * p, zeroToOne ? -near * p : -(far + near) * p,
      0, 0, 0, 1,
    );
  }
  getMaxScaleOnAxis(): number {
    const e = this.elements;
    return Math.sqrt(Math.max(e[0] * e[0] + e[1] * e[1] + e[2] * e[2], e[4] * e[4] + e[5] * e[5] + e[6] * e[6], e[8] * e[8] + e[9] * e[9] + e[10] * e[10]));
  }
  equals(m: MatrixLike, epsilon = 0): boolean {
    for (let i = 0; i < 16; i++) if (!(Math.abs(this.elements[i] - m.elements[i]) <= epsilon)) return false;
    return true;
  }

  /** Copies 16 column-major numbers, e.g. from core `camera.matrix` or a mesh world matrix. */
  fromArray(array: ArrayLike<number>, offset = 0): this { for (let i = 0; i < 16; i++) this.elements[i] = array[offset + i]; return this; }
  toArray(): number[];
  toArray<T extends NumberArray>(out: T, offset?: number): T;
  toArray(out: NumberArray = [], offset = 0): NumberArray { for (let i = 0; i < 16; i++) out[offset + i] = this.elements[i]; return out; }
}
