
import {autoEngine} from '@margoengine/webgl2-compat/auto';
const canvas=document.querySelector('#valley');
const status=document.querySelector('#loading');
const warning=document.querySelector('#error');
const lifetime=new AbortController();
const params=new URLSearchParams(location.search);
const compatibility=params.get('backend')==='webgl2'||!navigator.gpu;
let scene,engine;
const high=import('./scene.js');
async function compat(){
  const {install}=await import('@margoengine/webgl2-compat');
  return {install:()=>install({force:true,signal:lifetime.signal})};
}
function report(error){
  if(lifetime.signal.aborted)return;
  status.hidden=true;
  warning.textContent=error.message;
  warning.hidden=false;
  document.body.dataset.error=error.message;
  console.error(error);
}
function prepareValley(){
  const worker=new Worker(new URL("./terrain-worker.js",import.meta.url),{type:"module"});
  lifetime.signal.addEventListener("abort",()=>worker.terminate(),{once:true});
  return new Promise((resolve,reject)=>{
    worker.addEventListener("message",event=>{worker.terminate();resolve(event.data);},{once:true});
    worker.addEventListener("error",event=>{worker.terminate();reject(event.error??Error(event.message));},{once:true});
    lifetime.signal.addEventListener("abort",()=>reject(lifetime.signal.reason),{once:true});
  });
}
async function open(){
  const preparation=prepareValley();
  preparation.catch(report);
  if(compatibility)await compat().then(m=>m.install());
  await autoEngine(canvas,async target=>{
    engine=target;
    engine.onError=report;
    performance.mark('alpine-device');
    scene=await (await high).install(engine,canvas,lifetime.signal,compatibility,await preparation);
  },{backend:compatibility?'webgpu':undefined,loadCompat:compat,signal:lifetime.signal,exactSize:true,antialias:false,
    camera:{near:.3,far:7800,fov:46},startupTimeout:17000});
  lifetime.signal.throwIfAborted();
  status.hidden=true;
  scene.connect();
  performance.mark('margo-first-usable-frame');
}
addEventListener('pagehide',event=>{
  if(event.persisted)return;
  lifetime.abort();
  scene?.dispose();
  engine?.dispose();
},{once:true});
open().catch(report);
