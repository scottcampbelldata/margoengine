import { demoStatus } from 'margo-demo-status';
import amberGlass from './tools/amber-glass.webp?url';
import blueGlass from './tools/blue-glass.webp?url';
import amberOpaque from './tools/amber-opaque.webp?url';
import blueOpaque from './tools/blue-opaque.webp?url';
import { referenceSamples } from './optics.js';

const el=id=>document.getElementById(id);
const exhibit=el('exhibit'),light=el('light'),material=el('material'),mode=el('live'),message=el('status');
const status=demoStatus(exhibit,message),controller=new AbortController(),{signal}=controller;
const forced=new URLSearchParams(location.search).get('backend')==='webgl2';
const urls={'amber-glass':amberGlass,'blue-glass':blueGlass,'amber-opaque':amberOpaque,'blue-opaque':blueOpaque};
const afterPaint=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
const images=new Map();
let reference=el('reference'),scene,compiledVariant,blue=false,opaque=false,updating=false,opening=false,live=false;
let inputs=0,liveInputs=0;
let sampleCount=referenceSamples;

function name(nextBlue,nextOpaque){
  return (nextBlue?'blue':'amber')+'-'+(nextOpaque?'opaque':'glass');
}
function image(key){
  let pending=images.get(key);
  if(!pending){
    const node=key==='amber-glass'?reference:new Image(960,840);
    if(key!=='amber-glass')node.src=urls[key];
    pending=node.decode().then(()=>node);
    images.set(key,pending);
  }
  return pending;
}
function displaySamples(){
  const samples=live?sampleCount:referenceSamples;
  if(el('samples').textContent!==String(samples))el('samples').textContent=String(samples);
}
function present(stats){
  const {samples,sceneRevision,width,height}=stats;
  sampleCount=samples;
  Object.assign(exhibit.dataset,{traceSamples:samples,traceRevision:sceneRevision,traceWidth:width,traceHeight:height});
  if(live)displaySamples();
}
function selection(){
  Object.assign(exhibit.dataset,{blue,opaque,variant:name(blue,opaque)});
  el('lamp').textContent=blue?'Blue lamp':'Amber lamp';
  el('surface').textContent=opaque?'Opaque':'Glass';
  light.innerHTML=(blue?'Switch to amber':'Switch to blue')+' <span aria-hidden="true">↗</span>';
  material.textContent=opaque?'Restore glass':'Make opaque';
  material.setAttribute('aria-pressed',String(opaque));
}
async function showReference(nextBlue,nextOpaque){
  const key=name(nextBlue,nextOpaque);
  const node=await image(key);
  signal.throwIfAborted();
  node.alt='Afterglass with the '+(nextBlue?'blue':'amber')+' lamp active and the column '+(nextOpaque?'opaque.':'made of glass.');
  if(node!==reference){
    node.id='reference';
    reference.replaceWith(node);
    reference=node;
  }
}
function fail(error){
  if(signal.aborted||status.failed)return;
  scene?.close();
  light.disabled=material.disabled=mode.disabled=true;
  status.error(error);
}
function liveFailure(){
  if(signal.aborted)return;
  scene?.close();
  scene=undefined;
  toReference();
  exhibit.dataset.live='failed';
  message.textContent='Live tracing is unavailable on this device. The path-traced reference is available.';
}
function setMode(active){
  live=active;
  exhibit.dataset.mode=active?'live':'reference';
  el('canvas').setAttribute('aria-hidden',String(!active));
  reference.setAttribute('aria-hidden',String(active));
  el('render-mode').textContent=active?
    'Live · '+(scene.backend==='webgpu'?'WebGPU':'WebGL2 compatibility'):'Path-traced reference';
  mode.textContent=active?'Show reference':'Start live trace';
  displaySamples();
}
function toReference(){
  scene?.pause();
  setMode(false);
}

async function change(nextBlue,nextOpaque){
  if(updating||status.failed)return;
  updating=true;
  try{
    const key=name(nextBlue,nextOpaque);
    if(live){
      await Promise.all([scene.change(nextBlue,nextOpaque),showReference(nextBlue,nextOpaque)]);
      compiledVariant=key;
    }else {
      await showReference(nextBlue,nextOpaque);
    }
    blue=nextBlue;
    opaque=nextOpaque;
    selection();
    await afterPaint();
    exhibit.dataset.inputs=String(++inputs);
    if(inputs===1)performance.mark('margo-first-input-rendered');
    if(live&&++liveInputs===1)performance.mark('margo-live-input-rendered');
  }catch(error){fail(error);}
  finally{updating=false;}
}

function loadLive(){
  const compatibility=(forced||!navigator.gpu)?import('./compatibility.js').then(async module=>{
    await module.installCompatibility(forced,signal);
    return {};
  }).catch(error=>({error})):undefined;
  const url=new URL('./tools/afterglass.vox',import.meta.url);
  const bytes=fetch(url,{signal}).then(response=>{
    if(!response.ok)throw new Error('Afterglass VOX download failed.');
    return response.arrayBuffer();
  }).catch(error=>({error}));
  const starting={blue,opaque};
  compiledVariant=name(blue,opaque);
  return import('./scene.js').then(module=>module.openStudy(
    el('canvas'),forced,signal,bytes,compatibility,starting,present,liveFailure));
}
async function toggleMode(){
  if(opening||updating||status.failed)return;
  if(live){toReference();return;}
  opening=true;
  mode.disabled=true;
  message.textContent='Preparing the live path tracer…';
  exhibit.dataset.live='loading';
  performance.mark('margo-live-requested');
  try{
    scene??=await loadLive();
    scene.pause();
    while(compiledVariant!==name(blue,opaque)){
      const current={blue,opaque};
      await scene.change(current.blue,current.opaque);
      compiledVariant=name(current.blue,current.opaque);
    }
    Object.assign(exhibit.dataset,{renderer:scene.backend,cells:scene.cells,materials:JSON.stringify(scene.counts),live:'ready'});
    setMode(true);
    scene.resume();
    message.textContent='';
    await afterPaint();
    performance.mark('margo-live-available');
  }catch{liveFailure();}
  finally{
    opening=false;
    if(!signal.aborted)mode.disabled=false;
  }
}

light.addEventListener('click',()=>void change(!blue,opaque),{signal});
material.addEventListener('click',()=>void change(blue,!opaque),{signal});
mode.addEventListener('click',()=>void toggleMode(),{signal});
window.addEventListener('pagehide',event=>{if(!event.persisted)controller.abort();},{signal});
Promise.all([image('amber-glass'),image('blue-glass')]).then(async()=>{
  signal.throwIfAborted();
  await showReference(false,false);
  selection();
  setMode(false);
  exhibit.dataset.live='idle';
  exhibit.dataset.inputs='0';
  light.disabled=material.disabled=mode.disabled=false;
  await afterPaint();
  performance.mark('margo-first-usable-frame');
  status.ready('');
}).catch(fail);
