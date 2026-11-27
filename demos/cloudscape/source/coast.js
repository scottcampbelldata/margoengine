import {PbrMaterial as CoreMaterial,box} from '@margoengine/core';
import {PbrMaterial,createMesh} from '@margoengine/materials';

import {span,heightAt,colorAt} from './coast-field.mjs';
const side=145,pitch=span/(side-1);
export function installCoast(engine){
  const verts=side*side;
  const positions=new Float32Array(verts*3),normals=new Float32Array(verts*3),colors=new Float32Array(verts*3),
    levels=new Float32Array(verts);
  for(let j=0;j<side;j++)for(let i=0;i<side;i++){
    const x=i*pitch-span/2,z=j*pitch-span/2,k=j*side+i;
    const h=heightAt(x,z);
    levels[k]=h;
    positions.set([x,Math.max(0,h)-.3,z],3*k);
  }
  const at=(i,j)=>positions[3*(Math.max(0,Math.min(side-1,j))*side+Math.max(0,Math.min(side-1,i)))+1];
  for(let j=0;j<side;j++)for(let i=0;i<side;i++){
    const k=j*side+i,dx=(at(i+1,j)-at(i-1,j))/(2*pitch),dz=(at(i,j+1)-at(i,j-1))/(2*pitch),
      scale=Math.hypot(dx,1,dz);
    const x=positions[k*3],z=positions[k*3+2];
    normals.set([-dx/scale,1/scale,-dz/scale],3*k);
    colors.set(colorAt(levels[k],x,z,Math.hypot(dx,dz)),3*k);
  }
  const indices=new Uint32Array((side-1)**2*6);
  for(let j=1,i=0;j<side;j++)for(let k=1;k<side;k++,i+=6){
    const d=j*side+k,c=d-1,b=d-side,a=b-1;
    indices.set((k^j)&1?[a,c,b,c,d,b]:[a,c,d,a,d,b],i);
  }
  const surface=new PbrMaterial({color:[1,1,1],roughness:.81,metalness:.018});
  const shore=createMesh(engine,{positions,normals,indices,colors},surface);
  const ocean=engine.createMesh().setGeometry(box(85000,1,85000))
    .setPosition([0,-1.3,0]).setMaterial(new CoreMaterial({color:[.02217,.07421,.12214],roughness:.79,metalness:.022}));
  return [shore,ocean];
}
