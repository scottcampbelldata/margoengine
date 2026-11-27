export const ringRadius=.049;
export const initialCore=.0036;
export const viscosity=1.2e-6;
export const startY=.123;
export const trackLength=.172;
export const minimumCirculation=18;
export const maximumCirculation=33;
export const playback=.65;

const diffusion=4*viscosity;
const variance=initialCore**2;
const offset=Math.log(8*ringRadius/initialCore)-.558;

export function coreAt(age){
  return Math.sqrt(variance+diffusion*age);
}

export function speedAt(model,age){
  return model.factor*(offset-.5*Math.log1p(diffusion*age/variance));
}

export function riseAt(model,age){
  const growth=diffusion*age/variance;
  const integratedLog=variance/diffusion*((1+growth)*Math.log1p(growth)-growth);
  return model.factor*(offset*age-.5*integratedLog);
}

export function prepare(input){
  const circulation=Math.max(minimumCirculation,Math.min(maximumCirculation,input));
  const gamma=circulation*1e-4;
  const model={circulation,gamma,factor:gamma/(4*Math.PI*ringRadius)};
  let a=0,b=21;
  for(let i=0;i<32;i++){
    const t=(a+b)*.5;
    if(riseAt(model,t)<trackLength)a=t;
    else b=t;
  }
  return {...model,duration:(a+b)*.5};
}

export function spinAt(model,s,age){
  const count=12;
  const radius2=s*s;
  const sample=t=>-Math.expm1(-radius2/(variance+diffusion*t));
  let sum=sample(0)+sample(age);
  for(let i=1;i<count;i++)sum+=(i%2?4:2)*sample(age*i/count);
  return model.gamma*sum*age/(6*Math.PI*radius2*count);
}
