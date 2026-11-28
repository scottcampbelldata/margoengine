import {Engine} from '@margoengine/core';
import {demoStatus} from 'margo-demo-status';

const by=id=>document.getElementById(id);
const viewport=by('viewport'),canvas=by('scene'),loading=by('loading'),error=by('error');
const field=by('controls'),rebake=by('rebake'),page=demoStatus(viewport,loading,error);
const life=new AbortController(),{signal}=life;
const forceGL=new URLSearchParams(location.search).get('backend')==='webgl2';
let engine,cleanup;

function fail(reason){
  if(signal.aborted||page.failed)return;
  field.disabled=true;
  rebake.disabled=true;
  loading.hidden=true;
  error.hidden=false;
  page.error(reason);
}
function resize(){
  const {width,height}=canvas.getBoundingClientRect();
  if(!width||!height)return false;
  const scale=Math.min(devicePixelRatio||1,2,1370/width);
  const w=Math.round(width*scale),h=Math.round(height*scale);
  if(canvas.width===w&&canvas.height===h)return false;
  canvas.width=w;
  canvas.height=h;
  return true;
}
async function open(){
  const options={backend:'webgpu',exactSize:true,antialias:false,signal,startupWarning:3000,startupTimeout:8000};
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
  await install({force:true,minimumTier:'half-float',signal});
  const value=await Engine.create(canvas,options);
  viewport.dataset.renderer='webgl2';
  return value;
}
resize();
const opening=open().then(value=>{
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
  cleanup=mount({opening,viewport,canvas,field,rebake,loading,page,signal,fail,resize});
}).catch(fail);
