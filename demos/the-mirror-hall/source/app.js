import { demoStatus } from 'margo-demo-status';

const el=id=>document.getElementById(id);
const hall=el('hall'),slider=el('tilt'),canvas=el('view');
const status=demoStatus(hall,el('status'));
const controller=new AbortController(), {signal}=controller;
const forced=new URLSearchParams(location.search).get('backend')==='webgl2';
let angle=Number(slider.value), scene, observer, frame, busy=false, queued=false, serial=0;

function frameState(tilt){
  const ratio=Math.min(devicePixelRatio,2);
  return {tilt,width:Math.max(4,Math.round(canvas.clientWidth*ratio)),height:Math.max(4,Math.round(canvas.clientHeight*ratio))};
}

function readout(value,visibility){
  el('angle').textContent=value+'°';
  el('visibility').textContent=visibility==='off-camera'?'Sculpture off camera':
    visibility==='clipped'?'Sculpture crossing the frame':'Sculpture in frame';
  slider.setAttribute('aria-valuetext',value+' degrees downward. '+el('visibility').textContent);
  Object.assign(hall.dataset,{tilt:value,visibility});
}

function fail(error){
  if(signal.aborted)return;
  status.error(error);
  slider.disabled=true;
  controller.abort();
  observer?.disconnect();
  scene?.close();
}

function queue(){
  if(signal.aborted||!scene||status.failed||busy||frame!==undefined)return;
  frame=requestAnimationFrame(async()=>{
    frame=undefined;
    busy=true;
    queued=false;
    const value=angle,input=serial;
    try{
      const visibility=await scene.render(frameState(value));
      if(signal.aborted)return;
      readout(value,visibility);
      if(input>0&&input===serial&&!performance.getEntriesByName('margo-first-input-rendered').length){
        await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));
        if(input===serial&&!signal.aborted)performance.mark('margo-first-input-rendered');
      }
    }catch(error){fail(error);}
    finally{
      busy=false;
      if(queued)queue();
    }
  });
}

slider.addEventListener('input',()=>{
  angle=Number(slider.value);
  serial++;
  queued=true;
  queue();
},{signal});
window.addEventListener('pagehide',event=>{
  if(event.persisted)return;
  controller.abort();
  observer?.disconnect();
  if(frame!==undefined)cancelAnimationFrame(frame);
},{signal});

const compat=forced||!navigator.gpu;
const earlyCompatibility=compat?import('./compatibility.js').then(async module=>{
  await module.installCompatibility(true,signal);
  return {};
}).catch(error=>({error})):undefined;
async function prepareCompatible(){
  const implementation=await import('./local-mirror.js');
  signal.throwIfAborted();
  return {implementation,model:implementation.prepareMirror()};
}
async function prepareNative(){
  const implementation=await import('./stock-mirror.js');
  signal.throwIfAborted();
  return {implementation,model:implementation.prepareStockMirror()};
}
const earlyTracing=(compat?prepareCompatible():prepareNative()).then(prepared=>{
  performance.mark('mirror-tracing-prepared');
  return prepared;
}).catch(error=>({error}));
async function open(){
  const {openHall}=await import('./scene.js');
  scene=await openHall(canvas,frameState(angle),signal,compat,earlyCompatibility,earlyTracing);
  signal.throwIfAborted();
  Object.assign(hall.dataset,{renderer:scene.backend,bvhInstances:scene.accelerationInstances,method:scene.method});
  if(scene.programs)hall.dataset.programs=JSON.stringify(scene.programs);
  readout(angle,scene.initialVisibility);
  observer=new ResizeObserver(()=>{queued=true;queue();});
  observer.observe(el('view').parentElement);
  slider.disabled=false;
  performance.mark('margo-first-usable-frame');
  status.ready('');
}
open().catch(fail);
