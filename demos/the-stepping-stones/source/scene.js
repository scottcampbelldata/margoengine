import { EngineKernel } from '@margoengine/core';
import { parseGLTFAsync } from '@margoengine/gltf/pbr';
import walkerURL from './walker.glb?url';
import { makeCreek, movableStone } from './creek.js';
import { choreograph } from './walker.js';

const canvas=document.querySelector('#crossing');
const loading=document.querySelector('#loading');
const startButton=document.querySelector('#cross');
const resetButton=document.querySelector('#reset');
const shift=document.querySelector('#shift');
const shiftValue=document.querySelector('#offset');
const span=document.querySelector('#span');
const progress=document.querySelector('#progress');
const support=document.querySelector('#support');
const status=document.querySelector('#status');
const reduced=matchMedia('(prefers-reduced-motion: reduce)');
const controller=new AbortController();
const { signal }=controller;
const query=new URL(location.href).searchParams;
const forced=query.get('backend')==='webgl2';
const asset=fetch(walkerURL,{signal}).then((response)=>{
  if(!response.ok) throw new Error('Could not load the surveyor');
  return response.arrayBuffer();
});

let engine,model,creek,walker,frameId,observer;
let previous, ticks=0, follow=-1.22, reportedComplete=false;

function size(){
  const ratio=Math.min(devicePixelRatio,1.5);
  const width=Math.max(1,Math.round(canvas.clientWidth*ratio));
  const height=Math.max(1,Math.round(canvas.clientHeight*ratio));
  if(canvas.width!==width) canvas.width=width;
  if(canvas.height!==height) canvas.height=height;
}
function setCamera(delta){
  const aspect=canvas.clientWidth/Math.max(1,canvas.clientHeight);
  const framing=aspect<1.14 ? 1 + (1.14-aspect)*.51 : Math.max(.88,1-(aspect-1.14)*.12);
  follow+=(walker.position[2]*.69+.33-follow)*(reduced.matches?1:Math.min(1,delta*3.2));
  engine.camera.position=[3.5*framing,2.38*framing,follow+2.7*framing];
  engine.camera.target=[.02,.61,follow];
  if(query.has('side-view')){
    engine.camera.position=[3.5,1.37,walker.position[2]+.26];
    engine.camera.target=[.02,.93,walker.position[2]+.18];
  }
}
function showText(element,value){
  if(element.textContent!==value)element.textContent=value;
}
function setDisabled(element,value){
  if(element.disabled!==value)element.disabled=value;
}
function setState(key,value){
  if(document.body.dataset[key]!==value)document.body.dataset[key]=value;
}
function sync(){
  const contact=walker.contact;
  showText(shiftValue,(shift.valueAsNumber>0?'+':'')+shift.value+' cm');
  showText(span,walker.span.toFixed(2)+' m');
  showText(progress,walker.index+' / '+walker.stepCount);
  showText(support,contact);
  showText(startButton,walker.completed?'Cross again':walker.moving?'Crossing…':'Cross the stream');
  setDisabled(startButton,walker.moving);
  setDisabled(shift,walker.moving && walker.index>=movableStone);
  setState('steps',String(walker.index));
  setState('contact',contact);
  if(query.has('verify-motion')){
    setState('ankleError',walker.fit.distance.toFixed(6));
    setState('phase',walker.phase.toFixed(4));
    setState('motionTime',walker.time.toFixed(6));
    const pose=walker.posture;
    setState('torsoPitch',pose.pitch.toFixed(3));
    setState('forward',pose.forward.toFixed(5));
    setState('ankles',pose.ankles.map((ankle)=>ankle.map((value)=>value.toFixed(5)).join(',')).join(','));
    setState('footPins',pose.footPins.flat().map((value)=>value.toFixed(6)).join(','));
    setState('balance',[...pose.root,...pose.wrists.flat()].map((value)=>value.toFixed(6)).join(','));
    setState('torsoLean',pose.lean.toFixed(3));
    setState('swingLift',walker.swingLift.toFixed(4));
    setState('leftAnkleX',walker.leftAnkleX.toFixed(4));
  }
  setState('walk',walker.moving?'moving':walker.completed?'complete':'standing');
}
function tick(now){
  if(signal.aborted)return;
  try {
    const delta=previous===undefined?0:Math.max(0,Math.min(.047,(now-previous)/1000));
    previous=now;
    ticks+=delta;
    walker.update(delta);
    setCamera(delta);
    creek.animate(reduced.matches && !walker.moving?0:ticks);
    engine.render({delta});
    sync();
    if(walker.completed && !reportedComplete) status.textContent='Crossing complete.';
    reportedComplete=walker.completed;
    frameId=requestAnimationFrame(tick);
  } catch(error) {
    failure(error);
  }
}
function failure(error){
  document.body.dataset.state='error';
  loading.hidden=false;
  loading.textContent='The crossing could not open. '+(error?.message??error);
  startButton.disabled=true;
  resetButton.disabled=true;
  shift.disabled=true;
  controller.abort();
  console.error(error);
}
async function openEngine(){
  const options={backend:'webgpu',exactSize:true,signal,camera:{near:.23,far:55,fov:37}};
  if(!forced){
    try{return [await EngineKernel.create(canvas,options),'webgpu'];}
    catch(error){ if(error?.code!=='unsupported') throw error; }
  }
  const {install}=await import('@margoengine/webgl2-compat');
  await install({force:true,signal});
  return [await EngineKernel.create(canvas,options),'webgl2'];
}

