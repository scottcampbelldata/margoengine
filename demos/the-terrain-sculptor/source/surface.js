const edge=128, count=4;
const palettes=[
  {base:[72,78,83],local:[33,37,43],high:[126,131,132],rough:.78,amplitude:.59},
  {base:[114,126,66],local:[65,80,45],high:[159,156,82],rough:.91,amplitude:.47},
  {base:[180,112,49],local:[98,62,35],high:[208,160,80],rough:.68,amplitude:.70},
  {base:[132,120,104],local:[76,73,71],high:[163,153,131],rough:.83,amplitude:.39},
];
const tau=Math.PI*2;
const clamp=(v,lo=0,hi=1)=>Math.min(hi,Math.max(lo,v));
const mix=(a,b,t)=>a+(b-a)*t;
const linear=Float32Array.from({length:256},(_,i)=>i/255<=.04045?i/(255*12.92):((i/255+.055)/1.055)**2.4);
const srgb=v=>Math.round(255*(v<.0031308?12.92*v:1.055*v**(1/2.4)-.055));
function cells(u,v,period,seed){
  const X=u*period,Y=v*period,ix=Math.floor(X),iy=Math.floor(Y);
  const x=X-ix,y=Y-iy;
  const h=(a,b)=>{
    const p=(a%period+period)%period,q=(b%period+period)%period;
    let n=Math.imul(p,1597334677)^Math.imul(q,3812015801)^seed;
    n=Math.imul(n^(n>>>16),73244475);
    return (n>>>0)/4294967296;
  };
  const s=x*x*(3-2*x),t=y*y*(3-2*y);
  return mix(mix(h(ix,iy),h(ix+1,iy),s),mix(h(ix,iy+1),h(ix+1,iy+1),s),t);
}
function generateMaterials(){
  const albedo=new Uint8Array(edge*edge*count*4),normal=new Uint8Array(albedo.length),surface=new Uint8Array(albedo.length);
  const cellsPerLayer=edge*edge;
  for(let layer=0;layer<count;layer++){
    const palette=palettes[layer],cavity=new Float32Array(cellsPerLayer),field=new Float32Array(cellsPerLayer);
    const seed=37153+layer*3621,turn=tau*.85*layer;
    for(let j=0;j<edge;j++){
      for(let i=0;i<edge;i++){
        const u=i/edge,v=j/edge;
        const low=cells(u,v,6,seed),middle=cells(u,v,15,seed+137),fine=cells(u,v,41,seed+53);
        const schist=.029*Math.sin(tau*(u*5+v*9+low*.71)+turn);
        field[j*edge+i]=.51*low+.29*middle+.20*fine+schist;
        cavity[j*edge+i]=Math.max(0,1-Math.abs(low-.42)*19)*(.18+.68*fine);
      }
    }
    for(let j=0;j<edge;j++){
      const above=((j+edge-1)%edge)*edge,below=((j+1)%edge)*edge;
      for(let i=0;i<edge;i++){
        const local=j*edge+i,px=4*(layer*cellsPerLayer+local);
        const h=field[local],fissure=cavity[local];
        const stain=clamp((h-.14)*1.42-.11*fissure);
        for(let ch=0;ch<3;ch++)albedo[px+ch]=mix(mix(palette.local[ch],palette.high[ch],stain),palette.base[ch],.30);
        albedo[px+3]=255;
        const dx=(field[j*edge+(i+edge-1)%edge]-field[j*edge+(i+1)%edge])*palette.amplitude*2.2;
        const dy=(field[below+i]-field[above+i])*palette.amplitude*2.2;
        const magnitude=Math.hypot(dx,dy,1);
        normal[px]=127.5+127.5*dx/magnitude;
        normal[px+1]=127.5+127.5*dy/magnitude;
        normal[px+2]=127.5+127.5/magnitude;
        normal[px+3]=255;
        surface[px]=255*clamp(.70+h*.29-.11*fissure);
        surface[px+1]=255*clamp(palette.rough-.19*(h-.4)+.15*fissure);
        surface[px+2]=0;
        surface[px+3]=255*clamp(h*.85+.049*layer);
      }
    }
  }
  return {albedo,normal,surface};
}

function mip(source,previous,gamma){
  const width=previous/2,out=new Uint8Array(count*width*width*4);
  for(let layer=0;layer<count;layer++){
    for(let j=0;j<width;j++){
      for(let i=0;i<width;i++){
        const from=(layer*previous*previous+(j*previous+i)*2)*4,to=(layer*width*width+j*width+i)*4;
        for(let ch=0;ch<4;ch++){
          const a=source[from+ch],b=source[from+ch+4],c=source[from+ch+previous*4],d=source[from+ch+previous*4+4];
          out[to+ch]=gamma&&ch!==3?srgb((linear[a]+linear[b]+linear[c]+linear[d])*.25):Math.round((a+b+c+d)*.25);
        }
      }
    }
  }
  return out;
}
function chain(top,gamma){
  const data=[top];
  for(let size=edge;size>1;size/=2)data.push(mip(data.at(-1),size,gamma));
  return data;
}
export function prepareMaterials(){
  const maps=generateMaterials();
  return {albedo:chain(maps.albedo,true),normal:chain(maps.normal,false),surface:chain(maps.surface,false)};
}
function createArray(device,data,gamma=false){
  const texture=device.createTexture({size:[edge,edge,count],mipLevelCount:data.length,
    format:gamma?'rgba8unorm-srgb':'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
  for(let level=0,size=edge;level<data.length;level++,size/=2){
    device.queue.writeTexture({texture,mipLevel:level},data[level],{bytesPerRow:size*4,rowsPerImage:size},[size,size,count]);
  }
  return texture;
}

export function makeMaterials(maps){

  return {
    layers:device=>createArray(device,maps.albedo,true),
    pbr:device=>({normals:createArray(device,maps.normal),surface:createArray(device,maps.surface)}),
  };
}
