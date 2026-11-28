import {placeGeometry} from '@margoengine/geometry/builder';
import {chamferBoxGeometry,turnedGeometry} from '@margoengine/geometry/parts';
import {capsuleGeometry,sphereGeometry} from '@margoengine/geometry/primitives';
import {toGeometry} from '@margoengine/geometry/utils';
import {backdropGeometry} from '@margoengine/studio/backdrop';

// A rounded tray with chamfered top and bottom edges.
export const tray=(w,h,d,corner=.09,bevel=.017)=>
  toGeometry(chamferBoxGeometry(w,h,d,{chamfer:bevel,radius:corner,segments:4}));
// A turned part from [radius, height] pairs.
export const turned=(profile,segments=60)=>toGeometry(turnedGeometry(profile,{segments}));
export const sphere=(radius,segments=56,rings=30)=>toGeometry(sphereGeometry(radius,segments,rings));
// An emitter tube lies along X. Its dimensions describe cap centres and outer radius.
export const capsule=(radius,halfLength,segments=40)=>
  toGeometry(placeGeometry(capsuleGeometry(radius,halfLength*2,8,segments),{roll:-Math.PI/2}));
// The studio sweep: floor at y -0.09 from z 9 back to a 0.85 m bend into the wall at z -2.25.
export const cyclorama=()=>backdropGeometry({width:12,depth:11.25,height:5.09,radius:.85,segments:19});
export const cycloramaPosition=[0,-.09,3.375];
