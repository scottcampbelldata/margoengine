const g = 9.80665;
export const depositTension = .11;

export function steadyFountain(drop, pickup, deposit = depositTension) {
  const combined = 1 - pickup - deposit;
  if (!(drop > 0 && pickup >= 0 && deposit >= 0 && combined > 0)) {
    throw new RangeError('The steady model needs a positive drop and pickup plus deposit below one.');
  }
  const speedSquared = g * drop / combined;
  return {
    speed: Math.sqrt(speedSquared),
    rise: pickup * speedSquared / g,
    pickupTensionPerDensity: (1 - pickup) * speedSquared,
    depositTensionPerDensity: deposit * speedSquared,
  };
}

