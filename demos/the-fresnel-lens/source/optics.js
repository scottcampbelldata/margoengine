import { designFresnelLens } from '@margoengine/optics/imaging';

// The lens: acrylic (n 1.49), 450 mm focus, a 24 mm flat centre and ten 17.6 mm rings; the lamp slides 300 to 650 mm.
export const glassIndex = 1.49;
export const focalDistance = .450;
export const minDistance = .300;
export const maxDistance = .650;
export const baseDepth = .0046;
export const centerRadius = .024;
export const ringWidth = .0176;
export const targetPlane = .610;
const lens = designFresnelLens({ index: glassIndex, focalDistance, centerRadius, ringWidth, rings: 10, baseDepth });
export const lensRadius = lens.radius;
export const facets = lens.facets;

export const traceFacet = (distance, index) => lens.trace(distance, index);
export const targetRadius = (ray) => lens.radiusAt(ray, targetPlane);

export function beamMeasure(distance) {
  const edge = traceFacet(distance, facets.length - 1);
  const spread = 2 * Math.abs(edge.exterior) * 180 / Math.PI;
  return { spread, state: spread < .035 ? 'Parallel' : edge.exterior > 0 ? 'Diverging' : 'Converging' };
}
