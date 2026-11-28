export const latitude = 43.5;
export const lat = latitude * Math.PI / 180;
export const styleLength = 1.76;
const degrees = 180 / Math.PI;

export const days = Object.freeze([
  { label: 'March equinox', date: 'Mar 20', ordinal: 79 },
  { label: 'June solstice', date: 'Jun 21', ordinal: 172 },
  { label: 'December solstice', date: 'Dec 21', ordinal: 355 },
]);

/** Local apparent solar time in minutes. Coordinates are +X east, +Y up, −Z north. */
export function solarPosition(day, minute) {
  const annual = 2 * Math.PI / 365 * (day - 1 + (minute - 720) / 1440);
  const declination = .006918
    - .399912 * Math.cos(annual) + .070257 * Math.sin(annual)
    - .006758 * Math.cos(2 * annual) + .000907 * Math.sin(2 * annual)
    - .002697 * Math.cos(3 * annual) + .001480 * Math.sin(3 * annual);
  const hourAngle = Math.PI * (minute - 720) / 720;
  const north = Math.cos(lat) * Math.sin(declination)
    - Math.sin(lat) * Math.cos(declination) * Math.cos(hourAngle);
  const up = Math.sin(lat) * Math.sin(declination)
    + Math.cos(lat) * Math.cos(declination) * Math.cos(hourAngle);
  const east = -Math.cos(declination) * Math.sin(hourAngle);
  const direction = [east, up, -north];
  const tipHeight = styleLength * Math.sin(lat);
  const northOfFoot = styleLength * Math.cos(lat);
  const shadow = up > 0
    ? [-tipHeight * east / up, -northOfFoot - tipHeight * direction[2] / up]
    : null;
  return { direction, elevation: Math.asin(up) * degrees,
    azimuth: (Math.atan2(east, north) * degrees + 360) % 360, shadow };
}

/** Angle of the time line clockwise from true north on a horizontal polar-style dial. */
export function hourLine(minute) {
  const h = Math.PI * (minute - 720) / 720;
  return Math.atan2(Math.sin(lat) * Math.sin(h), Math.cos(h));
}
