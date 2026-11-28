import { centerDistance, crankRadius, rollerRadius } from './mechanism.js';

const tau=Math.PI*2;
const quarter=Math.PI/2;
const lockRadius=.161;
const pocketRadius=.163;
const slotHalf=rollerRadius+.00155;
const slotSeat=centerDistance-crankRadius-.0005;
const rim=crankRadius+.0005;
const polar=(r,t)=>[r*Math.cos(t),r*Math.sin(t)];
const rotated=([x,y],a)=>[x*Math.cos(a)-y*Math.sin(a),x*Math.sin(a)+y*Math.cos(a)];
const plus=(a,b)=>a.map((v,i)=>v+b[i]);

function arc(radius,start,end,steps,origin=[0,0]) {
  return Array.from({length:steps+1},(_,i)=>plus(origin,polar(radius,start+(end-start)*i/steps)));
}

/** One continuous face. Each scallop is an arc centered on the other shaft in dwell. */
export function wheelOutline() {
  const limit=Math.PI/4-Math.asin(slotHalf/rim);
  const cut=Math.acos((rim**2+centerDistance**2-pocketRadius**2)/(2*rim*centerDistance));
  const angle=Math.atan2(rim*Math.sin(cut),centerDistance-rim*Math.cos(cut));
  const branch=[
    ...arc(rim,-limit,-cut,8),
    ...arc(pocketRadius,Math.PI+angle,Math.PI-angle,22,[centerDistance,0]).slice(1),
    ...arc(rim,cut,limit,8).slice(1),
    ...arc(slotHalf,-Math.PI/2,-Math.PI*1.5,16,[slotSeat,0]).map((p)=>rotated(p,Math.PI/4)),
  ];
  return Array.from({length:4},(_,i)=>branch.map((point)=>rotated(point,i*quarter))).flat();
}

export function camOutline() {
  const relief=lockRadius+.0009;
  const meet=Math.acos((crankRadius**2+lockRadius**2-relief**2)/(2*crankRadius*lockRadius));
  const bearing=Math.atan2(lockRadius*Math.sin(meet),crankRadius-lockRadius*Math.cos(meet));
  return [
    ...arc(lockRadius,meet,tau-meet,72),
    ...arc(relief,Math.PI+bearing,Math.PI-bearing,25,[crankRadius,0]).slice(1,-1),
  ];
}

