export const size=192;
export const recipes={
  labyrinth:{feed:.035,kill:.060,range:.27,spacing:12},
  cells:{feed:.030,kill:.062,range:.30,spacing:15},
  branches:{feed:.014,kill:.054,range:.36,spacing:16}
};

function random(x,y){
  let hash=(Math.imul(x+251,0x45d9f3b)^Math.imul(y+151,0x119de1f3))|0;
  hash=Math.imul(hash^(hash>>>16),0x45d9f3b);
  return ((hash^(hash>>>16))>>>0)/4294967295;
}
function half(unit){
  if(unit<2**-14)return Math.round(unit*2**24);
  const exponent=Math.floor(Math.log2(unit));
  return ((exponent+15)<<10)+Math.round((unit/(2**exponent)-1)*1024);
}
export function starter(name){
  const {spacing,range}=recipes[name],seed=new Uint16Array(size*size*4),inoculation=new Float32Array(size*size);
  for(let y=7;y<size-5;y+=spacing)for(let x=7;x<size-5;x+=spacing){
    const roll=random(x,y);
    if(roll<.14)continue;
    const cx=x+(random(x+91,y)-.5)*spacing*.8,cy=y+(random(x,y+61)-.5)*spacing*.8;
    const radius=2.+3.23*roll;
    for(let py=Math.floor(cy)-6;py<=Math.ceil(cy)+6;py++)for(let px=Math.floor(cx)-6;px<=Math.ceil(cx)+6;px++){
      const distance=Math.hypot(px-cx,py-cy),id=(py+size)%size*size+(px+size)%size;
      const falloff=Math.max(0,Math.min(1,(radius-distance)/2.42));
      inoculation[id]=Math.max(inoculation[id],falloff*falloff*(3-2*falloff));
    }
  }
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const id=y*size+x,spot=inoculation[id],jitter=random(x,y)*.028;
    seed[id*4]=half(1.-spot*(.41+jitter));
    seed[id*4+1]=half(spot*(range+jitter));
    seed[id*4+3]=0x3c00;
  }
  return seed;
}
