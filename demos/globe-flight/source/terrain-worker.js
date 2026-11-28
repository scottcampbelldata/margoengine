import {makeTerrain} from './geo.js';

self.onmessage=({data:{name,heights}})=>{
  try{
    const geometry=makeTerrain(name,heights);
    self.postMessage({name,geometry},Object.values(geometry).map(array=>array.buffer));
  }catch(error){
    self.postMessage({name,error:error.message});
  }
};
