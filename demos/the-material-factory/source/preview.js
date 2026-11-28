const names=['albedo','normal','roughness','height'];
const encoded=new Uint8ClampedArray(256);
for(let i=0;i<256;i++){
  const x=i/255;
  encoded[i]=255*(x<=.0031308?12.92*x:1.055*x**(1/2.4)-.055);
}
export async function readPreviews(device,set,amplitude){
  const level=1,width=set.width>>level,height=set.heightPixels>>level,bpr=width*4,stride=bpr*height;
  const buffer=device.createBuffer({size:stride*names.length,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
  try{
    const encoder=device.createCommandEncoder();
    for(let i=0;i<names.length;i++){
      encoder.copyTextureToBuffer({texture:set[names[i]],mipLevel:level},
        {buffer,offset:i*stride,bytesPerRow:bpr,rowsPerImage:height},[width,height,1]);
    }
    device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const raw=new Uint8Array(buffer.getMappedRange()),out={};
    for(let j=0;j<names.length;j++){
      const name=names[j],view=raw.subarray(j*stride,(j+1)*stride);
      const pixels=new Uint8ClampedArray(stride);
      let checksum=2166136261;
      for(let i=0;i<stride;i+=4){
        for(let c=0;c<3;c++){
          const v=view[i+c];
          checksum=Math.imul(checksum^v,16777619);
          pixels[i+c]=name==='albedo'?encoded[v]:name==='height'?v/Math.max(.001,amplitude):v;
        }
        pixels[i+3]=255;
      }
      out[name]={image:new ImageData(pixels,width,height),checksum:(checksum>>>0).toString(16).padStart(8,'0')};
    }
    buffer.unmap();
    return out;
  }finally{
    buffer.destroy();
  }
}
