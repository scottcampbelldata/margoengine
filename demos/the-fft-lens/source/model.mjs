export const size=256, samples=size*size, channels=3;
const gamma=[.2126,.7152,.0722];
const signed=k=>k>=size/2?k-size:k;
const squared=Array.from({length:size},(_,i)=>signed(i)**2);
const radii=Float32Array.from({length:samples},(_,i)=>squared[i%size]+squared[i>>8]);
const logHalf=Math.log(2);
export function filter(mode,cutoff){
  const result=new Float32Array(samples), scale=-logHalf/(cutoff*cutoff);
  for(let i=0;i<samples;i++){
    const r=radii[i]*scale;
    if(mode==='none')result[i]=1;
    else if(mode==='low')result[i]=Math.exp(r);
    else if(mode==='high')result[i]=-Math.expm1(r);
    else result[i]=Math.exp(r*.25)-Math.exp(r*4);
  }
  return result;
}
const linear=Float32Array.from({length:256},(_,i)=>{
  const s=i/255;
  return s<=.04045?s/12.92:((s+.055)/1.055)**2.4;
});
export function upload(rgba){
  const data=new Float32Array(channels*samples);
  for(let i=0;i<samples;i++){
    for(let c=0;c<channels;c++)data[c*samples+i]=linear[rgba[i*4+c]];
  }
  return data;
}
const clamp=v=>Math.max(0,Math.min(1,v));
function encode(v){
  const c=clamp(v);
  return Math.round(255*(c<=.0031308?12.92*c:1.055*c**(1/2.4)-.055));
}
export function download(data,mode){
  const rgba=new Uint8ClampedArray(samples*4);
  const signedMode=mode==='high'||mode==='band';
  for(let i=0;i<samples;i++){
    for(let c=0;c<channels;c++){
      const v=data[c*samples+i];
      rgba[4*i+c]=encode(signedMode ? .16+v*2.6 : v);
    }
    rgba[4*i+3]=255;
  }
  return rgba;
}
export function power(re,im){
  const energy=new Float32Array(samples);
  for(let i=0;i<samples;i++){
    let sum=0;
    for(let c=0;c<channels;c++){
      const k=c*samples+i;
      sum+=gamma[c]*(re[k]*re[k]+im[k]*im[k]);
    }
    energy[i]=sum;
  }
  return energy;
}
const colors=[[16,11,27],[44,29,78],[81,49,121],[168,78,112],[229,138,119],[255,231,183]];
function shade(t){
  const bands=colors.length-1,j=Math.min(bands-1,Math.floor(t*bands)),s=t*bands-j;
  return colors[j].map((value,c)=>value+(colors[j+1][c]-value)*s);
}
export function analysis(energy,mask){
  const rgba=new Uint8ClampedArray(samples*4);
  let total=0,kept=0;
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const i=((y+size/2)%size)*size+(x+size/2)%size,j=(y*size+x)*4;
    const e=energy[i], h=mask[i];
    total+=e;kept+=e*h*h;
    const intensity=clamp(Math.log1p(e*.33)/10.2), tint=shade(intensity);
    const opacity=.25+.75*h;
    rgba[j]=tint[0]*opacity;rgba[j+1]=tint[1]*opacity;
    rgba[j+2]=tint[2]*opacity;rgba[j+3]=255;
  }
  return {rgba,kept:total?100*kept/total:0};
}
