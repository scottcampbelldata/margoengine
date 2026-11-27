export const density = 998.2;
export const gravity = 9.80665;
export const feedHead = .27;
export const wideRadius = .0265;
export const throatRadius = .013;
export const axisHeight = .141;
export const inletX = -.48;
export const exitX = .48;
export const taps = [-.327,-.019];
const area = radius=>Math.PI*radius**2;
const smooth = t=>t*t*(3-2*t);

export function radiusAt(x) {
  if(x < -.246 || x > .388) return wideRadius;
  if(x < -.108) return wideRadius + (throatRadius-wideRadius)*smooth((x+.246)/.138);
  if(x <= .085) return throatRadius;
  return throatRadius+(wideRadius-throatRadius)*smooth((x-.085)/.303);
}

export function readFlow(value) {
  const literRate = Math.max(0,Math.min(50,value));
  const volumeRate = literRate/60000;
  const inletSpeed = volumeRate/area(wideRadius);
  const throatSpeed = volumeRate/area(throatRadius);
  const pressureDrop = density*(throatSpeed**2-inletSpeed**2)/2;
  const dropHead = pressureDrop/(density*gravity);
  return {
    literRate,volumeRate,inletSpeed,throatSpeed,pressureDrop,dropHead,
    inletHead:feedHead,
    throatHead:feedHead-dropHead,
  };
}

const steps=640;
const dx=(exitX-inletX)/steps;
const passage=Array.from({length:steps+1},(_,i)=>area(radiusAt(inletX+i*dx)));
const table=new Float64Array(steps+1);
for(let i=1;i<=steps;i++)table[i]=table[i-1]+dx*(passage[i-1]+passage[i])/2;
export const internalVolume=table[steps];

export function tracerAt(volume) {
  const target=(volume%internalVolume+internalVolume)%internalVolume;
  let left=0,right=steps;
  while(right-left>1){
    const mid=(right+left)>>1;
    if(table[mid]<=target)left=mid;
    else right=mid;
  }
  // Integrate the local linear area profile and invert the resulting quadratic.
  const scaled=(target-table[left])/dx;
  const a=passage[left];
  const delta=passage[right]-a;
  const local=2*scaled/(a+Math.sqrt(a*a+2*delta*scaled));
  return inletX+dx*(left+local);
}