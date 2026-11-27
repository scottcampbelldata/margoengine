import {bakeRefractedLightmap} from '@margoengine/lightmap/refracted';
import {bakeInputs,modes} from './optics.js';
import {packMap} from './package-map.js';

addEventListener('message',async event=>{
  const key=event.data;
  if(!Object.hasOwn(modes,key))return;
  try{
    const [surface,options]=bakeInputs(key);
    let percent=-1;
    const result=await bakeRefractedLightmap(surface,{...options,onProgress(done,steps){
      const progress=Math.floor(100*done/steps);
      if(progress===percent)return;
      percent=progress;
      postMessage({progress});
    }});
    const {rgba,stats}=packMap(result);
    postMessage({rgba,stats},[rgba.buffer]);
  }catch(error){
    postMessage({error:error.message});
  }
});
