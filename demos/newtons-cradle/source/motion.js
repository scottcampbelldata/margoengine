export const gravity=9.80665;
export const radius=.026;
export const length=.247;
export const restY=.100;
export const pivotY=restY+length;
export const count=5;
export const spacing=radius*2+.000022;
export const lift=34*Math.PI/180;
export const stepTime=1/60000;
export const mass=(4/3)*Math.PI*radius**3*7800;
const elastic=(4/3)*(195e9/(2*(1-.29**2)))*Math.sqrt(radius*.5);
const contactDamping=.062;
const swingDamping=.024;

export const pivotX=(index)=>(index-(count-1)/2)*spacing;

export function initialise(lifted) {
  const system={
    angle:Float64Array.from({length:count},(_,index)=>index<lifted?-lift:0),
    velocity:new Float64Array(count),
    sin:new Float64Array(count),cos:new Float64Array(count),
    x:new Float64Array(count),y:new Float64Array(count),acceleration:new Float64Array(count),
    time:0,carry:0,contacts:0,contacting:false,
  };
  locate(system);
  system.initial=energy(system);
  return system;
}
function locate(s) {
  for(let i=0;i<count;i++){
    const angle=s.angle[i];
    const sin=Math.sin(angle),cos=Math.cos(angle);
    s.sin[i]=sin;
    s.cos[i]=cos;
    s.x[i]=pivotX(i)+length*sin;
    s.y[i]=pivotY-length*cos;
  }
}

function forces(s) {
  let touching=false;
  for(let i=0;i<count;i++)s.acceleration[i]=-gravity/length*s.sin[i]-swingDamping*s.velocity[i];
  for(let i=1;i<count;i++){
    const j=i-1;
    const dx=s.x[i]-s.x[j],dy=s.y[i]-s.y[j];
    const distance=Math.hypot(dx,dy);
    const compression=2*radius-distance;
    if(compression<=0)continue;
    const nx=dx/distance,ny=dy/distance;
    const a=nx*s.cos[j]+ny*s.sin[j],b=nx*s.cos[i]+ny*s.sin[i];
    const rate=length*(a*s.velocity[j]-b*s.velocity[i]);
    const force=elastic*compression*Math.sqrt(compression)*Math.max(0,1+contactDamping*rate);
    s.acceleration[j]-=force*a/(mass*length);
    s.acceleration[i]+=force*b/(mass*length);
    touching=true;
  }
  if(touching&&!s.contacting)s.contacts++;
  s.contacting=touching;
}

export function advance(s,seconds) {
  s.carry+=seconds;
  for(;s.carry>=stepTime;s.carry-=stepTime){
    forces(s);
    for(let i=0;i<count;i++){
      s.velocity[i]+=s.acceleration[i]*stepTime;
      s.angle[i]+=s.velocity[i]*stepTime;
    }
    s.time+=stepTime;
    locate(s);
  }
}
export function energy(s) {
  let sum=0;
  for(let i=0;i<count;i++){
    sum+=.5*mass*(length*s.velocity[i])**2+mass*gravity*(s.y[i]-restY);
    if(i){
      const compression=2*radius-Math.hypot(s.x[i]-s.x[i-1],s.y[i]-s.y[i-1]);
      if(compression>0)sum+=.4*elastic*compression**2.5;
    }
  }
  return sum;
}