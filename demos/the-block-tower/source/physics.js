import { DragJoint,Physics } from '@margoengine/physics';
import { baseHeight,beamSize,fixedDelta,floorHeight,plinthSize,towerLayout } from './layout.js';

export const loadPhysics=signal=>Physics.load({signal});

export function createTower(){
  const world=new Physics(null,{fixedTimestep:fixedDelta});
  world.addBody(null,{type:'fixed',position:[0,baseHeight-.01,0],colliders:{
    shape:'box',halfExtents:[plinthSize[0]/2,.01,plinthSize[1]/2],friction:.65,
  }});
  world.addBody(null,{type:'fixed',position:[0,floorHeight-.025,0],colliders:{
    shape:'box',halfExtents:[3,.025,3],friction:.78,
  }});
  const entities=towerLayout();
  for(const entity of entities){
    const {center,rotation,size}=entity;
    const colliders={shape:'box',halfExtents:size.map(value=>value/2),density:'oak',friction:.52,restitution:.04};
    entity.body=world.addBody(null,{position:center,rotation,colliders,linearDamping:.25,angularDamping:.28,canSleep:true});
    entity.body.sleep();
  }
  world.step();
  let held=null,collapsed=false,removed=0,steps=0;
  function grip(entity,sign){
    if(held||collapsed||entity.removed||entity.slot===null)return false;
    const body=entity.body;
    const pos=body.position;
    const axis=entity.axis.map(a=>a*sign);
    const origin=Array.from(pos,(value,index)=>value+axis[index]*beamSize[0]*.38);
    const joint=new DragJoint(world,body,origin,{frequency:9,damping:.93,maxForce:23});
    for(const item of entities)if(!item.removed)item.body.wakeUp();
    held={entity,joint,axis,origin,start:pos,distance:0};
    return true;
  }
  function target(distance){
    if(!held)return;
    held.distance=Math.max(0,Math.min(.33,distance));
    held.joint.setTarget(held.origin.map((value,index)=>value+held.axis[index]*held.distance));
  }
  function release(){
    if(!held)return false;
    held.joint.remove();
    held=null;
    return true;
  }
  function advance(){
    world.step();
    steps++;
    for(const entity of entities){
      const p=entity.body.position;
      if(entity===held?.entity&&!entity.removed&&Math.hypot(p[0]-entity.center[0],p[2]-entity.center[2])>.245){
        entity.removed=true;
        removed++;
      }
      if(entity.slot===null&&entity.course>=2&&
        (p[1]<entity.center[1]-.072||Math.hypot(p[0],p[2])>.144)){
        collapsed=true;
      }
    }
    if(held?.entity.removed&&Math.hypot(...held.entity.body.linearVelocity)<.28)release();
  }
  function state(){
    return {held,removed,collapsed,steps,sleeping:entities.filter(({body})=>body.sleeping).length};
  }
  return {world,entities,grip,target,release,advance,state,dispose:()=>world.dispose()};
}
