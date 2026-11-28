import {Engine} from '@margoengine/core';
import {webglRenderer} from '@margoengine/webgl2-compat/preview';
import {connect} from './scene.js';
const canvas=document.querySelector('#land'),life=new AbortController(),{signal}=life;
const state=document.body.dataset;
const force=new URLSearchParams(location.search).get('backend')==='webgl2';
const worker=new Worker(new URL('./route-worker.js',import.meta.url),{type:'module'});
let engine,scene,seq=0;
const waiting=new Map();
worker.addEventListener('message',({data})=>{
  const pending=waiting.get(data.id);
  if(!pending)return;
  waiting.delete(data.id);
  if(data.error)pending.reject(new Error(data.error));
  else pending.resolve(data.value);
},{signal});
worker.addEventListener('error',event=>{
  for(const pending of waiting.values())pending.reject(new Error(event.message));
  waiting.clear();
},{signal});
function request(options){
  signal.throwIfAborted();
  const id=++seq;
  return new Promise((resolve,reject)=>{waiting.set(id,{resolve,reject});worker.postMessage({id,...options});});
}
const starter=request({spur:null,bank:8});
starter.catch(()=>{});
function fail(error){
  if(signal.aborted)return;
  state.error=error.message;delete state.ready;
  document.querySelector('#loading').hidden=true;
  const notice=document.querySelector('#error');
  notice.hidden=false;notice.textContent=error.message;console.error(error);
}
async function open(){
  engine=await Engine.create(canvas,{
    ...(force?{backend:'webgl2'}:{}),fallback:webglRenderer,exactSize:true,antialias:true,signal,
    camera:{fov:44,near:.4,far:860}
  });
  engine.onError=fail;
  performance.mark('roads-device');
  const original=await starter;
  performance.mark('roads-start-network');
  scene=await connect(engine,canvas,signal,original,request,fail);
}
open().catch(fail);
addEventListener('pagehide',event=>{
  if(event.persisted)return;
  life.abort();worker.terminate();
  for(const pending of waiting.values())pending.reject(signal.reason);
  waiting.clear();scene?.dispose();engine?.dispose();
});
