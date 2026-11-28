// The flume's dimensions. The jump itself (Belanger's conjugate depth, the Froude numbers, the energy lost and
// Hager's roller length) comes from @margoengine/physics/hydraulics.
import { hydraulicJump } from '@margoengine/physics/hydraulics';

export const gravity=9.80665;
export const width=.28;
export const upstreamDepth=.028;
export const bed=.263;
export const minimumSpeed=2.4;
export const maximumSpeed=3.9;
export const jumpToe=-.504;
export const inlet=-1.414;
export const outlet=1.355;

export function solve(input){
  const speed=Math.max(minimumSpeed,Math.min(maximumSpeed,input));
  const jump=hydraulicJump({upstreamDepth,upstreamSpeed:speed,width,gravity});
  return {
    speed,f1:jump.upstreamFroude,downstreamDepth:jump.downstreamDepth,downstreamSpeed:jump.downstreamSpeed,
    f2:jump.downstreamFroude,discharge:jump.discharge,head:jump.upstreamEnergy,loss:jump.headLoss,
    dissipation:jump.relativeLoss,depthRise:jump.height,roller:jump.rollerLength,end:jumpToe+jump.rollerLength,
  };
}
