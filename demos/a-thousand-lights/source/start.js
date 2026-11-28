import { Engine } from '@margoengine/core';
import { applyQualityTier } from '@margoengine/quality';
import { demoStatus } from 'margo-demo-status';

const canvas=document.querySelector('#hall');
const loading=document.querySelector('#status');
const message=document.querySelector('#message');
const errorBox=document.querySelector('#error');
const help=document.querySelector('#help');
const status=demoStatus(canvas,loading,message);
const controller=new AbortController();
const {signal}=controller;
const force=new URLSearchParams(location.search).get('backend')==='webgl2';
applyQualityTier();
const scene=import('./scene.js');

function resize() {
  const w=Math.max(1,Math.round(canvas.clientWidth*1.34));
  const h=Math.max(1,Math.round(canvas.clientHeight*1.34));
  if(w===canvas.width&&h===canvas.height)return false;
  canvas.width=w;
  canvas.height=h;
  return true;
}

resize();
const options={backend:'webgpu',signal,startupTimeout:2500,exactSize:true,antialias:true,capacity:32,
  camera:{near:.47,far:80,fov:47}};

async function connectEngine(){
  if(!force&&navigator.gpu){
    try{return await Engine.create(canvas,options);}
    catch(reason){if(reason?.code!=='unsupported'&&reason?.code!=='timeout')throw reason;}
  }
  const {install}=await import('@margoengine/webgl2-compat');
  await install({force:true,signal});
  return Engine.create(canvas,options);
}

let engine;
function stop(){
  controller.abort();
  engine?.dispose();
}
function fail(reason){
  if(signal.aborted)return;
  status.error(reason);
  for(const control of document.querySelectorAll('.panel input,.panel button'))control.disabled=true;
  loading.hidden=true;
  errorBox.hidden=false;
  help.hidden=reason?.code!=='unsupported';
  if(reason?.code!=='unsupported')console.error(reason);
  stop();
}
addEventListener('pagehide',event=>{if(!event.persisted)stop();},{signal});
const opening=connectEngine().then(target=>{
  if(signal.aborted){target.dispose();signal.throwIfAborted();}
  engine=target;
  performance.mark('thousand-lights-device-ready');
  return target;
});
Promise.all([opening,scene]).then(([engine,el])=>el.open({engine,status,resize,signal,fail})).catch(fail);
