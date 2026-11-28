import {autoEngine} from '@margoengine/webgl2-compat/auto';
const canvas=document.querySelector('#reef'),life=new AbortController(),{signal}=life;
const target=new URLSearchParams(location.search).get('backend')==='webgl2';
const view=import('./scene.js'),worker=new Worker(new URL('./coral-worker.js',import.meta.url),{type:'module'});
const pending=new Map();let engine,installation,number=0;
worker.addEventListener('message',({data})=>{
  const item=pending.get(data.id);
  if(!item)return;
  pending.delete(data.id);
  if(data.error)item.reject(Error(data.error));else item.resolve(data);
},{signal});
worker.addEventListener('error',event=>{
  for(const item of pending.values())item.reject(Error(event.message));
  pending.clear();
},{signal});
function compute(settings){
  signal.throwIfAborted();
  const id=++number;
  return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});worker.postMessage({id,...settings});});
}
const opening=compute({age:.37,current:0,initial:true});
opening.catch(()=>{});
function fail(error){
  if(signal.aborted)return;
  delete document.body.dataset.ready;document.body.dataset.error=error.message;
  document.querySelector('#loading').hidden=true;
  const notice=document.querySelector('#error');notice.hidden=false;notice.textContent=error.message;console.error(error);
}
async function compat(){
  const {install}=await import('@margoengine/webgl2-compat');
  return {install:()=>install({force:true,signal})};
}
async function open(){
  if(target||!navigator.gpu)await (await compat()).install();
  await autoEngine(canvas,async device=>{
    engine=device;engine.onError=fail;performance.mark('reef-device');
    installation=await (await view).install(engine,engine.canvas,signal,await opening,compute,fail);
  },{loadCompat:compat,signal,exactSize:true,antialias:true,camera:{near:.14,far:62,fov:44}});
  installation?.connect();
}
open().catch(fail);
addEventListener('pagehide',event=>{
  if(event.persisted)return;
  life.abort();worker.terminate();
  for(const item of pending.values())item.reject(signal.reason);
  pending.clear();installation?.dispose();engine?.dispose();
});
