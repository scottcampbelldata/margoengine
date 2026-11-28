import { airIndexTemperatureSlope } from '@margoengine/optics/imaging';

export const ambientIndex=1.000273;
export const ambientKelvin=293.15;
export const focusRun=.380;
export const focusOffset=.255;
export const focalLength=Math.hypot(focusRun,focusOffset);
export const sourceWidth=.000047;
// Deflection per unit of the line-of-sight temperature gradient of a Gaussian lobe (Gladstone-Dale dn/dT, Settles 2001).
export const derivativeGain=-airIndexTemperatureSlope(ambientIndex,ambientKelvin)*Math.sqrt(2*Math.PI)/ambientIndex;
export const bladeOut=-1;

// Positive Gaussian components with a wider, wandering core as the plume rises.
const lobes=[
  [32,.116,.0088,.081,0,.0107,57,2.23,.18,.045],
  [10,.151,.0047,.071,.0124,.017,72,2.91,2.31,.036],
  [8,.129,.0054,.062,-.0148,.016,81,2.7,4.20,.041],
];

export function components(y,time) {
  return lobes.map(([base,decay,radius,growth,drift,sway,frequency,speed,phase,gate],i)=>{
    const rise=1-Math.exp(-y/gate);
    const turn=y*frequency-time*speed+phase;
    return {
      sigma:radius+growth*y,
      center:rise*(drift+sway*Math.sin(turn)),
      temperature:base*Math.exp(-y/decay)*(.81+.19*Math.cos(turn*.74))*(i===0?1:rise),
    };
  });
}
// Emit the same constants for the closed-form gradient evaluated by the Margo material.
export function plumeWGSL() {
  const f=(value)=>value.toFixed(10);
  const mix=lobes.map((lobe,i)=>`sum+=lobe(x,y,t,${lobe.map(f).join(',')},${i===0?'1.0':'0.0'});`).join('\n  ');
  return `
fn lobe(x:f32,y:f32,t:f32,base:f32,decay:f32,rad:f32,growth:f32,drift:f32,sway:f32,
  freq:f32,speed:f32,phase:f32,gate:f32,root:f32)->f32 {
  let rise=1.0-exp(-y/gate);
  let turn=y*freq-t*speed+phase;
  let temperature=base*exp(-y/decay)*(.81+.19*cos(turn*.74))*mix(rise,1.0,root);
  let xi=(x-rise*(drift+sway*sin(turn)))/(rad+growth*y);
  return temperature*xi*exp(-.5*xi*xi);
}
fn imageTransmission(x:f32,y:f32,t:f32,cut:f32)->f32 {
  var sum=0.0;
  ${mix}
  return clamp(1.0-cut+${f(derivativeGain*focalLength/sourceWidth)}*sum,0.0,1.0);
}`;
}
