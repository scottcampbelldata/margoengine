import {Engine} from '@margoengine/core';
import {demoStatus} from 'margo-demo-status';

const viewport=document.getElementById('viewport'),canvas=document.getElementById('scene');
const loading=document.getElementById('loading'),error=document.getElementById('error');
const life=new AbortController(),{signal}=life,page=demoStatus(viewport,loading,error);
const forceGL=new URLSearchParams(location.search).get('backend')==='webgl2';
let engine,cleanup;

function fail(reason){
  if(signal.aborted||page.failed)return;
  document.getElementById('controls').disabled=true;
  document.getElementById('satin').disabled=true;
  loading.hidden=true;
  error.hidden=false;
  page.error(reason);
}

function resize(){
  const {width,height}=canvas.getBoundingClientRect();
  if(!width||!height)return false;
  const scale=Math.min(devicePixelRatio||1,2,1450/width);
  const w=Math.round(width*scale),h=Math.round(height*scale);
  if(canvas.width===w&&canvas.height===h)return false;
  canvas.width=w;canvas.height=h;
  return true;
}

async function open(){
  const options={backend:'webgpu',exactSize:true,antialias:false,signal,
    camera:{position:[0,1.88,7.1],target:[0,1.2,-.1],fov:34,near:.09,far:28},startupWarning:3000,startupTimeout:8000};
  if(!forceGL&&navigator.gpu){
    try{
      const value=await Engine.create(canvas,options);
      viewport.dataset.renderer='webgpu';
      return value;
    }catch(reason){
      signal.throwIfAborted();
      if(reason?.code&&!['unsupported','adapter','device','timeout','startup'].includes(reason.code))throw reason;
    }
  }
  const {install}=await import('@margoengine/webgl2-compat');
  performance.mark('compat-imported');
  await install({force:true,minimumTier:'half-float',signal});
  performance.mark('compat-installed');
  const value=await Engine.create(canvas,options);
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

addEventListener('pagehide',event=>{
  if(event.persisted)return;
  life.abort();
  cleanup?.();
  engine?.dispose();
});

import('./scene.js').then(({mount})=>{
  cleanup=mount({opening,viewport,canvas,loading,page,signal,fail,resize});
}).catch(fail);
