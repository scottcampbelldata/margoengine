
import {Engine} from '@margoengine/core';
import {demoStatus} from 'margo-demo-status';

const canvas=document.querySelector('#table');
const notice=document.querySelector('#notice');
const message=document.querySelector('#status');
const status=demoStatus(canvas,message,document.querySelector('#error'));
const controller=new AbortController(),{signal}=controller;
let engine;

function stop(){
  if(signal.aborted)return;
  controller.abort();
  engine?.dispose();
}
function fail(reason){
  if(signal.aborted)return;
  status.error(reason);
  notice.hidden=false;
  message.textContent='The shadow comparison could not start.';
  for(const control of document.querySelectorAll('button,input,select'))control.disabled=true;
  if(reason?.code!=='unsupported')console.error(reason);
  stop();
}
function size(){
  const scale=Math.min(1.75,devicePixelRatio);
  const width=Math.max(1,Math.round(scale*canvas.clientWidth)), height=Math.max(1,Math.round(scale*canvas.clientHeight));
  if(canvas.width===width&&canvas.height===height)return false;
  canvas.width=width;
  canvas.height=height;
  return true;
}
async function connect(){
  const force=new URLSearchParams(location.search).get('backend')==='webgl2';
  const options={backend:'webgpu',exactSize:true,antialias:true,capacity:54,signal,startupTimeout:2500,
    camera:{position:[1.59,2.61,3.66],target:[.045,.098,0],fov:35,near:.05,far:120}};
  if(!force&&navigator.gpu){
    try{return await Engine.create(canvas,options);}
    catch(reason){if(reason?.code!=='unsupported'&&reason?.code!=='timeout')throw reason;}
  }
  const {install}=await import('@margoengine/webgl2-compat');
  await install({force:true,signal});
  return Engine.create(canvas,options);
}

addEventListener('pagehide',event=>{if(!event.persisted)stop();},{signal});
size();
const device=connect().then(result=>{
  if(signal.aborted){result.dispose();signal.throwIfAborted();}
  engine=result;
  engine.onError=fail;
  performance.mark('ray-device-ready');
  return result;
});
const scene=import('./scene.js');
const prepared=scene.then(({prepareStudy})=>{
  signal.throwIfAborted();
  const model=prepareStudy();
  performance.mark('ray-scene-geometry-prepared');
  return model;
});
Promise.all([device,scene,prepared]).then(([engine,scene,prepared])=>
  scene.show({engine,canvas,status,notice,size,signal,fail,prepared})).catch(fail);
