import {Engine} from '@margoengine/core';
import {demoStatus} from 'margo-demo-status';

const canvas=document.querySelector('#view'), notice=document.querySelector('#notice');
const message=document.querySelector('#status');
const status=demoStatus(canvas,message,document.querySelector('#error'));
const lifetime=new AbortController();
const {signal}=lifetime;
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
  message.textContent='The scene pair could not open.';
  for(const control of document.querySelectorAll('button,input'))control.disabled=true;
  if(reason?.code!=='unsupported')console.error(reason);
  close();
}
function size(){
  const scale=Math.min(1.65,devicePixelRatio);
  const width=Math.max(1,Math.round(canvas.clientWidth*scale));
  const height=Math.max(1,Math.round(canvas.clientHeight*scale));
  if(width===canvas.width&&height===canvas.height)return false;
  canvas.width=width;
  canvas.height=height;
  return true;
}
async function connect(){
  const forced=new URLSearchParams(location.search).get('backend')==='webgl2';
  const options={backend:'webgpu',exactSize:true,antialias:true,capacity:8,signal,startupTimeout:2500};
  if(!forced&&navigator.gpu){
    try{return await Engine.create(canvas,options);}
    catch(reason){if(reason?.code!=='unsupported'&&reason?.code!=='timeout')throw reason;}
  }
  const {installCompatibility}=await import('./compatibility.js');
  await installCompatibility(signal);
  return Engine.create(canvas,options);
}

addEventListener('pagehide',event=>{if(!event.persisted)close();},{signal});
size();
const device=connect().then(result=>{
  if(signal.aborted){result.dispose();signal.throwIfAborted();}
  engine=result;
  engine.onError=fail;
  performance.mark('transitions-device');
  return result;
});
const study=import('./scene.js').then(module=>{
  signal.throwIfAborted();
  const worlds=module.prepareWorlds();
  performance.mark('transitions-geometry');
  return {worlds,show:module.show};
});
Promise.all([device,study]).then(([engine,{worlds,show}])=>
  show({engine,worlds,canvas,notice,status,size,signal,fail})).catch(fail);
