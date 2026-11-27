export const floorY = .109;
export const feedX = -.165;
export const planeZ = .055;
export const pitch = .027;

export function fountainPath(drop, rise) {
  const feedY = floorY + drop;
  const radius = Math.min(.122, .72 * rise);
  const shoulder = feedY + rise - radius;
  const up = shoulder - feedY;
  const bend = Math.PI * radius;
  const down = shoulder - floorY;
  return {
    length: up + bend + down,
    crest: feedY + rise,
    sample(distance) {
      if (distance < up) return [feedX, feedY + distance, planeZ];
      if (distance < up + bend && radius > 0) {
        const theta = (distance - up) / radius;
        return [feedX + radius * (1 - Math.cos(theta)), shoulder + radius * Math.sin(theta), planeZ];
      }
      return [feedX + 2 * radius, shoulder - (distance - up - bend), planeZ];
    },
  };
}


