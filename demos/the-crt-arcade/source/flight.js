export const laneWidth=3.18;
export const elevation=1.13;
export const alignTolerance=.49;
export const relativeGateZ=[-11.2,-25.8,-40.3,-54.8,-68.4,-83.1];
export const course=[0,1,-1,0,-1,1].map((lane,i)=>({lane,x:lane*laneWidth,z:relativeGateZ[i]}));

const speed=4.95;
const maxShift=9.4;
const acceleration=35;
const lastZ=relativeGateZ.at(-1)-9.5;
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));

export function flight(){
  let phase='idle',lane=0,position=0,velocity=0,z=0,follow=0,elapsed=0,bank=0,correct=0,next=0;
  const gates=course.map(()=>0);
  const events=[];
  function reset(){
    phase='idle';
    lane=position=velocity=z=follow=elapsed=bank=correct=next=0;
    gates.fill(0);
    events.length=0;
  }
  function choose(value){
    if(phase==='finished'||next===course.length)return;
    lane=clamp(Math.round(value),-1,1);
  }
  function toggle(){
    if(phase==='finished')reset();
    phase=phase==='running'?'paused':'running';
  }
  function pause(){if(phase==='running')phase='paused';}
  function step(dt){
    if(phase!=='running'||dt<=0)return;
    const previousX=position,previousZ=z;
    const desired=lane*laneWidth;
    const gap=desired-position;
    const wanted=clamp(gap*6.3,-maxShift,maxShift);
    velocity+=clamp(wanted-velocity,-acceleration*dt,acceleration*dt);
    position=clamp(position+velocity*dt,-laneWidth-.1,laneWidth+.1);
    if(gap*(desired-position)<0){position=desired;velocity=0;}
    follow+=(position-follow)*(1-Math.exp(-dt*4));
    bank+=(-velocity*.028-bank)*(1-Math.exp(-dt*8));
    elapsed+=dt;
    z=Math.max(lastZ,z-dt*speed);
    while(next<course.length&&z<=course[next].z){
      const gate=course[next];
      const ratio=(gate.z-previousZ)/(z-previousZ);
      const crossingX=previousX+ratio*(position-previousX);
      const error=Math.abs(crossingX-gate.x);
      const passed=error<=alignTolerance;
      gates[next]=passed?1:-1;
      events.push({index:next,z:gate.z,x:crossingX,error,passed});
      next++;
      correct+=Number(passed);
      if(next===course.length)lane=0;
    }
    if(z===lastZ){phase='finished';velocity=0;}
  }
  function state(){
    return {phase,lane,position,z,follow,bank,correct,next,gates:[...gates],elapsed,
      lastEvent:events.at(-1)??null,velocity};
  }
  return {choose,toggle,pause,step,state,reset};
}
