import { Engine } from '@margoengine/core';
import { loadSamples } from './samples.js';
import { demoStatus } from 'margo-demo-status';

const canvas=document.querySelector('#plot');
const notice=document.querySelector('#status');
const message=document.querySelector('#message');
const error=document.querySelector('#error');
const help=document.querySelector('#help');
const status=demoStatus(canvas,notice,message);
const controller=new AbortController();
const {signal}=controller;
let engine;

function fail(reason) {
  if(signal.aborted)return;
  status.error(reason);
  notice.hidden=true;
  error.hidden=false;
  help.hidden=reason?.code!=='unsupported';
  for(const control of document.querySelectorAll('button,input,select'))control.disabled=true;
  if(reason?.code!=='unsupported')console.error(reason);
  queueMicrotask(stop);
}
function stop() {
  if(signal.aborted)return;
  controller.abort();
  engine?.dispose();
}
function size() {
  const dpr=Math.min(1.75,devicePixelRatio);
  const w=Math.max(1,Math.round(canvas.clientWidth*dpr)), h=Math.max(1,Math.round(canvas.clientHeight*dpr));
  if(canvas.width===w&&canvas.height===h)return false;
  canvas.width=w;canvas.height=h;
  return true;
}
async function connect() {
  const forced=new URLSearchParams(location.search).get('backend')==='webgl2';
  const options={backend:'webgpu',exactSize:true,antialias:false,capacity:36,signal,startupTimeout:2500,
    camera:{position:[0,0,3],target:[0,0,0],near:.1,far:20}};
  if(!forced&&navigator.gpu){
    try{return await Engine.create(canvas,options);}
    catch(reason){if(reason?.code!=='unsupported'&&reason?.code!=='timeout')throw reason;}
  }
  const {install}=await import('@margoengine/webgl2-compat');
  await install({force:true,signal});
  return Engine.create(canvas,options);
}

size();
addEventListener('pagehide',event=>{if(!event.persisted)stop();},{signal});
const device=connect().then(result=>{
  if(signal.aborted){result.dispose();signal.throwIfAborted();}
  engine=result;
  performance.mark('coordinates-device-ready');
  return result;
});
const view=import('./scene.js');
const data=loadSamples(signal);
const exhibit=Promise.all([data,view]).then(([samples,scene])=>scene.prepare(samples,signal));
Promise.all([device,view,exhibit]).then(([target,scene,model])=>
  scene.open({engine:target,model,canvas,size,notice,status,signal,fail})).catch(fail);
