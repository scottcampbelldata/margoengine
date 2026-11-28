// The bellows' board outline and handle stroke. The chamber's volume and the air through its two check valves come
// from @margoengine/physics/hydraulics (`hingedBellows`, the exact ruled volume between two hinged boards).
import { hingedBellows } from '@margoengine/physics/hydraulics';

const curves = [
  [[.012,0],[.001,.023],[.067,.036],[.108,.052]],
  [[.108,.052],[.142,.067],[.193,.132],[.265,.131]],
  [[.265,.131],[.346,.135],[.405,.069],[.405,0]],
];

function bezier(points,t) {
  const a=1-t;
  return [0,1].map(i=>a**3*points[0][i]+3*a*a*t*points[1][i]+3*a*t*t*points[2][i]+t**3*points[3][i]);
}

const half = curves.flatMap(points=>Array.from({length:13},(_,i)=>bezier(points,i/13)));
half.push(curves.at(-1).at(-1));
export const flange = [...half,...half.slice(1,-1).reverse().map(([x,z])=>[x,-z])];
export const gap = .034;
export const lo = .065;
export const hi = .575;
export const intake = [.251,0,-.016];
export const nozzle = [-.228,.045,0];

const bellows = hingedBellows({ outline: flange, gap });
export const area = bellows.area;
export const firstMoment = bellows.firstMoment;
export const angleAt = (lift) => lo+(hi-lo)*Math.max(0,Math.min(1,lift));
export const volume = (angle) => bellows.volume(angle);
export const strokeCapacity = 1000*(volume(hi)-volume(lo));

/** The chamber at handle lift `lift` (0 to 1) moving at `perSecond` lifts per second, in litres and L/s. */
export function response(lift, perSecond) {
  const angle = angleAt(lift);
  const air = bellows.flow(angle, (hi-lo)*perSecond);
  return {
    angle,
    liters:1000*air.volume,
    intake:1000*air.intake,
    outlet:1000*air.outlet,
  };
}

const smooth = (value) => value*value*(3-2*value);
const rate = (value) => 6*value*(1-value);
export const pumpDuration = 2.45;
export function cycle(start, time) {
  const elapsed = Math.max(0,time);
  if(elapsed<1.19) {
    const phase=elapsed/1.19;
    return {lift:start+(1-start)*smooth(phase), speed:(1-start)*rate(phase)/1.19};
  }
  if(elapsed<1.32) return {lift:1,speed:0};
  if(elapsed<pumpDuration) {
    const phase=(elapsed-1.32)/(pumpDuration-1.32);
    return {lift:1-smooth(phase),speed:-rate(phase)/(pumpDuration-1.32)};
  }
  return {lift:0,speed:0};
}