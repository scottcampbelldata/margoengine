import {Engine} from '@margoengine/core';
import {demoStatus} from 'margo-demo-status';

const canvas=document.querySelector('#view'),notice=document.querySelector('#notice');
const label=document.querySelector('#status'),status=demoStatus(canvas,label,document.querySelector('#error'));
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
  label.textContent='The sculpture could not be displayed.';
  canvas.dataset.error=String(reason?.message??reason);
  for(const control of document.querySelectorAll('input'))control.disabled=true;
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
  const force=new URLSearchParams(location.search).get('backend')==='webgl2';
  const options={backend:'webgpu',exactSize:true,antialias:false,capacity:128,startupTimeout:2500,signal,
    camera:{position:[3.30,3.18,9.4],target:[0,2.05,0],near:.18,far:68,fov:36}};
  if(!force&&navigator.gpu){
    try{return await Engine.create(canvas,options);}
    catch(reason){if(reason?.code!=='timeout'&&reason?.code!=='unsupported')throw reason;}
  }
  const {installCompatibility}=await import('./compatibility.js');
  await installCompatibility(signal);
  return Engine.create(canvas,options);
}
function createForm(){
  const worker=new Worker(new URL('./model-worker.js',import.meta.url),{type:'module'});
  return new Promise((resolve,reject)=>{
    const stop=()=>{worker.terminate();reject(signal.reason);};
    signal.addEventListener('abort',stop,{once:true});
    function finish(callback,value){
      signal.removeEventListener('abort',stop);
      worker.terminate();
      callback(value);
    }
    worker.addEventListener('message',event=>finish(resolve,event.data),{once:true});
    worker.addEventListener('error',event=>finish(reject,new Error(event.message||'Statue geometry could not be built.')),{once:true});
  });
}
size();
addEventListener('pagehide',event=>{if(!event.persisted)close();},{signal});
const form=createForm().then(value=>{performance.mark('statue-form');return value;});
const scene=import('./scene.js');
const clustered=Promise.all([form,import('./cluster.js')]).then(([form,{cluster}])=>cluster(form));
const renderer=connect().then(value=>{
  if(signal.aborted){value.dispose();signal.throwIfAborted();}
  engine=value;
  engine.onError=fail;
  performance.mark('statue-device');
  return value;
});
Promise.all([renderer,clustered,scene]).then(([engine,clustered,{show}])=>
  show({engine,clustered,canvas,notice,status,signal,size,fail})).catch(fail);
