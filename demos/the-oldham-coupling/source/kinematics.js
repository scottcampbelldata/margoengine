const radians=Math.PI/180;
export const maxOffset=.104;
export const hubRadius=.139;
export const tongueHalfLength=.088;
export const tongueHalfWidth=.015;
export const grooveHalfWidth=.0164;

export function couplingPose(degrees,offset) {
  const angle=degrees*radians;
  const c=Math.cos(angle),s=Math.sin(angle);
  // In the transverse plane the input center is (0,0) and the output center is (d,0).
  // Project the distance between them onto the rotating input slot.
  return {
    inputAngle:angle,
    outputAngle:angle,
    diskAngle:angle,
    center:[offset*c*c,offset*c*s],
    orbitCenter:[offset*.5,0],
    orbitRadius:offset*.5,
    inputSlide:offset*c,
    outputSlide:offset*s,
  };
}
