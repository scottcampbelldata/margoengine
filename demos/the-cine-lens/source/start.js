import {Engine} from '@margoengine/core';
import {demoStatus} from 'margo-demo-status';

const canvas=document.querySelector('#view');
const notice=document.querySelector('#notice');
const message=document.querySelector('#status');
const status=demoStatus(canvas,message,document.querySelector('#error'));
const lifetime=new AbortController();
const {signal}=lifetime;
let engine;

function stop(){
  if(signal.aborted)return;
  lifetime.abort();
  engine?.dispose();
}

function fail(error){
  if(signal.aborted)return;
  status.error(error);
  notice.hidden=false;
  message.textContent='The cinema study could not open.';
  for(const control of document.querySelectorAll('button,input'))control.disabled=true;
  if(error?.code!=='unsupported')console.error(error);
  stop();
}

function size(){
  const ratio=Math.min(1.7,devicePixelRatio);
  const width=Math.max(1,Math.round(canvas.clientWidth*ratio));
  const height=Math.max(1,Math.round(canvas.clientHeight*ratio));
  if(canvas.width===width&&canvas.height===height)return false;
  canvas.width=width;
  canvas.height=height;
  return true;
}

async function connect(){
  const forced=new URLSearchParams(location.search).get('backend')==='webgl2';
  const options={backend:'webgpu',capacity:64,exactSize:true,antialias:false,startupTimeout:2500,signal,
    camera:{position:[.55,.956,2.56],target:[-.012,.796,.03],near:.22,far:19,fov:34}};
  if(!forced&&navigator.gpu){
    try{return await Engine.create(canvas,options);}
    catch(error){if(error?.code!=='unsupported'&&error?.code!=='timeout')throw error;}
  }
  const {installCompatibility}=await import('./compatibility.js');
  await installCompatibility(signal);
  return Engine.create(canvas,options);
}

addEventListener('pagehide',event=>{if(!event.persisted)stop();},{signal});
size();
const device=connect().then(result=>{
  if(signal.aborted){result.dispose();signal.throwIfAborted();}
  engine=result;
  engine.onError=fail;
  performance.mark('cine-device');
  return result;
});
const scene=import('./scene.js').then(module=>{
  signal.throwIfAborted();
  const room=module.prepareRoom();
  performance.mark('cine-geometry');
  return {room,show:module.show};
});
Promise.all([device,scene]).then(([engine,{room,show}])=>
  show({engine,room,canvas,notice,status,size,signal,fail})).catch(fail);
