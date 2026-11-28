import {design} from './geometry.js';
self.addEventListener('message',({data})=>{
  try{
    const train=design(data.counts),arrays=train.meshes.flatMap(item=>[item.positions.buffer,item.normals.buffer,item.indices.buffer]);
    self.postMessage({id:data.id,train},arrays);
  }catch(error){self.postMessage({id:data.id,error:error.message});}
});
