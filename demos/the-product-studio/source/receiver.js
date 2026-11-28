import {createMesh,ShadowCatcherMaterial} from '@margoengine/materials';
import {Shadows} from '@margoengine/shadows';

const floorY=.002;
const canvasPoint=[.25,floorY,-.28];

function plane(){
  const [x,y,z]=canvasPoint,w=2.37,h=2.12;
  return {positions:[x-w,y,z-h,x+w,y,z-h,x+w,y,z+h,x-w,y,z+h],
    normals:[0,1,0,0,1,0,0,1,0,0,1,0],indices:[0,2,1,0,3,2]};
}
export function previewCatcher(engine,product){
  const shadows=Shadows.attach(engine,{resolution:512,bounds:{min:[-2.5,-.018,-2.35],max:[2.5,1.64,1.60]},
    filter:'soft',lightSize:.24,samples:18,blockerSamples:10,jitter:false});
  const catcher=new ShadowCatcherMaterial({color:'#161a20',opacity:0});
  const floor=createMesh(engine,plane(),catcher);
  floor.root.name='SM_ShadowReceiver';
  shadows.add(floor,{castShadow:false});
  for(const part of product)shadows.add(part,{static:true,receiveShadow:false});
  return catcher;
}
