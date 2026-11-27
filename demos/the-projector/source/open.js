import {Engine} from '@margoengine/core';
import {demoStatus} from 'margo-demo-status';

const viewport=document.getElementById('viewport'),canvas=document.getElementById('scene');
const loading=document.getElementById('loading'),error=document.getElementById('error');
const life=new AbortController(),{signal}=life;
const page=demoStatus(viewport,loading,error);
const forceGL=new URLSearchParams(location.search).get('backend')==='webgl2';
const expectNative=!forceGL&&Boolean(navigator.gpu);
const eye=[2.23,1.67,7.05],focus=[.39,1.49,-1.14];

function fail(reason){
  if(signal.aborted||page.failed)return;
  document.getElementById('slides').disabled=true;
  loading.hidden=true;
  error.hidden=false;
  page.error(reason);
}

function sizeScene(engine){
  const {width,height}=canvas.getBoundingClientRect();
  if(!width||!height)return false;
  const ratio=Math.min(devicePixelRatio||1,2,1520/width);
  const w=Math.round(width*ratio),h=Math.round(height*ratio);
  if(canvas.width===w&&canvas.height===h)return false;
  canvas.width=w;canvas.height=h;
  if(engine)engine.camera.fov=w/h<1?36:30;
  return true;
}

async function openEngine(){
  const options={
    backend:'webgpu',exactSize:true,antialias:false,signal,
    camera:{position:eye,target:focus,fov:canvas.width/canvas.height<1?36:30,near:.10,far:38},
    startupWarning:3000,startupTimeout:7500,
  };
  performance.mark('device-requested');
  if(!forceGL&&navigator.gpu){
    try{
      const engine=await Engine.create(canvas,options);
      viewport.dataset.renderer='webgpu';
      return engine;
    }catch(reason){
      signal.throwIfAborted();
      if(reason?.code&&!['unsupported','adapter','device','timeout','startup'].includes(reason.code))throw reason;
    }
  }
  const {install}=await import('@margoengine/webgl2-compat');
  performance.mark('compatibility-imported');
  await install({force:true,signal});
  performance.mark('compatibility-installed');
  const engine=await Engine.create(canvas,options);
  viewport.dataset.renderer='webgl2';
  return engine;
}

sizeScene();
let engine,cleanup;
const opening=openEngine().then(value=>{
  engine=value;
  if(signal.aborted){value.dispose();signal.throwIfAborted();}
  value.onError=fail;
  performance.mark('engine-ready');
  return value;
});
opening.catch(fail);

addEventListener('pagehide',event=>{
  if(event.persisted)return;
  life.abort();
  cleanup?.();
  engine?.dispose();
});

import('./scene.js').then(({mount})=>{
  cleanup=mount({opening,viewport,canvas,loading,page,signal,fail,sizeScene,expectNative});
}).catch(fail);
