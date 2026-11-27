export const crankRadius=.142;
export const rollerRadius=.019;
export const slotHalfWidth=.021;
export const slotHalfHeight=.168;
export const slotEndRadius=.021;
const radians=Math.PI/180;

export function yokePose(degrees) {
  const angle=degrees*radians;
  return {angle,x:crankRadius*Math.cos(angle),y:crankRadius*Math.sin(angle)};
}
