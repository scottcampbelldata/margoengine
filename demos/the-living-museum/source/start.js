import { Engine } from '@margoengine/core';
import { applyQualityTier } from '@margoengine/quality';
import { demoStatus } from 'margo-demo-status';
import packet from './opening-actors.mesh?url';

const canvas=document.querySelector('#museum');
const overlay=document.querySelector('#status');
const detail=document.querySelector('#detail');
const help=document.querySelector('#help');
const status=demoStatus(canvas,overlay,detail);
const controller=new AbortController(),{signal}=controller;
const eye=[9.2,11.4,13.85],aim=[0,.44,-.18];
let engine;

function destroy(){
  if(signal.aborted)return;
  controller.abort();
  engine?.dispose();
}
function fail(error){
  if(signal.aborted||status.failed)return;
  status.error(error);
  overlay.hidden=false;
  overlay.querySelector('strong').textContent='The gallery could not be opened.';
  help.hidden=false;
  for(const button of document.querySelectorAll('.controls button'))button.disabled=true;
  if(error?.code!=='unsupported')console.error(error);
  queueMicrotask(destroy);
}

function fit(){
  const ratio=Math.max(1,Math.min(1.4,devicePixelRatio));
  const width=Math.max(1,Math.round(canvas.clientWidth*ratio));
  const height=Math.max(1,Math.round(canvas.clientHeight*ratio));
  if(canvas.width!==width)canvas.width=width;
  if(canvas.height!==height)canvas.height=height;
}

async function connect(){
  const force=new URLSearchParams(location.search).get('backend')==='webgl2';
  const options={backend:'webgpu',signal,exactSize:true,antialias:false,startupTimeout:2500,capacity:1024,
    camera:{position:eye,target:aim,near:.12,far:74,fov:43}};
  if(!force&&navigator.gpu){
    try{return await Engine.create(canvas,options);}
    catch(error){if(error?.code!=='unsupported'&&error?.code!=='timeout')throw error;}
  }
  const {install}=await import('@margoengine/webgl2-compat');
  await install({force:true,signal});
  return Engine.create(canvas,options);
}

async function loadOpening(){
  const response=await fetch(packet,{signal});
  if(!response.ok)throw new Error('The gallery visitor poses could not be opened.');
  return new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}

fit();
applyQualityTier();
addEventListener('pagehide',event=>{if(!event.persisted)destroy();},{signal});
const opening=loadOpening();
const exhibit=import('./scene.js');
const device=connect().then(target=>{
  if(signal.aborted){target.dispose();signal.throwIfAborted();}
  engine=target;
  performance.mark('museum-device');
  return target;
});
Promise.all([device,exhibit,opening]).then(([target,scene,bytes])=>
  scene.open({target,bytes,signal,status,overlay,eye,aim,fit,fail})).catch(fail);
