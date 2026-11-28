// Open channels for the hydraulics entry (HYDRO-07): Froude number, critical and normal depth, specific energy and the
// classical hydraulic jump. Clean room, from:
// - J.-B. Belanger, "Essai sur la solution numérique de quelques problèmes relatifs au mouvement permanent des eaux
//   courantes" (1828): the momentum balance across a jump and its conjugate-depth ratio;
// - V. T. Chow, "Open-Channel Hydraulics", McGraw-Hill (1959), chapters 3, 6 and 15 (specific energy, Manning's
//   uniform flow and the jump types by approach Froude number);
// - W. H. Hager, R. Bremen and N. Kawagoshi, "Classical hydraulic jump: length of roller", J. Hydraulic Research
//   28(5), 591-608 (1990): L_r / y₁ = 160 tanh(F₁ / 20) - 12, for 2 < F₁ < 16 and y₁ / b < 0.1.
import { exp, pow } from '@margoengine/math/pinned';
import { cbrt, finite, GRAVITY, nonNegative, positive } from './fluid.js';

/** Froude number of a free-surface flow, v / √(g h), with h the hydraulic depth (depth for a rectangle). */
export function froudeNumber(speed: number, depth: number, gravity = GRAVITY): number {
  return Math.abs(finite('speed', speed)) / Math.sqrt(positive('gravity', gravity) * positive('depth', depth));
}

/** Critical depth of a rectangular channel carrying `unitDischarge` m²/s per metre of width: (q²/g)^(1/3). */
export function criticalDepth(unitDischarge: number, gravity = GRAVITY): number {
  const q = nonNegative('unitDischarge', Math.abs(unitDischarge));
  return cbrt((q * q) / positive('gravity', gravity));
}

/** Specific energy above the bed, depth + v²/2g, in metres. */
export function specificEnergy(depth: number, speed: number, gravity = GRAVITY): number {
  return nonNegative('depth', depth) + (finite('speed', speed) * speed) / (2 * positive('gravity', gravity));
}

/** The jump types of Chow (1959) by approach Froude number. */
export type JumpType = 'undular' | 'weak' | 'oscillating' | 'steady' | 'strong';

/** A hydraulic jump in a horizontal rectangular channel. */
export interface HydraulicJump {
  /** Approach (supercritical) depth y₁ and speed v₁, m and m/s. */
  readonly upstreamDepth: number;
  readonly upstreamSpeed: number;
  /** Conjugate (subcritical) depth y₂ and speed v₂ downstream of the roller. */
  readonly downstreamDepth: number;
  readonly downstreamSpeed: number;
  /** Froude numbers before and after the jump. */
  readonly upstreamFroude: number;
  readonly downstreamFroude: number;
  /** Discharge per metre of width, m²/s; times `width` when one is given, m³/s. */
  readonly unitDischarge: number;
  readonly discharge: number;
  /** Approach specific energy y₁ + v₁²/2g, m. */
  readonly upstreamEnergy: number;
  /** Head lost in the roller, (y₂ - y₁)³ / (4 y₁ y₂), m. */
  readonly headLoss: number;
  /** headLoss / upstreamEnergy. */
  readonly relativeLoss: number;
  /** Power dissipated, W (ρ g Q ΔE), with `density` and `width`. */
  readonly power: number;
  /** y₂ - y₁, m. */
  readonly height: number;
  /** Roller length, m (Hager, Bremen and Kawagoshi 1990). */
  readonly rollerLength: number;
  readonly type: JumpType;
}

/** Inputs to {@link hydraulicJump}. */
export interface HydraulicJumpInput {
  /** Approach depth y₁, m. */
  readonly upstreamDepth: number;
  /** Approach speed v₁, m/s; the flow must be supercritical (F₁ > 1). */
  readonly upstreamSpeed: number;
  /** Channel width, m. Default 1 (per metre). */
  readonly width?: number;
  /** Liquid density for the dissipated power, kg/m³. Default 998.2. */
  readonly density?: number;
  readonly gravity?: number;
}

