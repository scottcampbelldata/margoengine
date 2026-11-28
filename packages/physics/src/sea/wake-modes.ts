import { MargoError } from '@margoengine/math/errors';
import { cos, exp, sin } from '@margoengine/math/pinned';
import type { WakeNativeModes } from './wake-native-modes.js';

const TAU = 6.283185307179586;
const ROW = 8;

// The integral of exp(a + ib) from zero to one. Treat the zero eigenvalue continuously,
// including a stationary pressure pattern at the intrinsic frequency in the moving water.
function exponentialIntegral(a: number, b: number, decay: number): [number, number] {
  if (Math.abs(a) + Math.abs(b) < 1e-4) {
    const aa = a * a,
      bb = b * b;
    return [1 + a / 2 + (aa - bb) / 6 + (a * (aa - 3 * bb)) / 24, b / 2 + (a * b) / 3 + (b * (3 * aa - bb)) / 24];
  }
  const cm = cos(b),
    sh = sin(b / 2),
    dm = Math.abs(a) < 1e-4 ? a * (1 + a * (0.5 + a * (1 / 6 + a / 24))) : decay - 1,
    re = dm * cm - 2 * sh * sh,
    im = decay * sin(b);
  // Scale the complex denominator before squaring so high damping does not overflow.
  const scale = Math.max(Math.abs(a), Math.abs(b)),
    u = a / scale,
    v = b / scale,
    divisor = u * u + v * v;
  return [(re * u + im * v) / divisor / scale, (im * u - re * v) / divisor / scale];
}

/** Optional linear gravity-capillary propagator with uniform current and leading-order viscous decay. */
export class WakeModeStep {
  private readonly natural: Float64Array;
  private readonly shifted: Float64Array;
  private readonly dissipation: Float64Array;
  private readonly coefficients: Float64Array;

  constructor(
    private readonly vertical: Float64Array,
    cells: readonly [number, number],
    dx: number,
    gravity: number,
    private readonly density: number,
    tension: number,
    viscosity: number,
    current: readonly [number, number],
  ) {
    const [nx, nz] = cells;
    const half = nx / 2 + 1;
    this.natural = new Float64Array(vertical.length);
    this.shifted = new Float64Array(vertical.length);
    this.dissipation = new Float64Array(vertical.length);
    this.coefficients = new Float64Array(ROW * vertical.length);
    for (let j = 0; j < nz; j++) {
      const kz = (TAU * (j < nz / 2 ? j : j - nz)) / (nz * dx);
      for (let i = 0; i < half; i++) {
        const m = i + j * half;
        if (!m) continue;
        const kx = (TAU * i) / (nx * dx),
          square = kx * kx + kz * kz;
        // A first derivative on the real grid omits the unresolved, self-conjugate Nyquist axis.
        const shift = (i === nx / 2 ? 0 : kx * current[0]) + (j === nz / 2 ? 0 : kz * current[1]);
        const omega = Math.sqrt((gravity + (tension / density) * square) * vertical[m]!);
        const damp = 2 * viscosity * square;
        if (!(omega > 0 && Number.isFinite(omega) && Number.isFinite(shift) && Number.isFinite(damp)))
          throw new MargoError('state', 'Use a resolved wake grid and scale its depth, current, tension or viscosity.');
        this.natural[m] = omega;
        this.shifted[m] = shift;
        this.dissipation[m] = damp;
      }
    }
  }

  prepare(dt: number, native?: WakeNativeModes): void {
    const { natural, shifted, dissipation, vertical, coefficients } = this;
    for (let m = 1; m < natural.length; m++) {
      const at = m * ROW,
        omega = natural[m]!,
        theta = omega * dt,
        a = -dissipation[m]! * dt,
        b = -shifted[m]! * dt;
      if (!(Number.isFinite(a) && Math.abs(b) + theta < 1048576))
        throw new MargoError('state', 'Use a finer wake step or reduce the grid’s current, tension or viscosity.');
      const decay = exp(a),
        re = decay * cos(b),
        im = decay * sin(b),
        c = cos(theta),
        s = sin(theta) / omega;
      coefficients[at] = c * re;
      coefficients[at + 1] = c * im;
      coefficients[at + 2] = s * re;
      coefficients[at + 3] = s * im;
      // The pressure is held at its world position throughout the step. Convolve it with the
      // same damped and Doppler-shifted propagator rather than moving it with the fluid.
      const [upperRe, upperIm] = exponentialIntegral(a, b + theta, decay);
      const [lowerRe, lowerIm] = exponentialIntegral(a, b - theta, decay);
      const f = (-0.5 * dt) / this.density;
      const h = (vertical[m]! / omega) * f;
      coefficients[at + 4] = h * (upperIm - lowerIm);
      coefficients[at + 5] = h * (lowerRe - upperRe);
      coefficients[at + 6] = f * (upperRe + lowerRe);
      coefficients[at + 7] = f * (upperIm + lowerIm);
    }
    native?.prepareCurrent(vertical, natural, coefficients);
  }

  advance(height: Float64Array, potential: Float64Array, pressure: Float64Array): void {
    const { coefficients, natural, vertical } = this;
    // The mean elevation is the volume ledger. The mean potential is an arbitrary gauge.
    potential[0] = potential[1] = 0;
    for (let m = 1; m < vertical.length; m++) {
      const r = 2 * m,
        i = r + 1,
        at = m * ROW,
        k = vertical[m]!,
        restoring = (natural[m]! / k) * natural[m]!,
        cr = coefficients[at]!,
        ci = coefficients[at + 1]!,
        sr = coefficients[at + 2]!,
        si = coefficients[at + 3]!,
        chr = coefficients[at + 4]!,
        chi = coefficients[at + 5]!,
        cpr = coefficients[at + 6]!,
        cpi = coefficients[at + 7]!,
        hr = height[r]!,
        hi = height[i]!,
        fr = potential[r]!,
        fi = potential[i]!,
        pr = pressure[r]!,
        pi = pressure[i]!;
      height[r] = cr * hr - ci * hi + k * (sr * fr - si * fi) + chr * pr - chi * pi;
      height[i] = cr * hi + ci * hr + k * (sr * fi + si * fr) + chr * pi + chi * pr;
      potential[r] = cr * fr - ci * fi - restoring * (sr * hr - si * hi) + cpr * pr - cpi * pi;
      potential[i] = cr * fi + ci * fr - restoring * (sr * hi + si * hr) + cpr * pi + cpi * pr;
    }
  }
}
