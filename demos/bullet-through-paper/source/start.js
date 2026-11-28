import {Engine} from '@margoengine/core';
import {applyQualityTier} from '@margoengine/quality';
import {demoStatus} from 'margo-demo-status';

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
  message.textContent='The comparison could not open.';
  canvas.dataset.error=String(reason?.message??reason);
  for(const control of document.querySelectorAll('button,input'))control.disabled=true;
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
  const options={backend:'webgpu',exactSize:true,antialias:false,capacity:170,camera:{
    position:[-1.87,6.02,7.72],target:[0,.16,0],near:.22,far:50,fov:35,
  },startupTimeout:2500,signal};
  if(!forced&&navigator.gpu){
    try{return await Engine.create(canvas,options);}
    catch(reason){if(reason?.code!=='unsupported'&&reason?.code!=='timeout')throw reason;}
  }
  const {webglRenderer}=await import('./compatibility.js');
  return Engine.create(canvas,{...options,backend:'webgl2',fallback:webglRenderer});
}
addEventListener('pagehide',event=>{if(!event.persisted)close();},{signal});
applyQualityTier({search:'?quality=low'});
size();
const prepared=import('./solver.js').then(({openExperiment})=>openExperiment(signal));
prepared.then(model=>model.ready).catch(fail);
const stage=import('./scene.js');
const device=connect().then(value=>{
  if(signal.aborted){value.dispose();signal.throwIfAborted();}
  engine=value;
  engine.onError=fail;
  performance.mark('divider-device');
  return value;
});
Promise.all([device,stage,prepared]).then(([engine,{show},physics])=>
  show({engine,physics,canvas,notice,status,signal,size,fail})).catch(fail);
