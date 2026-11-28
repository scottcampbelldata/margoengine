// The panel leaves the open quarter diagonally. The remaining shell first
// rotates about the shaft and then lifts with its opening facing downward.
const smooth = (x) => {
  const n = Math.max(0, Math.min(1, x));
  return n * n * (3 - 2 * n);
};
const ramp = (t, a, b) => smooth((t - a) / (b - a));

export const engineAxis = 0.8;
export const fanTravel = 0.88;
export const compressorTravel = 0.48;
const housingTurnStart = 0.11;
const housingLiftStart = 0.5;
export const housingRotation = (-3 * Math.PI) / 4;
const housingLift = 1.74;
export const coverTravel = [1.12, 1.12, -0.88];

export function turbofanAssembly(time) {
  const coverAmount = ramp(time, 6.4, 13.6) * (1 - ramp(time, 80.5, 83.2));
  const inspection = ramp(time, 56.7, 64.1) * (1 - ramp(time, 76.9, 82.4));
  return {
    cover: coverTravel.map((v) => v * coverAmount),
    inspection,
    turn: housingRotation * ramp(inspection, housingTurnStart, housingLiftStart),
    lift: housingLift * ramp(inspection, housingLiftStart, 1),
  };
}
