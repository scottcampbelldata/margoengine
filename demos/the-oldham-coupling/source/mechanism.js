// This demo's mechanism: its dimensions, and its motion from a stepped @margoengine/physics world
// (@margoengine/machinery/rigs), checked every step against the closed form of @margoengine/machinery/mechanisms.
import { keyedRig, loadRigs, oldhamRig } from '@margoengine/machinery/rigs';

export const maxOffset=.104;
export const hubRadius=.139;
export const tongueHalfLength=.088;
export const tongueHalfWidth=.015;
export const grooveHalfWidth=.0164;

/** Loads the solver; the rig is remade when the shaft offset (the key, in metres) changes; `signal` disposes it. */
export const openCoupling=(signal)=>loadRigs().then(()=>keyedRig((offset,angle)=>oldhamRig(offset,{angle}),{signal}));
