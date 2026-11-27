const radians=Math.PI/180;
export const rosettes=[
  {lobes:6,amplitude:.015,overtone:.0028},
  {lobes:9,amplitude:.0125,overtone:.0022},
];
export const camRadius=.198;
export const toolX=.125;

export function modulation(rosette,angle) {
  return rosette.amplitude*Math.cos(rosette.lobes*angle)+rosette.overtone*Math.cos(2*rosette.lobes*angle);
}

export function cutAt(rosette,angle,baseRadius=toolX) {
  const radius=baseRadius+modulation(rosette,angle);
  return [radius*Math.cos(angle),radius*Math.sin(angle)];
}

export function spindlePose(degrees,rosette) {
  const angle=degrees*radians,contactAngle=-angle;
  const shift=-modulation(rosette,contactAngle);
  return {angle,shift,contactAngle,cut:cutAt(rosette,contactAngle),period:360/rosette.lobes};
}
