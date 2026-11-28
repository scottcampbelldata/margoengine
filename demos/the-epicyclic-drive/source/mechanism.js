// This demo's mechanism: its dimensions, and its motion from a stepped @margoengine/physics world
// (@margoengine/machinery/rigs), checked every step against Willis's relation in @margoengine/machinery/mechanisms.
import { loadRigs, epicyclicRig, describeCheck } from '@margoengine/machinery/rigs';

export const teeth={sun:21,planet:18,ring:57};
export const moduleSize=.009;
export const pressureAngle=20*Math.PI/180;
export const orbitRadius=(teeth.sun+teeth.planet)*moduleSize/2;
export const assemblyAngles=[0,2*Math.PI/3,4*Math.PI/3];

/** Loads the solver; the returned function turns the input member `degrees` with `held` still and reads the train. */
export async function openTrain() {
  await loadRigs();
  let rig=null,rigHeld=null;
  return {
    pose(degrees,held) {
      const turn=degrees*Math.PI/180;
      if(held!==rigHeld) { rig?.dispose(); rig=epicyclicRig(teeth,{held,angle:turn}); rigHeld=held; }
      return {...rig.drive(turn,false),check:describeCheck(rig.check)};
    },
    dispose:()=>rig?.dispose(),
  };
}
