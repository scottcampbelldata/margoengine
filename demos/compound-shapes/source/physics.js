import { Physics } from '@margoengine/physics';
import { deck,fixed,ramp,specimens } from './layout.js';

export const loadPhysics=signal=>Physics.load({signal});

export function openRig(roots){
  const world=new Physics(null,{fixedTimestep:fixed,substeps:6});
  const makeStand=(part,rotation)=>{
    return world.addBody(null,{type:'fixed',position:part.position,rotation,colliders:{
      shape:'box',halfExtents:part.size.map(value=>value/2),friction:.58,restitution:.06,
    }});
  };
  const rampRotation=[Math.sin(ramp.angle/2),0,0,Math.cos(ramp.angle/2)];
  const supports=[makeStand(deck),makeStand(ramp,rampRotation)];
  world.addBody(null,{type:'fixed',position:[0,-.20,0],colliders:{shape:'box',halfExtents:[12,.025,12],friction:.75}});
  const bodies=specimens.map((item,index)=>world.addBody(roots?.[index]??null,{
    position:item.position,rotation:item.rotation,linearDamping:.21,angularDamping:.28,
    colliders:{
      shape:'compound',density:item.density,friction:.54,restitution:.18,
      parts:item.parts.map(({name,finish,...part})=>part),
    },
  }));
  const observations=bodies.map(body=>({mass:body.mass,center:body.centerOfMass,inertia:body.principalInertia}));
  const contacts=bodies.map(()=>0);
  world.on('afterstep',()=>{
    for(let index=0;index<bodies.length;index++){
      const body=bodies[index];
      if(supports.some(support=>world.touching(body,support)))contacts[index]++;
    }
  });
  function stats(){
    return bodies.map((body,index)=>{
      const one=specimens[index].rotation,two=body.rotation;
      const dot=one.reduce((sum,value,i)=>sum+value*two[i],0)/(Math.hypot(...one)*Math.hypot(...two));
      return {steps:world.stepCount,height:body.position[1],
        rotation:2*Math.acos(Math.min(1,Math.abs(dot))),contacts:contacts[index],sleeping:body.sleeping};
    });
  }
  return {world,bodies,observations,stats,tumble(){for(const body of bodies)body.applyTorqueImpulse([1.85,0,.52]);},dispose:()=>world.dispose()};
}
