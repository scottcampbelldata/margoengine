import {Geometry,PbrMaterial} from '@margoengine/core';
import {MeshletMesh} from '@margoengine/culling/meshlets';

export function cluster({positions,normals,indices}){
  const geometry=new Geometry(positions,normals,indices);
  const material=new PbrMaterial({color:'#b8814c',roughness:.38,metalness:.45,doubleSided:false});
  const transforms=new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,.24,0,1]);
  const statue=new MeshletMesh([{geometry,material,transforms}],{culling:'occlusion'});
  performance.mark('statue-clustered');
  return {statue,total:indices.length/3};
}
