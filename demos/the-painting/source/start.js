import {Engine} from '@margoengine/core';
import {demoStatus} from 'margo-demo-status';

const canvas=document.querySelector('#view'), notice=document.querySelector('#notice');
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

function fail(reason){
  if(signal.aborted)return;
  status.error(reason);
  notice.hidden=false;
  message.textContent='The headland could not open.';
  for(const control of document.querySelectorAll('button,input'))control.disabled=true;
  if(reason?.code!=='unsupported')console.error(reason);
  stop();
}

function size(){
  const scale=Math.min(1.62,devicePixelRatio);
  const w=Math.max(1,Math.round(canvas.clientWidth*scale)),h=Math.max(1,Math.round(canvas.clientHeight*scale));
  if(canvas.width===w&&canvas.height===h)return false;
  canvas.width=w;canvas.height=h;
  return true;
}

async function connect(){
  const forced=new URLSearchParams(location.search).get('backend')==='webgl2';
  const options={backend:'webgpu',exactSize:true,antialias:false,capacity:8,startupTimeout:2500,signal,
    camera:{position:[12.00,12.29,23.8],target:[-11.03,3.12,-75],near:.55,far:1440,fov:44}};
  if(!forced&&navigator.gpu){
    try{return await Engine.create(canvas,options);}
    catch(reason){if(reason?.code!=='unsupported'&&reason?.code!=='timeout')throw reason;}
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
  performance.mark('painting-device');
  return result;
});
const art=import('./scene.js').then(module=>{
  signal.throwIfAborted();
  const land=module.prepareLand();
  performance.mark('painting-art');
  return {land,show:module.show};
});
Promise.all([device,art]).then(([engine,{land,show}])=>
  show({engine,land,canvas,notice,status,size,signal,fail})).catch(fail);
