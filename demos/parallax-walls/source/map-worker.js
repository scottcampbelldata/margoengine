import {masonryMaps} from './masonry.js';
self.onmessage=({data:stone})=>{
  const result=masonryMaps(stone);
  const buffers=[result.albedo.buffer,result.normal.buffer];
  if(result.height)buffers.push(result.height.buffer);
  self.postMessage(result,buffers);
};
