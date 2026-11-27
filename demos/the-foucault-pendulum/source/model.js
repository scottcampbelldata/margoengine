const radians = Math.PI / 180;
const siderealHours = 23.9344696;
export const cableLength = 12;
export const amplitude = 1.78;
export const bobRadius = .23;
export const pivotHeight = cableLength + bobRadius + .105;
export const periodSeconds = 2 * Math.PI * Math.sqrt(cableLength / 9.80665);

export function precessionRate(latitude) {
  if (!Number.isFinite(latitude) || Math.abs(latitude) > 90) throw new RangeError('Latitude must be within ±90°.');
  return 360 / siderealHours * Math.sin(latitude * radians);
}

export function pendulumPose(latitude, hours, phase) {
  const azimuth = precessionRate(latitude) * hours * radians;
  const radius = amplitude * Math.cos(phase);
  return {
    azimuth,
    position: [Math.sin(azimuth) * radius,
      pivotHeight - Math.sqrt(cableLength ** 2 - radius ** 2), -Math.cos(azimuth) * radius],
  };
}
