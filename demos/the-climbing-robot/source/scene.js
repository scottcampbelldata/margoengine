import { applyQualityTier } from '@margoengine/quality';
import { autoEngine } from '@margoengine/webgl2-compat/auto';
import { demoStatus } from 'margo-demo-status';
import { boneCount,buildOpeningCell,loadCell,loadPose,loadRobot,poseStride,readOpeningRobot,routeMoves,step } from './opening-data.js';
import { mountOpeningRobot } from './opening-robot.js';

const get=id=>document.getElementById(id);
const canvas=get('robot');
const detailed=get('full-robot');
const overlay=get('status');
const status=demoStatus(canvas,overlay,get('error'));
const start=get('climb'),reset=get('reset'),routeSelector=get('route');
const controls=[start,reset,routeSelector];
const controller=new AbortController(), {signal}=controller,events={signal};
const force=new URLSearchParams(location.search).get('backend')==='webgl2';
const names=['Left hand reaching','Right hand reaching','Left foot reaching','Right foot reaching'];

let engine,actor,bytes,full,observer,raf,detailTimer,fadeTimer,backend;
let route=routeSelector.value,sequence=0,clip,current,desired=0,playing=false,initialTouch=false;
let warmFailure,drawBusy=false,dirty=true,showingFull=false,lockedForReveal=false;
let clock=0,fraction=0,lastSent=-1,loadSequence=0,pauseAt;
const poseCache=new Map();
const phase=id=>performance.mark('robot-'+id);

function pose(name) {
  let request=poseCache.get(name);
  if(!request) {
    request=loadPose(name,signal).catch(error=>{poseCache.delete(name);throw error;});
    poseCache.set(name,request);
  }
  return request;
}

function fail(error) {
  if(signal.aborted||status.failed)return;
  status.error(error);
  overlay.hidden=false;
  overlay.querySelector('strong').textContent='The test cell could not be opened.';
  get('requirements').hidden=false;
  for(const control of controls)control.disabled=true;
}

function failDetail(error) {
  if(signal.aborted||warmFailure)return;
  if(showingFull){fail(error);return;}
  warmFailure=error?.message??String(error);
  canvas.dataset.detail='unavailable';
  get('detail-note').hidden=false;
  get('detail-note').textContent=error?.code==='unsupported'
    ? 'The live solver needs WebGPU on this browser. The eight-second opening still plays.'
    : 'The live solver could not load. The eight-second opening still plays.';
  full?.dispose();
  full=undefined;
  lockedForReveal=false;
}

function view() {
  const ratio=Math.max(1,Math.min(devicePixelRatio||1,1.4));
  const width=Math.max(1,Math.round(canvas.clientWidth*ratio));
  const height=Math.max(1,Math.round(canvas.clientHeight*ratio));
  return {width,height,fov:Math.max(36,Math.min(60,49/Math.sqrt(width/height)))};
}

function openingFrame(index) {
  const v=clip.values;
  const at=poseStride*index+boneCount*12;
  return {...view(),name:route,sequence,index,eye:Array.from(v.subarray(at,at+3)),look:Array.from(v.subarray(at+3,at+6)),
    pelvis:v[at+6],gap:v[at+7],travel:v[at+8],contacts:clip.contacts[index],moving:clip.moving[index]-1};
}

function readout(frame=current) {
  if(!frame)return;
  const reached=frame.contacts, moves=routeMoves[route];
  const finished=frame.complete||reached===moves;
  if(finished||frame.reachedShort)playing=false;
  let title=frame.reachedShort?'Reach came up short'
    : finished?'Top hold secured'
    : !playing?(frame.index?'Paused':'At the wall')
    : frame.moving>=0?names[frame.moving]:'Planning the next reach';
  if(!showingFull && frame.index===clip.count-1)title=warmFailure?'Opening complete':'Opening the live solver…';
  get('state').textContent=title;
  get('contacts').textContent=String(reached);
  get('gap').textContent=(frame.gap*1000).toFixed(1)+' mm';
  start.textContent=playing?'Pause':finished||(!showingFull&&warmFailure&&frame.index===clip.count-1)?'Climb again'
    : frame.index?'Resume':'Climb';
  Object.assign(canvas.dataset,{contacts:reached,route,moves,moving:frame.moving,pelvis:frame.pelvis.toFixed(4),
    clearance:frame.gap.toFixed(6),running:String(playing),state:title,frame:String(frame.index)});
  if(initialTouch && frame.moving>=0 && frame.travel>.002 && !performance.getEntriesByName('climber-first-input-frame').length){
    phase('first-input-frame');
    performance.mark('climber-first-input-frame');
    performance.mark('margo-first-input-rendered');
  }
}

