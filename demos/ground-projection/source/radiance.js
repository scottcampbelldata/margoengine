
export async function decodePhoto(blob){
  const bitmap=await createImageBitmap(blob,{colorSpaceConversion:'none',premultiplyAlpha:'none'});
  try{
    const canvas=new OffscreenCanvas(bitmap.width,bitmap.height),drawer=canvas.getContext('2d',{willReadFrequently:true});
    drawer.drawImage(bitmap,0,0);
    const {data}=drawer.getImageData(0,0,bitmap.width,bitmap.height);
    return {width:bitmap.width,height:bitmap.height,data};
  }finally{bitmap.close();}
}
const radiance=Float32Array.from({length:256},(_,code)=>(2**(13*code/255)-1)/24);
function half(value){
  if(value===0)return 0;
  const exponent=Math.floor(Math.log2(value));
  return (exponent+15)*1024+Math.round((value/2**exponent-1)*1024);
}
const halfRadiance=Uint16Array.from(radiance,half);
export function linearPhoto({width,height,data}){
  const rgba=new Float32Array(data.length);
  for(let i=0;i<data.length;i+=4){
    rgba[i]=radiance[data[i]];
    rgba[i+1]=radiance[data[i+1]];
    rgba[i+2]=radiance[data[i+2]];
    rgba[i+3]=1;
  }
  return {width,height,data:rgba};
}
export function backgroundSource(environment,photo){
  const {width,height,data}=photo,values=new Uint16Array(data.length);
  for(let i=0;i<data.length;i+=4){
    values[i]=halfRadiance[data[i]];values[i+1]=halfRadiance[data[i+1]];
    values[i+2]=halfRadiance[data[i+2]];values[i+3]=0x3c00;
  }
  let device,texture,view;
  function release(){texture?.destroy();device=texture=view=undefined;}
  function getView(){
    if(device!==environment.device){
      release();
      device=environment.device;
      texture=device.createTexture({label:'Coastal HDR photograph',size:[width,height],format:'rgba16float',
        usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
      device.queue.writeTexture({texture},values,{bytesPerRow:width*8,rowsPerImage:height},[width,height]);
      view=texture.createView();
    }
    return view;
  }
  const source=new Proxy(environment,{get(target,key){
    if(key==='equirectView')return getView();
    if(key==='equirectTexture'){getView();return texture;}
    const property=Reflect.get(target,key,target);
    return typeof property==="function"?property.bind(target):property;
  }});
  return {source,dispose:release};
}
