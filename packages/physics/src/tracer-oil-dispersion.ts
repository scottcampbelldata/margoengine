import { MargoError } from '@margoengine/math/errors';
import { pow } from '@margoengine/math/pinned';

/** Physical breaker conditions over an oil slick. */
export interface TracerBreakerExposure {
  /** Energy lost per unit area of a breaking event, J/m². */
  energy: number;
  /** Effective fraction of the surface swept by breaking crests each second, s⁻¹. */
  turnover: number;
  /** Breaking wave height, m. */
  height: number;
}

/** Transfer floating oil into buoyant droplets by the Delvigne–Sweeney model. */
export interface TracerOilDispersion {
  /** Oil-specific coefficient in the Delvigne–Sweeney SI entrainment equation. */
  entrainmentCoefficient: number;
  /** Smallest dispersed oil diameter, m (default 3 μm). */
  minimumDiameter?: number;
  /** Largest dispersed oil diameter, m, for the prescribed oil and breaker conditions. */
  maximumDiameter: number;
  /** Number of logarithmic diameter classes, each using one tracer slot (default 24). */
  classes?: number;
  /** Fixed conditions or time-varying conditions at the slick centre in the tracer origin cell. */
  breaking: TracerBreakerExposure | ((x: number, z: number, time: number) => TracerBreakerExposure);
}

export interface OilDropClass {
  diameter: number;
  share: number;
}

export interface OilDispersionLaw {
  classes: readonly OilDropClass[];
  rateScale: number;
  breaking: TracerOilDispersion['breaking'];
}

function checkExposure({ energy, turnover, height }: TracerBreakerExposure): void {
  if (!(energy >= 0 && turnover >= 0 && height >= 0 && [energy, turnover, height].every(Number.isFinite)))
    throw new MargoError(
      'unsupported',
      'Oil breaker exposure is outside range; supply finite nonnegative energy, turnover and height.',
    );
}

export function oilDispersionLaw(options: TracerOilDispersion, capacity: number): OilDispersionLaw {
  const { entrainmentCoefficient, minimumDiameter = 3e-6, maximumDiameter, classes = 24, breaking } = options;
  if (
    !(
      entrainmentCoefficient >= 0 &&
      minimumDiameter > 0 &&
      maximumDiameter > minimumDiameter &&
      [entrainmentCoefficient, minimumDiameter, maximumDiameter].every(Number.isFinite)
    )
  )
    throw new MargoError(
      'unsupported',
      'Oil droplet sizes or entrainment are outside range; supply increasing positive diameters and a finite nonnegative coefficient.',
    );
  if (!(Number.isSafeInteger(classes) && classes >= 2 && classes <= capacity))
    throw new MargoError(
      'unsupported',
      'Oil droplet classes exceed available capacity; reserve at least two whole classes within tracer capacity.',
    );
  if (typeof breaking !== 'function') checkExposure(breaking);
  const ratio = maximumDiameter / minimumDiameter;
  const integral = (pow(maximumDiameter, 1.7) - pow(minimumDiameter, 1.7)) / 1.7;
  const rateScale = entrainmentCoefficient * integral;
  if (!(integral > 0 && Number.isFinite(rateScale) && Number.isFinite(ratio)))
    throw new MargoError(
      'unsupported',
      'Oil droplet bins exceed numeric range; supply physical diameters and entrainment.',
    );
  const bins: OilDropClass[] = [];
  let low = minimumDiameter;
  for (let i = 0; i < classes; i++) {
    const high = i + 1 === classes ? maximumDiameter : minimumDiameter * pow(ratio, (i + 1) / classes);
    // Delvigne et al. (1987), ES.3 and ES.6. Integrate number and volume separately to preserve both moments.
    const dMass = (pow(high, 1.7) - pow(low, 1.7)) / 1.7;
    const dNumber = (pow(low, -1.3) - pow(high, -1.3)) / 1.3;
    const diameter = pow(dMass / dNumber, 1 / 3);
    if (!(diameter > 0 && dMass > 0 && Number.isFinite(diameter)))
      throw new MargoError(
        'unsupported',
        'Oil droplet classes collapse within numeric precision; use fewer classes or a wider diameter interval.',
      );
    bins.push({ diameter, share: dMass / integral });
    low = high;
  }
  return { rateScale, classes: bins, breaking: typeof breaking === 'function' ? breaking : { ...breaking } };
}

export function oilBreaking(
  law: OilDispersionLaw,
  x: number,
  z: number,
  time: number,
): { rate: number; depth: number } {
  const { breaking, rateScale } = law;
  const exposure = typeof breaking === 'function' ? breaking(x, z, time) : breaking;
  if (typeof breaking === 'function') checkExposure(exposure);
  // ES.5 and ES.6. The slick footprint supplies the area covered by oil.
  const depth = 1.5 * exposure.height;
  const rate = rateScale * pow(exposure.energy, 0.57) * exposure.turnover;
  if (!(Number.isFinite(rate) && Number.isFinite(depth)))
    throw new MargoError(
      'unsupported',
      'Oil breaker entrainment exceeds numeric range; use physical energy, turnover and wave height.',
    );
  return { rate, depth };
}
