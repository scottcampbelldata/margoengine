// This demo's mechanism: its dimensions, and its pose from @margoengine/machinery/mechanisms.
import { genevaCrankRadius, genevaPose as solve } from '@margoengine/machinery/mechanisms';

const radians=Math.PI/180;
export const centerDistance=.320;
export const crankRadius=genevaCrankRadius(4,centerDistance);
export const rollerRadius=.012;
/** The slider's crank angle (0 to 360 degrees) puts mid-stroke at 195 degrees. */
const midStroke=195;

export function genevaPose(degrees) {
  const driver=(degrees-midStroke)*radians;
  const {wheel,indexing}=solve(driver,{slots:4,centerDistance});
  return {driver,wheel,indexing};
}
