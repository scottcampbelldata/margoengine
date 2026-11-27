export const minimumDistance = .160;
export const maximumDistance = .440;
export const axisHeight = .270;

export function projectPoint(u, v, sourceDistance, plateDistance) {
  const scale = -plateDistance / sourceDistance;
  return [u * scale, v * scale];
}

export function relativeExposure(plateDistance, slope = 0) {
  // For fixed aperture area, irradiance is proportional to cos⁴(theta) / d².
  const cosineSquared = 1 / (1 + slope * slope);
  return (minimumDistance / plateDistance) ** 2 * cosineSquared ** 2;
}
