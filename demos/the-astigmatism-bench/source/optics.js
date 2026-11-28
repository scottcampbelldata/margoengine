export const pupilRadius = .105;
export const meanFocalLength = .420;
export const minImageDistance = .280;
export const maxImageDistance = .560;

export function focusPlanes(separation) {
  const tangential = meanFocalLength - separation / 2;
  const sagittal = meanFocalLength + separation / 2;
  return {
    tangential,
    sagittal,
    circle: 2 * tangential * sagittal / (tangential + sagittal),
  };
}

// u is sagittal (screen horizontal), v is tangential (screen vertical).
export function imagePoint(u, v, distance, planes) {
  return [
    u * (1 - distance / planes.sagittal),
    v * (1 - distance / planes.tangential),
  ];
}

export function spotRadii(distance, planes) {
  return imagePoint(pupilRadius, pupilRadius, distance, planes).map(Math.abs);
}
