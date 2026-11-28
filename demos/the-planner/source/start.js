import {Engine} from '@margoengine/core';
import {applyQualityTier} from '@margoengine/quality';
import {demoStatus} from 'margo-demo-status';
import actorURL from './worker.skin?url';

const canvas=document.querySelector('#view'),notice=document.querySelector('#notice');
const message=document.querySelector('#status'),status=demoStatus(canvas,message,document.querySelector('#error'));
const lifetime=new AbortController(),{signal}=lifetime;
let engine;
function close(){
  if(signal.aborted)return;
  lifetime.abort();
  engine?.dispose();
}
function fail(reason){
  if(signal.aborted)return;
  status.error(reason);
  notice.hidden=false;
  message.textContent='The lookout could not open.';
  canvas.dataset.error=String(reason?.message??reason);
  for(const control of document.querySelectorAll('button,select'))control.disabled=true;
  if(reason?.code!=='unsupported')console.error(reason);
  close();
}
function size(){
  const scale=Math.min(1.70,devicePixelRatio);
  const width=Math.max(1,Math.round(canvas.clientWidth*scale)),height=Math.max(1,Math.round(canvas.clientHeight*scale));
  if(canvas.width===width&&canvas.height===height)return false;
  canvas.width=width;canvas.height=height;
  return true;
}
async function connect(){
  const forced=new URLSearchParams(location.search).get('backend')==='webgl2';
  const options={backend:'webgpu',exactSize:true,antialias:true,capacity:650,signal,startupTimeout:2400,
    camera:{near:1.1,far:85,position:[4.91,5.32,9.77],target:[0,.54,-.08],fov:36.5}};
  if(!forced&&navigator.gpu){
    try{return await Engine.create(canvas,options);}
    catch(reason){if(reason?.code!=='unsupported'&&reason?.code!=='timeout')throw reason;}
  }
  const {webglRenderer}=await import('./compatibility.js');
  return Engine.create(canvas,{...options,backend:'webgl2',fallback:webglRenderer});
}
async function loadActor(){
  const response=await fetch(actorURL,{signal});
  if(!response.ok||!response.body)throw new Error('The fitted lookout worker could not load.');
  return new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}
addEventListener('pagehide',event=>{if(!event.persisted)close();},{signal});
applyQualityTier({search:'?quality=high'});
size();
const stage=import('./scene.js');
const device=connect().then(value=>{
  if(signal.aborted){value.dispose();signal.throwIfAborted();}
  engine=value;engine.onError=fail;
  performance.mark('planner-device');
  return engine;
});
const actor=loadActor();
Promise.all([stage,device,actor]).then(([{mount},engine,actor])=>
  mount({engine,actor,canvas,notice,signal,size,fail})).catch(fail);
