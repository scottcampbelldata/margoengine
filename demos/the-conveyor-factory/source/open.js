import {openBench} from '@margoengine/studio/bench';

const life=new AbortController(),{signal}=life;
const loaded=import('./physics.js').then(async api=>{
  await api.loadPhysics(signal);
  performance.mark('factory-physics');
  return api;
});
loaded.catch(()=>{});
const view=import('./scene.js');
const element=id=>document.getElementById(id);
let exhibit,resized=()=>{};

function fail(error){
  if(signal.aborted)return;
  document.body.dataset.error=error.message;
  element('controls').disabled=true;
  element('loading').hidden=true;
  element('error').hidden=false;
  element('error').textContent=error.message;
  console.error(error);
}
async function start(){
  // The bench opens WebGPU or the WebGL2 layer (?backend=webgl2 forces it), sizes the backbuffer and disposes on pagehide.
  const bench=await openBench(element('stage'),{
    signal,pixelRatio:2,maxWidth:4096,capacity:650,startupTimeout:12000,
    camera:{position:[3.05,6.10,8.35],target:[.075,.97,0],near:.09,far:40},
    background:'#344c5b',backdrop:false,contact:false,environment:false,shadows:{bounds:{min:[-3.5,-.1,-1.9],max:[3.5,2.3,1.9]}},
    light:{direction:[-4,7,5],intensity:3.1,color:[1,.93,.80],ambient:.55,ambientColor:[.74,.88,.99]},
    onError:fail,onResize:()=>resized(),
  });
  performance.mark('factory-device');
  exhibit=await (await view).connect(bench,loaded,signal,fail,hook=>{resized=hook;});
}
start().catch(fail);
addEventListener('pagehide',event=>{
  if(event.persisted)return;
  life.abort();
  exhibit?.dispose();
});
