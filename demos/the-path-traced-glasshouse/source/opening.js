import openingURL from './assets/opening.png?url';
import fixedURL from './assets/fixed.png?url';

const exhibit=document.querySelector('#exhibit');
const opening=document.querySelector('#opening'), fixed=document.querySelector('#fixed');
const save=document.querySelector('#save'), rayButton=document.querySelector('#view-rays');
const controls=[document.querySelector('#flint-control'),document.querySelector('#fixed-control')];
const status=document.querySelector('#status'), mode=document.querySelector('#mode');
const progress=document.querySelector('#progress'), help=document.querySelector('#help');
const comparison={flint:{image:opening,url:openingURL},fixed:{image:fixed,url:fixedURL}};
const canvas=document.querySelector('#glasshouse'), diagramCanvas=document.querySelector('#diagram');
const controller=new AbortController(), {signal}=controller;
const params=new URLSearchParams(location.search);
const capture=params.has('capture');
const native=params.get('backend')!=='webgl2'&&Boolean(navigator.gpu);
let glass='flint', view='bench', savedURL, launchTimer, deadline, live, liveSave, liveGlass, diagram, diagramLoad;
let launchStarted=false, selectionVersion=0, rayRequested=false, nativeError=false, liveSamples=0;

function present() {
  const tracing=view==='bench'&&liveSave&&liveGlass===glass;
  canvas.hidden=capture?false:!tracing;
  diagramCanvas.hidden=view!=='rays';
  for(const [name,{image}] of Object.entries(comparison))image.hidden=view==='rays'||tracing||name!==glass;
  rayButton.setAttribute('aria-pressed',String(view==='rays'));
  if(view==='bench'){
    help.hidden=true;
    mode.textContent=tracing?'Live spectral trace':'Spectral comparison';
    progress.textContent=tracing?liveSamples+' samples per pixel':
      native&&!nativeError?'Recorded rendering · Live trace is preparing':'Recorded Margo rendering';
  }
}
function error(reason) {
  status.hidden=false;
  status.textContent=reason.message;
  exhibit.dataset.error=reason.message;
}
function stopLive(reason) {
  if(capture){error(reason);return;}
  nativeError=true;
  liveSave=undefined;
  delete exhibit.dataset.live;
  exhibit.dataset.liveError=reason.message;
  present();
}
function scheduleLaunch(wait=720) {
  if(!native||launchStarted||view!=='bench'||signal.aborted)return;
  clearTimeout(launchTimer);
  launchTimer=setTimeout(launch,wait);
}
async function launch() {
  if(launchStarted||signal.aborted)return;
  if(!capture&&(!native||view!=='bench'))return;
  launchStarted=true;
  const liveController=new AbortController();
  const cancel=()=>liveController.abort(signal.reason);
  signal.addEventListener('abort',cancel,{once:true});
  deadline=setTimeout(()=>{
    const reason=new Error('Live spectral tracing did not finish preparing in 60 seconds.');
    liveController.abort(reason);
    signal.removeEventListener('abort',cancel);
    stopLive(reason);
  },60000);
  try {
    const {start}=await import('./start.js');
    liveController.signal.throwIfAborted();
    await start({
      signal:liveController.signal,
      selected:()=>glass,
      active:()=>view==='bench'&&!rayRequested,
      attach(controls){live=controls;},
      ready({snapshot,samples,glass:tracedGlass}){
        clearTimeout(deadline);
        if(tracedGlass!==glass||view!=='bench')return;
        performance.mark('glasshouse-live-ready');
        exhibit.dataset.live='true';
        exhibit.dataset.liveGlass=tracedGlass;
        liveSave=snapshot;
        liveGlass=tracedGlass;
        liveSamples=samples;
        present();
      },
      capturePrepared(){clearTimeout(deadline);},
      sampleCount(value,tracedGlass){
        if(liveSave&&liveGlass===tracedGlass){
          liveSamples=value;
          if(view==='bench')progress.textContent=value+' samples per pixel';
        }
      },
      onError(reason){clearTimeout(deadline);if(!signal.aborted)stopLive(reason);},
    });
  }catch(reason){
    clearTimeout(deadline);
    if(!signal.aborted&&!liveController.signal.aborted)stopLive(reason);
  }
}

async function loadComparison(entry) {
  const {image,url}=entry;
  const response=await fetch(url,{signal});
  if(!response.ok)throw new Error('A spectral comparison render could not be opened ('+response.status+').');
  const blob=await response.blob();
  signal.throwIfAborted();
  entry.objectURL=URL.createObjectURL(blob);
  image.src=entry.objectURL;
  await image.decode();
}
async function openComparison() {
  await Promise.all(Object.values(comparison).map(loadComparison));
  signal.throwIfAborted();
  exhibit.dataset.glass=glass;
  exhibit.dataset.view=view;
  status.hidden=true;
  present();
  for(const control of [...controls,rayButton,save])control.disabled=false;
  exhibit.dataset.ready='true';
  performance.mark('margo-first-usable-frame');
  scheduleLaunch();
}

