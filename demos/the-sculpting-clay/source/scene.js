import {autoEngine} from '@margoengine/webgl2-compat/auto';
import {MeshSculptSession} from '@margoengine/mesh-edit/sculpt';
import {applyQualityTier} from '@margoengine/quality';
import {demoStatus} from 'margo-demo-status';
import {
  clayCenter, clayRadius, createClay, cross, highResolution, lowResolution, lowSurface,
  mapHeight, mapWidth, subtract, unit,
} from './model.mjs';
import {installStudio} from './studio.js';

const get = id => document.getElementById(id);
let canvas = get('clay');
const tools=get('tools'), baking=get('baking'), overlay=get('status');
const controls={tools,baking,radius:get('size'),undo:get('undo'),turn:get('turn'),bake:get('bake')};
const cursor=get('brush-cursor'), map=get('normal'), download=get('download');
const brushes=[...tools.querySelectorAll('[data-brush]')];
const views=[...baking.querySelectorAll('[data-view]')];
const readout=get('bake-readout'), hint=get('instruction');
const status=demoStatus(document.body,overlay,get('error'));
const lifetime=new AbortController(), {signal}=lifetime, events={signal};
const info=document.body.dataset;
const force=new URLSearchParams(location.search).get('backend')==='webgl2';
const fov=33, cameraTarget=[0,1.13,0], height=2.08, orbit=5.48;
const labels={high:'Original clay',low:'Low-poly copy',baked:'With baked normals'};
const number=new Intl.NumberFormat('en');
let engine, studio, session, drawing, low, observer, frame, worker, downloadUrl;
let mode='high', brush='draw', yaw=.13, eye=[0,height,orbit], previous, pointer, changed=false;
let revision=0, bakedRevision=-1, bakingRevision=-1, job=0, pending=false, busy=false, dirty=false, started=false;

function fail(reason) {
  if (signal.aborted || status.failed) return;
  status.error(reason);
  overlay.hidden=false;
  overlay.querySelector('strong').textContent='The studio could not be opened.';
  get('requirements').hidden=!['unsupported','no-adapter'].includes(reason?.code);
  tools.disabled=baking.disabled=true;
}

function resize() {
  const ratio=Math.max(1,Math.min(devicePixelRatio||1,1.75));
  const width=Math.max(1,Math.round(canvas.clientWidth*ratio));
  const height=Math.max(1,Math.round(canvas.clientHeight*ratio));
  if (canvas.width!==width) canvas.width=width;
  if (canvas.height!==height) canvas.height=height;
}

function metrics() {
  const count=mode==='high'?session.triangleCount:low.indices.length/3;
  get('view-name').textContent=labels[mode];
  get('mesh-count').textContent=number.format(count)+' triangles';
  canvas.dataset.view=mode;
  for(const button of views) button.setAttribute('aria-pressed',String(button.dataset.view===mode));
  for(const button of views) if(button.dataset.view==='baked')button.disabled=bakedRevision!==revision;
  for(const button of brushes) button.disabled=mode!=='high';
  controls.radius.disabled=mode!=='high';
  controls.undo.disabled=mode!=='high'||session.undoSteps===0||pointer!==undefined;
  hint.textContent=mode==='high'?'Drag over the clay to make a stroke.':'Choose Sculpt to work the clay again.';
  Object.assign(info,{view:mode,triangles:String(count),sculptTriangles:String(session.triangleCount),strokes:String(session.undoSteps),
    revision:String(revision),dabVertices:String(session.stats.dabVertices),orientation:String(yaw),bakeCurrent:String(bakedRevision===revision)});
}

function synchronizeGeometry() {
  if(!changed)return;
  const ranges=drawing.update();
  studio.update(ranges==='all'?[{start:0,count:drawing.vertices.length/20}]:ranges);
  changed=false;
}

async function render() {
  resize();
  synchronizeGeometry();
  eye=[Math.sin(yaw)*orbit,height,Math.cos(yaw)*orbit];
  engine.camera.position=eye;
  engine.camera.target=cameraTarget;
  studio.view(mode);
  engine.render();
  await engine.gpu?.queue.onSubmittedWorkDone();
  return !signal.aborted && !status.failed;
}

function schedule() {
  dirty=true;
  if(frame!==undefined||busy||!started||status.failed||signal.aborted)return;
  frame=requestAnimationFrame(async()=>{
    frame=undefined;
    busy=true;
    dirty=false;
    const submittedRevision=revision;
    const submittedMode=mode;
    const submittedYaw=yaw;
    try {
      const ok=await render();
      if(ok&&submittedRevision===revision&&submittedMode===mode&&submittedYaw===yaw) {
        metrics();
        if(pending&&!performance.getEntriesByName('margo-first-input-rendered').length) {
          performance.mark('margo-first-input-rendered');
        }
        pending=false;
      }
    } catch(reason) {fail(reason);}
    finally {busy=false;if(dirty)schedule();}
  });
}

