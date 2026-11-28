
import {Engine} from '@margoengine/core';
import {demoStatus} from 'margo-demo-status';

const canvas=document.querySelector('#bench');
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
  message.textContent='The lighting bench could not start.';
  for(const control of document.querySelectorAll('button,input'))control.disabled=true;
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
  const options={backend:'webgpu',exactSize:true,antialias:true,capacity:96,signal,startupTimeout:2500,
    camera:{position:[.18,1.40,2.655],target:[.005,.68,0],fov:33,near:.05,far:35}};
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
  performance.mark('area-device-ready');
  return result;
});
const scene=import('./scene.js').then(({prepareBench,show})=>{
  signal.throwIfAborted();
  const assemble=prepareBench();
  performance.mark('area-geometry-prepared');
  return {assemble,show};
});
Promise.all([device,scene]).then(([engine,{assemble,show}])=>
  show({engine,canvas,status,notice,size,signal,fail,assemble})).catch(fail);
