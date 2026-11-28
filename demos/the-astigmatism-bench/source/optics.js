import { astigmaticFoci, astigmaticImage } from '@margoengine/optics/imaging';

// The bench lens: 105 mm pupil radius and a 420 mm mean focal length; the screen runs 280 to 560 mm.
export const pupilRadius = .105;
export const meanFocalLength = .420;
export const minImageDistance = .280;
export const maxImageDistance = .560;

export function focusPlanes(separation) {
  const foci = astigmaticFoci(meanFocalLength, separation);
  return { tangential: foci.tangential, sagittal: foci.sagittal, circle: foci.leastConfusion };
}

// u is sagittal (screen horizontal), v is tangential (screen vertical).
export const imagePoint = (u, v, distance, planes) => astigmaticImage(u, v, distance, planes);

export const spotRadii = (distance, planes) => imagePoint(pupilRadius, pupilRadius, distance, planes).map(Math.abs);
