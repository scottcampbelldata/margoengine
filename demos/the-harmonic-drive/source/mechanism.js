export const tau = Math.PI * 2;
export const flexTeeth = 60;
export const fixedTeeth = 62;
export const reduction = (flexTeeth - fixedTeeth) / flexTeeth;
export const major = .220;
export const minor = .197;
export const nominalRadius = (major + minor) / 2;
export const flexToothDepth = .007;
export const fixedRootRadius = .232;
export const fixedToothDepth = .0096;
const toothHeightSamples = [1,1,.47,0,0,0,.47,1];

export function pose(turns) {
  return {input: turns * tau, output: turns * reduction * tau};
}

export function ellipseRadius(offset, a=major, b=minor) {
  return a*b / Math.hypot(b*Math.cos(offset),a*Math.sin(offset));
}

export function bend(materialAngle, input, output, strength=1) {
  const angle=materialAngle+output;
  const delta=angle-input;
  const local=delta-Math.PI*Math.round(delta/Math.PI);
  const blend=Math.min(1,Math.max(0,(Math.abs(local)-.44)/.86));
  const taper=1-blend*blend*(3-2*blend);
  const fixedPitch=angle-strength*taper*local*(1-flexTeeth/fixedTeeth);
  return {angle:fixedPitch, offset:ellipseRadius(fixedPitch-input)-nominalRadius};
}

export function toothProfile(theta,count,phase=0) {
  const tooth=(theta/tau*count+phase)*toothHeightSamples.length;
  const start=Math.floor(tooth+1e-10),index=(start%8+8)%8;
  const blend=tooth-start;
  return toothHeightSamples[index]+blend*(toothHeightSamples[(index+1)%8]-toothHeightSamples[index]);
}
