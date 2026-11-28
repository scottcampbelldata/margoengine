import { degrees, sunPath } from '@margoengine/sky/sun';

export const latitude = 43.5;
export const lat = latitude * Math.PI / 180;
export const styleLength = 1.76;

export const days = Object.freeze([
  { label: 'March equinox', date: 'Mar 20', ordinal: 79 },
  { label: 'June solstice', date: 'Jun 21', ordinal: 172 },
  { label: 'December solstice', date: 'Dec 21', ordinal: 355 },
]);

/** Local apparent solar time in minutes. Coordinates are +X east, +Y up, -Z north (sky/sun's axes). */
export function solarPosition(day, minute) {
  const sun = sunPath({ latitude: degrees(latitude), dayOfYear: day, hour: minute / 60 });
  const direction = sun.direction, up = direction[1];
  // The style's tip sits above the foot, toward north; its shadow lands where the sun's ray through it meets the dial.
  const tipHeight = styleLength * Math.sin(lat), northOfFoot = styleLength * Math.cos(lat);
  const shadow = up > 0
    ? [-tipHeight * direction[0] / up, -northOfFoot - tipHeight * direction[2] / up]
    : null;
  const bearing = (540 - sun.azimuth.degrees) % 360;
  return { direction, elevation: sun.elevation.degrees, azimuth: bearing, shadow };
}

/** Angle of the time line clockwise from true north on a horizontal polar-style dial. */
export function hourLine(minute) {
  const h = Math.PI * (minute - 720) / 720;
  return Math.atan2(Math.sin(lat) * Math.sin(h), Math.cos(h));
}