const radius=()=>clayRadius*controls.radius.valueAsNumber/100;

function ray(x, y) {
  const box=canvas.getBoundingClientRect();
  const forward=unit(subtract(cameraTarget,eye));
  const right=unit(cross(forward,[0,1,0]));
  const up=cross(right,forward);
  const scale=Math.tan(fov*Math.PI/360);
  const u=(2*x/box.width-1)*scale*box.width/box.height;
  const v=(1-2*y/box.height)*scale;
  return session.pick(eye,forward.map((value,i)=>value+right[i]*u+up[i]*v));
}

function cursorAt(x,y,hit) {
  cursor.hidden=mode!=='high'||!hit;
  if(!hit)return;
  const width=radius()*canvas.clientHeight/(Math.tan(fov*Math.PI/360)*hit.distance);
  Object.assign(cursor.style,{left:x+'px',top:y+'px',width:width+'px',height:width+'px'});
}

function clearBake() {
  if (bakedRevision>=0) readout.textContent='Clay changed. Bake again to update.';
  else if (bakingRevision<0) readout.textContent=mapWidth+' × '+mapHeight+' pixels';
  bakedRevision=-1;
  map.hidden=true;
  download.hidden=true;
  delete info.hitTexels;
  delete info.coveredTexels;
  delete info.sharedTexels;
  delete info.normalSignature;
  if(downloadUrl){URL.revokeObjectURL(downloadUrl);downloadUrl=undefined;}
}

function dab(hit) {
  session.dab(hit.point);
  if(!session.stats.dabVertices)return;
  revision++;
  changed=true;
  clearBake();
  schedule();
}

function begin(hit) {
  session.beginStroke({brush:brush==='smooth'?'smooth':'draw',invert:brush==='carve',
    radius:radius(),strength:brush==='smooth'?.68:.53});
  dab(hit);
}

function local(event) {
  const rect=canvas.getBoundingClientRect();
  return [event.clientX-rect.left,event.clientY-rect.top];
}

function press(event) {
  if(!started||mode!=='high'||pointer!==undefined||event.button!==0)return;
  const [x,y]=local(event);
  const hit=ray(x,y);
  if(!hit)return;
  canvas.setPointerCapture(event.pointerId);
  pointer=event.pointerId;
  previous=[x,y];
  cursorAt(x,y,hit);
  pending=true;
  begin(hit);
}

function move(event) {
  if(!started||mode!=='high')return;
  const [x,y]=local(event);
  const hit=ray(x,y);
  cursorAt(x,y,hit);
  if(pointer!==event.pointerId)return;
  const [a,b]=previous;
  const pixels=Math.max(3,radius()*canvas.clientHeight*.49/orbit);
  const distance=Math.hypot(x-a,y-b);
  if(distance<pixels)return;
  const steps=Math.ceil(distance/pixels);
  for(let i=1;i<=steps;i++){
    const sample=i===steps?hit:ray(a+(x-a)*i/steps,b+(y-b)*i/steps);
    if(sample)dab(sample);
  }
  previous=[x,y];
}

function release(event) {
  if(pointer!==event.pointerId)return;
  pointer=undefined;
  previous=undefined;
  session.endStroke();
  if(event.pointerType!=='mouse')cursor.hidden=true;
  schedule();
}

function view(next) {
  if(pointer!==undefined||next===mode||next==='baked'&&revision!==bakedRevision)return;
  mode=next;
  cursor.hidden=true;
  schedule();
}

function bakeFailure(revisionInFlight, text) {
  if (bakingRevision!==revisionInFlight||signal.aborted)return;
  bakingRevision=-1;
  controls.bake.disabled=false;
  readout.textContent=text;
}

function baked({data}) {
  if(data.job!==job||data.revision!==bakingRevision||signal.aborted)return;
  if(data.error) {bakeFailure(data.revision,data.error);return;}
  bakingRevision=-1;
  controls.bake.disabled=false;
  if (data.revision!==revision) {
    readout.textContent='Clay changed during baking. Bake again.';
    return;
  }
  const {texture, covered, missed, shared}=data;
  const pixels=Uint8ClampedArray.from(texture);
  map.getContext('2d').putImageData(new ImageData(pixels,mapWidth,mapHeight),0,0);
  let signature=2166136261;
  for(const value of pixels) signature=Math.imul((signature^value)>>>0,16777619)>>>0;
  Object.assign(info,{hitTexels:String(covered-missed),coveredTexels:String(covered),sharedTexels:String(shared),normalSignature:String(signature)});
  readout.textContent=number.format(covered-missed)+' / '+number.format(covered)+' texels matched';
  const bakedAt=revision;
  map.toBlob(blob=>{
    if(!blob||signal.aborted||bakedRevision!==bakedAt||job!==data.job)return;
    if(downloadUrl)URL.revokeObjectURL(downloadUrl);
    downloadUrl=URL.createObjectURL(blob);
    download.href=downloadUrl;
    download.hidden=false;
  },'image/png');
  map.hidden=false;
  studio.map(texture);
  bakedRevision=revision;
  mode='baked';
  cursor.hidden=true;
  schedule();
}