function presentFull(frame) {
  if(signal.aborted || frame.sequence!==sequence || warmFailure)return;
  if(!showingFull) {
    if(frame.index!==desired || frame.width!==view().width || frame.height!==view().height){
      lockedForReveal=true;
      dirty=true;
      schedule();
      return;
    }
    showingFull=true;
    lockedForReveal=false;
    detailed.classList.add('shown');
    canvas.setAttribute('aria-hidden','true');
    detailed.removeAttribute('aria-hidden');
    canvas.dataset.detail='full';
    canvas.dataset.fullRenderer=frame.backend;
    phase('full-presented');
    fadeTimer=setTimeout(()=>{actor?.dispose(); actor=undefined;engine?.dispose();engine=undefined;},210);
  }
  if(pauseAt!==undefined&&frame.index<pauseAt)return;
  if(pauseAt!==undefined){pauseAt=undefined;start.disabled=false;}
  current=frame;
  readout();
  if(playing && !frame.complete && !frame.reachedShort)schedule();
}

function fullWorker() {
  const worker=new Worker(new URL('./full-worker.js',import.meta.url),{type:'module'});
  worker.addEventListener('message',({data})=>{
    if(data.type==='frame')presentFull(data.frame);
    else if(data.type==='phase')phase('full-'+data.name);
    else failDetail(data);
  },events);
  worker.addEventListener('error',event=>failDetail(event.error??new Error(event.message)),events);
  const output=detailed.transferControlToOffscreen();
  worker.postMessage({type:'attach',bytes,canvas:output,compatibility:backend==='webgl2'},[output,bytes]);
  bytes=undefined;
  return {send(frame){worker.postMessage({type:'frame',frame});},dispose(){worker.terminate();}};
}

async function fullLocal() {
  const {openFull}=await import('./full-stage.js');
  const target=await openFull(detailed,bytes,backend==='webgl2',signal,name=>phase('full-'+name));
  target.engine.onError=failDetail;
  bytes=undefined;
  let next,busy=false;
  async function render(){
    if(busy||!next||signal.aborted||warmFailure)return;
    const request=next;
    next=undefined;
    busy=true;
    try{presentFull(await target.render(request));}
    catch(error){failDetail(error);}
    finally{busy=false;if(next)render();}
  }
  return {send(frame){next=frame;render();},dispose(){target.dispose();}};
}

async function openDetail() {
  if(signal.aborted)return;
  canvas.dataset.detail='streaming';
  try {
    full=globalThis.Worker&&typeof detailed.transferControlToOffscreen==='function'?fullWorker():await fullLocal();
    if(signal.aborted){full.dispose();return;}
    dirty=true;
    schedule();
  } catch(error){failDetail(error);}
}

async function paintOpening(frame) {
  if(canvas.width!==frame.width)canvas.width=frame.width;
  if(canvas.height!==frame.height)canvas.height=frame.height;
  engine.camera.position=frame.eye;
  engine.camera.target=frame.look;
  engine.camera.fov=frame.fov;
  actor.use(clip,frame.index);
  engine.render();
  await engine.gpu?.queue.onSubmittedWorkDone();
}

