import type { FlowCell, FlowSample, Wind } from '@margoengine/math/fields';
import { cos, exp, hypot, ln, sin } from '@margoengine/math/pinned';
import {
  compactDeficit,
  compactPeakWind,
  compactTangential,
  hollandDeficit,
  hollandGradient,
  oneMinusDecay,
} from '../../../shared/vortex-balance.js';

/** Natural atmospheric vortices with a shared spatial wind contract. */
export type VortexKind = 'cyclone' | 'tornado' | 'waterspout' | 'dustDevil' | 'fireWhirl';

/** Prescribed centre track and pressure profile in SI units. */
export interface StormVortexOptions {
  /** Profile and initial settings. Default 'cyclone'. */
  kind?: VortexKind;
  /** Origin cell of the field. Default [0, 0, 0]. */
  cell?: FlowCell;
  /** Centre at t=0 in x and z metres. Default [0, 0]. */
  center?: readonly [number, number];
  /** Track speed in x and z m/s. Default [0, 0]. */
  translation?: readonly [number, number];
  /** Radius at the nominal peak, m. Defaults to 30 km for the cyclone. */
  radius?: number;
  /** Central pressure deficit in Pa. Defaults to 6,000 for the cyclone. */
  pressureDrop?: number;
  /** Ambient surface pressure in Pa. Default 101,000 for cyclone and 101,325 otherwise. */
  ambientPressure?: number;
  /** Air density in kg/m³. Default 1.15. */
  density?: number;
  /** Sample temperature in K. Default 288.15. */
  temperature?: number;
  /** Holland shape exponent. Default 1.6. */
  shape?: number;
  /** Latitude in degrees, default 20, used for rotation direction and cyclone Coriolis. */
  latitude?: number;
  /** Local radial inflow angle in degrees. Default 22 for cyclone. */
  inflow?: number;
  /** Ratio of nominal 10 m wind to gradient wind. Default 0.9 for cyclone and 1 otherwise. */
  surfaceFactor?: number;
  /** Height scale at which the vortex wind decays, m. Defaults to 11,000 for cyclone. */
  scaleHeight?: number;
  /** Roughness length for the ground-to-10 m profile. Default 0.03 m. */
  roughness?: number;
  /** Ground elevation in m. Default 0. */
  groundY?: number;
  /** Compact vortex tangential law. Default 'burgers'. */
  compactProfile?: 'rankine' | 'burgers';
  /** Rankine outer decay exponent. Default 1. */
  decay?: number;
  /** Scale of the compact core's vertical updraft, m/s. Default depends on kind. */
  updraft?: number;
  /** Optional secondary eyewall's radius, Gaussian width and strength relative to the primary wind. */
  secondary?: { radius: number; width: number; strength: number };
}

/** The existing Sky Hurricane's normalized parameters that the physics field shares. */
export interface HurricaneVortexProfile {
  cx: number;
  cz: number;
  vx: number;
  vz: number;
  dp: number;
  rmax: number;
  b: number;
  rho: number;
  f: number;
  spin: number;
  surface: number;
  inflow: number;
  outer: number;
  outerStrength: number;
  wall: number;
}

const DEFAULTS = {
  cyclone: { radius: 30000, deficit: 6000, height: 11000, inflow: 22, updraft: 0 },
  tornado: { radius: 120, deficit: 8000, height: 1500, inflow: 30, updraft: 15 },
  waterspout: { radius: 35, deficit: 900, height: 600, inflow: 24, updraft: 5 },
  dustDevil: { radius: 8, deficit: 150, height: 200, inflow: 20, updraft: 4 },
  fireWhirl: { radius: 5, deficit: 220, height: 120, inflow: 28, updraft: 9 },
} as const;
const DEG = Math.PI / 180;
const EARTH_ROTATION = 7.292115e-5;

function bounded(value: number, label: string, min = -Infinity, max = Infinity): number {
  if (!Number.isFinite(value) || value < min || value > max)
    throw new RangeError(`Invalid vortex ${label}. Pass a finite SI value in the documented range.`);
  return value;
}

