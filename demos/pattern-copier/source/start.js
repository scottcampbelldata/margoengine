import {Engine} from '@margoengine/core';
import {demoStatus} from 'margo-demo-status';
import {firstSeed,initial,sample} from './patterns.js';
import {openSolver} from './solver.js';

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
  message.textContent='The pattern station could not open.';
  for(const control of document.querySelectorAll('button,input,select'))control.disabled=true;
  if(reason?.code!=='unsupported')console.error(reason);
  close();
}
function size(){
  const scale=Math.min(1.75,devicePixelRatio);
  const width=Math.max(1,Math.round(canvas.clientWidth*scale));
  const height=Math.max(1,Math.round(canvas.clientHeight*scale));
  if(width===canvas.width&&height===canvas.height)return false;
  canvas.width=width;
  canvas.height=height;
  return true;
}
async function connect(){
  const forced=new URLSearchParams(location.search).get('backend')==='webgl2';
  const options={backend:'webgpu',exactSize:true,antialias:false,capacity:4,startupTimeout:2500,signal};
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
const solve=openSolver(signal),seed=sample(initial);
const opening=solve(seed,firstSeed).then(result=>{
  if(result.error)throw new Error(result.error);
  performance.mark('pattern-first-solve');
  return result;
});
const device=connect().then(result=>{
  if(signal.aborted){result.dispose();signal.throwIfAborted();}
  engine=result;
  engine.onError=fail;
  performance.mark('pattern-device');
  return result;
});
const panel=import('./scene.js');
Promise.all([device,opening,panel]).then(([engine,opening,{show}])=>
  show({engine,opening,seed,solve,canvas,notice,status,size,signal,fail})).catch(fail);
