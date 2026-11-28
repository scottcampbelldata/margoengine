import {Engine} from '@margoengine/core';
import {demoStatus} from 'margo-demo-status';

const canvas=document.querySelector('#view');
const notice=document.querySelector('#notice'),message=document.querySelector('#status');
const status=demoStatus(canvas,message,document.querySelector('#error'));
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
  message.textContent='The specimen could not be displayed.';
  canvas.dataset.error=String(reason?.message??reason);
  for(const node of document.querySelectorAll('input'))node.disabled=true;
  if(reason?.code!=='unsupported')console.error(reason);
  close();
}
function size(){
  const scale=Math.min(1.75,devicePixelRatio);
  const width=Math.max(1,Math.round(canvas.clientWidth*scale));
  const height=Math.max(1,Math.round(canvas.clientHeight*scale));
  if(canvas.width===width&&canvas.height===height)return false;
  canvas.width=width;canvas.height=height;
  return true;
}
async function connect(){
  const forced=new URLSearchParams(location.search).get('backend')==='webgl2';
  const options={backend:'webgpu',exactSize:true,antialias:false,capacity:4,startupTimeout:2500,signal};
  if(!forced&&navigator.gpu){
    try{return await Engine.create(canvas,options);}
    catch(error){if(error?.code!=='unsupported'&&error?.code!=='timeout')throw error;}
  }
  const {installCompatibility}=await import('./compatibility.js');
  await installCompatibility(signal);
  return Engine.create(canvas,options);
}
addEventListener('pagehide',event=>{if(!event.persisted)close();},{signal});
size();
const scene=import('./scene.js');
const device=connect().then(value=>{
  if(signal.aborted){value.dispose();signal.throwIfAborted();}
  engine=value;
  engine.onError=fail;
  performance.mark('noise-device');
  return engine;
});
Promise.all([device,scene]).then(([engine,{show}])=>show({engine,canvas,notice,status,size,signal,fail})).catch(fail);
