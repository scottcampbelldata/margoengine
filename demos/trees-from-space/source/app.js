import { demoStatus } from 'margo-demo-status';

const el = id => document.getElementById(id);
const exhibit=el('exhibit'), button=el('barriers'), slider=el('growth'), angle=el('angle'), status=demoStatus(exhibit,el('status'));
const abort=new AbortController(),{signal}=abort;
const force=new URLSearchParams(location.search).get('backend')==='webgl2';
const worker=new Worker(new URL('./growth.worker.js',import.meta.url),{type:'module'});
let scene,observer,pending,revision=0,blocked=false,clock=100,working=false,viewDirty=false,drawing,side=false;

function fail(error) {
  if (signal.aborted || status.failed) return;
  status.error(error);
  button.disabled=slider.disabled=angle.disabled=true;
  worker.terminate();
  scene?.close();
}
worker.addEventListener('error',event=>{
  const error=new Error(event.message || 'The growth worker could not open.');
  pending?.reject(error);
  fail(error);
},{signal});
worker.addEventListener('message',({data})=>{
  if (data.id!==pending?.id) return;
  const job=pending;
  pending=undefined;
  if (data.error) job.reject(new Error(data.error));
  else job.resolve(data.model);
},{signal});
signal.addEventListener('abort',()=>{
  pending?.reject(signal.reason);
  worker.terminate();
},{once:true});

function solve(active) {
  const id=revision;
  return new Promise((resolve,reject)=>{
    pending={id,resolve,reject};
    worker.postMessage({id,blocked:active});
  });
}
function report(model) {
  Object.assign(exhibit.dataset,model.stats,{revision,blocked,growth:clock});
  button.setAttribute('aria-pressed',String(blocked));
  button.textContent=blocked?'Remove barriers':'Insert barriers';
  el('condition').textContent=blocked?'Barriers in place':'Open growth';
  el('upper').textContent=model.stats.crownNodes-1;
  el('lower').textContent=model.stats.rootNodes-1;
  el('crossings').textContent=blocked?String(model.stats.crownSweep+model.stats.rootSweep):'—';
}
async function refresh() {
  if (!scene || working || drawing || signal.aborted || status.failed) return;
  viewDirty=false;
  const next=clock, angleView=side;
  scene.setAngle(angleView);
  drawing=scene.frame(next/100);
  try {
    await drawing;
    if (signal.aborted) return;
    exhibit.dataset.growth=next;
    exhibit.dataset.angle=angleView?"side":"front";
  } catch (error) {
    fail(error);
  } finally {
    drawing=undefined;
    if (viewDirty) void refresh();
  }
}

async function toggle() {
  if (!scene || working || status.failed || signal.aborted) return;
  working=true;
  button.disabled=true;
  const active=!blocked;
  revision++;
  el('status').textContent='Recomputing growth…';
  try {
    const model=await solve(active);
    await drawing;
    signal.throwIfAborted();
    performance.mark('margo-grown-'+revision);
    await scene.setModel(model,active,clock/100);
    blocked=active;
    report(model);
    el('status').textContent='';
    if (revision===1) performance.mark('margo-first-input-rendered');
  } catch (error) {
    fail(error);
  } finally {
    working=false;
    if (!status.failed && !signal.aborted) {
      button.disabled=false;
      if (viewDirty) void refresh();
    }
  }
}
button.addEventListener('click',()=>void toggle(),{signal});
angle.addEventListener('click',()=>{
  side=!side;
  angle.setAttribute('aria-pressed',String(side));
  angle.textContent=side?'Front view':'Side view';
  viewDirty=true;
  void refresh();
},{signal});
slider.addEventListener('input',()=>{
  clock=Number(slider.value);
  el('growth-value').value=clock+'%';
  slider.setAttribute('aria-valuetext',clock+' percent');
  viewDirty=true;
  void refresh();
},{signal});

window.addEventListener('pagehide',event=>{
  if (event.persisted) return;
  abort.abort();
  observer?.disconnect();
},{signal});
const initial=solve(blocked);
initial.catch(fail);
import('./scene.js').then(async({openSpecimen})=>{
  scene=await openSpecimen(el('view'),initial,force,signal);
  signal.throwIfAborted();
  report(await initial);
  exhibit.dataset.renderer=scene.backend;
  observer=new ResizeObserver(()=>{
    viewDirty=true;
    void refresh();
  });
  observer.observe(el('view'));
  button.disabled=slider.disabled=angle.disabled=false;
  performance.mark('margo-first-usable-frame');
  status.ready('');
}).catch(fail);
