import { Physics } from '@margoengine/physics';
import { blockHalf,columns,depth,fixedDelta,rows,sphereRadius,terrainGrid,width } from './layout.js';

export const loadPhysics=signal=>Physics.load({signal});

export function createRain(entities){
  const world=new Physics(null,{fixedTimestep:fixedDelta,substeps:2,predictionDistance:.018});
  world.setSolver({adaptiveSubsteps:false});
  world.addBody(null,{
    type:'fixed',
    colliders:{shape:'heightfield',rows,columns,heights:terrainGrid(),scale:[width,1,depth],friction:.82,fixInternalEdges:true},
  });
  world.addBody(null,{
    type:'fixed',position:[0,-2.3,0],colliders:{shape:'box',halfExtents:[25,.25,25],friction:.89},
  });
  const bodyToInfo=new Map(),bodies=[];
  const block={shape:'box',halfExtents:[blockHalf,blockHalf,blockHalf],density:615,restitution:.13,friction:.68};
  const sphere={shape:'sphere',radius:sphereRadius,density:900,restitution:.38,friction:.57};
  for(const item of entities){
    const body=world.addBody(null,{
      position:item.position,rotation:item.rotation,colliders:item.kind==='sphere'?sphere:block,
      linearVelocity:item.velocity,linearDamping:.66,angularDamping:1.28,canSleep:true,
    });
    bodyToInfo.set(body,item);
    bodies.push(body);
  }

  function ray(origin,direction){
    const hit=world.raycast(origin,direction,{maxDistance:170});
    const item=bodyToInfo.get(hit?.body);
    return item?{...hit,item}:null;
  }
  function push(hit,direction){
    const body=hit.body,before=body.linearVelocity;
    const impulse=body.mass*5.25;
    body.applyImpulseAtPoint(direction.map(value=>value*impulse),hit.point);
    return {id:hit.item.id,kind:hit.item.kind,mass:body.mass,distance:hit.distance,change:impulse/body.mass,before};
  }
  return {world,bodies,ray,push,advance:()=>world.step(),dispose:()=>world.dispose()};
}
