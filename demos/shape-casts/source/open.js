import {autoEngine} from '@margoengine/webgl2-compat/auto';
const life=new AbortController(),{signal}=life;
const forced=new URLSearchParams(location.search).get('backend')==='webgl2';
const hardware=import('./physics.js').then(async api=>{
  await api.loadPhysics(signal);
  performance.mark('cast-solver');
  return api;
});
hardware.catch(()=>{});
const scene=import('./scene.js');
const el=id=>document.getElementById(id);
let engine,app;
function fail(error){
  if(signal.aborted)return;
  document.body.dataset.error=error.message;
  el('loading').hidden=true;el('error').hidden=false;
  el('error').textContent=error.message;el('controls').disabled=true;
  console.error(error);
}
async function open(){
  await autoEngine(el('view'),async target=>{
    engine=target;target.onError=fail;
    performance.mark('cast-device');
    app=await (await scene).connect(engine,engine.canvas,signal,hardware,fail);
  },{backend:forced?'webgl2':undefined,exactSize:true,antialias:true,capacity:324,signal,startupTimeout:12000,
    camera:{position:[-2.35,4.2,8.0],target:[0,.75,0],near:.11,far:32}});
}
open().catch(fail);
addEventListener('pagehide',event=>{
  if(event.persisted)return;
  life.abort();app?.dispose();engine?.dispose();
});