function comparisonApplied(version) {
  requestAnimationFrame(()=>requestAnimationFrame(()=>{
    if(!signal.aborted&&version===selectionVersion)performance.mark('glasshouse-comparison-applied');
  }));
}
async function drawDiagram(version) {
  const result=await diagram.choose(glass);
  if(signal.aborted||version!==selectionVersion||view!=='rays')return;
  exhibit.dataset.rays=String(result.rays);
  exhibit.dataset.spread=String(result.width);
  exhibit.dataset.diagramGlass=glass;
  progress.textContent=result.text;
  status.hidden=true;
  save.disabled=false;
  performance.mark('glasshouse-rays-applied');
}
function select(choice) {
  if(glass===choice)return;
  glass=choice;
  exhibit.dataset.glass=glass;
  delete exhibit.dataset.live;
  liveSave=undefined;
  for(const [index,control] of controls.entries())control.setAttribute('aria-pressed',String((index?'fixed':'flint')===glass));
  const version=++selectionVersion;
  if(view==='rays'){
    save.disabled=true;
    drawDiagram(version).catch(diagramError);
  } else {
    present();
    live?.refresh();
    comparisonApplied(version);
  }
}

function diagramError(reason) {
  if(signal.aborted)return;
  delete exhibit.dataset.rays;
  exhibit.dataset.diagramError=reason.message;
  rayRequested=false;
  rayButton.removeAttribute('aria-busy');
  view='bench';
  exhibit.dataset.view=view;
  status.hidden=true;
  save.disabled=false;
  present();
  help.hidden=false;
  progress.textContent='The ray study needs WebGPU or compatible WebGL2.';
  live?.refresh();
  scheduleLaunch();
}

async function openRayView() {
  if(rayRequested)return;
  rayRequested=true;
  clearTimeout(launchTimer);
  rayButton.setAttribute('aria-busy','true');
  status.textContent='Opening the live ray study…';
  status.hidden=false;
  diagramCanvas.hidden=false;
  if(!diagramLoad)diagramLoad=import('./analytic.js').then(({openDiagram})=>openDiagram({canvas:diagramCanvas,signal,fail:diagramError}));
  diagram=await diagramLoad;
  if(signal.aborted||!rayRequested)return;
  rayButton.removeAttribute('aria-busy');
  view='rays';
  exhibit.dataset.view=view;
  exhibit.dataset.diagramRenderer=diagram.renderer;
  mode.textContent='Live ray study';
  help.hidden=true;
  diagram.setVisible(true);
  present();
  save.disabled=true;
  await drawDiagram(++selectionVersion);
}
function backToBench() {
  rayRequested=false;
  rayButton.removeAttribute('aria-busy');
  diagram?.setVisible(false);
  status.hidden=true;
  view='bench';
  exhibit.dataset.view=view;
  present();
  save.disabled=false;
  live?.refresh();
  scheduleLaunch();
}
controls[0].addEventListener('click',()=>select('flint'),{signal});
controls[1].addEventListener('click',()=>select('fixed'),{signal});
rayButton.addEventListener('click',()=>{
  if(rayRequested||view==='rays')backToBench();
  else openRayView().catch(diagramError);
},{signal});

save.addEventListener('click',async()=>{
  const snapshot=view==='rays'?diagram.snapshot:liveSave;
  const which=view==='rays'?'rays':glass;
  try {
    let url=comparison[glass].objectURL;
    if(snapshot){
      save.disabled=true;
      const png=await snapshot();
      if(signal.aborted)return;
      if(savedURL)URL.revokeObjectURL(savedURL);
      savedURL=URL.createObjectURL(png);
      url=savedURL;
    }
    const link=document.createElement('a');
    link.href=url;
    link.download='glasshouse-'+which+'.png';
    link.click();
    performance.mark('glasshouse-png-saved');
  }catch(reason){
    if(!signal.aborted)progress.textContent=reason.message;
  }finally {
    if(!signal.aborted)save.disabled=false;
  }
},{signal});

addEventListener('pagehide',event=>{
  if(event.persisted)return;
  controller.abort();
  clearTimeout(launchTimer);
  clearTimeout(deadline);
  for(const {objectURL} of Object.values(comparison))if(objectURL)URL.revokeObjectURL(objectURL);
  if(savedURL)URL.revokeObjectURL(savedURL);
},{signal});

if(capture)launch();
else openComparison().catch(reason=>{if(!signal.aborted)error(reason);});
