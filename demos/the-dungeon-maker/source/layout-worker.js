import {createBase,solveGallery} from './model.js';
import {prepareGallery} from './art.js';
const base=createBase();
self.addEventListener('message',async({data})=>{
  try{
    const result=solveGallery(await base,data.seed);
    const art=prepareGallery(result.solved);
    const arrays=art.layers.flatMap(layer=>layer.flatMap(a=>[a.positions.buffer,a.normals.buffer,a.indices.buffer]));
    self.postMessage({id:data.id,result:{...result,art}},[result.solved.buffer,...arrays]);
  }catch(error){self.postMessage({id:data.id,error:error.message});}
});
