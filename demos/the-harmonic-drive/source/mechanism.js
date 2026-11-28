// This demo's mechanism: its dimensions, its tooth shapes from @margoengine/machinery/mechanisms, and its motion from a stepped
// @margoengine/physics world (@margoengine/machinery/rigs), checked every step against the closed form.
import { flexsplinePoint, harmonicDriveRatio, waveGeneratorRadius } from '@margoengine/machinery/mechanisms';
import { harmonicDriveRig, openRig } from '@margoengine/machinery/rigs';

export const tau = Math.PI * 2;
export const flexTeeth = 60;
export const fixedTeeth = 62;
const spec = {flexTeeth, circularTeeth:fixedTeeth};
export const reduction = harmonicDriveRatio(spec);
export const major = .220;
export const minor = .197;
export const nominalRadius = (major + minor) / 2;
export const flexToothDepth = .007;
export const fixedRootRadius = .232;
export const fixedToothDepth = .0096;
/** Tooth height at eight points across a tooth pitch: the drawn tooth shape. */
const toothHeightSamples = [1,1,.47,0,0,0,.47,1];

/** Builds the drive on the solver at `turns` of the wave generator; `signal` disposes it. */
export const openDrive = (turns, signal) => openRig(harmonicDriveRig, spec, {angle: turns * tau, signal});

export const ellipseRadius = (offset, a=major, b=minor) => waveGeneratorRadius(offset, a, b);

export function bend(materialAngle, input, output, strength=1) {
  return flexsplinePoint(materialAngle, input, output, {...spec, major, minor, strength});
}

export function toothProfile(theta,count,phase=0) {
  const tooth=(theta/tau*count+phase)*toothHeightSamples.length;
  const start=Math.floor(tooth+1e-10),index=(start%8+8)%8;
  const blend=tooth-start;
  return toothHeightSamples[index]+blend*(toothHeightSamples[(index+1)%8]-toothHeightSamples[index]);
}
