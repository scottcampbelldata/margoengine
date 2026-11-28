const gravity=9.80665;
export const minRpm=58,maxRpm=112;
export const ballArm=.292;
export const pickoff=.198;
export const linkLength=.232;
export const pivotHeight=.705;
const tau=2*Math.PI;

function geometry(rpm) {
  const omega=rpm*tau/60;
  const height=gravity/(omega*omega);
  const theta=Math.acos(Math.min(1,height/ballArm));
  const radial=Math.sin(theta);
  const vertical=Math.cos(theta);
  const jointRadius=pickoff*radial;
  const jointY=pivotHeight-pickoff*vertical;
  const sleeveY=jointY-Math.sqrt(linkLength*linkLength-jointRadius*jointRadius);
  return {theta,ballX:ballArm*radial,ballY:pivotHeight-ballArm*vertical,jointRadius,jointY,sleeveY};
}

export const lowSleeve=geometry(minRpm).sleeveY;
export const highSleeve=geometry(maxRpm).sleeveY;
export const rackPitchRadius=(highSleeve-lowSleeve)/(Math.PI*.5);

export function governorPose(rpm) {
  const pose=geometry(rpm);
  const travel=pose.sleeveY-lowSleeve;
  const valveAngle=travel/rackPitchRadius;
  return {...pose,travel,valveAngle,opening:1-Math.sin(valveAngle)};
}
