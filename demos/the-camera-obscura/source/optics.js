import { pinholeImage, relativeIllumination } from '@margoengine/optics/imaging';

// The box: the plate slides from 160 to 440 mm behind a pinhole 270 mm above the base.
export const minimumDistance = .160;
export const maximumDistance = .440;
export const axisHeight = .270;

export const projectPoint = (u, v, sourceDistance, plateDistance) => pinholeImage(u, v, sourceDistance, plateDistance);

/** Plate irradiance relative to the nearest plate position, with the cos^4 fall-off off axis. */
export const relativeExposure = (plateDistance, slope = 0) =>
  (minimumDistance / plateDistance) ** 2 * relativeIllumination(slope);
