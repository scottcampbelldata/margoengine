import {autoEngine} from '@margoengine/webgl2-compat/auto';
const canvas=document.querySelector('#dungeon'),life=new AbortController(),{signal}=life;
const state=document.body.dataset,force=new URLSearchParams(location.search).get('backend')==='webgl2';
const view=import('./scene.js'),worker=new Worker(new URL('./layout-worker.js',import.meta.url),{type:'module'});
const replies=new Map();
let engine,installed,counter=0;
function fail(error){
  if(signal.aborted)return;
  state.error=error.message;delete state.ready;
  document.querySelector('#loading').hidden=true;
  const notice=document.querySelector('#error');
  notice.hidden=false;notice.textContent=error.message;
  console.error(error);
}
worker.addEventListener('message',({data})=>{
  const reply=replies.get(data.id);
  if(!reply)return;
  replies.delete(data.id);
  if(data.error)reply.reject(Error(data.error));else reply.resolve(data.result);
},{signal});
worker.addEventListener('error',event=>{
  for(const reply of replies.values())reply.reject(Error(event.message));
  replies.clear();
},{signal});
function generate(seed){
  signal.throwIfAborted();
  const id=++counter;
  return new Promise((resolve,reject)=>{replies.set(id,{resolve,reject});worker.postMessage({seed,id});});
}
const opening=generate(271828);
opening.catch(()=>{});
async function compat(){
  const {install}=await import('@margoengine/webgl2-compat');
  return {install:()=>install({force:true,signal})};
}
async function open(){
  if(force||!navigator.gpu)await (await compat()).install();
  await autoEngine(canvas,async target=>{
    engine=target;engine.onError=fail;performance.mark('dungeon-device');
    installed=await (await view).install(engine,target.canvas,signal,await opening,generate,fail);
  },{loadCompat:compat,signal,exactSize:true,antialias:true,camera:{fov:62,near:.055,far:140}});
  installed?.connect();
}
open().catch(fail);
addEventListener('pagehide',event=>{
  if(event.persisted)return;
  life.abort();worker.terminate();
  for(const reply of replies.values())reply.reject(signal.reason);
  replies.clear();installed?.dispose();engine?.dispose();
});
