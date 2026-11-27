import {Engine,Geometry,PbrMaterial} from '@margoengine/core';
import {demoStatus} from 'margo-demo-status';

const canvas=document.querySelector('#grove');
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
  message.textContent='The fog scene could not start.';
  for(const control of document.querySelectorAll('input'))control.disabled=true;
  if(reason?.code!=='unsupported')console.error(reason);
  close();
}

function size(){
  const scale=Math.min(1.65,devicePixelRatio);
  const width=Math.max(1,Math.round(scale*canvas.clientWidth));
  const height=Math.max(1,Math.round(scale*canvas.clientHeight));
  if(width===canvas.width&&height===canvas.height)return false;
  canvas.width=width;
  canvas.height=height;
  return true;
}

async function connect(){
  const force=new URLSearchParams(location.search).get('backend')==='webgl2';
  const options={backend:'webgpu',exactSize:true,antialias:false,capacity:64,signal,startupTimeout:2500,
    camera:{position:[.25,1.66,8.90],target:[-.85,2.91,-15.9],near:.32,far:120}};
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
  performance.mark('fog-device-ready');
  return result;
});
const art=new Promise((resolve,reject)=>{
  const worker=new Worker(new URL('./forest-worker.js',import.meta.url),{type:'module'});
  const abort=()=>{
    worker.terminate();
    reject(signal.reason);
  };
  signal.addEventListener('abort',abort,{once:true});
  function closeWorker(){
    signal.removeEventListener('abort',abort);
    worker.terminate();
  }
  worker.addEventListener('message',event=>{
    closeWorker();
    performance.mark('fog-forest-prepared');
    resolve(event.data);
  },{once:true});
  worker.addEventListener('error',event=>{
    closeWorker();
    reject(event.error??new Error(event.message||'Forest geometry worker failed.'));
  },{once:true});
}).then(parts=>{
  signal.throwIfAborted();
  const forest=parts.map(({name,caster,color,roughness,positions,normals,indices})=>({
    name,caster,geometry:new Geometry(positions,normals,indices),
    material:new PbrMaterial({color,roughness}),
  }));
  performance.mark('fog-geometry-ready');
  return forest;
});
const study=import('./scene.js');
Promise.all([device,art,study]).then(([engine,forest,{show}])=>
  show({engine,forest,canvas,status,notice,size,signal,fail})).catch(fail);
