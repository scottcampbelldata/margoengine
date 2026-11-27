import {Engine} from '@margoengine/core';
import {demoStatus} from 'margo-demo-status';
import {cameraAt,terrainData} from './meadow-data.js';
import {buildLandscape,clump} from './landscape.js';

const by=id=>document.getElementById(id);
const viewport=by('viewport'),canvas=by('scene'),loading=by('loading'),error=by('error');
const movement=by('movement'),weather=by('weather'),page=demoStatus(viewport,loading,error);
const life=new AbortController(),{signal}=life;
const forceGL=new URLSearchParams(location.search).get('backend')==='webgl2';
let engine,cleanup;

function fail(reason){
  if(signal.aborted||page.failed)return;
  movement.disabled=true;
  weather.disabled=true;
  loading.hidden=true;
  error.hidden=false;
  page.error(reason);
}
function resize(){
  const rect=canvas.getBoundingClientRect(),ratio=Math.min(1.6,devicePixelRatio||1,1320/rect.width);
  const width=Math.round(rect.width*ratio),height=Math.round(rect.height*ratio);
  if(width<1||height<1||(canvas.width===width&&canvas.height===height))return false;
  canvas.width=width;canvas.height=height;
  return true;
}
async function open(){
  const options={backend:'webgpu',exactSize:true,antialias:false,signal,startupWarning:3000,startupTimeout:8000,
    camera:cameraAt(0,canvas.width/canvas.height<1.06)};
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
  engine.onError=fail;
  performance.mark('engine-ready');
  return value;
});
opening.catch(fail);
const interaction=import('@margoengine/scatter/interact');
const features=import('./scene.js');
const landscape=buildLandscape(),terrain=terrainData(),blade=clump();
performance.mark('meadow-geometry');
features.then(({mount})=>{
  cleanup=mount({opening,interaction,landscape,terrain,blade,viewport,canvas,movement,weather,loading,page,signal,fail,resize});
}).catch(fail);
addEventListener('pagehide',event=>{
  if(event.persisted)return;
  life.abort();
  cleanup?.();
  engine?.dispose();
});
