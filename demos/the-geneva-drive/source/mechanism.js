// This demo's mechanism: its dimensions, and its motion from a stepped @margoengine/physics world
// (@margoengine/machinery/rigs), checked every step against the closed form of @margoengine/machinery/mechanisms.
import { genevaCrankRadius } from '@margoengine/machinery/mechanisms';
import { loadRigs, genevaRig, describeCheck } from '@margoengine/machinery/rigs';

const radians=Math.PI/180;
const slots=4;
export const centerDistance=.320;
export const crankRadius=genevaCrankRadius(slots,centerDistance);
export const rollerRadius=.012;
/** The slider's crank angle (0 to 360 degrees) puts mid-stroke at 195 degrees. */
const midStroke=195;

/** Builds the drive on the solver at `degrees`; the returned function turns the crank and reads the wheel. */
export async function openDrive(degrees) {
  await loadRigs();
  const rig=genevaRig({slots,centerDistance,angle:(degrees-midStroke)*radians});
  return {
    pose(value) {
      const driver=(value-midStroke)*radians,{wheel,indexing}=rig.drive(driver);
      // The wheel keeps count over many turns; whole crank turns are whole slot pitches, which look the same.
      const turns=Math.round((rig.input-driver)/(2*Math.PI));
      return {driver,wheel:wheel+turns*2*Math.PI/slots,indexing,check:describeCheck(rig.check)};
    },
    dispose:()=>rig.dispose(),
  };
}
