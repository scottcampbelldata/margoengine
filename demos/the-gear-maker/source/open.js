import {autoEngine} from '@margoengine/webgl2-compat/auto';
const canvas=document.querySelector('#bench'),life=new AbortController(),{signal}=life;
const force=new URLSearchParams(location.search).get('backend')==='webgl2';
const worker=new Worker(new URL('./train-worker.js',import.meta.url),{type:'module'}),requests=new Map();
const view=import('./scene.js');
let engine,exhibit,requestId=0;
worker.addEventListener('message',({data})=>{
  const task=requests.get(data.id);
  if(!task)return;
  requests.delete(data.id);
  if(data.error)task.reject(Error(data.error));else task.resolve(data.train);
},{signal});
worker.addEventListener('error',event=>{
  for(const task of requests.values())task.reject(Error(event.message));
  requests.clear();
},{signal});
function build(counts){
  signal.throwIfAborted();
  const id=++requestId;
  return new Promise((resolve,reject)=>{requests.set(id,{resolve,reject});worker.postMessage({id,counts});});
}
const opening=build({a:20,b:39,c:23,d:48});
opening.catch(()=>{});
function fail(error){
  if(signal.aborted)return;
  const state=document.body.dataset;
  delete state.ready;state.error=error.message;document.querySelector('#loading').hidden=true;
  const alert=document.querySelector('#error');alert.hidden=false;alert.textContent=error.message;
  console.error(error);
}
async function compat(){
  const {install}=await import('@margoengine/webgl2-compat');
  return {install:()=>install({force:true,signal})};
}
async function start(){
  if(force||!navigator.gpu)await (await compat()).install();
  await autoEngine(canvas,async target=>{
    engine=target;engine.onError=fail;performance.mark('gear-device');
    exhibit=await (await view).connect(engine,engine.canvas,signal,await opening,build,fail);
  },{loadCompat:compat,signal,exactSize:true,antialias:true,camera:{near:.1,far:60,fov:44}});
}
start().catch(fail);
addEventListener('pagehide',event=>{
  if(event.persisted)return;
  life.abort();worker.terminate();
  for(const pending of requests.values())pending.reject(signal.reason);
  requests.clear();exhibit?.dispose();engine?.dispose();
});
