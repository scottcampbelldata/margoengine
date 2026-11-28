// This demo's mechanism: its dimensions, and its pose from @margoengine/machinery/mechanisms.
import { epicyclicSpeeds } from '@margoengine/machinery/mechanisms';

export const teeth={sun:21,planet:18,ring:57};
export const moduleSize=.009;
export const pressureAngle=20*Math.PI/180;
export const orbitRadius=(teeth.sun+teeth.planet)*moduleSize/2;
export const assemblyAngles=[0,2*Math.PI/3,4*Math.PI/3];

/** The train with `held` still and the input member turned `degrees`. */
export function drivePose(degrees,held) {
  const turn=degrees*Math.PI/180;
  const known=held==='carrier'?{sun:turn,carrier:0}:held==='sun'?{ring:turn,sun:0}:{sun:turn,ring:0};
  return epicyclicSpeeds(teeth,known);
}
