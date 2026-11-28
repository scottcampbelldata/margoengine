import {autoEngine} from '@margoengine/webgl2-compat/auto';

const life=new AbortController(),{signal}=life;
const forced=new URLSearchParams(location.search).get('backend')==='webgl2';
const loaded=import('./physics.js').then(async api=>{
  await api.loadPhysics(signal);
  performance.mark('factory-physics');
  return api;
});
loaded.catch(()=>{});
const view=import('./scene.js');
const element=id=>document.getElementById(id);
let engine,exhibit;

function fail(error){
  if(signal.aborted)return;
  document.body.dataset.error=error.message;
  element('controls').disabled=true;
  element('loading').hidden=true;
  element('error').hidden=false;
  element('error').textContent=error.message;
  console.error(error);
}
async function start(){
  await autoEngine(element('stage'),async target=>{
    engine=target;engine.onError=fail;
    performance.mark('factory-device');
    exhibit=await (await view).connect(engine,engine.canvas,loaded,signal,fail);
  },{backend:forced?'webgl2':undefined,signal,exactSize:true,antialias:true,capacity:650,startupTimeout:12000,
    camera:{position:[3.05,6.10,8.35],target:[.075,.97,0],near:.09,far:40}});
}
start().catch(fail);
addEventListener('pagehide',event=>{
  if(event.persisted)return;
  life.abort();
  exhibit?.dispose();
  engine?.dispose();
});
