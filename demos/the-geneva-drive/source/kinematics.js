const radians=Math.PI/180;
export const centerDistance=.320;
export const crankRadius=centerDistance*Math.sin(Math.PI/4);
export const rollerRadius=.012;
export const entry=150;
export const exit=240;
export const center=(entry+exit)/2;

/** Ideal centerline tracking for an external four-slot Geneva. */
export function genevaPose(degrees) {
  const driver=(degrees-center)*radians;
  if(degrees<=entry) return {driver,wheel:0,indexing:false};
  if(degrees>=exit) return {driver,wheel:-Math.PI/2,indexing:false};
  const x=centerDistance-crankRadius*Math.cos(driver);
  const y=crankRadius*Math.sin(driver);
  return {driver,wheel:-Math.PI/4-Math.atan2(y,x),indexing:true};
}
