import {autoEngine} from '@margoengine/webgl2-compat/auto';

const life=new AbortController(),{signal}=life;
const forced=new URLSearchParams(location.search).get('backend')==='webgl2';
const machine=import('./physics.js').then(async api=>{
  await api.loadPhysics(signal);
  performance.mark('pinball-physics');
  return api;
});
machine.catch(()=>{});
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
    performance.mark('pinball-device');
    app=await (await scene).connect(engine,engine.canvas,machine,signal,fail);
  },{backend:forced?'webgl2':undefined,exactSize:true,antialias:true,capacity:420,signal,startupTimeout:12000,
    camera:{position:[.35,1.29,1.34],target:[0,.006,-.011],near:.05,far:16}});
}
open().catch(fail);
addEventListener('pagehide',event=>{
  if(event.persisted)return;
  life.abort();app?.dispose();engine?.dispose();
});
