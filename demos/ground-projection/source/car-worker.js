import {buildAster,buildSurfaceBatches} from './coachwork.js';
addEventListener('message',event=>{
if(event.data===true){
  const batches=buildSurfaceBatches();
  postMessage(batches,batches.flatMap(({positions,normals,indices})=>[positions.buffer,normals.buffer,indices.buffer]));
}else{
  const asset=buildAster();postMessage(asset,[asset]);
}
},{once:true});
