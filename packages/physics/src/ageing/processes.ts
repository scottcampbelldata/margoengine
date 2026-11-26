import { MargoError } from '@margoengine/math/errors';
import { exp, pow } from '@margoengine/math/pinned';

/** Length of a model year in seconds, using 365.25 days. */
export const AGEING_YEAR = 365.25 * 86400;

/** The atmospheric coupon fits are for either carbon steel or copper. */
export type AgeingMetal = 'steel' | 'copper';

export const METAL = {
  steel: { exponent: 0.523, molarMass: 0.055845, density: 7870, oxideRatio: (0.159687 * 7870) / (2 * 0.055845 * 5240) },
  copper: {
    exponent: 0.667,
    molarMass: 0.063546,
    density: 8960,
    oxideRatio: (0.143091 * 8960) / (2 * 0.063546 * 6000),
  },
} as const;

const FARADAY = 96485.33212331002;
const CALCITE_MOLAR_MASS = 0.1000869;
const CALCITE_DENSITY = 2710;
const NEUTRAL_RECESSION = 18.8e-6;

export function bounded(value: number, low: number, high: number, quantity: string): number {
  if (!Number.isFinite(value) || value < low || value > high)
    throw new MargoError(
      'state',
      `Material ageing ${quantity} is out of range. Pass a number from ${low} through ${high}.`,
    );
  return value;
}

export function unit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** Variables for the ISO 9223 annual atmospheric model. */
export interface AtmosphericExposure {
  /** Air temperature in K. Default 293.15. */
  readonly temperature?: number;
  /** Relative humidity in 0..1. Default 0.7. */
  readonly relativeHumidity?: number;
  /** Sulphur dioxide deposition in mg/(m² day). Default 4. */
  readonly sulphurDioxide?: number;
  /** Chloride deposition in mg/(m² day). Default 3. */
  readonly chloride?: number;
}

export function corrosionRate(metal: AgeingMetal, tC: number, rh: number, sulphur: number, chloride: number): number {
  const t = tC - 10;
  if (metal === 'steel') {
    const adjustment = t * (t <= 0 ? 0.15 : -0.054);
    return (
      1e-6 *
      (1.77 * pow(sulphur, 0.52) * exp(0.02 * rh + adjustment) +
        0.102 * pow(chloride, 0.62) * exp(0.033 * rh + 0.04 * tC))
    );
  }
  const adjustment = t * (t <= 0 ? 0.126 : -0.08);
  return (
    1e-6 *
    (0.0053 * pow(sulphur, 0.26) * exp(0.059 * rh + adjustment) +
      0.01025 * pow(chloride, 0.27) * exp(0.036 * rh + 0.049 * tC))
  );
}

/** First-year atmospheric penetration in metres, from ISO 9223 §8.2. Supply annualized exposure. */
export function atmosphericMetalLoss(metal: AgeingMetal, exposure: AtmosphericExposure = {}): number {
  if (metal !== 'steel' && metal !== 'copper')
    throw new MargoError('state', 'Use steel or copper for atmospheric metal ageing.');
  const t = bounded(exposure.temperature ?? 293.15, 173.15, 373.15, 'temperature in K') - 273.15;
  const humidity = 100 * bounded(exposure.relativeHumidity ?? 0.7, 0, 1, 'relative humidity');
  const sulphur = bounded(exposure.sulphurDioxide ?? 4, 0, 1e6, 'sulphur dioxide deposition');
  const chloride = bounded(exposure.chloride ?? 3, 0, 1e6, 'chloride deposition');
  return corrosionRate(metal, t, humidity, sulphur, chloride);
}

// ISO 9224 Eq. 1, then its conservative linear extension (Eq. 3).
// At a climate change, starting from the same penetration on the new climate's curve preserves the accumulated loss.
export function advanceAtmospheric(
  loss: number,
  annualLoss: number,
  exponent: number,
  transition: number,
  years: number,
) {
  if (annualLoss === 0 || years === 0) return loss;
  const value = loss / annualLoss;
  const slope = (exponent * transition) / 20;
  if (value >= transition) return loss + annualLoss * slope * years;
  const age = pow(value, 1 / exponent) + years;
  const next = age <= 20 ? pow(age, exponent) : transition + slope * (age - 20);
  return Math.max(loss, annualLoss * next);
}

// ASTM G102 in SI, with steel represented by Fe -> Fe²⁺ and copper by Cu -> Cu²⁺.
export function immersionSpeed(metal: AgeingMetal, currentDensity: number): number {
  const { molarMass, density } = METAL[metal];
  return (currentDensity * molarMass) / (2 * FARADAY * density);
}

export function defaultMarineCurrent(): number {
  // Melchers reports an approximately 60 µm annual long-term loss in coastal seawater at 20 °C.
  return 60e-6 / AGEING_YEAR / immersionSpeed('steel', 1);
}

// Viitanen et al. activation in hours and irreversible mass loss as a fraction of initial mass.
export function woodRates(tC: number, rh: number): readonly [activationPerHour: number, lossPerHour: number] {
  if (tC < 0 || tC > 30 || rh < 95) return [-1 / 17520, 0];
  const time = (720 * (2.3 * tC + 0.035 * rh - 0.024 * tC * rh)) / (-42 + 0.14 * tC + 0.45 * rh);
  return [1 / time, Math.max(0, -0.0596 + 0.000196 * tC + 0.000625 * rh) / 100];
}

export function carbonateSpeed(rain: number, pH: number, dryRecession: number): number {
  // Separate clean-rain equilibrium and consumption of protons in excess of the clean-rain reference at pH 5.6.
  // The acid reaction consumes two protons per mole CaCO3. Factor 1000 converts L to m^3.
  const excess = Math.max(0, pow(10, -pH) - pow(10, -5.6));
  return rain * (NEUTRAL_RECESSION + (1000 * excess * CALCITE_MOLAR_MASS) / (2 * CALCITE_DENSITY)) + dryRecession;
}

/** 1 - e^-x for x ≥ 0. Near 0 the alternating Taylor form avoids cancellation. */
export function oneMinusExp(x: number): number {
  if (x >= 1e-3) return 1 - exp(-x);
  return x * (1 - x * (1 / 2 - x * (1 / 6 - x * (1 / 24 - x * (1 / 120 - x / 720)))));
}

export function advanceFouling(cover: number, settlement: number, removal: number, seconds: number): number {
  const rate = settlement + removal;
  return rate === 0 ? cover : unit(cover + (settlement / rate - cover) * oneMinusExp(rate * seconds));
}
