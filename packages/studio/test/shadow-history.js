/** Read the real accumulated R16F texture, retaining exact integer visibility sums. */
export async function shadowHistory(device, effect) {
  const size=effect.options.resolution,texture=effect.history.textures[(effect.samples-1)&1],stride=Math.ceil(size*2/256)*256;
  const buffer=device.createBuffer({size:stride*size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
  try{
    const encoder=device.createCommandEncoder();encoder.copyTextureToBuffer({texture},{buffer,bytesPerRow:stride},[size,size]);
    device.queue.submit([encoder.finish()]);await buffer.mapAsync(GPUMapMode.READ);
    const words=new Uint16Array(buffer.getMappedRange()),out=[];
    for(let y=0;y<size;y++)for(let x=0;x<size;x++){
      const h=words[y*stride/2+x],e=(h>>10)&31;
      out.push(e===0?(h&1023)*2**-24:2**(e-15)*(1+(h&1023)/1024));
    }
    return out;
  }finally{buffer.destroy();}
}
