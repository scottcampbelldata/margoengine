import {Physics2D} from '@margoengine/physics2d';
import {Vehicle2D} from '@margoengine/physics2d/vehicle';
import {delta,firstX,radius,roadElevation,startX,trail,wheelSpacing,checkpoints} from './terrain.js';

import {unpackKernel} from './transport.js';

export const loadPhysics=async signal=>{
  const wasm=await unpackKernel(signal);
  return Physics2D.load({signal,wasm});
};

export function makeBuggy(){
  const world=new Physics2D(null,{pixelsPerMeter:1,fixedTimestep:delta,gravity:[0,9.81]});
  world.addBody(null,{type:'fixed',position:[0,0],colliders:{shape:'polyline',points:trail,friction:.86}});
  const body=world.addBody(null,{
    position:[startX,roadElevation(startX)-.78],
    colliders:{shape:'box',width:2.48,height:.49,mass:650,friction:.57},
    linearDamping:.18,angularDamping:1.74,canSleep:false,ccd:true
  });
  const wheel=x=>({
    position:[x,.18],radius,suspensionRestLength:.39,maxSuspensionTravel:.31,
    suspensionStiffness:43,suspensionCompression:4.8,suspensionRelaxation:5.2,
    maxSuspensionForce:6200,frictionSlip:1.55
  });
  const buggy=new Vehicle2D(world,body,{
    wheels:[wheel(-wheelSpacing*.5),wheel(wheelSpacing*.5)],maxEngineForce:2120,maxBrakeForce:4500
  });
  let tick=0,stage=0,mode='park',high=startX;
  buggy.setInput({throttle:0,brake:1});
  for(let i=0;i<40;i++)world.step();
  function control(next){
    mode=next;
  }
  function step(){
    const [x,y]=body.position;
    const speed=buggy.speed;
    let throttle=0,brake=0;
    if(mode==='drive'||mode==='reverse'){
      const forward=mode==='drive',direction=forward?1:-1;
      const remaining=forward?checkpoints.at(-1)+2-x:x-(firstX+4);
      const target=Math.min(forward?11.4:4.2,Math.sqrt(Math.max(0,remaining)*5.25));
      const difference=target-speed*direction;
      if(speed*direction<-.42)brake=Math.min(.57,Math.abs(speed)*.29);
      else if(difference>=0)throttle=direction*Math.min(1,difference*.36);
      else brake=Math.min(.56,-difference*.61);
      if(remaining<.18&&Math.abs(speed)<.45){mode='park';throttle=0;brake=1;}
    }else brake=mode==='brake'?.58:.38;
    buggy.setInput({throttle,brake});
    world.step();
    tick++;
    high=Math.max(high,body.position[0]);
    while(stage<checkpoints.length&&high>=checkpoints[stage])stage++;
    if(y>8.6||Math.abs(body.rotation)>1.92)mode='recover';
  }
  function state(){
    return {p:body.position,angle:body.rotation,speed:buggy.speed,tick,stage,mode,high,
      wheels:[0,1].map(i=>{
        const measured=buggy.wheel(i);
        return {center:buggy.wheelCenter(i),hard:measured.hardPoint,spin:measured.rotation,contact:measured.inContact,
          travel:measured.suspensionLength,normal:measured.contactNormal};
      })};
  }
  return {step,control,state,dispose(){buggy.dispose();world.dispose();}};
}
