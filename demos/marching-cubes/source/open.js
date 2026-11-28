import {Engine} from '@margoengine/core';
import {demoStatus} from 'margo-demo-status';
import {cameraFor,setting,glassGeometry} from './art.js';

const by=id=>document.getElementById(id);
const canvas=by('scene'),viewport=by('viewport'),loading=by('loading'),error=by('error');
const status=demoStatus(viewport,loading,error);
const controller=new AbortController(),{signal}=controller;
const forced=new URLSearchParams(location.search).get('backend')==='webgl2';
const controls=['threshold','pause','wire'];
let engine,close,pending;
const worker=new Worker(new URL('./wax-worker.js',import.meta.url),{type:'module'});
worker.onmessage=({data})=>{
  const request=pending;
  pending=undefined;
  if(!request)return;
  if(data.error)request.reject(new Error(data.error));else request.resolve(data);
};
worker.onerror=event=>{
  const message=event.message||'The surface worker stopped.';
  pending?.reject(new Error(message));
  pending=undefined;
  fail(new Error(message));
};
function extract(request){
  signal.throwIfAborted();
  return new Promise((resolve,reject)=>{
    if(pending){reject(new Error('The lamp already has a surface request.'));return;}
    pending={resolve,reject};
    worker.postMessage(request);
  });
}
function fail(reason){
  if(signal.aborted||status.failed)return;
  for(const id of controls)by(id).disabled=true;
  loading.hidden=true;error.hidden=false;
  status.error(reason);
}
function size(){
  const {width,height}=canvas.getBoundingClientRect(),ratio=Math.min(devicePixelRatio||1,1.8,1400/width);
  const w=Math.round(width*ratio),h=Math.round(height*ratio);
  if(!w||!h||canvas.width===w&&canvas.height===h)return false;
  canvas.width=w;canvas.height=h;
  return true;
}
async function open(){
  const options={backend:'webgpu',exactSize:true,antialias:true,signal,startupWarning:3000,startupTimeout:9000,
    camera:cameraFor(canvas.width,canvas.height)};
  if(!forced&&navigator.gpu){
    try{
      const result=await Engine.create(canvas,options);
      viewport.dataset.renderer='webgpu';
      return result;
    }catch(reason){
      signal.throwIfAborted();
      if(reason?.code&&!['unsupported','adapter','device','timeout','startup'].includes(reason.code))throw reason;
    }
  }
  const {install}=await import('@margoengine/webgl2-compat');
  await install({force:true,minimumTier:'half-float',signal});
  const result=await Engine.create(canvas,options);
  viewport.dataset.renderer='webgl2';
  return result;
}
size();
const initial=extract({revision:0,time:0,level:.71,wire:false});
initial.catch(fail);
const opening=open().then(result=>{
  engine=result;
  if(signal.aborted){result.dispose();signal.throwIfAborted();}
  result.onError=fail;
  performance.mark('engine-ready');
  return result;
});
opening.catch(fail);
const art=Promise.resolve().then(()=>({room:setting(),vessel:glassGeometry()}));
Promise.all([import('./scene.js'),art]).then(([{mount},art])=>{
  close=mount({opening,initial,extract,art,canvas,viewport,loading,status,controls,signal,fail,size});
}).catch(fail);
addEventListener('pagehide',event=>{
  if(event.persisted)return;
  controller.abort();
  pending?.reject(signal.reason);
  pending=undefined;
  worker.terminate();
  close?.();
  engine?.dispose();
});
