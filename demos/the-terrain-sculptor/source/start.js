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
  message.textContent='The sculpting bench could not open.';
  for(const control of document.querySelectorAll('button,input,select'))control.disabled=true;
  if(reason?.code!=='unsupported')console.error(reason);
  close();
}
function size(){
  const scale=Math.min(1.62,devicePixelRatio);
  const width=Math.max(1,Math.round(canvas.clientWidth*scale));
  const height=Math.max(1,Math.round(canvas.clientHeight*scale));
  if(width===canvas.width&&height===canvas.height)return false;
  canvas.width=width;
  canvas.height=height;
  return true;
}
async function connect(){
  const forced=new URLSearchParams(location.search).get('backend')==='webgl2';
  const options={backend:'webgpu',exactSize:true,antialias:false,capacity:32,startupTimeout:2500,signal,
    camera:{position:[63,67,85],target:[0,4,-74],near:1.6,far:2250,fov:48}};
  if(!forced&&navigator.gpu){
    try{return await Engine.create(canvas,options);}
    catch(reason){if(reason?.code!=='unsupported'&&reason?.code!=='timeout')throw reason;}
  }
  const {installCompatibility}=await import('./compatibility.js');
  await installCompatibility(signal);
  return Engine.create(canvas,options);
}
function prepare(){
  const worker=new Worker(new URL('./terrain-worker.js',import.meta.url),{type:'module'});
  return new Promise((resolve,reject)=>{
    function stop(){worker.terminate();reject(signal.reason);}
    function complete(){signal.removeEventListener('abort',stop);worker.terminate();}
    signal.addEventListener('abort',stop,{once:true});
    worker.addEventListener('message',event=>{complete();performance.mark('terrain-sculpt-data');resolve(event.data);},{once:true});
    worker.addEventListener('error',event=>{complete();reject(event.error??new Error(event.message||'Terrain worker failed.'));},{once:true});
  });
}

addEventListener('pagehide',event=>{if(!event.persisted)close();},{signal});
size();
const data=prepare();
const device=connect().then(result=>{
  if(signal.aborted){result.dispose();signal.throwIfAborted();}
  engine=result;
  engine.onError=fail;
  performance.mark('terrain-sculpt-device');
  return result;
});
const study=import('./scene.js');
Promise.all([device,data,study]).then(([engine,data,{show}])=>
  show({engine,data,canvas,notice,status,size,signal,fail})).catch(fail);
