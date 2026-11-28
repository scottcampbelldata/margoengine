import {Physics2D} from '@margoengine/physics2d';
import {balks,guides,release,maxCutouts} from './layout.js';

export async function openPress(signal,wasm){
  await Physics2D.load({signal,wasm});
  signal.throwIfAborted();
  const world=new Physics2D(null,{gravity:[0,930],pixelsPerMeter:94,maxSubsteps:4,interpolate:true});
  const staticFrame={friction:.52,restitution:.14};
  for(const {name,x,y,w,h,rotation} of balks){
    world.addBody(null,{type:'fixed',position:[x,y],rotation,userData:{kind:'fixture',name},
      colliders:{shape:'box',width:w,height:h,...staticFrame}});
  }
  for(const {name,x,y,radius} of guides){
    world.addBody(null,{type:'fixed',position:[x,y],userData:{kind:'fixture',name},
      colliders:{shape:'circle',radius,friction:.25,restitution:.31}});
  }
  const drops=[];
  let serial=0,totalHits=0,latestImpact=null;
  world.on('contactstart',event=>{
    const cut=[event.bodyA,event.bodyB].find(body=>body.userData?.kind==='cutout');
    if(!cut)return;
    const item=cut.userData.item;
    item.impacts++;
    totalHits++;
    const other=event.bodyA===cut?event.bodyB:event.bodyA;
    latestImpact={x:cut.position[0],y:cut.position[1],kind:other.userData?.name??'cutout'};
  });
  function releasePaper(capture){
    if(!capture.shapes.length||drops.length>=maxCutouts)return null;
    const id=++serial,offset=[0,21,-23,35,-44,12,-11,30,-28,3][drops.length];
    const position=[release[0]+offset,release[1]];
    const rotation=[.18,-.17,.31,-.38,.05][drops.length%5];
    const pose={x:position[0],y:position[1],rotation};
    const body=world.addBody(pose,{position,rotation,ccd:true,linearDamping:.12,angularDamping:.36,
      colliders:capture.shapes});
    const item={id,index:drops.length,pose,body,impacts:0,hash:capture.hash,initialY:position[1]};
    body.userData={kind:'cutout',item};
    body.linearVelocity=[7.2,0];
    body.angularVelocity=(id%2===1?.38:-.31);
    drops.push(item);
    return item;
  }
  function advance(elapsed){world.update(elapsed);}
  function clear(){
    for(const {body} of drops)body.remove();
    drops.length=0;totalHits=0;latestImpact=null;
  }
  function data(){
    return {count:drops.length,totalHits,latest:drops.at(-1),latestImpact,
      sleeping:drops.filter(item=>item.body.sleeping).length};
  }
  function dispose(){world.dispose();}
  return {releasePaper,advance,clear,data,dispose};
}
