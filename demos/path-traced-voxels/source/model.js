import { parseVox } from '@margoengine/voxel/vox';
import { magicaVoxelMaterial,magicaVoxelModel } from '@margoengine/voxel-pathtracer';

export const lamps=[7,8];
export const glasses=[9,10,18];

export function loadStudy(bytes){
  const vox=parseVox(new Uint8Array(bytes));
  const source=vox.models[0];
  const model=magicaVoxelModel('afterglass',1,source.size,source.voxels);
  const ids=[...new Set(model.voxels)].filter(Boolean).sort((a,b)=>a-b);
  const materials=ids.map(id=>magicaVoxelMaterial(id,vox.palette.subarray(id*4,id*4+3),
    vox.materials.find(material=>material.id===id)?.attributes));
  if(glasses.some(id=>materials.find(material=>material.id===id)?.type!=='glass')||
      lamps.some(id=>materials.find(material=>material.id===id)?.type!=='emit')){
    throw new Error('The VOX file is missing glass or emitter materials.');
  }
  const counts=Object.fromEntries([...lamps,...glasses].map(id=>[id,0]));
  for(const id of model.voxels)if(id in counts)counts[id]++;
  const environment={
    skyColor:[.48,.63,.78],skyIntensity:.40,
    sunColor:[1,.88,.76],sunDirection:[-.55,.80,.33],sunIntensity:.34,sunAngularSize:.10,
    groundColor:[.052,.062,.079],groundHeight:-.02,
    background:[.018,.024,.047],
  };
  function state(revision,blue,opaque){
    const mapped=materials.map(material=>{
      if(lamps.includes(material.id)&&material.id!==(blue?8:7)){
        return {id:material.id,type:'diffuse',color:material.color.map(channel=>channel*.34)};
      }
      if(glasses.includes(material.id)&&opaque){
        return {id:material.id,type:'diffuse',color:material.color};
      }
      return material;
    });
    return {
      revision,models:[model],instances:[{id:'gallery',modelId:model.id,
        matrix:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]}],
      materials:mapped,environment,
    };
  }
  return {state,counts,cells:source.voxels.length/4};
}
