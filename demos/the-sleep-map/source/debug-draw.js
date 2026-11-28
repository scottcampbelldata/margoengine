import {Geometry,PbrMaterial} from '@margoengine/core';
import {radius} from './layout.js';

const lifts=[radius*1.24,radius*1.06];
const radii=[.0012,.0017];
const colors=['#8ce3d2','#ffc68c'];
const normal=[0,1,0];

export function attachDebug(engine){
  const meshes=colors.map(color=>engine.createMesh().setMaterial(new PbrMaterial({
    color,roughness:.79,metalness:0,doubleSided:true,
  })));
  return data=>{
    if(!data?.vertices.length){
      for(const mesh of meshes)mesh.visible=false;
      return;
    }
    const {vertices,colors}=data;
    const buckets=meshes.map(()=>({positions:[],normals:[],indices:[]}));
    for(let i=0;i<vertices.length;i+=6){
      const [x,y,z,X,Y,Z]=vertices.subarray(i,i+6);
      const bucket=colors[i/3*4]>.82?1:0;
      const {positions,normals,indices}=buckets[bucket];
      const lift=lifts[bucket],width=radii[bucket];
      const length=Math.hypot(X-x,Z-z);
      const nx=length?(Z-z)*width/length:width,nz=length?(x-X)*width/length:0;
      const origin=positions.length/3;
      positions.push(x-nx,y+lift,z-nz,X-nx,Y+lift,Z-nz,X+nx,Y+lift,Z+nz,x+nx,y+lift,z+nz);
      normals.push(...normal,...normal,...normal,...normal);
      indices.push(origin,origin+1,origin+2,origin,origin+2,origin+3);
    }
    for(const [i,mesh] of meshes.entries()){
      const {positions,normals,indices}=buckets[i];
      mesh.visible=!!indices.length;
      if(indices.length)mesh.setGeometry(new Geometry(positions,normals,indices));
    }
  };
}
