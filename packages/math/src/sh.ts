// Real spherical harmonics, bands 0 to 2. Basis constants: Ramamoorthi and Hanrahan 2001, eq. 3; Sloan 2008, "Stupid
// Spherical Harmonics Tricks". Cosine convolution per band: Ramamoorthi and Hanrahan 2001 (pi, 2 pi / 3, pi / 4).
import type { ColorLike } from './color.js';
import type { NumberArray, Vec3Like } from './types.js';

// Band of each coefficient's Lambert factor, in coefficient order.
const COSINE = [
  Math.PI,
  (2 * Math.PI) / 3,
  (2 * Math.PI) / 3,
  (2 * Math.PI) / 3,
  Math.PI / 4,
  Math.PI / 4,
  Math.PI / 4,
  Math.PI / 4,
  Math.PI / 4,
] as const;
const Y00 = 0.282094791773878,
  Y1 = 0.48860251190292,
  Y2A = 1.09254843059208,
  Y2B = 0.31539156525252,
  Y2C = 0.54627421529604;

const basis = new Float64Array(9);

/**
 * The 9 basis values at `direction` into `out` (default a new Float64Array), in the coefficient order of {@link SH3}.
 * `direction` need not be unit length.
 * @throws RangeError for a zero or non-finite direction.
 */
export function shBasis<T extends NumberArray = Float64Array>(
  direction: Vec3Like,
  out: T = new Float64Array(9) as unknown as T,
): T {
  const length = Math.hypot(direction.x, direction.y, direction.z);
  if (!(length > 0) || length === Infinity)
    throw new RangeError(
      `SH direction (${direction.x}, ${direction.y}, ${direction.z}) must be finite and not zero; pass a direction`,
    );
  const x = direction.x / length,
    y = direction.y / length,
    z = direction.z / length;
  out[0] = Y00;
  out[1] = Y1 * y;
  out[2] = Y1 * z;
  out[3] = Y1 * x;
  out[4] = Y2A * x * y;
  out[5] = Y2A * y * z;
  out[6] = Y2B * (3 * z * z - 1);
  out[7] = Y2A * x * z;
  out[8] = Y2C * (x * x - y * y);
  return out;
}

/**
 * Order-3 spherical harmonics of RGB radiance: `coefficients` holds 9 RGB triples, coefficient-major (`k * 3 + channel`),
 * for (l, m) = (0,0), (1,-1), (1,0), (1,1), (2,-2), (2,-1), (2,0), (2,1), (2,2): the layout `@margoengine/environment`
 * uses for its radiance coefficients. Stored as radiance; {@link SH3.getIrradianceAt} applies the cosine lobe.
 */
export class SH3 {
  readonly coefficients = new Float64Array(27);

  /** Starts from 27 values in coefficient order, or black. */
  constructor(coefficients?: ArrayLike<number>) {
    if (coefficients) this.fromArray(coefficients);
  }

  /** Back to black. */
  zero(): this {
    this.coefficients.fill(0);
    return this;
  }
  copy(sh: SH3): this {
    this.coefficients.set(sh.coefficients);
    return this;
  }
  clone(): SH3 {
    return new SH3().copy(this);
  }
  /** Reads 27 values at `offset`. @throws RangeError when `array` is too short. */
  fromArray(array: ArrayLike<number>, offset = 0): this {
    if (array.length < offset + 27)
      throw new RangeError(`SH3 needs 27 values from offset ${offset}; the array has ${array.length}`);
    for (let i = 0; i < 27; i++) this.coefficients[i] = array[offset + i];
    return this;
  }
  /** Writes the 27 values at `offset` of `out` (default a new array), such as a Float32Array for upload. */
  toArray<T extends NumberArray = number[]>(out: T = [] as unknown as T, offset = 0): T {
    for (let i = 0; i < 27; i++) out[offset + i] = this.coefficients[i];
    return out;
  }
  add(sh: SH3): this {
    return this.addScaledSH(sh, 1);
  }
  addScaledSH(sh: SH3, scale: number): this {
    for (let i = 0; i < 27; i++) this.coefficients[i] += sh.coefficients[i] * scale;
    return this;
  }
  scale(s: number): this {
    for (let i = 0; i < 27; i++) this.coefficients[i] *= s;
    return this;
  }
  lerp(sh: SH3, t: number): this {
    for (let i = 0; i < 27; i++) this.coefficients[i] += (sh.coefficients[i] - this.coefficients[i]) * t;
    return this;
  }
  equals(sh: SH3, epsilon = 0): boolean {
    for (let i = 0; i < 27; i++) if (!(Math.abs(this.coefficients[i] - sh.coefficients[i]) <= epsilon)) return false;
    return true;
  }
  /** Adds light of the same radiance from every direction. */
  addAmbient(color: ColorLike): this {
    const c = this.coefficients,
      scale = 1 / Y00;
    c[0] += color.r * scale;
    c[1] += color.g * scale;
    c[2] += color.b * scale;
    return this;
  }
  /**
   * Projects one radiance sample arriving from `direction`, `weight` being the solid angle it stands for: `4 * Math.PI
   * / count` for `count` uniform samples, a cube-map texel's solid angle, or 1 for a distant light of `color` irradiance.
   * @throws RangeError for a zero or non-finite direction.
   */
  addSample(direction: Vec3Like, color: ColorLike, weight = 1): this {
    shBasis(direction, basis);
    const c = this.coefficients;
    for (let k = 0; k < 9; k++) {
      const w = basis[k] * weight;
      c[k * 3] += color.r * w;
      c[k * 3 + 1] += color.g * w;
      c[k * 3 + 2] += color.b * w;
    }
    return this;
  }
  /**
   * Radiance arriving from `direction`, into `out`. Three bands ring around bright lights, so a value can fall below 0;
   * it is not clamped. @throws RangeError for a zero or non-finite direction.
   */
  getAt<T extends ColorLike>(direction: Vec3Like, out: T): T {
    return this.evaluate(direction, out, false);
  }
  /**
   * Irradiance on a surface facing `normal`, into `out`: the radiance convolved with the clamped cosine. Multiply by
   * albedo / PI for the diffuse light that surface reflects. Not clamped. @throws RangeError for a zero or non-finite normal.
   */
  getIrradianceAt<T extends ColorLike>(normal: Vec3Like, out: T): T {
    return this.evaluate(normal, out, true);
  }
  private evaluate<T extends ColorLike>(direction: Vec3Like, out: T, cosine: boolean): T {
    shBasis(direction, basis);
    const c = this.coefficients;
    let r = 0,
      g = 0,
      b = 0;
    for (let k = 0; k < 9; k++) {
      const w = cosine ? basis[k] * COSINE[k] : basis[k];
      r += c[k * 3] * w;
      g += c[k * 3 + 1] * w;
      b += c[k * 3 + 2] * w;
    }
    out.r = r;
    out.g = g;
    out.b = b;
    return out;
  }
}
