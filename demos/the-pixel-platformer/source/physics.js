import { Physics2D } from '@margoengine/physics2d';
import { checkpoint,finish,map,samples,spawn,width } from './level.js';

export const fixed=1/90;
export const loadPhysics=(wasm,signal)=>Physics2D.load({wasm,signal});
const pixelSpeed=96;
const acceleration=760;
const jumpSpeed=208;
const groundQueryDistance=12;

export function createRig(){
  const world=new Physics2D(null,{gravity:[0,560],pixelsPerMeter:32,fixedTimestep:fixed});
  const ground=world.addTileMap(map);
  const hero=world.addBody(null,{
    position:spawn,lockRotation:true,ccd:true,canSleep:false,
    colliders:{shape:'capsule',radius:5.5,height:18,restitution:0,friction:0},
  });
  world.step();
  let jumpBuffer=0,groundGrace=0,lit=0,jumps=0,rests=0,steps=0,facing=1,victory=false,onGround=true,flag=false;
  const available=new Set(samples.map((_,i)=>i));
  function floor(){
    const [x,y]=hero.position;
    return [-3,0,3].some(dx=>{
      const hit=world.raycast([x+dx,y],[0,1],{exclude:hero,maxDistance:groundQueryDistance});
      return hit?.body===ground&&hit.normal[1]<-.75&&hit.distance<=9.75;
    });
  }
  function step(direction,jump){
    if(victory)direction=0;
    let vx,vy;
    [vx,vy]=hero.linearVelocity;
    onGround=vy>=-2&&floor();
    groundGrace=onGround?.085:Math.max(0,groundGrace-fixed);
    jumpBuffer=jump&&!victory?.13:Math.max(0,jumpBuffer-fixed);
    if(jumpBuffer>0&&groundGrace>0){
      jumpBuffer=groundGrace=0;
      vy=-jumpSpeed;
      jumps++;
    }
    if(direction)facing=Math.sign(direction);
    const [x]=hero.position;
    const desired=x<9&&direction<0||x>width-11&&direction>0?0:direction*pixelSpeed;
    const change=desired-vx,limit=acceleration*fixed;
    hero.linearVelocity=[vx+Math.max(-limit,Math.min(limit,change)),vy];
    world.step();
    steps++;
    const [px,py]=hero.position;
    onGround=hero.linearVelocity[1]>=-2&&floor();
    if(!flag&&onGround&&px>289&&px<343&&py>125)flag=true;
    if(py>194){
      hero.teleport(flag?checkpoint:spawn,0);
      hero.linearVelocity=[0,0];
      groundGrace=jumpBuffer=0;
      rests++;
      return;
    }
    for(const index of available){
      const point=samples[index];
      if(Math.abs(px-point.x)<12&&Math.abs(py-point.y)<19){
        available.delete(index);
        lit++;
      }
    }
    if(lit===samples.length&&onGround&&Math.abs(px-finish[0])<12&&Math.abs(py-finish[1])<5)victory=true;
  }
  function state(){
    return {position:hero.position,velocity:hero.linearVelocity,jumps,attempts:rests,steps,lit,facing,
      collected:samples.map((_,i)=>!available.has(i)),victory,grounded:onGround,flag};
  }
  return {step,state,dispose:()=>world.dispose()};
}
