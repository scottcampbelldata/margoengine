import {Engine} from '@margoengine/core';
import {demoStatus} from 'margo-demo-status';
import {buildRoom} from './room.js';
import {lightRoom,roomCamera} from './room-view.js';

const by=id=>document.getElementById(id);
const viewport=by('viewport'),canvas=by('room'),loading=by('loading'),error=by('error');
const field=by('lighting'),view=by('view'),details=by('details');
const buttons=Array.from(field.querySelectorAll('[data-mode]'));
const traceButton=buttons.find(button=>button.dataset.mode==='traced');
const page=demoStatus(viewport,loading,error),life=new AbortController(),{signal}=life;
const forceGL=new URLSearchParams(location.search).get('backend')==='webgl2';
const expectingCompat=forceGL||!navigator.gpu;
const notes={
  direct:'Direct illumination with a fixed ambient fill.',
  screen:'SSGI gathers diffuse light from surfaces visible in the current frame.',
  traced:'Ray-traced GI finds the scene geometry missing from the screen, including the ceiling light.',
};
let engine,indirect,observer,rendering=false,mode='direct',cropped=false,desired;
let traceNotice='';

function fail(reason){
  if(signal.aborted||page.failed)return;
  field.disabled=true;
  view.disabled=true;
  error.hidden=false;
  loading.hidden=true;
  page.error(reason);
}

function placeCamera(){
  if(!engine)return;
  const camera=roomCamera(canvas.width,canvas.height,cropped);
  engine.camera.position=camera.position;
  engine.camera.target=camera.target;
  engine.camera.fov=camera.fov;
}

function resize(){
  const {height}=canvas.getBoundingClientRect();
  const width=cropped?Math.min(viewport.clientWidth,height*1.28):viewport.clientWidth;
  const ratio=Math.min(devicePixelRatio||1,1.5,1410/width);
  const w=Math.round(width*ratio),h=Math.round(height*ratio);
  if(w<1||h<1||(canvas.width===w&&canvas.height===h))return false;
  canvas.width=w;canvas.height=h;
  placeCamera();
  return true;
}

function applyCrop(value){
  cropped=value;
  viewport.dataset.cropFrame=String(cropped);
  resize();
  placeCamera();
}

async function openEngine(){
  const options={
    backend:'webgpu',exactSize:true,antialias:false,signal,
    camera:roomCamera(canvas.width,canvas.height,false),
    startupWarning:3000,startupTimeout:7500,
  };
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

function describe(){
  for(const button of buttons)button.setAttribute('aria-pressed',String(button.dataset.mode===mode));
  view.textContent=cropped?'Show both walls':'Crop the walls';
  view.setAttribute('aria-pressed',String(cropped));
  details.textContent=traceNotice?notes[mode]+' '+traceNotice:notes[mode];
  viewport.dataset.lighting=mode;
  viewport.dataset.view=cropped?'cropped':'wide';
}

async function frame(){
  engine.render();
  await engine.gpu.queue.onSubmittedWorkDone();
  await new Promise(resolve=>requestAnimationFrame(resolve));
  signal.throwIfAborted();
}

async function control(nextMode=mode,nextCrop=cropped){
  if(signal.aborted||page.failed)return;
  performance.mark('control-request');
  desired={nextMode,nextCrop};
  if(rendering)return;
  rendering=true;
  try{
    while(desired&&!signal.aborted){
      const change=desired;
      desired=null;
      mode=indirect.pick(change.nextMode);
      applyCrop(change.nextCrop);
      await frame();
      describe();
      performance.mark('comparison-frame');
      if(!performance.getEntriesByName('first-control-frame').length)performance.mark('first-control-frame');
    }
  }catch(reason){fail(reason);}
  finally{rendering=false;}
}

async function run(){
  resize();
  const engineOpening=openEngine().then(value=>{
    engine=value;
    performance.mark('device-ready');
    if(signal.aborted){value.dispose();signal.throwIfAborted();}
  });
  const library=import('./scene.js');
  const room=buildRoom();
  performance.mark('room-geometry');
  const prepare=library.then(api=>{
    const data=expectingCompat?api.flattenRoom(room):null;
    if(data)performance.mark('room-bvh');
    return [api,data];
  });
  const [,[api,prepared]]=await Promise.all([engineOpening,prepare]);
  signal.throwIfAborted();
  engine.onError=fail;
  lightRoom(engine,room);
  performance.mark('engine-ready');
  const limits=engine.gpu.limits;
  const compat=viewport.dataset.renderer==='webgl2';
  const canTrace=(limits.maxStorageBuffersInFragmentStage??limits.maxStorageBuffersPerShaderStage)>=(compat?4:5);
  const flat=compat&&canTrace?(prepared??api.flattenRoom(room)):null;
  indirect=api.makeIndirect(engine,room,canTrace,flat);
  indirect.pick('direct');
  await frame();
  if(!canTrace)traceNotice='This device can show screen-space light. The ray-tracing path needs more fragment storage.';
  describe();
  performance.mark('room-frame');
  viewport.dataset.traceSupported=String(canTrace);
  if(canTrace)viewport.dataset.traceExecution=compat?'flattened':'native';
  if(flat)viewport.dataset.triangles=String(flat.triangles);
  for(const button of buttons){
    button.disabled=button===traceButton&&!canTrace;
    button.addEventListener('click',()=>void control(button.dataset.mode),{signal});
  }
  view.addEventListener('click',()=>void control(mode,!cropped),{signal});
  observer=new ResizeObserver(()=>{
    if(!resize()||signal.aborted)return;
    try{engine.render();}catch(reason){fail(reason);}
  });
  observer.observe(canvas);
  if(page.ready()){
    field.disabled=false;
    view.disabled=false;
    loading.hidden=true;
  }
}

addEventListener('pagehide',event=>{
  if(event.persisted)return;
  life.abort();
  observer?.disconnect();
  engine?.dispose();
  indirect?.dispose();
});
run().catch(fail);
