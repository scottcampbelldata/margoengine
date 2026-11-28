// Tyre models for `Vehicle`: what the road gives a wheel from how it slips. A model is one function from the slip ratio, the slip angle and the load
// on the tyre to a longitudinal and a lateral force, so a vehicle takes any of them (or one a user writes) the same way.
//
// `pacejkaTyre` is the Magic Formula of Pacejka and Bakker (1992) in its simple sine form, F = D sin(C atan(B x - E (B x - atan(B x)))), for
// the longitudinal force against the slip ratio and the lateral against the slip angle, with the load sensitivity of the peak, and the two
// forces held inside the friction ellipse where they meet (a scaling of both back to the ellipse of the two peaks, not Pacejka's weighting
// functions G_x_alpha and G_y_kappa of 2012, section 4.3, which also shape one force falling as the other rises). `brushTyre` is the brush
// model (Pacejka 2012, chapter 3; Svendenius 2007): a row of elastic bristles in a contact patch that stick, then slide, whose combined
// slip gives one force in the direction of the slip, from the theoretical slips kappa / (1 + kappa) and tan(alpha) / (1 + kappa): the
// bristles are carried through the patch at the wheel's surface speed, so slip is measured against that, not the ground speed.
//
// Slip ratio: `(wheel surface speed - ground speed) / ground speed` along the rolling direction, positive under drive. Slip angle: the angle
// of the contact point's velocity to the rolling direction, the arc tangent of side speed over forward speed. Forces: longitudinal
// positive pushes the car forward, lateral positive along `side`; the vehicle gives the lateral force its sign against the slip.

import { MargoError } from '@margoengine/math/errors';
import { atan, cos, hypot, sin } from '@margoengine/math/pinned';

/** What a tyre is asked: the slips and the load. */
export interface TyreSample {
  /** `(omega R - v) / |v|` along the rolling direction (free rolling 0, locked wheel -1, full spin +infinity). */
  slipRatio: number;
  /** Radians: the arc tangent of side speed over forward speed. */
  slipAngle: number;
  /** The normal force on the tyre, newtons. */
  load: number;
}

/** What a tyre gives: forces in newtons on the car, along the rolling direction and sideways, with the sign of the slip they oppose. */
export interface TyreForces {
  longitudinal: number;
  /** Positive for a positive slip angle (the vehicle applies it against the slide). */
  lateral: number;
}

/** A tyre model: slips and load in, forces out. */
export interface TyreModel {
  forces(sample: TyreSample): TyreForces;
}

/** The four coefficients of a Magic Formula curve: stiffness B, shape C, peak factor D (a friction coefficient) and curvature E. */
export interface MagicCurve {
  B: number;
  C: number;
  D: number;
  E: number;
}

/** Options of {@link pacejkaTyre}. Defaults are textbook dry-asphalt values for a passenger tyre. */
export interface PacejkaOptions {
  /** The longitudinal curve against the slip ratio (default B 12, C 1.9, D 1.1, E 0.9). `D` is the peak friction coefficient. */
  longitudinal?: Partial<MagicCurve>;
  /** The lateral curve against the slip angle in radians (default B 9, C 1.3, D 1.0, E -0.8). */
  lateral?: Partial<MagicCurve>;
  /** The load the coefficients were fitted at, newtons (default 4000, a quarter of a 1,600 kg car). */
  nominalLoad?: number;
  /** How much the peak friction falls as load rises: `D` scales by `1 - sensitivity (load / nominalLoad - 1)` (default 0.1; 0 for none). */
  loadSensitivity?: number;
  /**
   * Hold the two forces inside the friction ellipse of their peaks (default true): where together they ask for more than the tyre has,
   * both are scaled back by the same factor. It is not Pacejka's combined slip of 2012, section 4.3 (the weighting functions that
   * lower each force as the other slip grows), only the limit those functions keep to.
   */
  combined?: boolean;
}

/** A tyre model input that cannot be used: a MargoError of code `unsupported` naming the input and its fix, with the help link. */
const invalidTyre = (message: string): MargoError =>
  new MargoError('unsupported', `${message} See https://margoengine.com/errors#vehicles`);
const magic = ({ B, C, D, E }: MagicCurve, x: number): number => {
  const bx = B * x;
  return D * sin(C * atan(bx - E * (bx - atan(bx))));
};

/**
 * The Magic Formula tyre of Pacejka and Bakker (1992). Odd in the slips; with the defaults the longitudinal force peaks near a slip ratio
 * of 0.1 and the lateral near a slip angle of 5 to 8 degrees, each at about the load times the curve's `D`.
 * @throws RangeError for a coefficient that is not a finite positive number (`E` may be zero or negative), or a negative sensitivity.
 */
