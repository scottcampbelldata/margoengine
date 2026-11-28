
import {autoEngine} from '@margoengine/webgl2-compat/auto';
import photograph from './coast-radiance.webp?url';
import lighting from './coast-ibl.bin?url';
const canvas=document.getElementById('vehicle'),errorPane=document.getElementById('error'),status=document.body.dataset;
const lifetime=new AbortController(),{signal}=lifetime;
const fallback=new URLSearchParams(location.search).get('backend')==='webgl2'||!navigator.gpu;
const scene=fallback?import('./direct.js'):import('./scene.js');
let engine,viewer;
async function fetchAsset(url,decode){
  const response=await fetch(url,{signal});
  if(!response.ok)throw Error('Could not load the coastal exhibit ('+response.status+').');
  return decode(response);
}
const photo=fetchAsset(photograph,response=>response.blob());
const field=fetchAsset(lighting,response=>new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
function prepareCar(){
  const worker=new Worker(new URL("./car-worker.js",import.meta.url),{type:"module"});
  worker.postMessage(fallback);
  signal.addEventListener("abort",()=>worker.terminate(),{once:true});
  return new Promise((resolve,reject)=>{
    worker.addEventListener("message",event=>{worker.terminate();resolve(event.data);},{once:true});
    worker.addEventListener("error",event=>{worker.terminate();reject(event.error??Error(event.message));},{once:true});
    signal.addEventListener("abort",()=>reject(signal.reason),{once:true});
  });
}
const car=prepareCar();
function fail(error){
  if(signal.aborted)return;
  delete status.ready;
  status.error=error.message;
  document.getElementById('loading').hidden=true;
  errorPane.textContent=error.message;errorPane.hidden=false;
  console.error(error);
}
photo.catch(fail);field.catch(fail);car.catch(fail);
async function compat(){
  const {install}=await import('@margoengine/webgl2-compat');
  return {install:()=>install({force:true,signal})};
}
async function open(){
  if(fallback){
    const opened=await (await scene).openDirect(canvas,photo,car,field,signal,fail);
    engine=opened.engine;viewer=opened.view;
  }else await autoEngine(canvas,async target=>{
    engine=target;engine.onError=fail;
    performance.mark('ground-device');
    const module=await scene;
    viewer=await module.install(target,canvas,photo,car,field,signal);
  },{loadCompat:compat,signal,exactSize:true,antialias:true,camera:{near:.08,far:100,fov:42},startupTimeout:16000});
  signal.throwIfAborted();
  document.getElementById('loading').hidden=true;
  viewer.connect();
  performance.mark('margo-first-usable-frame');
}
addEventListener('pagehide',event=>{
  if(event.persisted)return;
  lifetime.abort();viewer?.dispose();engine?.dispose();
},{once:true});
open().catch(fail);
