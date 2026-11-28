// This demo's mechanism: its dimensions, and its motion from a stepped @margoengine/physics world
// (@margoengine/machinery/rigs), checked every step against the closed form of @margoengine/machinery/mechanisms.
import { loadRigs, scotchYokeRig, describeCheck } from '@margoengine/machinery/rigs';

export const crankRadius=.142;
export const rollerRadius=.019;
export const slotHalfWidth=.021;
export const slotHalfHeight=.168;
export const slotEndRadius=.021;

/** Builds the yoke on the solver at `degrees`; the returned function turns the crank and reads the bodies. */
export async function openYoke(degrees) {
  await loadRigs();
  const rig=scotchYokeRig(crankRadius,{angle:degrees*Math.PI/180});
  return {
    pose(value) {
      const {angle,slide,slot}=rig.drive(value*Math.PI/180);
      return {angle,x:slide,y:slot,check:describeCheck(rig.check)};
    },
    dispose:()=>rig.dispose(),
  };
}
