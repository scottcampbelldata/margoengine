import {GPULightmapBaker} from '@margoengine/lightmap/gpu';
import {buildRoom,options} from './room.js';

addEventListener('message',async({data})=>{
  let device,baked;
  try{
    if(data.compatibility||!navigator.gpu){
      const {installCompatibility}=await import('./compatibility.js');
      await installCompatibility();
    }
    const adapter=await navigator.gpu.requestAdapter();
    if(!adapter)throw new Error('A GPU adapter is required for the stock lightmap bake.');
    const limits=adapter.limits;
    device=await adapter.requestDevice({requiredLimits:{
      maxTextureArrayLayers:limits.maxTextureArrayLayers,maxBufferSize:limits.maxBufferSize,
      maxStorageBufferBindingSize:limits.maxStorageBufferBindingSize,
    }});
    const room=buildRoom();
    baked=await GPULightmapBaker.create(device,room.mesh,options);
    for(const passes of [24,40,64]){
      await baked.step(passes-baked.passes);
      const map=await baked.read();
      const result={...map,triangle:map.triangle.slice(),passes:baked.passes};
      postMessage({result,complete:passes===64},[map.lightmap.buffer,map.irradiance.buffer,result.triangle.buffer,map.ao.buffer]);
    }
  }catch(reason){
    postMessage({error:reason?.message??String(reason)});
  }finally{
    baked?.[Symbol.dispose]();
    device?.destroy();
    close();
  }
},{once:true});
