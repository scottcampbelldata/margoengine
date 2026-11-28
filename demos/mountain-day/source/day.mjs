import { blend } from './relief.mjs';

export const duration = 40;
export const startHour = 4.8;
export const beats = [
  { label: 'Dawn', second: 3.02 },
  { label: 'Cumulus', second: 15.3 },
  { label: 'Sunset', second: 21.6 },
  { label: 'Stars', second: 31.3 },
];

const rad = Math.PI / 180;
const latitude = 44.4 * rad;
const declination = 0;
export const localHour = second => startHour + 24 * second / duration;

export function conditions(second) {
  const hours = localHour(second);
  const day = hours % 24;
  const hourAngle = (hours - 12) * 15 * rad;
  const sun = [
    Math.cos(latitude) * Math.sin(declination) - Math.sin(latitude) * Math.cos(declination) * Math.cos(hourAngle),
    Math.sin(latitude) * Math.sin(declination) + Math.cos(latitude) * Math.cos(declination) * Math.cos(hourAngle),
    -Math.cos(declination) * Math.sin(hourAngle),
  ];
  const elevation = Math.asin(sun[1]) / rad;
  const buildup = blend(7.1,14.1,day) * (1 - blend(15.8,18.8,day));
  const morningVeil = .09 * blend(4.8,6.7,day) * (1 - blend(6.7,9,day));
  const eveningVeil = .30 * blend(15.5,17.6,day) * (1 - blend(18.1,20,day));
  const clouds = morningVeil + .51 * buildup + eveningVeil;
  const stars = 1 - blend(-18,-6,elevation);
  const label = day > 19.25 || day < 4.9 ? 'Night'
    : day < 7.15 ? 'Dawn'
    : day < 10.3 ? 'Morning'
    : day < 15.5 ? 'Clouds building'
    : day < 17.1 ? 'Afternoon'
    : 'Sunset';
  return {
    sun, elevation, clouds, buildup, stars, label,
    minutes: Math.floor(hours * 60 + .0001) % 1440,
    flight: blend(0, 1, second / duration),
  };
}