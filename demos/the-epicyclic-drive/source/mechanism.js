// This demo's mechanism: its dimensions, and its motion from a stepped @margoengine/physics world
// (@margoengine/machinery/rigs), checked every step against Willis's relation in @margoengine/machinery/mechanisms.
import { epicyclicRig, keyedRig, loadRigs } from '@margoengine/machinery/rigs';

export const teeth={sun:21,planet:18,ring:57};
export const moduleSize=.009;
export const pressureAngle=20*Math.PI/180;
export const orbitRadius=(teeth.sun+teeth.planet)*moduleSize/2;
export const assemblyAngles=[0,2*Math.PI/3,4*Math.PI/3];

/** Loads the solver; the train is remade when the held member (the key) changes; `signal` disposes it. */
export const openTrain=(signal)=>loadRigs().then(()=>keyedRig((held,angle)=>epicyclicRig(teeth,{held,angle}),{signal}));
