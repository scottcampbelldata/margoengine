// Sarpkaya, NPS-59SL76021 (1976), Appendix A, printed pages 158 and 163.
// Select the last complete sweep for each calibration diameter. The entire
// beta=4480 diameter is reserved for validation. Rows are [KC, C_M, C_D].
type CoefficientRow = readonly [number, number, number];
const BETA_LOW = 3123;
const BETA_HIGH = 5260;
const SMALLER_CYLINDER: readonly CoefficientRow[] = [
  [6.62, 1.75, 1.3],
  [7.06, 1.72, 1.3],
  [7.72, 1.7, 1.36],
  [8.13, 1.62, 1.36],
  [11.95, 1.14, 1.38],
  [13.18, 1.31, 1.16],
  [14.73, 1.52, 1.1],
];
const LARGER_CYLINDER: readonly CoefficientRow[] = [
  [6.5, 1.9, 1.04],
  [7.2, 1.86, 0.98],
  [7.9, 1.79, 1.05],
  [8.8, 1.75, 1.04],
  [9.2, 1.66, 1],
  [11.4, 1.78, 0.95],
  [12.4, 1.73, 0.92],
  [13.6, 1.67, 0.83],
  [14.8, 1.63, 0.82],
];

interface Coefficients {
  drag: number;
  addedMass: number;
}

function mix(from: number, to: number, fraction: number): number {
  return from + fraction * (to - from);
}

function interpolate(rows: readonly CoefficientRow[], kc: number): Coefficients {
  let upper = 1;
  while (rows[upper]![0] < kc) upper++;
  const [x0, m0, d0] = rows[upper - 1]!;
  const [x1, m1, d1] = rows[upper]!;
  const f = (kc - x0) / (x1 - x0);
  return { drag: mix(d0, d1, f), addedMass: mix(m0, m1, f) - 1 };
}

/** Smooth-cylinder coefficients within the measured viscous and displacement range. */
export function smoothOscillatoryCylinder(
  kc: number,
  beta: number,
  currentRatio: number,
  dnv: Coefficients,
): Coefficients {
  if (beta < BETA_LOW || beta > BETA_HIGH || currentRatio >= 0.4 || kc <= 6.62 || kc >= 14.73) return dnv;
  const low = interpolate(SMALLER_CYLINDER, kc);
  const high = interpolate(LARGER_CYLINDER, kc);
  const betaFraction = (beta - BETA_LOW) / (BETA_HIGH - BETA_LOW);
  // Transition over the two outer bins of the common support and as a steady current takes over.
  const weight = Math.min(1, (kc - 6.62) / (7.06 - 6.62), (14.73 - kc) / (14.73 - 13.18)) * (1 - currentRatio / 0.4);
  return {
    drag: mix(dnv.drag, mix(low.drag, high.drag, betaFraction), weight),
    addedMass: mix(dnv.addedMass, mix(low.addedMass, high.addedMass, betaFraction), weight),
  };
}
