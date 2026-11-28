export const dimensions = {
  length: .462, width: .193, crankcaseFloor: .047, deck: .253,
  corner: .012, shellWall: .0085, pitch: .101,
  centers: [-.1515, -.0505, .0505, .1515],
  outerRadius: .052, boreRadius: .043,
};

export const sectionLimit = 127;

export function boreChord(offset) {
  return Math.abs(offset) < dimensions.boreRadius
    ? 2 * Math.sqrt(dimensions.boreRadius ** 2 - offset ** 2)
    : 0;
}