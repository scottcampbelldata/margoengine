// This demo's mechanism: its dimensions, and its motion from a stepped @margoengine/physics world
// (@margoengine/machinery/rigs), checked every step against the closed form of @margoengine/machinery/mechanisms.
import { genevaCrankRadius } from '@margoengine/machinery/mechanisms';
import { openRig, genevaRig } from '@margoengine/machinery/rigs';

const radians=Math.PI/180;
const slots=4;
export const centerDistance=.320;
export const crankRadius=genevaCrankRadius(slots,centerDistance);
export const rollerRadius=.012;
/** The slider's crank angle (0 to 360 degrees) puts mid-stroke at 195 degrees. */
const midStroke=195;

/** Builds the drive on the solver at `degrees`; `signal` disposes it. */
export const openDrive=(degrees,signal)=>openRig(genevaRig,{slots,centerDistance,angle:(degrees-midStroke)*radians,signal});
/** The crank angle of a slider value. */
export const crankAngle=(degrees)=>(degrees-midStroke)*radians;
