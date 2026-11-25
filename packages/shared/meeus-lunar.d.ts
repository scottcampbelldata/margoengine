export function meeusLunarPosition(
  centuries: number,
  sinDegrees: (angle: number) => number,
  cosDegrees: (angle: number) => number,
): { longitude: number; latitude: number; distance: number };
