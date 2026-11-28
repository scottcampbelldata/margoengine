import { parseIES, iesCandela } from '@margoengine/clustered/ies';
import { candelaToLux, lumensToCandela } from '@margoengine/clustered/units';
import narrowRaw from './profiles/narrow.ies?raw';
import wideRaw from './profiles/wide.ies?raw';

export const both = [parseIES(narrowRaw),parseIES(wideRaw)];
export const equalOutput = 3000;
export const sourceHeight=1.55;
export const lowerOffset=.75;
const deg = 180/Math.PI;

export function peakAt(profile, mode) {
  return mode==='lab'?profile.peak:lumensToCandela(equalOutput,profile);
}

export function wallLux(profile,mode,distance,x,y) {
  const length=Math.hypot(x,y,distance);
  const theta=Math.atan2(Math.hypot(x,y),distance)*deg;
  const phi=(Math.atan2(y,x)*deg+360)%360;
  const candela=iesCandela(profile,theta,phi)*peakAt(profile,mode)/profile.peak;
  return candelaToLux(candela,length)*(distance/length);
}

export function readings(distance,mode) {
  return both.map(profile=>({
    center:wallLux(profile,mode,distance,0,0),
    lower:wallLux(profile,mode,distance,0,-lowerOffset),
    peak:peakAt(profile,mode),
    flux:mode==='lab'?profile.flux:equalOutput,
  }));
}
