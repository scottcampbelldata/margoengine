import {autoEngine} from '@margoengine/webgl2-compat/auto';

const requested=document.querySelector('#view');
const life=new AbortController(),{signal}=life;
const force=new URLSearchParams(location.search).get('backend')==='webgl2';
const loaded=import('./scene.js').then(module=>{
  signal.throwIfAborted();
  const opening=module.prepare();
  performance.mark('voxel-editor-model-ready');
  signal.addEventListener('abort',()=>opening.world.dispose(),{once:true});
  return {module,opening};
});
loaded.catch(()=>{});
let engine,app;

function fail(error){
  if(signal.aborted)return;
  document.body.dataset.error=error.message;
  document.getElementById('loading').hidden=true;
  document.getElementById('controls').disabled=true;
  const output=document.getElementById('error');
  output.hidden=false;
  output.textContent=error.message;
  console.error(error);
}

async function compatibility(){
  const {install}=await import('@margoengine/webgl2-compat');
  return {install:()=>install({force:true,signal})};
}
async function start(){
  if(force||!navigator.gpu)await (await compatibility()).install();
  await autoEngine(requested,async target=>{
    if(!target.gpu)throw Error('The voxel studio requires WebGPU or full WebGL2 compatibility.');
    engine=target;engine.onError=fail;
    performance.mark('margo-device-open');
    const {module,opening}=await loaded;
    app=await module.connect(engine,engine.canvas,signal,fail,opening);
  },{loadCompat:compatibility,signal,capacity:32,exactSize:true,antialias:false,
    camera:{fov:41,near:.8,far:197,position:[55,40.6,59.1],target:[15.6,9.8,15.6]}});
}
start().catch(fail);
addEventListener('pagehide',event=>{
  if(event.persisted)return;
  life.abort();
  app?.dispose();
  engine?.dispose();
});
