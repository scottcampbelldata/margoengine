import { createTreeGenerator } from '@margoengine/procedural/trees';
import { simulate } from './growth.js';
import { renderGrowth } from './meshes.js';

const kernel=createTreeGenerator();
self.addEventListener('message',async ({data:{id,blocked}})=>{
  try {
    const generator=await kernel;
    const model=renderGrowth(simulate(generator,blocked),blocked);
    const transfer=[model.upper,model.lower,model.canopy].flatMap(group=>Object.values(group).map(a=>a.buffer));
    self.postMessage({id,blocked,model},transfer);
  } catch (error) {
    self.postMessage({id,error:error.message??String(error)});
  }
});
