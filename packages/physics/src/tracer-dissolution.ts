import { MargoError } from '@margoengine/math/errors';
import { exp, hypot } from '@margoengine/math/pinned';
import { oneMinusExp } from './ageing/processes.js';

/** One soluble constituent in a dilute, well-mixed oil and water system. */
export interface TracerOilSolute {
  /** Its mass divided by the original oil mass. */
  massFraction: number;
  /** Equilibrium oil concentration divided by water concentration at the modeled salinity and temperature. */
  oilWaterPartition: number;
  /** Water-side transfer velocity in m/s, including both films' resistance if known. */
  transferVelocity: number;
  /** First-order loss half-life of dissolved oil in seconds. Default leaves the dissolved mass intact. */
  biodegradationHalfLife?: number;
}

/** Dissolution into one well-mixed water volume below a floating slick. */
export interface TracerOilDissolution {
  /** Underlying water volume in m³. The volume moves with the slick and does not exchange with other pools. */
  waterVolume: number;
  /** Constituents in output order. Unlisted oil remains insoluble. Mass fractions sum to at most one. */
  solutes: readonly TracerOilSolute[];
  /** Override the exchange area in m². Default uses the evolving Fay footprint. */
  transferArea?: number;
}

/** Mass of a constituent in the water and transformed by biodegradation, in kg. */
export interface TracerOilSoluteMass {
  dissolved: number;
  biodegraded: number;
}

interface Solute {
  mass: number;
  fromOil: number;
  fromWater: number;
  decay: number;
}

export interface OilDissolution {
  first: number;
  transferArea?: number;
  solutes: Solute[];
}

export function oilDissolution(
  options: TracerOilDissolution,
  mass: number,
  oilVolume: number,
  first: number,
): OilDissolution {
  const { solutes, waterVolume, transferArea } = options;
  if (
    !(waterVolume > 0 && Number.isFinite(waterVolume) && solutes.length > 0) ||
    (transferArea !== undefined && !(transferArea > 0 && Number.isFinite(transferArea)))
  )
    throw new MargoError(
      'unsupported',
      'Oil dissolution needs a physical exchange geometry and constituents; pass positive finite water volume and area and at least one solute.',
    );
  let fraction = 0;
  const rates = solutes.map(({ massFraction, oilWaterPartition, transferVelocity, biodegradationHalfLife }) => {
    const fromOil = transferVelocity / oilWaterPartition / oilVolume;
    const fromWater = transferVelocity / waterVolume;
    const decay = biodegradationHalfLife === undefined ? 0 : Math.LN2 / biodegradationHalfLife;
    fraction += massFraction;
    if (
      !(massFraction > 0 && mass * massFraction > 0 && fraction <= 1 && oilWaterPartition > 0) ||
      !(fromOil > 0 && fromWater > 0 && decay >= 0) ||
      ![oilWaterPartition, fromOil, fromWater, decay].every(Number.isFinite) ||
      (biodegradationHalfLife !== undefined && !Number.isFinite(biodegradationHalfLife))
    )
      throw new MargoError(
        'unsupported',
        'Oil solute parameters are outside range; use finite positive partition, transfer velocity and optional half-life, and positive mass fractions totaling at most one.',
      );
    return { mass: mass * massFraction, fromOil, fromWater, decay };
  });
  return { first, transferArea, solutes: rates };
}

function exchange(
  oil: number,
  water: number,
  fromOil: number,
  fromWater: number,
  decay: number,
): readonly [number, number] {
  const drainage = fromWater + decay;
  const trace = fromOil + drainage;
  if (!Number.isFinite(trace))
    throw new MargoError(
      'unsupported',
      'The oil exchange exposure exceeds numeric range; use physical transfer velocities, areas, volumes and time steps.',
    );
  if (!decay) {
    const equilibrium = trace > 0 ? (oil + water) * (fromOil / trace) : water;
    const transferred = (equilibrium - water) * oneMinusExp(trace);
    return [oil - transferred, water + transferred];
  }
  // Exponential of the two-reservoir system with an aqueous sink. Use the determinant for the slow mode to
  // preserve its rate when exchange is much faster than decay. Both diagonal weights are nonnegative.
  const gap =
    trace *
    Math.min(1, hypot((drainage - fromOil) / trace, 2 * Math.sqrt(fromOil / trace) * Math.sqrt(fromWater / trace)));
  const fast = 0.5 * trace + 0.5 * gap;
  const slow = (fromOil / fast) * decay;
  const fastWeight = exp(-fast);
  const slowWeight = exp(-slow);
  const difference = slowWeight * oneMinusExp(gap);
  const oilWeight = gap > 0 ? 0.5 * (1 + (drainage - fromOil) / gap) : 0.5;
  const mixing = gap > 0 ? difference / gap : fastWeight;
  return [
    oil * (fastWeight + difference * oilWeight) + water * (mixing * fromWater),
    water * (fastWeight + difference * (1 - oilWeight)) + oil * (mixing * fromOil),
  ];
}

/** Advance the soluble pools and return changes in dissolved and biodegraded oil. */
export function advanceOilDissolution(
  law: OilDissolution,
  inventory: Float64Array,
  areaTime: number,
  dt: number,
): TracerOilSoluteMass {
  let dissolved = 0;
  let biodegraded = 0;
  const exposure = law.transferArea === undefined ? areaTime : law.transferArea * dt;
  for (let i = 0; i < law.solutes.length; i++) {
    const solute = law.solutes[i]!;
    const index = law.first + 2 * i;
    const water = inventory[index]!;
    const remaining = solute.mass - inventory[index + 1]!;
    const oil = Math.max(0, remaining - water);
    const [oilAfter, waterAfter] = exchange(
      oil,
      water,
      solute.fromOil * exposure,
      solute.fromWater * exposure,
      solute.decay * dt,
    );
    const loss = solute.decay ? Math.max(0, remaining - (oilAfter + waterAfter)) : 0;
    const nextWater = Math.min(remaining - loss, waterAfter);
    inventory[index] = nextWater;
    inventory[index + 1]! += loss;
    dissolved += nextWater - water;
    biodegraded += loss;
  }
  return { dissolved, biodegraded };
}