async function start(){
  size();
  const [[created,backend],bytes]=await Promise.all([openEngine(),asset]);
  engine=created;
  engine.onError=failure;
  engine.scene.background='#203733';
  engine.lighting.direction.set([.38,.76,.47,2.75]);
  engine.lighting.radiance.set([1,.89,.78,.41]);
  engine.lighting.ambient.set([.34,.42,.44]);

  performance.mark('margo-assets-and-device-ready');
  const loadedModel=parseGLTFAsync(engine,bytes,{signal,baseURL:new URL(walkerURL,location.href)});
  creek=makeCreek(engine);
  model=await loadedModel;
  creek.sun.add(model);
  walker=choreograph(model,[Number(shift.min)/100,Number(shift.max)/100]);
  setCamera(1);
  performance.mark('margo-crossing-built');
  engine.render({delta:0});
  performance.mark('margo-crossing-submitted');
  await engine.gpu.queue.onSubmittedWorkDone();
  if(signal.aborted)return;

  startButton.addEventListener('click',()=>{
    walker.start();
    status.textContent='The surveyor is crossing.';
    performance.mark('margo-cross-applied');
    sync();
  },{signal});
  resetButton.addEventListener('click',()=>{
    walker.reset();
    shift.value='0';
    walker.offset(0);
    creek.setStoneOffset(0);
    follow=-1.22;
    status.textContent='Crossing reset.';
    sync();
  },{signal});
  shift.addEventListener('input',()=>{
    const value=shift.valueAsNumber/100;
    walker.offset(value);
    creek.setStoneOffset(value);
    sync();
  },{signal});

  document.body.dataset.renderer=backend;
  document.body.dataset.state='ready';
  loading.hidden=true;
  resetButton.disabled=false;
  sync();
  performance.mark('margo-scene-ready');
  observer=new ResizeObserver(size);
  observer.observe(canvas);
  frameId=requestAnimationFrame(tick);
}

addEventListener('pagehide',(event)=>{
  if(event.persisted)return;
  controller.abort();
  cancelAnimationFrame(frameId);
  observer?.disconnect();
  walker?.dispose();
  model?.dispose();
  engine?.dispose();
});
start().catch((error)=>{if(!signal.aborted)failure(error);});
