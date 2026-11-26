import { MargoError } from '@margoengine/math/errors';
import { pow } from '@margoengine/math/pinned';

/** A circular submerged jet at normal incidence to a flat bed, in SI units. */
export interface SubmergedJet {
  /** Nozzle-to-bed distance in metres, at least one nozzle diameter. */
  height: number;
  /** Nozzle diameter in metres. */
  diameter: number;
  /** Mean nozzle-exit speed in metres per second. */
  speed: number;
  /** Water density in kilograms per cubic metre. */
  density: number;
  /** Kinematic viscosity in square metres per second. */
  viscosity: number;
}

// Phares et al. (2000), Fig. 5b. Each row samples the theoretical laminar solution
// at one nozzle clearance. Entries are [r/H, normalized wall stress]; Eq. 2.33 gives the last row's exact maximum.
const CORE = [
  [
    [0.12, 0.1],
    [0.2, 0.2],
    [0.4, 0.51],
    [0.6, 0.86],
    [0.8, 1.05],
    [1, 0.97],
  ],
  [
    [0.01, 0.18],
    [0.02, 0.35],
    [0.05, 0.9],
    [0.1, 1.73],
    [0.2, 3.01],
    [0.35, 3.66],
    [0.5, 3.36],
    [0.75, 2.38],
    [0.82, 2.15],
  ],
  [
    [0.01, 1.39],
    [0.02, 2.75],
    [0.05, 6.8],
    [0.1, 11.8],
    [0.18, 14.6],
    [0.25, 13.6],
    [0.35, 10.3],
    [0.45, 7.9],
  ],
  [
    [0.01, 4.6],
    [0.02, 8.7],
    [0.05, 19],
    [0.1, 29.8],
    [0.12, 29.9],
    [0.2, 25.3],
    [0.4, 14.7],
    [0.57, 11.8],
  ],
  [
    [0.01, 9],
    [0.02, 16.8],
    [0.05, 33],
    [0.09, 44.6],
    [0.14, 40.5],
    [0.2, 30.4],
    [0.3, 22],
    [0.39, 18.5],
  ],
] as const;
const CLEARANCE = [1, 2, 4, 6, 8];
const PEAK_RADIUS = [0.8, 0.35, 0.18, 0.12, 0.09];

function coreStress(row: number, distance: number): number {
  const curve = CORE[row]!;
  let fromRadius = 0;
  let fromStress = 0;
  for (const [radius, stress] of curve) {
    if (distance <= radius)
      return fromStress + ((distance - fromRadius) * (stress - fromStress)) / (radius - fromRadius);
    fromRadius = radius;
    fromStress = stress;
  }
  return fromStress;
}

export interface WallJetProfile {
  /** Shear-stress scale in pascals. */
  scale: number;
  /** Normalized Poreh radial wall-jet coefficient. */
  outer: number;
  low: number;
  high: number;
  weight: number;
  peak: number;
}

export function wallJetProfile(
  height: number,
  diameter: number,
  speed: number,
  density: number,
  viscosity: number,
): WallJetProfile {
  const ratio = height / diameter;
  const reynolds = (speed * diameter) / viscosity;
  const high = ratio <= 1 ? 0 : ratio <= 2 ? 1 : ratio <= 4 ? 2 : ratio <= 6 ? 3 : 4;
  const low = Math.max(0, high - 1);
  const weight = high === 0 ? 0 : (Math.min(ratio, 8) - CLEARANCE[low]!) / (CLEARANCE[high]! - CLEARANCE[low]!);
  return {
    scale: (density * speed * speed) / (Math.sqrt(reynolds) * ratio * ratio),
    outer: 0.34 * pow(reynolds, 0.2),
    low,
    high,
    weight,
    peak: PEAK_RADIUS[low]! + weight * (PEAK_RADIUS[high]! - PEAK_RADIUS[low]!),
  };
}

export function evaluateWallJet(jet: WallJetProfile, rOverHeight: number): number {
  const near = coreStress(jet.low, rOverHeight);
  const core = near + jet.weight * (coreStress(jet.high, rOverHeight) - near);
  // The Eq. 2.37 radial decay can limit the stress outside the core peak.
  // At smaller radii it is singular and does not describe the impingement region.
  const outer = rOverHeight > jet.peak ? jet.outer * pow(rOverHeight, -2.3) : Infinity;
  return jet.scale * Math.min(core, outer);
}

/** Steady wall shear in pascals at a radial distance from a submerged jet's stagnation point. */
export function submergedJetWallShear(jet: SubmergedJet, radius: number): number {
  const { height, diameter, speed, density, viscosity } = jet;
  if (
    ![height, diameter, speed, density, viscosity, radius].every(Number.isFinite) ||
    !(height >= diameter && diameter > 0 && speed > 0 && density > 0 && viscosity > 0 && radius >= 0)
  )
    throw new MargoError(
      'unsupported',
      'The submerged jet is outside the wall shear model; use finite positive fluid and nozzle values, a clearance of one diameter or more, and a nonnegative radius.',
    );
  const stress = evaluateWallJet(wallJetProfile(height, diameter, speed, density, viscosity), radius / height);
  if (!Number.isFinite(stress))
    throw new MargoError(
      'unsupported',
      'The submerged jet wall stress exceeds numeric range; use physical nozzle dimensions, speed, density and viscosity.',
    );
  return stress;
}
