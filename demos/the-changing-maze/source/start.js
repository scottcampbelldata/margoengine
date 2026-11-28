import {Engine} from '@margoengine/core';
import {applyQualityTier} from '@margoengine/quality';
import {demoStatus} from 'margo-demo-status';

const canvas=document.querySelector('#view'),notice=document.querySelector('#notice');
const message=document.querySelector('#status'),status=demoStatus(canvas,message,document.querySelector('#error'));
const startLifetime=new AbortController(),{signal}=startLifetime;
let engine;
function close(){
  if(signal.aborted)return;
  startLifetime.abort();
  engine?.dispose();
}
function fail(reason){
  if(signal.aborted)return;
  status.error(reason);
  notice.hidden=false;message.textContent='The routing table could not open.';
  canvas.dataset.error=String(reason?.message??reason);
  for(const control of document.querySelectorAll('button,input'))control.disabled=true;
  if(reason?.code!=='unsupported')console.error(reason);
  close();
}
function size(){
  const scale=Math.min(1.65,devicePixelRatio);
  const w=Math.max(1,Math.round(canvas.clientWidth*scale)),h=Math.max(1,Math.round(canvas.clientHeight*scale));
  if(canvas.width===w&&canvas.height===h)return false;
  canvas.width=w;canvas.height=h;
  return true;
}
async function connect(){
  const forced=new URLSearchParams(location.search).get('backend')==='webgl2';
  const options={backend:'webgpu',exactSize:true,antialias:true,capacity:280,signal,startupTimeout:2300,
    camera:{near:.59,far:22,position:[1.35,2.83,2.87],target:[.006,-.131,.258],fov:34.1}};
  if(!forced&&navigator.gpu){
    try{return await Engine.create(canvas,options);}
    catch(reason){if(reason?.code!=='unsupported'&&reason?.code!=='timeout')throw reason;}
  }
  const {webglRenderer}=await import('./compatibility.js');
  return Engine.create(canvas,{...options,backend:'webgl2',fallback:webglRenderer});
}
addEventListener('pagehide',event=>{if(!event.persisted)close();},{signal});
applyQualityTier({search:'?quality=high'});
size();
const stage=import('./scene.js');
const device=connect().then(value=>{
  if(signal.aborted){value.dispose();signal.throwIfAborted();}
  engine=value;engine.onError=fail;
  performance.mark('changing-maze-device');
  return engine;
});
Promise.all([stage,device]).then(([{mount},engine])=>mount({engine,canvas,notice,signal,size,fail})).catch(fail);
