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

let sum = 0;
let first = 0;
for(const [i,[x,z]] of flange.entries()) {
  const [a,b] = flange[(i+1)%flange.length];
  const cross = x*b-a*z;
  sum += cross;
  first += (x+a)*cross;
}
export const area = Math.abs(sum*.5);
export const firstMoment = Math.abs(first/6);
export const angleAt = (lift) => lo+(hi-lo)*Math.max(0,Math.min(1,lift));
export const volume = (angle) => area*gap*(1+Math.cos(angle))/2+firstMoment*Math.sin(angle);
export const strokeCapacity = 1000*(volume(hi)-volume(lo));

export function response(lift, perSecond) {
  const angle = angleAt(lift);
  const delta = (firstMoment*Math.cos(angle)-area*gap*Math.sin(angle)/2)*(hi-lo)*perSecond;
  return {
    angle,
    liters:1000*volume(angle),
    intake:1000*Math.max(0,delta),
    outlet:1000*Math.max(0,-delta),
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