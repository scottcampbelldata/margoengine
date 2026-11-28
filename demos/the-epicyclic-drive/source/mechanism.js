export const teeth={sun:21,planet:18,ring:57};
export const moduleSize=.009;
export const pressureAngle=20*Math.PI/180;
export const orbitRadius=(teeth.sun+teeth.planet)*moduleSize/2;
export const assemblyAngles=[0,2*Math.PI/3,4*Math.PI/3];
const radians=Math.PI/180;

export function drivePose(degrees,held) {
  const turn=degrees*radians;
  const sum=teeth.sun+teeth.ring;
  let sun=turn,ring=0,carrier=0;
  if(held==='carrier') ring=-turn*teeth.sun/teeth.ring;
  else if(held==='sun') {
    sun=0;
    ring=turn;
    carrier=turn*teeth.ring/sum;
  } else carrier=turn*teeth.sun/sum;
  const planet=carrier-(sun-carrier)*teeth.sun/teeth.planet;
  return {sun,ring,carrier,planet};
}
