export const columns=38,rows=34,width=24,depth=21;
export const count=400;
export const blockHalf=.166,sphereRadius=.183,fixedDelta=1/60;
const clamp=value=>Math.max(0,Math.min(1,value));
const smooth=(a,b,x)=>{const t=clamp((x-a)/(b-a));return t*t*(3-2*t);};

export function ground(x,z){
  const r=Math.hypot((x+.32*Math.sin(z*.25))/11.5,(z+.4*Math.sin(x*.31))/10.2);
  const contour=.08*smooth(.24,.42,r)+.12*smooth(.47,.66,r)+.29*smooth(.72,.92,r);
  const basin=.079*Math.sin(.53*x+.24*z)*Math.cos(.29*z)-.082*Math.cos(.52*z+.2*x);
  const rib=.056*Math.sin(.91*x+.35*z)*Math.sin(z*.67);
  return -.32+contour+basin+rib+1.31*smooth(1.03,1.19,r);
}
export const index=(r,c)=>r+(rows+1)*c;
export function terrainGrid(){
  const heights=new Float32Array((rows+1)*(columns+1));
  for(let c=0;c<=columns;c++)for(let r=0;r<=rows;r++)heights[index(r,c)]=ground(-width/2+c*width/columns,-depth/2+r*depth/rows);
  return heights;
}

function randomGenerator(seed){
  let value=seed;
  return ()=>{
    value^=value<<13;value^=value>>>17;value^=value<<5;
    return (value>>>0)/4294967296;
  };
}
export function layout(){
  const random=randomGenerator(0x817c521);
  const entities=[];
  for(const kind of ['block','sphere'])for(let row=0;row<25;row++)for(let column=0;column<32;column++){
    if((row+column)%2!==Number(kind==='sphere'))continue;
    const x=(column-15.5)*.646+(random()-.5)*.13;
    const z=(row-12)*.683+(random()-.5)*.14;
    const wave=.5+.5*Math.sin(.47*x+.59*z+(kind==='sphere'?.82:0));
    const y=ground(x,z)+1.9+wave*5.2+random()*3.4+(kind==='sphere'?1.55:0);
    const a=(random()-.5)*2.2,b=(random()-.5)*.39;
    const rotation=[Math.sin(b/2)*Math.cos(a/2),Math.cos(b/2)*Math.sin(a/2),
      -Math.sin(b/2)*Math.sin(a/2),Math.cos(b/2)*Math.cos(a/2)];
    const color=Math.floor(random()*5);
    entities.push({id:entities.length,kind,color,position:[x,y,z],rotation,
      velocity:[(random()-.5)*.16,0,(random()-.5)*.16]});
  }
  return entities;
}
