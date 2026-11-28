export const linkLength=.231;
export const pivotY=.767;
export const openAngle=52, stopAngle=8;
const radians=Math.PI/180;
export const openOffset=linkLength*Math.sin(openAngle*radians);
export const stopOffset=linkLength*Math.sin(stopAngle*radians);
export const kneeTravel=openOffset-stopOffset;
const initialHeight=Math.sqrt(linkLength*linkLength-openOffset*openOffset);

export function pressPose(progress) {
  const input=kneeTravel*progress;
  const kneeX=openOffset-input;
  const h=Math.sqrt(linkLength*linkLength-kneeX*kneeX);
  return {input,kneeX,kneeY:pivotY-h,ramY:pivotY-2*h,
    angle:Math.asin(kneeX/linkLength)/radians,
    descent:2*(h-initialHeight),advantage:h/(2*kneeX)};
}
