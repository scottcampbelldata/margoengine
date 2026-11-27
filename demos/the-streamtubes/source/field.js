import {streamTubeGeometry} from '@margoengine/sciviz/tubes';

export const flowStart=-2.43,flowEnd=4.66;
const twoPi=2*Math.PI;
function vortex(y,z,cy,cz,gamma,core){
  const dy=y-cy,dz=z-cz, q=dy*dy+dz*dz;
  const spin=gamma*(q<1e-9?1/(core*core):-Math.expm1(-q/(core*core))/q);
  return [-dz*spin,dy*spin,Math.exp(-q/(core*core))];
}
export function velocity([x,y,z]){
  const run=Math.max(0,x-flowStart);
  const resolution=Math.min(1,run*.13);
  const center=.57-.18*resolution;
  const separation=1.31-.29*resolution;
  const core=.35+.16*resolution;
  const taper=1-.29*resolution;
  const right=vortex(y,z,center,separation,.52*taper,core);
  const left=vortex(y,z,center,-separation,-.52*taper,core);
  return [1.40-.35*(right[2]+left[2]),right[0]+left[0]-.014,right[1]+left[1]];
}
const add=(a,b,t)=>a.map((n,i)=>n+b[i]*t);
function step(p,dt){
  const a=velocity(p),b=velocity(add(p,a,dt*.5)),c=velocity(add(p,b,dt*.5)),d=velocity(add(p,c,dt));
  return p.map((n,i)=>n+dt*(a[i]+2*b[i]+2*c[i]+d[i])/6);
}
function trace(seed){
  const positions=[], scalar=[];
  let p=seed;
  for(let i=0;i<140;i++){
    positions.push(...p);
    scalar.push(Math.hypot(...velocity(p)));
    if(p[0]>=flowEnd)break;
    const next=step(p,.092);
    p=next[0]>flowEnd?add(p,next.map((v,k)=>v-p[k]),(flowEnd-p[0])/(next[0]-p[0])):next;
  }
  return {positions,scalar};
}
export const paths=[];
for(const side of [-1,1]){
  for(let ring=0;ring<3;ring++){
    const radius=[.22,.43,.62][ring],count=[3,3,4][ring];
    for(let sample=0;sample<count;sample++){
      const angle=twoPi*sample/count+ring*.43+(side<0?.17:-.13);
      const seed=[flowStart,.57+Math.sin(angle)*radius,side*1.31+Math.cos(angle)*radius];
      paths.push({side,ring,...trace(seed)});
    }
  }
}
export const speedRange=[.99,1.90];

export function tube(path,thickness){
  const radial=path.scalar.map((speed,i)=>{
    const p=i/(path.scalar.length-1);
    return thickness*(.72+.29*speed)*(.81+.21*Math.sin(Math.PI*p));
  });
  return streamTubeGeometry(path,{radius:radial,sides:12,steps:68,caps:true});
}
