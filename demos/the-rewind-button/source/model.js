import {cadence,crate,drum,interval,startPoses,ticks,track} from './course.js';

export function createReplay(KernelWorld){
  const world=new KernelWorld(73,76).setGravity(0,-9.81,0);
  world.substeps=4;
  world.setSolver({adaptiveSubsteps:false});
  const starting=startPoses();
  for(const {p,half} of Object.values(track)){
    const body=world.addBody('fixed');
    world.setPose(body,p,[0,0,0,1]);
    world.addCollider(body,'box',half,{friction:.57,restitution:.10});
  }
  const ids=starting.map(({p,q},i)=>{
    const body=world.addBody('dynamic');
    world.setPose(body,p,q);
    world.addCollider(body,i===0?'cylinder':'box',i===0?drum:crate,{
      density:i===0?6200:680,friction:i===0?.54:.48,restitution:i===0?.07:.13,
    });
    if(i===0)world.setCcd(body,true);
    return body;
  });
  const origin=world.snapshot();
  let history=[],recorded=0,current=0,storage=0,source=0,restores=0;
  function checkpoint(){
    const bytes=world.snapshot();
    storage+=bytes.byteLength;
    history.push({tick:current,bytes});
  }
  function begin(){
    world.restore(origin);
    const id=ids[0],c=world.columns;
    c.linearX[id]=3.8;
    c.angularZ[id]=-3.8/drum[0];
    history=[];recorded=0;current=0;storage=0;source=0;restores=0;
    checkpoint();
  }
  function advance(count){
    if(current!==recorded)throw new Error('The rewind is separate from recording a run.');
    for(let i=0;i<count&&current<ticks;i++){
      world.step(interval);
      current++;
      if(current%cadence===0)checkpoint();
    }
    recorded=current;
  }
  function seek(k){
    const goal=Math.max(0,Math.min(recorded,Math.trunc(k)));
    const saved=history[Math.floor(goal/cadence)];
    if(!saved)return;
    world.restore(saved.bytes);
    source=saved.tick;
    restores++;
    for(let i=saved.tick;i<goal;i++)world.step(interval);
    current=goal;
  }
  function sample(){
    const c=world.columns;
    return {
      states:ids.map((id,i)=>({
        p:[c.positionX[id],c.positionY[id],c.positionZ[id]],
        q:[c.rotationX[id],c.rotationY[id],c.rotationZ[id],c.rotationW[id]],
        ink:starting[i].ink,
      })),
      current,recorded,storage,source,restores,checkpoints:history.length,hash:world.hash,
    };
  }
  return {begin,advance,seek,sample};
}