function positive(value: number, label: string): number {
  if (!(bounded(value, label) > 0)) throw new RangeError(`Vortex ${label} must be positive. Pass a value above zero.`);
  return value;
}

/** Surface pressure and height-dependent velocity from one translating natural vortex. */
export class StormVortex implements Wind {
  readonly medium = 'air' as const;
  readonly cell: FlowCell;
  readonly kind: VortexKind;
  readonly ambientPressure: number;
  readonly density: number;
  private readonly cx: number;
  private readonly cz: number;
  private readonly vx: number;
  private readonly vz: number;
  private readonly radius: number;
  private readonly deficit: number;
  private readonly temperature: number;
  private readonly shape: number;
  private readonly coriolis: number;
  private readonly spin: number;
  private readonly radial: number;
  private readonly tangential: number;
  private readonly surface: number;
  private readonly height: number;
  private readonly roughness: number;
  private readonly ground: number;
  private readonly decay: number;
  private readonly burgers: boolean;
  private readonly updraft: number;
  private readonly peak: number;
  private readonly secondary: StormVortexOptions['secondary'];

  constructor(options: StormVortexOptions = {}, balance?: { coriolis: number; spin: number }) {
    this.kind = options.kind ?? 'cyclone';
    const defaults = DEFAULTS[this.kind];
    if (!defaults)
      throw new RangeError('Unknown vortex kind. Pass a cyclone, tornado, waterspout, dustDevil, or fireWhirl.');
    const copiedCell = options.cell ?? [0, 0, 0];
    if (copiedCell.some((value) => !Number.isInteger(value)))
      throw new RangeError('Vortex origin needs three integer cells. Pass the world cell coordinates.');
    this.cell = [...copiedCell];
    this.cx = bounded(options.center?.[0] ?? 0, 'centre x');
    this.cz = bounded(options.center?.[1] ?? 0, 'centre z');
    this.vx = bounded(options.translation?.[0] ?? 0, 'translation x');
    this.vz = bounded(options.translation?.[1] ?? 0, 'translation z');
    this.radius = positive(options.radius ?? defaults.radius, 'radius');
    this.ambientPressure = positive(
      options.ambientPressure ?? (this.kind === 'cyclone' ? 101000 : 101325),
      'ambient pressure',
    );
    this.deficit = bounded(options.pressureDrop ?? defaults.deficit, 'pressure drop', 0);
    if (this.deficit >= this.ambientPressure)
      throw new RangeError('Vortex pressure deficit reaches vacuum. Use a deficit smaller than ambient pressure.');
    this.density = positive(options.density ?? 1.15, 'air density');
    this.temperature = positive(options.temperature ?? 288.15, 'temperature');
    this.shape = positive(options.shape ?? 1.6, 'Holland exponent');
    const latitude = bounded(options.latitude ?? 20, 'latitude', -90, 90);
    this.coriolis = balance
      ? bounded(balance.coriolis, 'Coriolis frequency', 0)
      : 2 * EARTH_ROTATION * sin(Math.abs(latitude) * DEG);
    this.spin = (balance?.spin ?? latitude) < 0 ? -1 : 1;
    const angle = bounded(options.inflow ?? defaults.inflow, 'inflow angle', 0, 90) * DEG;
    this.radial = sin(angle);
    this.tangential = cos(angle);
    this.surface = bounded(options.surfaceFactor ?? (this.kind === 'cyclone' ? 0.9 : 1), 'surface factor', 0, 1);
    this.height = positive(options.scaleHeight ?? defaults.height, 'scale height');
    this.roughness = positive(options.roughness ?? 0.03, 'roughness length');
    if (this.roughness >= 10)
      throw new RangeError('Vortex roughness must be below the 10 m reference height. Pass a smaller value.');
    this.ground = bounded(options.groundY ?? 0, 'ground height');
    this.decay = positive(options.decay ?? 1, 'Rankine exponent');
    this.burgers = options.compactProfile !== 'rankine';
    this.updraft = bounded(options.updraft ?? defaults.updraft, 'updraft', 0);
    this.peak =
      this.kind === 'cyclone'
        ? Math.sqrt((this.shape * this.deficit) / (this.density * Math.E))
        : compactPeakWind(this.deficit, this.density, this.decay, this.burgers);
    const secondary = options.secondary;
    if (secondary)
      this.secondary = {
        radius: positive(secondary.radius, 'outer radius'),
        width: positive(secondary.width, 'outer width'),
        strength: bounded(secondary.strength, 'outer strength', 0),
      };
  }

