import { demoStatus } from 'margo-demo-status';
import { prepareAssets, sectors } from './assets.js';

const el=id=>document.getElementById(id);
const exhibit=el('exhibit'), canvas=el('canvas'), button=el('flight'), message=el('status');
const status=demoStatus(exhibit,message), controller=new AbortController(),{signal}=controller;
const stations=[...document.querySelectorAll('[data-sector]')];
const overview={key:'overview',label:'Overview'};
const force=new URLSearchParams(location.search).get('backend')==='webgl2';
const earlyCompatibility=(force||!navigator.gpu)?import('./compatibility.js').then(async module=>{
  await module.installCompatibility(force,signal);
  return {};
}).catch(error=>({error})):undefined;
const fetchAssets=prepareAssets(signal);
let scene, current=0, flying=false, flightNumber=0, last;

function fail(error) {
  if(signal.aborted||status.failed)return;
  status.error(error);
  for(const control of [button,...stations])control.disabled=true;
  scene?.close();
}
function present(data) {
  if(signal.aborted||status.failed)return;
  if(data.error){if(scene)fail(data.error);return;}
  const {visible,loaded,ready,altitude,east,south,pending,bytes}=data;
  if(last&&visible===last.visible&&loaded===last.loaded&&ready===last.ready&&pending===last.pending&&
      altitude.toFixed(1)===last.altitude.toFixed(1)&&east.toFixed(1)===last.east.toFixed(1)&&south.toFixed(1)===last.south.toFixed(1))return;
  last=data;
  Object.assign(exhibit.dataset,{visible,loaded,readyTiles:ready,pending,bytes,
    altitude:altitude.toFixed(2),east:east.toFixed(2),south:south.toFixed(2)});
  el('visible').textContent=visible?visible.split(',').length:0;
  el('loaded').textContent=ready+' / 4';
  el('altitude').textContent=Math.round(altitude)+' m';
  const tally=new Set(loaded.split(','));
  for(const item of stations)item.dataset.loaded=String(tally.has(item.dataset.sector));
}
function updateDestination() {
  const selected=sectors[current]??overview, next=sectors[(current+1)%sectors.length];
  el('sector').textContent=current<0?'District overview':selected.label+' sector';
  button.textContent='Fly to '+next.label.toLowerCase()+' ↗';
  exhibit.dataset.station=selected.key;
  for(const item of stations)item.setAttribute('aria-pressed',String(item.dataset.sector===selected.key));
}
async function fly(index) {
  if(!scene||flying||status.failed||signal.aborted||index===current)return;
  flying=true;
  exhibit.dataset.flying='true';
  const target=sectors[index]??overview;
  message.textContent=index<0?'Climbing to the district overview…':'Flying to the '+target.label.toLowerCase()+' sector…';
  try {
    if(!await scene.fly(target.key))return;
    if(signal.aborted)return;
    current=index;
    exhibit.dataset.flight=String(++flightNumber);
    updateDestination();
    present(scene.read());
    if(flightNumber===1)performance.mark('margo-first-input-rendered');
  }catch(error){fail(error);}
  finally {
    flying=false;
    exhibit.dataset.flying='false';
    if(!signal.aborted&&!status.failed)message.textContent='';
  }
}
button.addEventListener('click',()=>void fly((current+1)%sectors.length),{signal});
for(const item of stations)item.addEventListener('click',()=>void fly(sectors.findIndex(row=>row.key===item.dataset.sector)),{signal});
window.addEventListener('pagehide',event=>{if(!event.persisted)controller.abort();},{signal});
import('./scene.js').then(async({openSurvey})=>{
  scene=await openSurvey(canvas,force,signal,present,fetchAssets,earlyCompatibility);
  signal.throwIfAborted();
  exhibit.dataset.renderer=scene.backend;
  exhibit.dataset.flying='false';
  exhibit.dataset.flight='0';
  present(scene.read());
  updateDestination();
  for(const control of [button,...stations])control.disabled=false;
  performance.mark('margo-first-usable-frame');
  status.ready('');
}).catch(fail);
