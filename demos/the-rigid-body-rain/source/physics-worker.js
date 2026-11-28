import { createRain,loadPhysics } from './physics.js';
import { layout } from './layout.js';
import { camera,dot,forward,origin,pace,right,up } from './view.js';

const entities=layout();
let model,run=1,inputs=0,lastHit=null,lastTick=0,timer,playing=false;
const interval=1000/pace;
await loadPhysics();
postMessage({type:'kernel'});
model=createRain(entities);
sendFrame(0,true);

function sendFrame(work,reset=false){
  const poses=new Float32Array(entities.length*7);
  for(let i=0;i<model.bodies.length;i++){
    const pose=model.bodies[i].pose;
    for(let j=0;j<7;j++)poses[7*i+j]=pose[7+j];
  }
  const awake=model.world.counts.awake||(
    model.world.stepCount===0?entities.length:0
  );
  if(lastHit&&model.world.stepCount>lastTick&&lastHit.observed===undefined){
    const velocity=model.bodies[lastHit.id].linearVelocity;
    lastHit.observed=Math.hypot(...velocity.map((value,i)=>value-lastHit.before[i]));
  }
  postMessage({type:'frame',poses,awake,run,inputs,steps:model.world.stepCount,work,total:entities.length,
    hit:lastHit,highlight:!!lastHit&&model.world.stepCount-lastTick<36,reset},[poses.buffer]);
  return awake;
}
function step(){
  const start=performance.now();
  model.advance();
  const awake=sendFrame(performance.now()-start);
  playing=awake>0;
  if(playing)timer=setTimeout(step,Math.max(1,interval-(performance.now()-start)));
}
function start(){
  if(playing)return;
  playing=true;
  timer=setTimeout(step,0);
}
function centerRay(){
  const center=model.ray(camera.position,forward);
  if(center)return center;
  let best,nearest=Infinity;
  for(const body of model.bodies){
    const offset=body.position.map((value,index)=>value-camera.target[index]);
    const dx=dot(offset,right),dy=dot(offset,up),distance=dx*dx+dy*dy;
    if(distance<nearest){best=[dx,dy];nearest=distance;}
  }
  return best?model.ray(origin(...best),forward):null;
}

self.onmessage=({data})=>{
  try{
    if(data.type==='drop'){
      clearTimeout(timer);
      playing=false;
      lastHit=null;
      run++;
      model.dispose();
      model=createRain(entities);
      sendFrame(0,true);
      start();
      return;
    }
    const hit=data.type==='center'?centerRay():model.ray(data.origin,forward);
    if(!hit)return;
    lastHit=model.push(hit,forward);
    lastTick=model.world.stepCount;
    inputs++;
    start();
  }catch(error){
    clearTimeout(timer);
    postMessage({type:'error',message:error.message});
  }
};
