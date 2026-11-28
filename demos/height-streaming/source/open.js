import {Engine} from '@margoengine/core';
import {demoStatus} from 'margo-demo-status';
import {tileSource} from './tiles.js';
import {home} from './art.js';

const by=id=>document.getElementById(id);
const canvas=by('scene'),viewport=by('viewport'),loading=by('loading'),error=by('error');
const status=demoStatus(viewport,loading,error);
const controller=new AbortController(),{signal}=controller;
const forced=new URLSearchParams(location.search).get('backend')==='webgl2';
const source=tileSource(signal);
let engine,cleanup;
function fail(reason){
  if(signal.aborted||status.failed)return;
  for(const id of ['flight','return','left','right'])by(id).disabled=true;
  loading.hidden=true;
  error.hidden=false;
  status.error(reason);
}
function size(){
  const rect=canvas.getBoundingClientRect(),dpr=Math.min(devicePixelRatio||1,1.8,1400/rect.width);
  const width=Math.round(rect.width*dpr),height=Math.round(rect.height*dpr);
  if(!width||!height||canvas.width===width&&canvas.height===height)return false;
  canvas.width=width;canvas.height=height;
  return true;
}
function projection(){return canvas.width/canvas.height<1.18?52:49;}
async function open(){
  const options={backend:'webgpu',exactSize:true,antialias:false,signal,startupWarning:3000,startupTimeout:9000,
    camera:{...home,fov:projection()}};
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
const opening=open().then(result=>{
  engine=result;
  if(signal.aborted){result.dispose();signal.throwIfAborted();}
  result.onError=fail;
  performance.mark('engine-ready');
  return result;
});
opening.catch(fail);
import('./scene.js').then(({mount})=>{
  cleanup=mount({opening,source,canvas,viewport,loading,status,signal,fail,size,projection});
}).catch(fail);
addEventListener('pagehide',event=>{
  if(event.persisted)return;
  controller.abort();
  cleanup?.();
  engine?.dispose();
});
