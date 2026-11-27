import {Engine} from '@margoengine/core';
import {demoStatus} from 'margo-demo-status';
import {cameraFor,scenery,vesselGeometry,glazeSample} from './art.js';
import {reflectionFaces} from './reflection.js';

const by=id=>document.getElementById(id);
const canvas=by('scene'),viewport=by('viewport'),loading=by('loading'),error=by('error'),page=demoStatus(viewport,loading,error);
const controller=new AbortController(),{signal}=controller;
const forced=new URLSearchParams(location.search).get('backend')==='webgl2';
let engine,cleanup;

function fail(reason){
  if(signal.aborted||page.failed)return;
  for(const id of ['finish','restore','turn'])by(id).disabled=true;
  loading.hidden=true;
  error.hidden=false;
  page.error(reason);
}
function resize(){
  const {width,height}=canvas.getBoundingClientRect(),ratio=Math.min(devicePixelRatio||1,1.8,1360/width);
  const w=Math.round(width*ratio),h=Math.round(height*ratio);
  if(w<1||h<1||(canvas.width===w&&canvas.height===h))return false;
  canvas.width=w;canvas.height=h;
  return true;
}
async function open(){
  const opts={backend:'webgpu',exactSize:true,antialias:false,signal,startupWarning:3000,startupTimeout:8000,
    camera:cameraFor(canvas.width,canvas.height)};
  if(!forced&&navigator.gpu){
    try{
      const value=await Engine.create(canvas,opts);
      viewport.dataset.renderer='webgpu';
      return value;
    }catch(reason){
      signal.throwIfAborted();
      if(reason?.code&&!['unsupported','adapter','device','timeout','startup'].includes(reason.code))throw reason;
    }
  }
  const {install}=await import('@margoengine/webgl2-compat');
  await install({force:true,minimumTier:'half-float',signal});
  const value=await Engine.create(canvas,opts);
  viewport.dataset.renderer='webgl2';
  return value;
}

resize();
const opening=open().then(value=>{
  engine=value;
  if(signal.aborted){value.dispose();signal.throwIfAborted();}
  engine.onError=fail;
  performance.mark('engine-ready');
  return value;
});
opening.catch(fail);
const runtime=import('./scene.js');
const art={room:scenery(),vessel:vesselGeometry(),sample:glazeSample(),reflections:reflectionFaces()};
performance.mark('specimen-geometry');
runtime.then(({mount})=>{
  cleanup=mount({opening,art,canvas,viewport,loading,page,signal,fail,resize});
}).catch(fail);
addEventListener('pagehide',event=>{
  if(event.persisted)return;
  controller.abort();
  cleanup?.();
  engine?.dispose();
});
