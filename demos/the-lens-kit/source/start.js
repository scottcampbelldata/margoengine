import {Engine} from '@margoengine/core';
import {demoStatus} from 'margo-demo-status';

const canvas=document.querySelector('#view');
const notice=document.querySelector('#notice');
const message=document.querySelector('#status');
const status=demoStatus(canvas,message,document.querySelector('#error'));
const lifecycle=new AbortController(),{signal}=lifecycle;
let engine;

function close(){
  if(signal.aborted)return;
  lifecycle.abort();
  engine?.dispose();
}

function fail(reason){
  if(signal.aborted)return;
  status.error(reason);
  notice.hidden=false;
  message.textContent='The lens preview could not start.';
  for(const control of document.querySelectorAll('button,input'))control.disabled=true;
  if(reason?.code!=='unsupported')console.error(reason);
  close();
}

function size(){
  const scale=Math.min(1.75,devicePixelRatio);
  const width=Math.max(1,Math.round(scale*canvas.clientWidth));
  const height=Math.max(1,Math.round(scale*canvas.clientHeight));
  if(width===canvas.width&&height===canvas.height)return false;
  canvas.width=width;
  canvas.height=height;
  return true;
}

async function connect(){
  const force=new URLSearchParams(location.search).get('backend')==='webgl2';
  const options={backend:'webgpu',exactSize:true,antialias:true,capacity:48,signal,startupTimeout:2500,
    camera:{position:[.67,1.62,7.7],target:[-.25,1.43,-6.8],near:.2,far:210}};
  if(!force&&navigator.gpu){
    try{return await Engine.create(canvas,options);}
    catch(reason){if(reason?.code!=='timeout'&&reason?.code!=='unsupported')throw reason;}
  }
  const {install}=await import('@margoengine/webgl2-compat');
  await install({force:true,signal});
  return Engine.create(canvas,options);
}

addEventListener('pagehide',event=>{if(!event.persisted)close();},{signal});
size();
const device=connect().then(result=>{
  if(signal.aborted){result.dispose();signal.throwIfAborted();}
  engine=result;
  engine.onError=fail;
  performance.mark('lens-device-ready');
  return result;
});
const study=import('./scene.js').then(({preparePier,show})=>{
  signal.throwIfAborted();
  const pier=preparePier();
  performance.mark('lens-pier-prepared');
  return {pier,show};
});
Promise.all([device,study]).then(([engine,{pier,show}])=>
  show({engine,pier,canvas,status,notice,size,signal,fail})).catch(fail);
