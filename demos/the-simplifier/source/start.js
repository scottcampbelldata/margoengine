import { Engine } from '@margoengine/core';
import { applyQualityTier } from '@margoengine/quality';
import { demoStatus } from 'margo-demo-status';
import archive from './assets/statue.bin?url';

const canvas=document.querySelector('#statue');
const notice=document.querySelector('#status');
const error=document.querySelector('#error');
const help=document.querySelector('#help');
const status=demoStatus(canvas,notice,document.querySelector('#message'));
const controller=new AbortController(), {signal}=controller;
let engine;

function fit(){
  const width=Math.max(1,Math.round(canvas.clientWidth*1.65));
  const height=Math.max(1,Math.round(canvas.clientHeight*1.65));
  if(canvas.width===width&&canvas.height===height)return false;
  canvas.width=width;
  canvas.height=height;
  return true;
}
function stop(){
  if(signal.aborted)return;
  controller.abort();
  engine?.dispose();
}
function fail(reason){
  if(signal.aborted)return;
  status.error(reason);
  notice.hidden=true;
  error.hidden=false;
  help.hidden=reason?.code!=='unsupported';
  for(const control of document.querySelectorAll('.bench button,.bench input')) control.disabled=true;
  if(reason?.code!=='unsupported')console.error(reason);
  queueMicrotask(stop);
}

async function connect(){
  const force=new URLSearchParams(location.search).get('backend')==='webgl2';
  const options={backend:'webgpu',exactSize:true,antialias:true,capacity:14,startupTimeout:2500,signal,
    camera:{fov:34,near:.11,far:48}};
  if(!force&&navigator.gpu){
    try{return await Engine.create(canvas,options);}
    catch(reason){if(reason?.code!=='unsupported'&&reason?.code!=='timeout')throw reason;}
  }
  const {install}=await import('@margoengine/webgl2-compat');
  await install({force:true,signal});
  return Engine.create(canvas,options);
}

async function load(){
  const response=await fetch(archive,{signal});
  if(!response.ok)throw new Error('The carved model could not be opened.');
  return new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}

fit();
applyQualityTier({search:'?quality=high',userAgent:''});
addEventListener('pagehide',event=>{if(!event.persisted)stop();},{signal});
const data=load(), scene=import('./scene.js');
const device=connect().then(target=>{
  if(signal.aborted){target.dispose();signal.throwIfAborted();}
  engine=target;
  performance.mark('simplifier-device-ready');
  return target;
});
Promise.all([device,data,scene]).then(([target,bytes,exhibit])=>
  exhibit.open({engine:target,bytes,fit,status,notice,signal,fail})).catch(fail);
