import { demoStatus } from 'margo-demo-status';

const host=document.getElementById('exhibit'),canvas=document.getElementById('ocean');
const status=demoStatus(host,document.getElementById('status'));
const aborter=new AbortController(),{signal}=aborter;
const forced=new URLSearchParams(location.search).get('backend')==='webgl2';
let trustedPointer=false,pending=false,inputDone=false;

function observe(event){
  if(event.isTrusted&&host.dataset.screen==='title')trustedPointer=true;
}
host.addEventListener('pointerup',observe,{capture:true,signal});
host.addEventListener('keydown',observe,{capture:true,signal});
host.addEventListener('click',observe,{capture:true,signal});
window.addEventListener('pagehide',event=>{if(!event.persisted)aborter.abort();},{signal});

function fail(error){
  if(signal.aborted)return;
  status.error(error);
  aborter.abort();
}
async function open(){
  const scene=import('./scene.js');
  const native=!forced&&navigator.gpu&&await navigator.gpu.requestAdapter().catch(()=>null);
  const fallback=native?undefined:(await import('./compatibility.js')).webglRenderer;
  signal.throwIfAborted();
  const {openGame}=await scene;
  await openGame(canvas,{
    host,signal,fallback,fail,
    onAction(){pending=!inputDone&&trustedPointer;},
    onRendered(engine){
      if(!pending)return;
      pending=false;
      inputDone=true;
      performance.mark('game-action-submitted');
      const submitted=engine.backend==='webgpu'?engine.gpu.queue.onSubmittedWorkDone()
        :new Promise(resolve=>requestAnimationFrame(resolve));
      void submitted.then(()=>{
        if(!signal.aborted)performance.mark('margo-first-input-rendered');
      }).catch(fail);
    }
  });
  signal.throwIfAborted();
  performance.mark('margo-first-usable-frame');
  status.ready('');
}
open().catch(fail);
