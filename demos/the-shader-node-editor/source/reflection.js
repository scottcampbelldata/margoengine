
const clamp=(v,lo=0,hi=1)=>Math.max(lo,Math.min(hi,v));
const linear=Array.from({length:256},(_,k)=>k/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);
const encode=v=>Math.round(255*(v<=.0031308?v*12.92:1.055*v**(1/2.4)-.055));

function downsample({data,width,height}){
  const w=width>>1,h=height>>1,small=new Uint8Array(w*h*4);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const a=(y*2*width+x*2)*4,b=a+width*4,d=(y*w+x)*4;
    for(let k=0;k<3;k++)small[d+k]=encode((linear[data[a+k]]+linear[data[a+k+4]]+linear[data[b+k]]+linear[data[b+k+4]])*.25);
    small[d+3]=255;
  }
  return {data:small,width:w,height:h};
}

export function prepareReflector(faces){
  const base=faces[0].width,levels=Math.log2(base)+1;
  const chain=faces.map(face=>{
    const mips=[face];
    while(mips.length<levels)mips.push(downsample(mips.at(-1)));
    return mips;
  });
  let used,texture;
  return {
    of(device){
      if(used===device)return texture;
      texture?.destroy();
      used=device;
      texture=device.createTexture({label:'Ceramic studio softboxes',size:[base,base,6],mipLevelCount:levels,
        format:'rgba8unorm-srgb',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
      for(const [layer,mips] of chain.entries())for(const [mipLevel,{width,height,data}] of mips.entries()){
        device.queue.writeTexture({texture,mipLevel,origin:[0,0,layer]},data,{bytesPerRow:width*4,rowsPerImage:height},[width,height]);
      }
      return texture;
    },
    dispose(){texture?.destroy();texture=used=undefined;},
  };
}

export function reflectionFaces(){
  const width=32,height=32;
  const lamps=[
    {direction:[-.66,.56,.54],shape:[.21,.62,.19],color:[.88,.78,.64]},
    {direction:[.47,.66,.55],shape:[.34,.24,.13],color:[.62,.77,.78]},
    {direction:[.64,.23,-.73],shape:[.13,.42,.13],color:[.74,.65,.45]},
    {direction:[.02,.96,.14],shape:[.43,.24,.53],color:[.64,.59,.46]},
  ];
  const data=Array.from({length:6},(_,face)=>{
    const raster=new Uint8Array(width*height*4);
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){
      const u=(x+.5)*2/width-1,v=(y+.5)*2/height-1;
      const p=[[1,-v,-u],[-1,-v,u],[u,1,v],[u,-1,-v],[u,-v,1],[-u,-v,-1]][face];
      const length=Math.hypot(...p),q=p.map(v=>v/length),led=[.16+.07*q[1],.15+.068*q[1],.12+.057*q[1]];
      for(const {direction,shape,color} of lamps){
        const r=Math.max(...direction.map((v,j)=>Math.abs(v-q[j])/shape[j]));
        const power=clamp((1.28-r)*4.0);
        for(let k=0;k<3;k++)led[k]+=power*color[k];
      }
      const offset=(y*width+x)*4;
      for(let k=0;k<3;k++)raster[offset+k]=Math.round(clamp(led[k])*255);
      raster[offset+3]=255;
    }
    return {data:raster,width,height};
  });
  return data;
}
