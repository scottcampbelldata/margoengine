
import { Engine } from '@margoengine/core';
import { demoStatus } from 'margo-demo-status';

const canvas=document.querySelector('#plot');
const notice=document.querySelector('#notice');
const status=demoStatus(canvas,document.querySelector('#status'),document.querySelector('#error'));
const controller=new AbortController(),{signal}=controller;
let engine;

function fail(reason){
  if(signal.aborted)return;
  status.error(reason);
  notice.hidden=false;
  document.querySelector('#status').textContent='The exhibit could not start.';
  for(const button of document.querySelectorAll('button'))button.disabled=true;
  if(reason?.code!=='unsupported')console.error(reason);
  stop();
}
function stop(){
  if(signal.aborted)return;
  controller.abort();
  engine?.dispose();
}
function size(){
  const density=Math.min(1.75,devicePixelRatio);
  const width=Math.max(1,Math.round(canvas.clientWidth*density));
  const height=Math.max(1,Math.round(canvas.clientHeight*density));
  if(canvas.width===width&&canvas.height===height)return false;
  canvas.width=width;
  canvas.height=height;
  return true;
}
async function connect(){
  const forced=new URLSearchParams(location.search).get('backend')==='webgl2';
  const options={backend:'webgpu',exactSize:true,antialias:false,capacity:28,signal,startupTimeout:2500,
    camera:{position:[0,0,3],target:[0,0,0],near:.1,far:10}};
  if(!forced&&navigator.gpu){
    try{return await Engine.create(canvas,options);}
    catch(reason){if(reason?.code!=='unsupported'&&reason?.code!=='timeout')throw reason;}
  }
  const {install}=await import('@margoengine/webgl2-compat');
  await install({force:true,signal});
  return Engine.create(canvas,options);
}

addEventListener('pagehide',event=>{if(!event.persisted)stop();},{signal});
size();
const boot=connect().then(device=>{
  if(signal.aborted){device.dispose();signal.throwIfAborted();}
  engine=device;
  performance.mark('neural-device-ready');
  return device;
});
const scene=import('./scene.js');
const compute=import('./trainer.js');
const model=Promise.all([boot,compute]).then(([device,module])=>module.prepareTrainer(device,signal))
  .then(trainer=>{
    performance.mark('neural-kernels-ready');
    return trainer;
  });
Promise.all([boot,scene,model]).then(([engine,viewer,trainer])=>
  viewer.open({engine,trainer,canvas,notice,status,signal,fail,size})).catch(fail);
