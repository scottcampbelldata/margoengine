import {Engine} from '@margoengine/core';
import {demoStatus} from 'margo-demo-status';
import {makeGuard,nodes} from './brain.js';
import {chimePlayer} from './audio.js';
import {makeGallery} from './gallery.js';
import {openRita,placeRita} from './rita.js';
import {stations} from './plan.js';

const get=id=>document.getElementById(id);
const canvas=get('scene'),view=get('viewport'),loading=get('loading'),error=get('error'),tree=get('tree');
const ui=Object.fromEntries(['station','range','ring','follow','mute','reset'].map(id=>[id,get(id)]));
const gate=demoStatus(view,loading,error),controller=new AbortController(),{signal}=controller;
const query=new URLSearchParams(location.search),forced=query.get('backend')==='webgl2';
const inspect=query.has('inspect'),reduced=matchMedia('(prefers-reduced-motion: reduce)');
const waitFrame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
const sound=chimePlayer(),modelData=openRita(signal);
modelData.catch(()=>{});

let engine,guard,gallery,rita,observer,raf,last=0,lastHUD=-1,toggleView=false,muted=false,ready=false;
let count=0,firstEffect=false,lastSnapshot,zoom=[0,1.06,0],cameraAt=[6,8,8];
let startPose=0;
const rows=new Map(),branches=new Map();
tree.className='tree-list';
for(const {name,path} of nodes){
  const entry=document.createElement('li'),branch=document.createElement('ul');
  const row=document.createElement('div'),lamp=document.createElement('span'),label=document.createElement('span');
  row.className='tree-row';branch.className='tree-list';branch.hidden=true;
  lamp.className='lamp';lamp.setAttribute('aria-hidden','true');label.textContent=name;
  row.append(lamp,label);entry.append(row,branch);
  const parent=branches.get(path.slice(0,path.lastIndexOf('.children[')))??tree;
  parent.hidden=false;parent.append(entry);
  rows.set(path,row);branches.set(path,branch);
}
function currentStation(){return stations.find(station=>station.id===ui.station.value)??stations[0];}
function message(id,value){const out=get(id);if(out.textContent!==value)out.textContent=value;}
function fail(reason){
  if(signal.aborted||gate.failed)return;
  ready=false;loading.hidden=true;error.hidden=false;
  Object.values(ui).forEach(button=>{button.disabled=true;});
  gate.error(reason);
  if(inspect)console.error(reason?.stack??reason);
}
function size(){
  const w=canvas.clientWidth,h=canvas.clientHeight;
  if(!w||!h)return;
  const ratio=Math.min(devicePixelRatio||1,1.6,1500/w);
  const width=Math.round(w*ratio),height=Math.round(h*ratio);
  if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;}
}
async function device(){
  const config={backend:'webgpu',exactSize:true,antialias:true,signal,
    camera:{position:[4.2,8.2,9.6],target:[0,1,-.52],near:.31,far:70,fov:44}};
  if(!forced&&navigator.gpu){
    try{
      const instance=await Engine.create(canvas,config);
      view.dataset.renderer='webgpu';return instance;
    }catch(reason){
      signal.throwIfAborted();
      if(reason?.code&&!['unsupported','adapter','device','timeout','startup'].includes(reason.code))throw reason;
    }
  }
  const {webglRenderer}=await import('@margoengine/webgl2-compat/preview');
  const instance=await Engine.create(canvas,{...config,backend:'webgl2',fallback:webglRenderer});
  view.dataset.renderer='webgl2';return instance;
}
function camera(state,dt,force=false){
  const aspect=canvas.width/canvas.height,portrait=Math.max(0,1.27-aspect);
  const wide=[4.42-portrait*6.25,8.13+portrait*7.1,9.94+portrait*4.4];
  const [x,,z]=state.position;
  const at=toggleView?[x+.07,.97,z-.04]:[0,.96,-.37];
  const near=z<-1.76?[x+(x<0?3.46:-3.46),2.28,z-.44]:x<0?
    [Math.max(-4.45,x-1.30),2.18,z+3.61]:[Math.min(4.49,x+1.34),2.18,z+3.61];
  const eye=toggleView?near:wide;
  const n=force||reduced.matches?1:1-Math.exp(-4*dt);
  for(let i=0;i<3;i++){zoom[i]+=(at[i]-zoom[i])*n;cameraAt[i]+=(eye[i]-cameraAt[i])*n;}
  engine.camera.target=zoom;engine.camera.position=cameraAt;
}
function display(state,force=false){
  if(!force&&state.elapsed-lastHUD<.085)return;
  lastHUD=state.elapsed;
  const {remembered,lastSound}=state;
  const byPath=new Map(state.trace.map(node=>[node.path,node]));
  for(const [path,entry] of rows){
    const newStatus=byPath.get(path)?.status??'waiting';
    if(entry.dataset.status!==newStatus)entry.dataset.status=newStatus;
  }
  message('responding',state.state==='Patrol'?'On patrol':state.state);
  message('awareness',state.awareness[0].toUpperCase()+state.awareness.slice(1));
  message('memory',remembered?(stations.find(station=>station.id===state.heard)?.label??'Chime'):'—');
  message('cleared',String(state.cleared));
  if(lastSound){
    const name=stations.find(station=>station.id===lastSound.id).label;
    message('heard',name+' · '+(lastSound.heard?'Heard':'Out of range')+' · '+lastSound.metres.toFixed(1)+' m from Rita');
  }else message('heard','Select a chime location to test Rita’s hearing.');
  Object.assign(view.dataset,{
    mode:state.state,awareness:state.awareness,position:state.position.map(n=>n.toFixed(3)).join(','),
    heard:state.heard??'',sound:state.lastSound?(state.lastSound.heard?'heard':'missed'):'',
    pulses:String(count),memory:remembered?remembered.map(n=>n.toFixed(2)).join(','):'',
    passes:String(state.cleared),retargeted:String(state.retargeted),version:String(state.blackboardVersion),
    phase:rita.state.phase.toFixed(3),tread:rita.state.footprint.toFixed(4),speed:state.speed.toFixed(3),
  });
}
function draw(delta,force=false){
  guard.tick(delta);
  const state=guard.snapshot();
  rita.pose(state,delta,force);
  gallery.update(state,currentStation());
  camera(state,delta,force);
  engine.render({delta});
  display(state,force);
  lastSnapshot=state;
  return state;
}
async function seen(){
  await engine.gpu?.queue.onSubmittedWorkDone();
  await waitFrame();
  if(!gate.failed){
    performance.mark('guard-first-chime');
    view.dataset.firstControl='painted';
  }
}
function tick(now){
  if(signal.aborted||gate.failed)return;
  try{
    const delta=last?Math.min(.055,Math.max(.002,(now-last)*.001)):1/60;
    last=now;
    const state=draw(delta);
    if(count>0&&!firstEffect&&state.lastSound){
      firstEffect=true;display(state,true);
      void seen().catch(fail);
    }
    raf=requestAnimationFrame(tick);
  }catch(reason){fail(reason);}
}
function select(){
  if(!ready)return;
  const station=currentStation();
  get('scene').setAttribute('aria-label',station.label+' selected in the Resonance Gallery');
}
function ringChime(){
  if(!ready)return;
  const station=currentStation(),radius=Number(ui.range.value);
  guard.ring(station,radius);
  if(!muted)sound.ring(station,radius/9.4);
  count++;
}
ui.ring.addEventListener('click',ringChime);
ui.station.addEventListener('change',select);
ui.follow.addEventListener('click',()=>{
  if(!ready)return;
  toggleView=!toggleView;
  ui.follow.setAttribute('aria-pressed',String(toggleView));
  ui.follow.textContent=toggleView?'Room view':'Closer view';
});
ui.mute.addEventListener('click',()=>{
  muted=!muted;
  ui.mute.setAttribute('aria-pressed',String(muted));
  ui.mute.textContent=muted?'Unmute':'Mute';
});
ui.reset.addEventListener('click',()=>{
  if(!ready)return;
  guard.dispose();guard=makeGuard();
  lastHUD=-1;startPose=rita.state.step;
  draw(0,true);
});

async function launch(){
  size();
  const loadingDevice=device();
  [engine]=await Promise.all([loadingDevice,modelData]);
  performance.mark('guard-device-and-asset');
  engine.onError=fail;
  guard=makeGuard();gallery=makeGallery(engine);
  rita=placeRita(engine,await modelData);
  await waitFrame();
  draw(1/60,true);
  await engine.gpu?.queue.onSubmittedWorkDone();
  await waitFrame();
  if(!gate.ready())return;
  performance.mark('guard-first-frame');
  loading.hidden=true;ready=true;
  for(const control of Object.values(ui))control.disabled=false;
  select();
  observer=new ResizeObserver(size);observer.observe(canvas);
  if(inspect){
    Object.defineProperty(globalThis,'guardInspection',{configurable:true,value:()=>{
      return {...lastSnapshot,body:{...rita.state},startPose,camera:{eye:[...cameraAt],target:[...zoom]},counts:engine.stats};
    }});
  }
  raf=requestAnimationFrame(tick);
}
addEventListener('pagehide',()=>{
  controller.abort();
  cancelAnimationFrame(raf);
  observer?.disconnect();
  guard?.dispose();
  sound.dispose();
  engine?.dispose();
},{once:true});
launch().catch(fail);
