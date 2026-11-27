export const rad=Math.PI/180;
export const apex=60*rad;
export const indices=Object.freeze([1.3080,1.3110,1.3157]);
export const representativeIndex=indices[1];
export const minIncidence=28;
export const maxIncidence=72;
export const prismRadius=.140;
export const prismHeight=.295;
export const minAt=(n=representativeIndex)=>Math.asin(n*Math.sin(apex/2))/rad;
export const minimumDeviation=(n=representativeIndex)=>2*minAt(n)-60;
export const minRadius=17;
export const maxRadius=33;
export const bins=256;
export const skyHalfAngle=33;
const root3=Math.sqrt(3);

export function refraction(incidence,n=representativeIndex){
  const incident=incidence*rad;
  const inside=Math.asin(Math.sin(incident)/n);
  const exitInternal=apex-inside;
  const sine=n*Math.sin(exitInternal);
  if(sine>1)return null;
  const exitAngle=Math.asin(sine);
  return {incident,inside,exitInternal,exitAngle,deviation:(incident+exitAngle-apex)/rad};
}
export const prismVertices=Array.from({length:6},(_,i)=>{
  const angle=i*Math.PI/3;
  return [prismRadius*Math.cos(angle),prismRadius*Math.sin(angle)];
});
export function tracePrism(incidence){
  const ray=refraction(incidence);
  const [left,right]=[prismVertices[3],prismVertices[4]];
  const p=left.map((value,i)=>value+.60*(right[i]-value));
  const frontAngle=Math.PI/6+ray.incident;
  const internalAngle=Math.PI/6+ray.inside;
  const backAngle=Math.PI/2-ray.exitAngle;
  const inDir=[Math.cos(frontAngle),Math.sin(frontAngle)];
  const midDir=[Math.cos(internalAngle),Math.sin(internalAngle)];
  const outDir=[Math.cos(backAngle),Math.sin(backAngle)];
  const exitZ=prismRadius*root3/2;
  const dist=(exitZ-p[1])/midDir[1];
  const exit=[p[0]+dist*midDir[0],exitZ];
  return {...ray,entry:p,exit,inDir,midDir,outDir};
}
const clamp=(v)=>Math.max(0,Math.min(1,v));
export function acceptedWidth(inside){
  const advance=root3/(2*Math.tan(Math.PI/6+inside));
  const base=advance-1;
  const sweep=.5+advance;
  return clamp((.5-base)/sweep)-clamp((-.5-base)/sweep);
}
function transmitted(n1,n2,ang1,ang2){
  const a=Math.cos(ang1),b=Math.cos(ang2);
  const s=(n1*a-n2*b)/(n1*a+n2*b);
  const p=(n2*a-n1*b)/(n2*a+n1*b);
  return 1-.5*(s*s+p*p);
}

// Conditional rays are uniform in inclination and azimuth, weighted by projected accepted aperture.
export function haloProfile(){
  const intensity=new Float64Array(bins*3);
  const binWidth=(maxRadius-minRadius)/(bins-1);
  for(let i=0;i<2800;i++){
    const incidence=15+74.8*(i+.5)/2800;
    for(const [channel,n] of indices.entries()){
      const ray=refraction(incidence,n);
      if(!ray)continue;
      const angle=ray.deviation;
      if(angle<minRadius-.8||angle>maxRadius+.8)continue;
      const weight=acceptedWidth(ray.inside)*Math.cos(ray.incident)
        *transmitted(1,n,ray.incident,ray.inside)*transmitted(n,1,ray.exitInternal,ray.exitAngle)
        /Math.sin(angle*rad);
      const bin=(angle-minRadius)/binWidth;
      for(let x=Math.max(0,Math.floor(bin)-10);x<=Math.min(bins-1,Math.ceil(bin)+10);x++){
        const delta=(x-bin)*binWidth/.19;
        intensity[x*3+channel]+=weight*Math.exp(-.5*delta*delta);
      }
    }
  }
  const peak=Math.max(...intensity);
  const texture=new Uint8Array(bins*4);
  for(let i=0;i<bins;i++){
    for(let c=0;c<3;c++)texture[4*i+c]=Math.round(255*intensity[3*i+c]/peak);
    texture[4*i+3]=255;
  }
  return texture;
}
