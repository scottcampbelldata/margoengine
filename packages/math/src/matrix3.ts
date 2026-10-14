import type {MatrixLike, NumberArray} from './types.js';

/** 3x3 matrix. `elements` is column-major (WGSL `mat3x3` order); `set()` takes row-major arguments like three.js. */
export class Matrix3 {
  readonly elements = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);

  set(n11: number, n12: number, n13: number, n21: number, n22: number, n23: number, n31: number, n32: number, n33: number): this {
    const e = this.elements;
    e[0] = n11; e[1] = n21; e[2] = n31; e[3] = n12; e[4] = n22; e[5] = n32; e[6] = n13; e[7] = n23; e[8] = n33;
    return this;
  }
  identity(): this { return this.set(1, 0, 0, 0, 1, 0, 0, 0, 1); }
  copy(m: MatrixLike): this { return this.fromArray(m.elements); }
  clone(): Matrix3 { return new Matrix3().copy(this); }
  /** Upper-left 3x3 of a 4x4 matrix. */
  setFromMatrix4(m: MatrixLike): this {
    const e = m.elements;
    return this.set(e[0], e[4], e[8], e[1], e[5], e[9], e[2], e[6], e[10]);
  }

  multiply(m: MatrixLike): this { return this.multiplyMatrices(this, m); }
  premultiply(m: MatrixLike): this { return this.multiplyMatrices(m, this); }
  multiplyMatrices(a: MatrixLike, b: MatrixLike): this {
    const x = a.elements, y = b.elements;
    const a11 = x[0], a12 = x[3], a13 = x[6], a21 = x[1], a22 = x[4], a23 = x[7], a31 = x[2], a32 = x[5], a33 = x[8];
    const b11 = y[0], b12 = y[3], b13 = y[6], b21 = y[1], b22 = y[4], b23 = y[7], b31 = y[2], b32 = y[5], b33 = y[8];
    return this.set(
      a11 * b11 + a12 * b21 + a13 * b31, a11 * b12 + a12 * b22 + a13 * b32, a11 * b13 + a12 * b23 + a13 * b33,
      a21 * b11 + a22 * b21 + a23 * b31, a21 * b12 + a22 * b22 + a23 * b32, a21 * b13 + a22 * b23 + a23 * b33,
      a31 * b11 + a32 * b21 + a33 * b31, a31 * b12 + a32 * b22 + a33 * b32, a31 * b13 + a32 * b23 + a33 * b33,
    );
  }
  multiplyScalar(s: number): this { const e = this.elements; for (let i = 0; i < 9; i++) e[i] *= s; return this; }
  determinant(): number {
    const e = this.elements;
    return e[0] * (e[4] * e[8] - e[7] * e[5]) - e[3] * (e[1] * e[8] - e[7] * e[2]) + e[6] * (e[1] * e[5] - e[4] * e[2]);
  }
  /** Inverse; a singular matrix becomes all zeros. */
  invert(): this {
    const e = this.elements, a = e[0], b = e[3], c = e[6], d = e[1], f = e[4], g = e[7], h = e[2], i = e[5], k = e[8];
    const c11 = f * k - g * i, c12 = g * h - d * k, c13 = d * i - f * h, det = a * c11 + b * c12 + c * c13;
    if (det === 0) return this.set(0, 0, 0, 0, 0, 0, 0, 0, 0);
    const s = 1 / det;
    return this.set(
      c11 * s, (c * i - b * k) * s, (b * g - c * f) * s,
      c12 * s, (a * k - c * h) * s, (c * d - a * g) * s,
      c13 * s, (b * h - a * i) * s, (a * f - b * d) * s,
    );
  }
  transpose(): this {
    const e = this.elements;
    let t = e[1]; e[1] = e[3]; e[3] = t; t = e[2]; e[2] = e[6]; e[6] = t; t = e[5]; e[5] = e[7]; e[7] = t;
    return this;
  }
  /** Inverse-transpose of the upper 3x3 of a model matrix, for transforming normals. */
  getNormalMatrix(m: MatrixLike): this { return this.setFromMatrix4(m).invert().transpose(); }
  makeTranslation(x: number, y: number): this { return this.set(1, 0, x, 0, 1, y, 0, 0, 1); }
  makeRotation(theta: number): this { const c = Math.cos(theta), s = Math.sin(theta); return this.set(c, -s, 0, s, c, 0, 0, 0, 1); }
  makeScale(x: number, y: number): this { return this.set(x, 0, 0, 0, y, 0, 0, 0, 1); }
  equals(m: MatrixLike, epsilon = 0): boolean {
    for (let i = 0; i < 9; i++) if (!(Math.abs(this.elements[i] - m.elements[i]) <= epsilon)) return false;
    return true;
  }

  fromArray(array: ArrayLike<number>, offset = 0): this { for (let i = 0; i < 9; i++) this.elements[i] = array[offset + i]; return this; }
  toArray(): number[];
  toArray<T extends NumberArray>(out: T, offset?: number): T;
  toArray(out: NumberArray = [], offset = 0): NumberArray { for (let i = 0; i < 9; i++) out[offset + i] = this.elements[i]; return out; }
}
