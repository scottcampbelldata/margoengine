// This demo's mechanism: its dimensions, and its motion from a stepped @margoengine/physics world
// (@margoengine/machinery/rigs), checked every step against the closed form of @margoengine/machinery/mechanisms.
import { openRig, scotchYokeRig } from '@margoengine/machinery/rigs';

export const crankRadius=.142;
export const rollerRadius=.019;
export const slotHalfWidth=.021;
export const slotHalfHeight=.168;
export const slotEndRadius=.021;

/** Builds the yoke on the solver at `degrees`; `signal` disposes it. */
export const openYoke=(degrees,signal)=>openRig(scotchYokeRig,crankRadius,{angle:degrees*Math.PI/180,signal});
