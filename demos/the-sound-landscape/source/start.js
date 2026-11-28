
import {Engine} from '@margoengine/core';
import {demoStatus} from 'margo-demo-status';

const canvas=document.querySelector('#landscape');
const notice=document.querySelector('#notice');
const message=document.querySelector('#status');
const status=demoStatus(canvas,message,document.querySelector('#error'));
const controller=new AbortController(),{signal}=controller;
let engine;

function stop(){
  if(signal.aborted)return;
  controller.abort();
  engine?.dispose();
}
function fail(reason){
  if(signal.aborted)return;
  status.error(reason);
  notice.hidden=false;
  message.textContent='The landscape could not start.';
  for(const control of document.querySelectorAll('button,input'))control.disabled=true;
  if(reason?.code!=='unsupported')console.error(reason);
  stop();
}
function resize(){
  const scale=Math.min(1.75,devicePixelRatio);
  const width=Math.max(1,Math.round(scale*canvas.clientWidth)), height=Math.max(1,Math.round(scale*canvas.clientHeight));
  if(canvas.width===width&&canvas.height===height)return false;
  canvas.width=width;
  canvas.height=height;
  return true;
}
async function connect(){
  const force=new URLSearchParams(location.search).get('backend')==='webgl2';
  const options={backend:'webgpu',exactSize:true,antialias:false,capacity:26,signal,startupTimeout:2500,
    camera:{position:[3.45,4.78,8.3],target:[0,-.17,0],near:.2,far:36}};
  if(!force&&navigator.gpu){
    try{return await Engine.create(canvas,options);}
    catch(reason){if(reason?.code!=='unsupported'&&reason?.code!=='timeout')throw reason;}
  }
  const {install}=await import('@margoengine/webgl2-compat');
  await install({force:true,signal});
  return Engine.create(canvas,options);
}

addEventListener('pagehide',event=>{if(!event.persisted)stop();},{signal});
resize();
const device=connect().then(result=>{
  if(signal.aborted){result.dispose();signal.throwIfAborted();}
  engine=result;
  engine.onError=fail;
  performance.mark('landscape-device-ready');
  return result;
});
const viewer=import('./scene.js');
const sounds=import('./sounds.js').then(bank=>{
  const opening=bank.makeLandscape('bells',signal);
  performance.mark('landscape-analysis-ready');
  return {bank,opening};
});
const audio=import('./transport.js');
Promise.all([device,viewer,sounds,audio]).then(async([engine,viewer,{bank,opening},audio])=>{
  const plot=viewer.openScene(engine,canvas,opening);
  signal.addEventListener('abort',()=>plot.dispose(),{once:true});
  const compat=engine.gpu.adapterInfo?.vendor==='margo-webgl2';
  canvas.dataset.renderer=compat?'compatibility':'webgpu';
  document.querySelector('#renderer').textContent=compat?'Margo WebGL2':'Margo WebGPU';
  await engine.gpu.queue.onSubmittedWorkDone();
  signal.throwIfAborted();
  const observer=new ResizeObserver(()=>{if(resize())plot.resize();});
  observer.observe(canvas);
  signal.addEventListener('abort',()=>observer.disconnect(),{once:true});
  audio.openTransport(plot,canvas,bank,opening,signal,fail);
  if(status.ready()){
    notice.hidden=true;
    for(const control of document.querySelectorAll('button,input'))control.disabled=false;
    performance.mark('landscape-frame-ready');
  }
}).catch(fail);
