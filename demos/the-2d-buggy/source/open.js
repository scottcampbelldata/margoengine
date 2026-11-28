import {autoEngine} from '@margoengine/webgl2-compat/auto';
const life=new AbortController(),{signal}=life;
const forced=new URLSearchParams(location.search).get('backend')==='webgl2';
const solver=import('./physics.js').then(async api=>{
  await api.loadPhysics(signal);
  performance.mark('buggy-solver');
  return api;
});
solver.catch(()=>{});
const scene=import('./scene.js');
const el=id=>document.getElementById(id);
let engine,app;
function fail(error){
  if(signal.aborted)return;
  document.body.dataset.error=error.message;
  el('controls').disabled=true;
  el('loading').hidden=true;el('error').hidden=false;
  el('error').textContent=error.message;
  console.error(error);
}
async function open(){
  await autoEngine(el('view'),async target=>{
    engine=target;engine.onError=fail;
    performance.mark('buggy-device');
    app=await (await scene).connect(engine,engine.canvas,signal,solver,fail);
  },{backend:forced?'webgl2':undefined,signal,exactSize:true,antialias:true,capacity:615,startupTimeout:12000,
    camera:{position:[5,-1,27],target:[5,-1,0],near:.08,far:90}});
}
open().catch(fail);
addEventListener('pagehide',event=>{
  if(event.persisted)return;
  life.abort();app?.dispose();engine?.dispose();
});
