import {Engine} from '@margoengine/core';
import {demoStatus} from 'margo-demo-status';
import {cameraFor,enclosure,ringGeometry,witnessGeometry} from './art.js';
import {startBaker,startCompatBaker} from './bake-engine.js';

const by=id=>document.getElementById(id);
const canvas=by('scene'),viewport=by('viewport'),loading=by('loading'),error=by('error');
const status=demoStatus(viewport,loading,error);
const controller=new AbortController(),{signal}=controller;
const forced=new URLSearchParams(location.search).get('backend')==='webgl2';
const separate=forced||!navigator.gpu;
const controls=['rust','wood','stone','rebake','detail','light'];
let engine,close;
function fail(reason){
  if(signal.aborted||status.failed)return;
  for(const id of controls)by(id).disabled=true;
  loading.hidden=true;error.hidden=false;
  status.error(reason);
}
function size(){
  const {width,height}=canvas.getBoundingClientRect(),ratio=Math.min(devicePixelRatio||1,1.8,1420/width);
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
const opening=open().then(result=>{
  engine=result;
  if(signal.aborted){result.dispose();signal.throwIfAborted();}
  engine.onError=fail;
  performance.mark('engine-ready');
  return result;
});
opening.catch(fail);
const baking=(separate?startCompatBaker(opening,signal):opening.then(engine=>startBaker(engine,signal))).then(factory=>{
  performance.mark('baker-ready');
  return factory;
});
baking.catch(fail);
const model=Promise.resolve().then(()=>({enclosure:enclosure(),ring:ringGeometry(),witness:witnessGeometry()}));
Promise.all([import('./scene.js'),model]).then(([{mount},art])=>{
  close=mount({opening,baking,art,canvas,viewport,loading,status,controls,signal,fail,size});
}).catch(fail);
addEventListener('pagehide',event=>{
  if(event.persisted)return;
  controller.abort();
  close?.();
  engine?.dispose();
});
