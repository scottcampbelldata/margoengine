import {growth,samples} from './growth.js';
let staticShapes;
function packed(shape){return {positions:shape.positions,normals:shape.normals,indices:shape.indices};}
const buffers=shape=>[shape.positions.buffer,shape.normals.buffer,shape.indices.buffer];
self.addEventListener('message',({data})=>{
  try{
    const evolving=growth(data.age,data.current);
    if(data.initial){
      staticShapes??=samples().map(packed);
      self.postMessage({id:data.id,evolving,neighbours:staticShapes},[...buffers(evolving),...staticShapes.flatMap(buffers)]);
      staticShapes=undefined;
    }else self.postMessage({id:data.id,evolving},buffers(evolving));
  }catch(error){self.postMessage({id:data.id,error:error.message});}
});
