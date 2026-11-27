import { openHistory, historySlice } from './history.js';
import { demoStatus } from 'margo-demo-status';
import { untilYear } from './archive.mjs';

const get=id=>document.getElementById(id);
const wall=get('wall'), control=get('cutoff'), overlay=get('status');
const downloads=[get('save-history'),get('save-orbit')];
const charts=[
  {id:'history',title:'Discovery by year',filename:'exoplanet-discoveries'},
  {id:'orbits',title:'Orbits and sizes',filename:'exoplanet-orbits'},
];
const status=demoStatus(wall,overlay,get('reason'));
const controller=new AbortController(),{signal}=controller;
let first, second, observer, resize, frame, active;
let desired=untilYear, running=false, dirty=false, exporting=false, secondReady=false, drawingOrbit;
const formatter=new Intl.NumberFormat('en-US');
const report=message=>{get('download-status').textContent=message;};

function buttons() {
  const disabled=running||dirty||exporting||status.failed;
  downloads[0].disabled=disabled;
  downloads[1].disabled=disabled||!secondReady;
}

function fail(error) {
  if(status.failed||signal.aborted)return;
  status.error(error);
  const unsupported=error?.code==='unsupported';
  overlay.querySelector('strong').textContent=unsupported?
    'The charts need WebGPU or full WebGL2.':'The charts could not open.';
  get('help').hidden=!unsupported;
  overlay.hidden=false;
  control.disabled=true;
  buttons();
}

function readout(snapshot) {
  const {cutoff,total,plotted,peak,peakYear}=snapshot;
  get('count').textContent=formatter.format(total);
  get('year').textContent=String(cutoff);
  control.setAttribute('aria-valuetext','Through '+cutoff);
  get('history-caption').textContent='Peak recorded year: '+peakYear+' · '+formatter.format(peak)+' discoveries.';
  get('orbit-caption').textContent=formatter.format(plotted)+' planets · 0.1–10,000 days · up to 24 Earth radii.';
  Object.assign(wall.dataset,{year:cutoff,total,plotted,peak,peakYear});
}

function enqueue() {
  dirty=true;
  buttons();
  if(frame===undefined&&!running&&!status.failed&&!signal.aborted)frame=requestAnimationFrame(flush);
}

async function renderOrbit(snapshot) {
  const execute=async()=>{
    if(!second||signal.aborted)return;
    await second.render(snapshot);
    if(active!==snapshot)return;
    secondReady=true;
    get('orbit-status').hidden=true;
    wall.dataset.orbits='true';
  };
  drawingOrbit=(drawingOrbit??Promise.resolve()).then(execute);
  await drawingOrbit;
}

async function flush() {
  frame=undefined;
  if(!dirty||signal.aborted||status.failed)return;
  dirty=false;
  running=true;
  try{
    const snapshot=desired===active.cutoff?active:historySlice(desired);
    const changed=snapshot!==active;
    await first.render(snapshot);
    signal.throwIfAborted();
    active=snapshot;
    readout(snapshot);
    if(changed&&!performance.getEntriesByName('wall-first-cutoff').length)performance.mark('wall-first-cutoff');
    if(second)await renderOrbit(snapshot);
  }catch(error){fail(error);}
  finally{
    running=false;
    buttons();
    if(dirty)enqueue();
  }
}

async function observeSecondary() {
  const canvas=get('orbits');
  observer=new IntersectionObserver(entries=>{
    if(!entries.some(entry=>entry.isIntersecting))return;
    observer.disconnect();
    void import('./orbit.js').then(({openOrbits})=>openOrbits(canvas,{signal,fail,renderer:first.renderer,describe:report}))
      .then(async output=>{
        if(signal.aborted){output.dispose();return;}
        second=output;
        await renderOrbit(active);
        buttons();
      }).catch(fail);
  });
  observer.observe(canvas);
}

async function download(index) {
  const plot=index?second:first;
  if(!plot||running||dirty||exporting)return;
  exporting=true;
  buttons();
  const chart=charts[index], snapshot=active;
  control.disabled=true;
  try{
    const { publicationSVG }=await import('./publication.js');
    const source=await plot.export();
    signal.throwIfAborted();
    const svg=publicationSVG(source,chart,snapshot);
    const link=document.createElement('a');
    const href=URL.createObjectURL(new Blob([svg],{type:'image/svg+xml;charset=utf-8'}));
    link.href=href;
    link.download=chart.filename+'-through-'+snapshot.cutoff+'.svg';
    link.click();
    setTimeout(()=>URL.revokeObjectURL(href),1000);
    report('Downloaded '+chart.title+' through '+snapshot.cutoff+'.');
  }catch(error){if(!signal.aborted)report('Download failed. '+error.message);}
  finally{
    exporting=false;
    control.disabled=status.failed;
    buttons();
  }
}

async function open() {
  first=await openHistory(get('history'),{signal,fail});
  active=historySlice(desired);
  await first.render(active);
  signal.throwIfAborted();
  if(status.failed)return;
  wall.dataset.renderer=first.renderer;
  readout(active);
  control.addEventListener('input',()=>{
    desired=Number(control.value);
    get('year').textContent=String(desired);
    enqueue();
  },{signal});
  downloads.forEach((button,index)=>button.addEventListener('click',()=>{void download(index);},{signal}));
  resize=new ResizeObserver(entries=>{
    for(const {target} of entries){
      const key=target.clientWidth+'x'+target.clientHeight;
      if(sizes.get(target)===key)continue;
      sizes.set(target,key);
      enqueue();
    }
  });
  const sizes=new WeakMap();
  for(const chart of charts){
    const canvas=get(chart.id);
    sizes.set(canvas,canvas.clientWidth+'x'+canvas.clientHeight);
    resize.observe(canvas);
  }
  control.disabled=false;
  buttons();
  overlay.hidden=true;
  performance.mark('margo-first-usable-frame');
  status.ready();
  void observeSecondary();
}

window.addEventListener('pagehide',event=>{
  if(event.persisted)return;
  controller.abort();
  resize?.disconnect();
  observer?.disconnect();
  if(frame!==undefined)cancelAnimationFrame(frame);
  second?.dispose();
  first?.dispose();
});
open().catch(fail);