  /** Bind a snapshot of the Sky Hurricane's existing profile, using the same moving centre and eyewall. */
  static fromHurricane(s: HurricaneVortexProfile, cell?: FlowCell): StormVortex {
    return new StormVortex(
      {
        cell,
        center: [s.cx, s.cz],
        translation: [s.vx, s.vz],
        radius: s.rmax,
        pressureDrop: s.dp,
        shape: s.b,
        density: s.rho,
        surfaceFactor: s.surface,
        inflow: s.inflow / DEG,
        secondary: s.outer > 0 ? { radius: s.outer, width: 0.6 * s.wall, strength: s.outerStrength } : undefined,
      },
      { coriolis: s.f, spin: s.spin },
    );
  }

  /** Deficit from ambient, Pa, evaluated directly to retain the weak outer gradient. */
  pressureDeficit(x: number, z: number, t = 0): number {
    const r = hypot(x - this.cx - this.vx * t, z - this.cz - this.vz * t);
    return this.kind === 'cyclone'
      ? hollandDeficit(r, this.radius, this.shape, this.deficit)
      : compactDeficit(r / this.radius, this.deficit, this.decay, this.burgers);
  }

  /** Surface pressure at a point, Pa. */
  pressureAt(x: number, z: number, t = 0): number {
    return this.ambientPressure - this.pressureDeficit(x, z, t);
  }

  /** Static inverse-barometer level rise, in metres, to use at an open water boundary. */
  inverseBarometer(x: number, z: number, t = 0, waterDensity = 1025, g = 9.80665): number {
    return this.pressureDeficit(x, z, t) / (positive(waterDensity, 'water density') * positive(g, 'gravity'));
  }

  sample(x: number, y: number, z: number, t: number, out?: FlowSample): FlowSample {
    const result = out ?? { velocity: [0, 0, 0], density: 0, temperature: 0 };
    const dx = x - this.cx - this.vx * t,
      dz = z - this.cz - this.vz * t;
    const r = hypot(dx, dz),
      h = Math.max(0, y - this.ground);
    let speed =
      this.kind === 'cyclone'
        ? hollandGradient(r, this.radius, this.shape, this.deficit, this.density, this.coriolis)
        : compactTangential(r / this.radius, this.peak, this.decay, this.burgers);
    if (this.secondary) {
      const q = (r - this.secondary.radius) / this.secondary.width;
      speed = Math.max(speed, this.secondary.strength * this.peak * exp(-q * q));
    }
    const heightFactor =
      h < 10
        ? ln(Math.max(h, this.roughness) / this.roughness) / ln(10 / this.roughness)
        : exp(-(h - 10) / this.height);
    const s = r > 0 ? (speed * this.surface * heightFactor) / r : 0;
    const radial = this.radial * s,
      tangent = this.tangential * this.spin * s;
    result.velocity[0] = tangent * dz - radial * dx;
    result.velocity[2] = -tangent * dx - radial * dz;
    const normalRadius = r / this.radius;
    result.velocity[1] =
      this.updraft * exp(-normalRadius * normalRadius - h / this.height) * oneMinusDecay(h / this.radius);
    result.density = this.density;
    result.temperature = this.temperature;
    return result;
  }
}

/** Neutral ocean drag closure with the high-wind saturation of Donelan et al. (2004). */
export function stormWaterDrag(speed: number): number {
  return (0.75 + 0.067 * Math.min(33, bounded(speed, '10 m wind', 0))) * 1e-3;
}
