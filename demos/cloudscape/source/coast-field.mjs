export const span=19000;
const mix=(a,b,t)=>a+(b-a)*t;
const smooth=t=>t*t*(3-2*t);
function hash(x,z,seed){
  let h=Math.imul(x^seed,0xb5219)+Math.imul(z^seed,0x9e3779b1);
  h=Math.imul(h^h>>>15,0x7feb352d);h=Math.imul(h^h>>>12,0x846ca68b);
  return ((h^h>>>16)>>>0)/4294967295;
}
function noise(x,z,seed){
  const i=Math.floor(x),j=Math.floor(z),u=smooth(x-i),v=smooth(z-j);
  return mix(mix(hash(i,j,seed),hash(i+1,j,seed),u),mix(hash(i,j+1,seed),hash(i+1,j+1,seed),u),v);
}
const banks=[
  [-4420,-1940,4080,3020,595,.40],
  [-2150,-5820,2490,3190,727,-.68],
  [1560,-2860,2160,3330,604,-.60],
  [3860,-4900,2280,1430,411,.46],
  [2620,1050,2150,1690,397,-.62],
  [-3790,2960,2210,1620,395,.54],
  [-5160,5700,3050,1730,450,.83],
  [6160,1770,1220,1430,285,-.18],
  [5600,-1970,1040,2180,345,-.48],
];
export function heightAt(x,z){
  const stretch=(noise(x/1600,z/1600,946)-.5)*1000;
  const dogleg=(noise(x/1350,z/1350,1243)-.5)*955;
  let h=-108,inner=0;
  for(const [cx,cz,rx,rz,up,angle] of banks){
    const a=x-cx+stretch,b=z-cz+dogleg,cos=Math.cos(angle),sin=Math.sin(angle);
    const u=(a*cos+b*sin)/rx,v=(-a*sin+b*cos)/rz;
    const d=u*u+v*v, lift=Math.exp(-1.88*d);
    h=Math.max(h,-108+up*lift);
    inner=Math.max(inner,lift);
  }
  const rough=(noise(x/471,z/471,219)-.49)*116+(noise(x/199,z/199,407)-.5)*56+
    (noise(x/96,z/96,735)-.52)*25;
  const ridged=1-2*Math.abs(noise(x/815,z/815,122)-.5);
  return h+inner*(rough+38*ridged);
}
const linear=h=>h.match(/../g).map(pair=>{
  const c=parseInt(pair,16)/255;
  return c<.04045?c/12.92:((c+.055)/1.055)**2.4;
});
const palette=Object.fromEntries(Object.entries({
  deep:'294d62',bay:'4e7a83',reef:'7ca89f',foam:'a0bca5',sand:'c3ad7f',
  scrub:'839271',fir:'435e56',stone:'8b8675',crest:'bab097',
}).map(([name,hex])=>[name,linear(hex)]));
const lerpColor=(a,b,t)=>a.map((value,i)=>mix(value,b[i],smooth(Math.max(0,Math.min(1,t)))));
export function colorAt(h,x,z,slope){
  if(h<=0){
    if(h<-44)return lerpColor(palette.deep,palette.bay,(h+109)/65);
    if(h<-8)return lerpColor(palette.bay,palette.reef,(h+44)/36);
    return lerpColor(palette.reef,palette.foam,(h+8)/8);
  }
  const brush=noise(x/675,z/675,69)*.61+noise(x/236,z/236,771)*.29+noise(x/91,z/91,803)*.1;
  const vegetation=lerpColor(palette.fir,palette.scrub,brush*1.28);
  const rocky=lerpColor(vegetation,palette.stone,Math.max((slope-.14)*2.7,(h-390)/220));
  const high=lerpColor(rocky,palette.crest,(h-490)/245);
  if(h<20)return lerpColor(palette.foam,palette.sand,h/20);
  if(h<55)return lerpColor(palette.sand,high,(h-20)/35);
  return high;
}
export const profile={base:940,top:3340,min:450,max:4850};
export const stations=[455,1790,4550];
export function fly(alt,heading,tilt){
  const t=Math.max(0,Math.min(1,(alt-profile.min)/(profile.max-profile.min)));
  const x=mix(-4470,2470,t)+620*Math.sin(Math.PI*t),z=mix(5490,-2160,t);
  const yaw=(25+heading)*Math.PI/180,pitch=(-3-19*t+tilt)*Math.PI/180;
  const level=1700*Math.cos(pitch);
  return {eye:[x,alt,z],look:[x+Math.sin(yaw)*level,alt+1700*Math.sin(pitch),z-Math.cos(yaw)*level]};
}


export function atlas(size){
  const elevation=new Uint8Array(size*size*4), diffuse=new Uint8Array(size*size*4);
  for(let j=0;j<size;j++)for(let i=0;i<size;i++){
    const x=(i/(size-1)-.5)*span,z=(j/(size-1)-.5)*span,k=(j*size+i)*4;
    const h=heightAt(x,z),dx=(heightAt(x+45,z)-heightAt(x-45,z))/90,
      dz=(heightAt(x,z+45)-heightAt(x,z-45))/90;
    const v=Math.max(0,Math.min(65535,Math.round(Math.max(h,0)*64)));
    elevation.set([v>>8,v&255,Math.round((Math.max(-1,Math.min(1,dx))*.5+.5)*255),
      Math.round((Math.max(-1,Math.min(1,dz))*.5+.5)*255)],k);
    const c=colorAt(h,x,z,Math.hypot(dx,dz));
    diffuse.set([...c.map(t=>Math.round(255*Math.min(1,Math.max(0,t)))),255],k);
  }
  return {elevation,diffuse};
}
export function vapor(size,seed){
  const out=new Uint8Array(size**3);
  const wrap=(i,n)=>(i%n+n)%n;
  function smoothCell(a,b,c,n,offset){
    const x=a*n,y=b*n,z=c*n,i=Math.floor(x),j=Math.floor(y),k=Math.floor(z);
    const u=smooth(x-i),v=smooth(y-j),w=smooth(z-k);
    const sample=(di,dj,dk)=>hash(wrap(i+di,n),wrap(j+dj,n),seed*131+wrap(k+dk,n)*329+offset);
    const layer=d=>mix(mix(sample(0,0,d),sample(1,0,d),u),mix(sample(0,1,d),sample(1,1,d),u),v);
    return mix(layer(0),layer(1),w);
  }
  for(let z=0;z<size;z++)for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const a=x/size,b=y/size,c=z/size;
    const sm=.56*smoothCell(a,b,c,4,71)+.29*smoothCell(a,b,c,9,884)+.10*smoothCell(a,b,c,16,321)+.05*smoothCell(a,b,c,27,509);
    out[(z*size+y)*size+x]=Math.round(sm*255);
  }
  return out;
}
