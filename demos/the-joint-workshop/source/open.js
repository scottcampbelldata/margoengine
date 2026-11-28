import {autoEngine} from '@margoengine/webgl2-compat/auto';

const byId=id=>document.getElementById(id);
const life=new AbortController(),{signal}=life;
const force=new URLSearchParams(location.search).get('backend')==='webgl2';
const source=import('./physics.js').then(async api=>{
  await api.loadPhysics(signal);
  performance.mark('workshop-physics');
  return api;
});
source.catch(()=>{});
const view=import('./scene.js');
let engine,exhibit;
function fail(error){
  if(signal.aborted)return;
  document.body.dataset.error=error.message;
  byId('controls').disabled=true;
  byId('loading').hidden=true;
  byId('error').hidden=false;
  byId('error').textContent=error.message;
  console.error(error);
}
async function start(){
  await autoEngine(byId('view'),async target=>{
    engine=target;engine.onError=fail;
    performance.mark('workshop-device');
    exhibit=await (await view).connect(engine,engine.canvas,source,signal,fail);
  },{backend:force?'webgl2':undefined,signal,capacity:300,exactSize:true,antialias:true,startupTimeout:12000,
    camera:{position:[1.05,2.20,7.2],target:[0,1.12,.19],near:.14,far:42}});
}
start().catch(fail);
addEventListener('pagehide',event=>{
  if(event.persisted)return;
  life.abort();
  exhibit?.dispose();
  engine?.dispose();
});
