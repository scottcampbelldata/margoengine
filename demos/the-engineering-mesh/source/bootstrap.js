import {Engine} from '@margoengine/core';
import {applyQualityTier} from '@margoengine/quality';
import {webglRenderer} from '@margoengine/webgl2-compat/preview';
import {demoStatus} from 'margo-demo-status';

const canvas=document.getElementById('specimen'),controls=document.getElementById('controls');
const overlay=document.getElementById('status');
const status=demoStatus(document.body,overlay,document.getElementById('error'));
const lifetime=new AbortController(),{signal}=lifetime;
const force=new URLSearchParams(location.search).get('backend')==='webgl2';
let engine,scene;

function fail(reason) {
  if(signal.aborted||status.failed)return;
  status.error(reason);
  overlay.hidden=false;
  overlay.querySelector('strong').textContent='The specimen could not open.';
  document.getElementById('requirements').hidden=!['unsupported','no-adapter'].includes(reason?.code);
  controls.disabled=true;
}

function fit(target=canvas) {
  const density=Math.max(1.5,Math.min(1.75,devicePixelRatio||1));
  const w=Math.max(1,Math.round(target.clientWidth*density)),h=Math.max(1,Math.round(target.clientHeight*density));
  if(target.width===w&&target.height===h)return false;
  target.width=w;
  target.height=h;
  return true;
}

async function openRenderer() {
  const options={backend:'webgpu',signal,exactSize:true,antialias:false,capacity:112,camera:{near:.06,far:14}};
  if(!force&&navigator.gpu){
    try{return {engine:await Engine.create(canvas,options),compatibility:false};}
    catch(reason){
      if(!['unsupported','no-adapter'].includes(reason?.code))throw reason;
    }
  }
  return {engine:await Engine.create(canvas,{...options,backend:'webgl2',fallback:webglRenderer}),compatibility:true};
}

addEventListener('pagehide',event=>{
  if(event.persisted)return;
  lifetime.abort();
  scene?.close();
  engine?.dispose();
});

applyQualityTier();
fit();
const rendererReady=openRenderer().then(opened=>{
  if(signal.aborted){opened.engine.dispose();signal.throwIfAborted();}
  engine=opened.engine;
  engine.scene.background='#344556';
  engine.onError=fail;
  performance.mark('engine-ready');
  return opened;
});
const specimenReady=import('./scene.js').then(module=>{
  scene=module;
  return scene.prepare(signal);
});
Promise.all([rendererReady,specimenReady]).then(([opened,data])=>{
  signal.throwIfAborted();
  return scene.open({...opened,data,canvas,fit,signal,status,fail,overlay,controls});
}).catch(fail);
