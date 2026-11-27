import { demoStatus } from 'margo-demo-status';

const el=id=>document.getElementById(id);
const exhibit=el('exhibit'),slider=el('drift'), status=demoStatus(exhibit,el('status'));
const controller=new AbortController(), {signal}=controller;
const force=new URLSearchParams(location.search).get('backend')==='webgl2';
let art, observer, running=false, queued=false, revision=0;

function fail(error) {
  if(signal.aborted||status.failed)return;
  status.error(error);
  slider.disabled=true;
  art?.close();
}
const worker=new Worker(new URL('./art.worker.js',import.meta.url),{type:'module'});
const initial=new Promise((resolve,reject)=>{
  worker.addEventListener('message',({data})=>{
    worker.terminate();
    if(data.error)reject(new Error(data.error));
    else resolve(data);
  },{once:true,signal});
  worker.addEventListener('error',event=>{
    worker.terminate();
    reject(new Error(event.message||'The sculpture could not be split.'));
  },{once:true,signal});
  signal.addEventListener('abort',()=>{
    worker.terminate();
    reject(signal.reason);
  },{once:true});
});
initial.catch(fail);
async function draw() {
  if(!art||running||status.failed||signal.aborted)return;
  queued=false;
  running=true;
  const value=Number(slider.value),edit=revision;
  try {
    const sample=await art.render(value/100);
    if(signal.aborted)return;
    exhibit.dataset.drift=value;
    exhibit.dataset.revision=edit;
    exhibit.dataset.travel=sample.toFixed(6);
    if(edit>0&&!performance.getEntriesByName('margo-first-input-rendered').length) {
      performance.mark('margo-first-input-rendered');
    }
  }catch(error){fail(error);}
  finally {
    running=false;
    if(queued)void draw();
  }
}
function schedule() {
  queued=true;
  void draw();
}
slider.addEventListener('input',()=>{
  revision++;
  el('value').value=slider.value+'%';
  slider.setAttribute('aria-valuetext',slider.value+' percent separated');
  schedule();
},{signal});
window.addEventListener('pagehide',event=>{
  if(event.persisted)return;
  controller.abort();
  observer?.disconnect();
},{signal});
import('./scene.js').then(async({openGallery})=>{
  const start=Number(slider.value);
  art=await openGallery(el('view'),initial,start/100,force,signal);
  signal.throwIfAborted();
  Object.assign(exhibit.dataset, art.stats, {renderer:art.backend,drift:start,travel:art.initialTravel,revision:0});
  el('pieces').textContent=art.stats.pieces+' cells';
  observer=new ResizeObserver(schedule);
  observer.observe(el('view'));
  slider.disabled=false;
  performance.mark('margo-first-usable-frame');
  status.ready('');
}).catch(fail);
