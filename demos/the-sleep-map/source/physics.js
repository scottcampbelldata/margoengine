import {Physics} from '@margoengine/physics';
import {PhysicsDebugView} from '@margoengine/physics/debug-view';
import {bays,pellets,links,count,countPerBay,radius,mass,floor,pitch,impulse,frequency} from './layout.js';

export async function createSimulation(signal){
  await Physics.load({signal});
  signal?.throwIfAborted();
  const world=new Physics(null,{fixedTimestep:1/frequency,lengthUnit:.24,predictionDistance:.003,
    substeps:4,iterations:2,interpolate:false});
  for(const {center:[x,z]} of bays){
    world.addBody(null,{type:'fixed',position:[x,floor-.023,z],colliders:{
      shape:'cylinder',halfHeight:.023,radius:.319,friction:.79,restitution:.07}});
  }
  const bodies=pellets.map(({x,y,z})=>{
    const body=world.addBody(null,{position:[x,y,z],linearDamping:4.8,angularDamping:8,
      colliders:{shape:'sphere',radius,mass,friction:.55,restitution:.12}});
    body.sleepThreshold=.033;
    body.sleepTime=.47;
    return body;
  });
  for(const [i,j] of links){
    world.addJoint(bodies[i],bodies[j],{type:'spring',restLength:pitch,stiffness:11.8,damping:.21,
      contactsEnabled:true});
  }
  const debug=new PhysicsDebugView(world,{world:{
    colliders:false,joints:true,contacts:true,
    style:{joint:[.43,.86,.90,.84],contact:[1,.60,.29,1],normalLength:.021},
  }});
  let time=0,serial=0;
  function step(n){
    for(let i=0;i<n;i++){world.step();time++;}
  }
  function strike(bay){
    const i=bay*countPerBay;
    bodies[i].applyImpulse([.0024,impulse,-.0018]);
    serial++;
  }
  function state(overlay=false){
    const positions=new Float32Array(count*3),flags=new Uint8Array(count),byBay=[0,0,0,0];
    for(let i=0;i<count;i++){
      const body=bodies[i];
      positions.set(body.position,i*3);
      if(!body.sleeping){flags[i]=1;byBay[pellets[i].bay]++;}
    }
    return {positions,flags,byBay,islands:world.counts.islands,contacts:world.counts.contactsSolved,step:time,serial,
      traces:overlay?debug.collect():null,links:links.length};
  }
  function dispose(){debug.dispose();world.dispose();}
  step(1);
  return {step,strike,state,dispose};
}