function schedule(){
  if(raf===undefined&&!drawBusy&&!status.failed&&!signal.aborted&&!document.hidden)raf=requestAnimationFrame(tick);
}
async function tick(now){
  raf=undefined;
  if(signal.aborted||status.failed||document.hidden)return;
  const previous=clock||now-step*1000;
  clock=now;
  const maximum=showingFull?Infinity:clip.count-1;
  if(playing&&!lockedForReveal){
    fraction+=Math.max(0,Math.min(100,now-previous))/1000;
    const added=Math.floor((fraction+1e-8)/step);
    desired=Math.min(maximum,desired+added);
    fraction-=added*step;
  }
  if(!showingFull&&warmFailure&&desired===maximum)playing=false;
  if(!dirty && current?.index===desired && (!full||lastSent===desired)){
    if(playing)schedule();
    return;
  }
  dirty=false;
  const frame=desired<clip.count?openingFrame(desired):{...view(),name:route,sequence,index:desired};
  if(full&&(lastSent!==desired||frame.width!==current?.width||frame.height!==current?.height)){
    full.send(frame);
    lastSent=desired;
  }
  if(showingFull){
    if(playing)schedule();
    return;
  }
  drawBusy=true;
  try{
    await paintOpening(frame);
    if(!showingFull&&!signal.aborted&&sequence===frame.sequence){
      current=frame;
      readout();
    }
  }catch(error){fail(error);}
  finally{drawBusy=false;if(playing||dirty)schedule();}
}

async function change(name) {
  playing=false;
  const wait=++loadSequence;
  try{
    const next=await pose(name);
    if(signal.aborted||wait!==loadSequence)return;
    pauseAt=undefined;
    start.disabled=false;
    clip=next;
    route=name;
    desired=0;
    fraction=0;
    clock=0;
    sequence++;
    lockedForReveal=false;
    lastSent=-1;
    dirty=true;
    schedule();
  }catch(error){fail(error);}
}

function bind() {
  start.addEventListener('click',()=>{
    if(playing){
      playing=false;
      desired=current?.index??desired;
      if(showingFull&&lastSent>desired){
        pauseAt=desired=lastSent;
        get('state').textContent='Settling the current frame…';
        start.disabled=true;
        return;
      }
    }else {
      if(current?.complete||(!showingFull&&warmFailure&&desired===clip.count-1)){
        sequence++;
        desired=0;
        lastSent=-1;
      }
      playing=true;
      initialTouch=true;
    }
    fraction=0;
    clock=0;
    readout();
    dirty=true;
    schedule();
  },events);
  routeSelector.addEventListener('change',()=>void change(routeSelector.value),events);
  reset.addEventListener('click',()=>void change(routeSelector.value),events);
  document.addEventListener('visibilitychange',()=>{
    clock=0;
    if(!document.hidden){dirty=true;schedule();}
  },events);
  observer=new ResizeObserver(()=>{dirty=true;schedule();});
  observer.observe(canvas);
}

async function open() {
  applyQualityTier();
  const uploads=Promise.all([loadRobot(signal),loadCell(signal),pose(route)]);
  void uploads.catch(()=>undefined);
  engine=await autoEngine(canvas,()=>{},{
    backend:force?'webgl2':undefined,signal,exactSize:true,antialias:false,capacity:384,
    camera:{position:[2.25,1.55,3.65],target:[0,1,.58],fov:42,near:.06,far:29},
  });
  phase('opening-device');
  engine.onError=fail;
  backend=engine.backend;
  const [packed,cell,motion]=await uploads;
  bytes=packed;
  clip=motion;
  engine.scene.background='#283739';
  engine.lighting.direction.set([-.45,.78,.36,2.6]);
  engine.lighting.radiance.set([1,.86,.66,.27]);
  engine.lighting.ambient.set([.39,.53,.50]);
  buildOpeningCell(engine,cell);
  actor=mountOpeningRobot(engine,readOpeningRobot(bytes));
  phase('opening-assets');
  current=openingFrame(0);
  await paintOpening(current);
  signal.throwIfAborted();
  canvas.dataset.renderer=backend;
  canvas.dataset.detail='opening';
  readout();
  bind();
  dirty=false;
  for(const control of controls)control.disabled=false;
  status.ready();
  overlay.hidden=true;
  performance.mark('margo-first-usable-frame');
  detailTimer=setTimeout(openDetail,220);
}

addEventListener('pagehide',event=>{
  if(event.persisted)return;
  controller.abort();
  observer?.disconnect();
  if(raf!==undefined)cancelAnimationFrame(raf);
  clearTimeout(detailTimer);
  clearTimeout(fadeTimer);
  full?.dispose();
  actor?.dispose();
  engine?.dispose();
},events);
open().catch(fail);
