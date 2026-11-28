// This demo's mechanism: its dimensions, and its pose from @margoengine/machinery/mechanisms.
import { sarrusPose } from '@margoengine/machinery/mechanisms';

export const armLength = .800;
export const baseHeight = .252;
export const apertureRadius = .085;
export const datumRadius = .012;
export const limits = {min:16,max:73};

export const families = [
  {pivot:[-.772,baseHeight,-.172], axis:[0,0,1], outward:[-1,0,0], spread:.632},
  {pivot:[.195,baseHeight,.646], axis:[1,0,0], outward:[0,0,1], spread:.633},
];

export function positionAt(degrees) {
  const angle = degrees * Math.PI/180;
  const {reach,rise,height,fromVertical} = sarrusPose(angle, armLength);
  const joints = families.map(({pivot,outward})=>({
    base:pivot,
    knee:[pivot[0]+outward[0]*reach,pivot[1]+rise,pivot[2]+outward[2]*reach],
    deck:[pivot[0],pivot[1]+height,pivot[2]],
  }));
  const x = joints[1].deck[0]-families[1].pivot[0];
  const z = joints[0].deck[2]-families[0].pivot[2];
  return {height, center:[x,baseHeight+height,z], offset:Math.hypot(x,z), jointAngle:fromVertical, joints};
}
