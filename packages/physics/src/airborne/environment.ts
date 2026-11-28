import { MargoError } from '@margoengine/math/errors';
import { cos, exp, ln, pow, sin } from '@margoengine/math/pinned';

export const KINDS = ['mineral-dust', 'freshwater-mist', 'sea-spray'] as const;
const SALT_DENSITY = 2160;
const WATER_DENSITY = 1000;
const SALINITY = 0.035;
const SALT_VOLUME_SHARE = SALINITY / SALT_DENSITY / (SALINITY / SALT_DENSITY + (1 - SALINITY) / WATER_DENSITY);
export const DRY_SALT_SCALE = pow(SALT_VOLUME_SHARE, 1 / 3);
export const RHO = [2650, WATER_DENSITY, WATER_DENSITY + SALT_VOLUME_SHARE * (SALT_DENSITY - WATER_DENSITY)] as const;

export function parcelDensity(kind: number, diameter: number, dryDiameter: number): number {
  if (kind !== 2) return RHO[kind]!;
  const ratio = dryDiameter / diameter;
  return WATER_DENSITY + (SALT_DENSITY - WATER_DENSITY) * ratio * ratio * ratio;
}
export const MIN_DIAMETER = 1e-6;
export const MAX_DIAMETER = [63e-6, 0.0005, 0.003] as const;
export const STANDARD_TEMPERATURE = 288.15;
export const STANDARD_DENSITY = 1.225;
export const BYTES = 8;
export const RECORD = 16;
export const FORCE = 11;
export const TWO32 = 4294967296;

export function range(value: number, label: string, min: number, max: number): number {
  if (!(Number.isFinite(value) && value >= min && value <= max))
    throw new MargoError('state', `Choose environmental particle ${label} in [${min}, ${max}].`);
  return value;
}

export function airViscosity(temperature: number): number {
  const ratio = temperature / 273.15;
  return (1.716e-5 * ratio * Math.sqrt(ratio) * (273.15 + 110.4)) / (temperature + 110.4);
}

export function dragRate(
  d: number,
  particle: number,
  air: number,
  viscosity: number,
  speed: number,
  stokes: boolean,
  temperature: number,
): number {
  const reynolds = (air * d * speed) / viscosity;
  const knudsen = (2 * (viscosity / air) * Math.sqrt(Math.PI / (2 * 287.05 * temperature))) / d;
  const slip = 1 + knudsen * (1.257 + 0.4 * exp(-1.1 / knudsen));
  const rate = (18 * viscosity) / (particle * d * d * slip);
  if (stokes) {
    if (reynolds > 0.1) throw new MargoError('state', 'Use sphere drag when the particle Reynolds number exceeds 0.1.');
    return rate;
  }
  return reynolds <= 1000 ? rate * (1 + 0.15 * pow(reynolds, 0.687)) : (3 * air * 0.44 * speed) / (4 * particle * d);
}

/** Integral of exp(-beta t), and its time integral, for a frozen environmental forcing interval. */
export function dragIntegrals(
  beta: number,
  dt: number,
): readonly [decay: number, velocityTime: number, positionTime: number] {
  const z = beta * dt;
  const decay = exp(-z);
  if (z < 0.002) {
    const z2 = z * z;
    const z3 = z2 * z;
    return [decay, dt * (1 - z * 0.5 + z2 / 6 - z3 / 24), dt * dt * (0.5 - z / 6 + z2 / 24 - z3 / 120)];
  }
  const exposure = (1 - decay) / beta;
  return [decay, exposure, (dt - exposure) / beta];
}

export function waterDrying(temperature: number, humidity: number, density: number): number {
  const celsius = temperature - 273.15;
  const vapour = 611.21 * exp(((18.678 - celsius / 234.5) * celsius) / (257.14 + celsius));
  const deficit = (vapour * (1 - humidity)) / (461.5 * temperature);
  return (8 * 2.5e-5 * deficit) / density;
}

export function normalDeviates(random: Uint32Array, into: Float64Array): void {
  const a = Math.sqrt(-2 * ln((random[0]! + 0.5) / TWO32));
  const b = Math.sqrt(-2 * ln((random[2]! + 0.5) / TWO32));
  const theta = (2 * Math.PI * (random[1]! + 0.5)) / TWO32;
  into[0] = a * cos(theta);
  into[1] = a * sin(theta);
  into[2] = b * cos((2 * Math.PI * (random[3]! + 0.5)) / TWO32);
}
