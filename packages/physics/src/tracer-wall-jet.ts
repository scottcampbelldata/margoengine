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
  /** Resolve the developing turbulent wall layer past the pressure plateau at H/D from 2 through 4. Default false. */
  turbulentTransition?: boolean;
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
  transition?: {
    radius: number;
    initialThickness: number;
    growth: number;
    stress: number;
  };
}

export function wallJetProfile(
  height: number,
  diameter: number,
  speed: number,
  density: number,
  viscosity: number,
  turbulentTransition = false,
): WallJetProfile {
  const ratio = height / diameter;
  const reynolds = (speed * diameter) / viscosity;
  const high = ratio <= 1 ? 0 : ratio <= 2 ? 1 : ratio <= 4 ? 2 : ratio <= 6 ? 3 : 4;
  const low = Math.max(0, high - 1);
  const weight = high === 0 ? 0 : (Math.min(ratio, 8) - CLEARANCE[low]!) / (CLEARANCE[high]! - CLEARANCE[low]!);
  const jet: WallJetProfile = {
    scale: (density * speed * speed) / (Math.sqrt(reynolds) * ratio * ratio),
    outer: 0.34 * pow(reynolds, 0.2),
    low,
    high,
    weight,
    peak: PEAK_RADIUS[low]! + weight * (PEAK_RADIUS[high]! - PEAK_RADIUS[low]!),
  };
  if (!turbulentTransition || ratio < 2 || ratio > 4) return jet;
  // Phares Eq. 2.12 gives the developing round jet's half width.
  // By three half widths the inviscid edge velocity in Fig. 4 has reached its plateau.
  const radius = 3 * (0.5 / ratio + 0.02);
  const edgeReynolds = reynolds * ratio;
  const stressScale = Math.sqrt(reynolds) * ratio * ratio;
  const initialStress = laminarStress(jet, radius);
  // The zero-pressure-gradient Pohlhausen quartic gives theta = 37/315 delta and tau = 2 mu U / delta.
  const thickness = ((74 / 315) * stressScale) / (edgeReynolds * initialStress);
  const viscosityFactor = pow(edgeReynolds, -1 / 6);
  const stress = 0.0065 * stressScale * viscosityFactor;
  // The Falkner turbulent wall law only adds the transition when it increases the shear (Phares Fig. 6).
  if (Number.isFinite(edgeReynolds) && thickness > 0 && stress * pow(thickness, -1 / 6) > initialStress) {
    jet.transition = {
      radius,
      initialThickness: pow(thickness, 7 / 6),
      growth: (7 / 13) * 0.0065 * viscosityFactor,
      stress,
    };
  }
  return jet;
}

function laminarStress(jet: WallJetProfile, rOverHeight: number): number {
  const near = coreStress(jet.low, rOverHeight);
  return near + jet.weight * (coreStress(jet.high, rOverHeight) - near);
}

export function evaluateWallJet(jet: WallJetProfile, rOverHeight: number): number {
  const transition = jet.transition;
  let core: number;
  if (transition && rOverHeight >= transition.radius) {
    // Integrate Phares Eq. 2.34–2.36 with constant edge speed in the pressure plateau.
    const spread = pow(transition.radius / rOverHeight, 7 / 6);
    const integrated =
      transition.initialThickness * spread + transition.growth * (rOverHeight - transition.radius * spread);
    core = transition.stress * pow(integrated, -1 / 7);
  } else {
    core = laminarStress(jet, rOverHeight);
  }
  // The Eq. 2.37 radial decay can limit the stress outside the core peak.
  // At smaller radii it is singular and does not describe the impingement region.
  const outer = rOverHeight > jet.peak ? jet.outer * pow(rOverHeight, -2.3) : Infinity;
  return jet.scale * Math.min(core, outer);
}

/** Steady wall shear in pascals at a radial distance from a submerged jet's stagnation point. */
export function submergedJetWallShear(jet: SubmergedJet, radius: number): number {
  const { height, diameter, speed, density, viscosity, turbulentTransition = false } = jet;
  if (
    typeof turbulentTransition !== 'boolean' ||
    ![height, diameter, speed, density, viscosity, radius].every(Number.isFinite) ||
    !(height >= diameter && diameter > 0 && speed > 0 && density > 0 && viscosity > 0 && radius >= 0)
  )
    throw new MargoError(
      'unsupported',
      'The submerged jet is outside the wall shear model; use finite positive fluid and nozzle values, a clearance of one diameter or more, a nonnegative radius, and a boolean turbulentTransition.',
    );
  const stress = evaluateWallJet(
    wallJetProfile(height, diameter, speed, density, viscosity, turbulentTransition),
    radius / height,
  );
  if (!Number.isFinite(stress))
    throw new MargoError(
      'unsupported',
      'The submerged jet wall stress exceeds numeric range; use physical nozzle dimensions, speed, density and viscosity.',
    );
  return stress;
}
