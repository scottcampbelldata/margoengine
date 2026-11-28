import {createPBRTextureBaker} from '@margoengine/procedural/textures-pbr';

export function startBaker(engine,signal){
  return createPBRTextureBaker(engine,{signal});
}

const mapNames=['albedo','normal','roughness','height'];

async function uploadMaps(source,target,set,signal){
  const size=set.width,mips=[];
  let bytes=0;
  for(let level=0;level<set.mipLevelCount;level++){
    const side=Math.max(1,size>>level),row=Math.ceil(side*4/256)*256;
    mips.push({level,side,row,offset:bytes});
    bytes+=row*side;
  }
  const buffer=source.createBuffer({size:bytes*mapNames.length,
    usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
  const views={};
  const dispose=()=>{for(const texture of Object.values(views))texture.destroy();};
  try{
    const encoder=source.createCommandEncoder();
    for(const [i,key] of mapNames.entries())for(const {level,side,row,offset} of mips){
      encoder.copyTextureToBuffer({texture:set[key],mipLevel:level},
        {buffer,offset:i*bytes+offset,bytesPerRow:row,rowsPerImage:side},[side,side,1]);
    }
    source.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    signal.throwIfAborted();
    const pixels=new Uint8Array(buffer.getMappedRange());
    for(const [i,key] of mapNames.entries()){
      const texture=target.createTexture({label:'Margo generated '+key,size:[size,size],mipLevelCount:mips.length,
        format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST|GPUTextureUsage.COPY_SRC});
      views[key]=texture;
      for(const {level,side,row,offset} of mips){
        const start=i*bytes+offset;
        target.queue.writeTexture({texture,mipLevel:level},pixels.subarray(start,start+row*side),
          {bytesPerRow:row,rowsPerImage:side},[side,side,1]);
      }
    }
    buffer.unmap();
    return {...views,width:size,heightPixels:size,mipLevelCount:mips.length,dispose};
  }catch(reason){
    dispose();
    throw reason;
  }finally{
    buffer.destroy();
    set.dispose();
  }
}
export async function startCompatBaker(opening,signal){
  const {createCompatGPU}=await import('@margoengine/webgl2-compat/device');
  const adapter=await createCompatGPU({minimumTier:'half-float'}).requestAdapter();
  signal.throwIfAborted();
  if(!adapter)return startBaker(await opening,signal);
  const device=await adapter.requestDevice();
  performance.mark('baker-device');
  try{
    const [baker,engine]=await Promise.all([startBaker(device,signal),opening]);
    signal.throwIfAborted();
    return {
      async bake(options){
        const set=await baker.bake(options);
        return uploadMaps(device,engine.gpu,set,signal);
      },
      dispose(){baker.dispose();device.destroy();},
    };
  }catch(reason){
    device.destroy();
    throw reason;
  }
}