function bake() {
  if(pointer!==undefined||bakingRevision>=0)return;
  synchronizeGeometry();
  if(!worker) {
    worker=new Worker(new URL('./bake-worker.js',import.meta.url),{type:'module'});
    worker.addEventListener('message',baked,events);
    worker.addEventListener('error',event=>{
      event.preventDefault();
      bakeFailure(bakingRevision,'The bake worker could not open. Try again.');
      worker?.terminate();
      worker=undefined;
    },events);
  }
  const vertices=drawing.vertices, count=vertices.length/20;
  const positions=new Float32Array(count*3), normals=new Float32Array(count*3), uvs=new Float32Array(count*2);
  for(let i=0;i<count;i++){
    positions.set(vertices.subarray(i*20,i*20+3),i*3);
    normals.set(vertices.subarray(i*20+4,i*20+7),i*3);
    uvs.set(vertices.subarray(i*20+12,i*20+14),i*2);
  }
  const indices=drawing.indices.slice();
  bakingRevision=revision;
  controls.bake.disabled=true;
  readout.textContent='Transferring surface normals…';
  worker.postMessage({job:++job,revision,high:{positions,normals,uvs,indices}},[positions.buffer,normals.buffer,uvs.buffer,indices.buffer]);
}

function bind() {
  canvas.addEventListener('pointerdown',press,events);
  canvas.addEventListener('pointermove',move,events);
  canvas.addEventListener('pointerleave',()=>{if(pointer===undefined)cursor.hidden=true;},events);
  for(const type of ['pointerup','pointercancel','lostpointercapture'])canvas.addEventListener(type,release,events);
  canvas.addEventListener('keydown',event=>{
    if(event.key!=='Enter'||mode!=='high'||event.repeat||pointer!==undefined)return;
    const hit=session.pick(eye,subtract([0,clayCenter,0],eye));
    if(!hit)return;
    event.preventDefault();
    pending=true;
    begin(hit);
    session.endStroke();
  },events);
  for(const tool of brushes)tool.addEventListener('click',()=>{
    brush=tool.dataset.brush;
    for(const button of brushes)button.setAttribute('aria-pressed',String(button===tool));
  },events);
  for(const button of views)button.addEventListener('click',()=>view(button.dataset.view),events);
  controls.radius.addEventListener('input',()=>{get('diameter').value=controls.radius.value+'%';},events);
  controls.turn.addEventListener('click',()=>{
    if(pointer!==undefined)return;
    yaw=(yaw+Math.PI/3)%(2*Math.PI);
    cursor.hidden=true;
    schedule();
  },events);
  controls.undo.addEventListener('click',()=>{
    if(pointer!==undefined||!session.undo())return;
    revision++;
    changed=true;
    clearBake();
    schedule();
  },events);
  controls.bake.addEventListener('click',bake,events);
  observer=new ResizeObserver(schedule);
  observer.observe(canvas);
}

async function open() {
  applyQualityTier();
  engine=await autoEngine(canvas,()=>{},{backend:force?'webgl2':undefined,signal,exactSize:true,
    antialias:false,capacity:64,camera:{near:.08,far:92,fov}});
  canvas=engine.canvas;
  engine.onError=fail;
  performance.mark('clay-device');
  session=new MeshSculptSession(createClay(...highResolution,true),{undoLimit:24,createId:idFactory()});
  drawing=session.drawing();
  drawing.update();
  low=lowSurface(createClay(...lowResolution));
  studio=installStudio(engine,drawing,low);
  performance.mark('clay-meshes');
  if(!await render())return;
  bind();
  started=true;
  info.renderer=engine.backend;
  metrics();
  tools.disabled=baking.disabled=false;
  status.ready();
  overlay.hidden=true;
  performance.mark('margo-first-usable-frame');
}

function idFactory(){let id=0;return()=>'new-'+id++;}

addEventListener('pagehide',event=>{
  if(event.persisted)return;
  lifetime.abort();
  observer?.disconnect();
  if(frame!==undefined)cancelAnimationFrame(frame);
  if(downloadUrl)URL.revokeObjectURL(downloadUrl);
  worker?.terminate();
  studio?.dispose();
  engine?.dispose();
},events);
open().catch(fail);
