// This demo's mechanism: its dimensions, and its motion from a stepped @margoengine/physics world
// (@margoengine/machinery/rigs), checked every step against the closed form of @margoengine/machinery/mechanisms.
import { loadRigs, oldhamRig, describeCheck } from '@margoengine/machinery/rigs';

export const maxOffset=.104;
export const hubRadius=.139;
export const tongueHalfLength=.088;
export const tongueHalfWidth=.015;
export const grooveHalfWidth=.0164;

/** Loads the solver; the returned function turns the input `degrees` with the shafts `offset` metres apart and reads the coupling. */
export async function openCoupling() {
  await loadRigs();
  let rig=null,rigOffset=-1;
  return {
    pose(degrees,offset) {
      const angle=degrees*Math.PI/180;
      if(offset!==rigOffset) { rig?.dispose(); rig=oldhamRig(offset,{angle}); rigOffset=offset; }
      const pose=rig.drive(angle,false);
      return {inputAngle:pose.input,outputAngle:pose.output,diskAngle:pose.disc,center:pose.center,
        orbitCenter:[offset/2,0],orbitRadius:offset/2,inputSlide:pose.inputSlide,outputSlide:pose.outputSlide,
        check:describeCheck(rig.check)};
    },
    dispose:()=>rig?.dispose(),
  };
}