/**
 * The classical jump: momentum conserved across the roller gives Belanger's conjugate depth
 * y₂ = y₁ (√(1 + 8 F₁²) - 1) / 2; energy is not conserved and the loss is (y₂ - y₁)³ / (4 y₁ y₂).
 * Throws a RangeError for a subcritical approach, which forms no jump.
 */
export function hydraulicJump(input: HydraulicJumpInput): HydraulicJump {
  const g = positive('gravity', input.gravity ?? GRAVITY),
    y1 = positive('upstreamDepth', input.upstreamDepth),
    v1 = finite('upstreamSpeed', input.upstreamSpeed),
    width = positive('width', input.width ?? 1),
    density = positive('density', input.density ?? 998.2);
  const f1 = froudeNumber(v1, y1, g);
  if (!(f1 > 1))
    throw new RangeError(`Approach Froude number ${f1} is not supercritical; a hydraulic jump needs F1 > 1.`);
  const y2 = 0.5 * y1 * (Math.sqrt(1 + 8 * f1 * f1) - 1),
    q = y1 * Math.abs(v1),
    v2 = q / y2,
    height = y2 - y1,
    energy = specificEnergy(y1, v1, g),
    loss = (height * height * height) / (4 * y1 * y2),
    x = f1 / 20,
    e2 = exp(2 * x),
    tanh = (e2 - 1) / (e2 + 1);
  return {
    upstreamDepth: y1,
    upstreamSpeed: v1,
    downstreamDepth: y2,
    downstreamSpeed: Math.sign(v1) * v2,
    upstreamFroude: f1,
    downstreamFroude: froudeNumber(v2, y2, g),
    unitDischarge: q,
    discharge: q * width,
    upstreamEnergy: energy,
    headLoss: loss,
    relativeLoss: loss / energy,
    power: density * g * q * width * loss,
    height,
    rollerLength: Math.max(0, (160 * tanh - 12) * y1),
    type: f1 < 1.7 ? 'undular' : f1 < 2.5 ? 'weak' : f1 < 4.5 ? 'oscillating' : f1 < 9 ? 'steady' : 'strong',
  };
}

/** A prismatic channel in uniform flow, for {@link normalDepth}. */
export interface UniformChannel {
  /** Discharge, m³/s. */
  readonly discharge: number;
  /** Bottom width, m (0 for a triangle). */
  readonly bottomWidth: number;
  /** Bed slope, m per m. */
  readonly slope: number;
  /** Manning's n, s/m^(1/3) (finished concrete about 0.013, clean earth about 0.022; Chow 1959, table 5-6). */
  readonly manningN: number;
  /** Side slope, horizontal per vertical. Default 0 (rectangular). */
  readonly sideSlope?: number;
}

/** Uniform-flow depth from Manning's equation Q = (1/n) A R^(2/3) √S, in metres, solved by bisection. */
export function normalDepth(channel: UniformChannel): number {
  const q = nonNegative('discharge', channel.discharge),
    b = nonNegative('bottomWidth', channel.bottomWidth),
    s = positive('slope', channel.slope),
    n = positive('manningN', channel.manningN),
    z = nonNegative('sideSlope', channel.sideSlope ?? 0);
  if (b === 0 && z === 0) throw new RangeError('A channel needs a bottom width or a side slope.');
  if (q === 0) return 0;
  const conveyance = (y: number): number => {
    const area = (b + z * y) * y,
      perimeter = b + 2 * y * Math.sqrt(1 + z * z);
    return (area * pow(area / perimeter, 2 / 3) * Math.sqrt(s)) / n;
  };
  let low = 0,
    high = 1;
  while (conveyance(high) < q) high *= 2;
  for (let i = 0; i < 200 && high - low > 1e-15 * high; i++) {
    const mid = 0.5 * (low + high);
    if (conveyance(mid) < q) low = mid;
    else high = mid;
  }
  return 0.5 * (low + high);
}
