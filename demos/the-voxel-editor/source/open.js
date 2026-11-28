import {openBench} from '@margoengine/studio/bench';

const requested=document.querySelector('#view');
const life=new AbortController(),{signal}=life;
const loaded=import('./scene.js').then(module=>{
  signal.throwIfAborted();
  const opening=module.prepare();
  performance.mark('voxel-editor-model-ready');
  signal.addEventListener('abort',()=>opening.world.dispose(),{once:true});
  return {module,opening};
});
loaded.catch(()=>{});
let app,resized=()=>{};

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

async function start(){
  // The bench opens WebGPU or the WebGL2 layer (?backend=webgl2 forces it), sizes the backbuffer, carries the harbor's
  // light and its single PCF cascade, and disposes on pagehide.
  const bench=await openBench(requested,{start:(on,o)=>import('@margoengine/webgl2-compat/auto').then(m=>m.startEngine(on,o)),loadCompat:()=>import('@margoengine/webgl2-compat'),
    signal,pixelRatio:2,capacity:32,antialias:false,
    camera:{fov:41,near:.8,far:197,position:[55,40.6,59.1],target:[15.6,9.8,15.6]},
    background:'#516c70',backdrop:false,contact:false,environment:false,
    light:{direction:[-3,6,4],intensity:2.3,color:[1,.889,.752],ambient:.94,ambientColor:[.68,.83,.91]},
    shadows:{resolution:1024,cascades:1,distance:105,filter:'pcf'},
    onError:fail,onResize:()=>resized(),
  });
  performance.mark('margo-device-open');
  const {module,opening}=await loaded;
  app=await module.connect(bench,signal,fail,opening,hook=>{resized=hook;});
}
start().catch(fail);
addEventListener('pagehide',event=>{
  if(event.persisted)return;
  life.abort();
  app?.dispose();
});