export function pacejkaTyre(options: PacejkaOptions = {}): TyreModel {
  const x: MagicCurve = { B: 12, C: 1.9, D: 1.1, E: 0.9, ...options.longitudinal },
    y: MagicCurve = { B: 9, C: 1.3, D: 1.0, E: -0.8, ...options.lateral },
    nominal = options.nominalLoad ?? 4000,
    sensitivity = options.loadSensitivity ?? 0.1,
    combined = options.combined ?? true;
  for (const [curve, name] of [
    [x, 'longitudinal'],
    [y, 'lateral'],
  ] as const) {
    for (const key of ['B', 'C', 'D'] as const)
      if (!(Number.isFinite(curve[key]) && curve[key] > 0))
        throw invalidTyre(`Pacejka ${name}.${key} must be a finite number above 0; got ${curve[key]}.`);
    if (!Number.isFinite(curve.E)) throw invalidTyre(`Pacejka ${name}.E must be a finite number; got ${curve.E}.`);
  }
  if (!(nominal > 0 && Number.isFinite(nominal)))
    throw invalidTyre('Pacejka nominalLoad must be a finite number above 0.');
  if (!(sensitivity >= 0 && Number.isFinite(sensitivity)))
    throw invalidTyre('Pacejka loadSensitivity must be a finite number of 0 or more.');
  return {
    forces({ slipRatio, slipAngle, load }) {
      if (!(load > 0)) return { longitudinal: 0, lateral: 0 };
      const shift = Math.max(0.2, 1 - sensitivity * (load / nominal - 1)),
        dx = x.D * shift * load,
        dy = y.D * shift * load;
      let fx = magic({ ...x, D: 1 }, slipRatio) * dx,
        fy = magic({ ...y, D: 1 }, slipAngle) * dy;
      if (combined) {
        // Inside the ellipse of the two peaks: scale both back where together they ask for more than the tyre has.
        const u = fx / dx,
          v = fy / dy,
          size = hypot(u, v);
        if (size > 1) {
          fx /= size;
          fy /= size;
        }
      }
      return { longitudinal: fx, lateral: fy };
    },
  };
}

/** Options of {@link brushTyre}. */
export interface BrushOptions {
  /** Friction coefficient of the contact (default 1.0). */
  friction?: number;
  /** Stiffness of the bristles per unit of patch length and slip, newtons per square metre (default 2.34e6: with the default half-length of 0.1 m a cornering stiffness `2 c a^2` of 46.8 kN per radian, what `pacejkaTyre()`'s defaults give at their nominal load of 4,000 N, `B C D` of 11.7 per radian times the load). */
  stiffness?: number;
  /** Half the length of the contact patch, metres (default 0.1). */
  halfLength?: number;
}

/**
 * The brush tyre: bristles of stiffness `stiffness` over a patch of half-length `a` stick to the road and slide where the force there
 * would pass the friction cone. With the practical slip `s = (sx, sy)` (the slip ratio and the tangent of the slip angle) and
 * `theta = 2 c a^2 / (3 mu Fz)` and the theoretical slip `|s| / (1 + sx)` (the slip over the wheel's surface speed; a locked wheel, `sx = -1`, slides whole), the force has the size `mu Fz (1 - (1 - theta |s| / (1 + sx))^3)` while that is under 1 and `mu Fz` past it, in
 * the direction of the slip: the forces of combined slip come out together, in one cone, with no weighting rule. Its slope at small slip is the
 * cornering stiffness `2 c a^2`.
 * @throws RangeError for a coefficient that is not a finite number above 0.
 */
export function brushTyre(options: BrushOptions = {}): TyreModel {
  const mu = options.friction ?? 1,
    c = options.stiffness ?? 2.34e6,
    a = options.halfLength ?? 0.1;
  for (const [value, name] of [
    [mu, 'friction'],
    [c, 'stiffness'],
    [a, 'halfLength'],
  ] as const)
    if (!(value > 0 && Number.isFinite(value)))
      throw invalidTyre(`Brush ${name} must be a finite number above 0; got ${value}.`);
  return {
    forces({ slipRatio, slipAngle, load }) {
      if (!(load > 0)) return { longitudinal: 0, lateral: 0 };
      const sx = slipRatio,
        sy = sin(slipAngle) / cos(slipAngle),
        size = hypot(sx, sy);
      if (size === 0) return { longitudinal: 0, lateral: 0 };
      // The theoretical slip: the practical slips over the wheel's surface speed in ground speeds, 1 + kappa. A wheel turning no
      // faster than the ground moves backward under it (1 + kappa of 0 or less) slides whole.
      const surface = 1 + sx,
        theta = (2 * c * a * a) / (3 * mu * load),
        t = surface > 0 ? (theta * size) / surface : Infinity,
        force = t >= 1 ? mu * load : mu * load * (1 - (1 - t) * (1 - t) * (1 - t));
      return { longitudinal: (force * sx) / size, lateral: (force * sy) / size };
    },
  };
}
