import { Geometry, PbrMaterial, box } from '@margoengine/core';
import { applyQualityTier } from '@margoengine/quality';
import { autoEngine } from '@margoengine/webgl2-compat/auto';
import { LabelRenderer } from '@margoengine/labels';
import { Callouts } from '@margoengine/labels/callouts';
import { measureDistance, snapAnchor } from '@margoengine/machinery/metrology';
import { HitDetails } from '@margoengine/selection/hit-details';
import { demoStatus } from 'margo-demo-status';

const element = id => document.getElementById(id);
const canvas = element('part');
const figure = canvas.parentElement;
const tools = element('tools');
const buttons = [...tools.querySelectorAll('button')];
const reference = element('reference');
const reset = element('reset');
const loading = element('status');
const errors = element('error');
const status = demoStatus(document.body,loading,errors);
const controller = new AbortController();
const {signal} = controller;
const forced = new URLSearchParams(location.search).get('backend')==='webgl2';
const asset = new URL('./assets/coupon.bin',import.meta.url);
const data = fetch(asset,{signal}).then(response=>{
  if(!response.ok)throw Error('The gauge model could not be downloaded.');
  return new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).json();
});
data.catch(()=>{});
const formatter = new Intl.NumberFormat(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
const choices = {
  distance:{title:'Distance',guide:'Pick two points. Taps near edges or corners snap to the feature.',reference:'Measure block width'},
  angle:{title:'Angle',guide:'Pick two flat faces to measure the smaller angle between them.',reference:'Measure ramp angle'},
  radius:{title:'Radius',guide:'Pick the inner wall or the rim of either bore.',reference:'Measure main bore'},
};
const view = {yaw:.69,tilt:.69};
const parts = new Map();
const pickedMaterial = new PbrMaterial({color:'#d7b768',roughness:.56,metalness:.34});
const normalMaterial = new PbrMaterial({color:'#839b9a',roughness:.44,metalness:.51,doubleSided:false});
const castingMaterial = new PbrMaterial({color:'#53605c',roughness:.66,metalness:.28});
const instrumentMaterial = new PbrMaterial({color:'#253b37',roughness:.8,metalness:.12});
let engine,model,labels,picking,observer;
let mode = 'distance';
let points = [];
let marks = [];
let selected = [];
let frame = 0;
let yaw = view.yaw, tilt = view.tilt;
let pointer, measuring = false, pendingApplication = false;

function mount(geometry,material,position=[0,0,0]) {
  return engine.createMesh().setGeometry(geometry).setMaterial(material).setPosition(position);
}

function makeTable() {
  mount(box(2.5,.01,2.5),instrumentMaterial,[0,-.026,0]);
  mount(box(.224,.013,.178),castingMaterial,[0,-.010,.002]);
  mount(box(.209,.007,.167),instrumentMaterial,[0,-.0035,.002]);
  const stripe = box(.00065,.0016,.025);
  for(let i=-9;i<=9;i++)mount(stripe,castingMaterial,[i*.010,-.0009,.059]);
}

function resetMeasurements() {
  for(const mesh of selected)mesh.setMaterial(normalMaterial);
  for(const mark of marks)mark.remove();
  selected = [];
  marks = [];
  points = [];
  element('measure').value = '—';
  delete document.body.dataset.measure;
  pendingApplication = false;
}

function note(point,text,offset) {
  const label = document.createElement('span');
  label.className='annotation';
  label.textContent=text;
  marks.push(labels.add(label,{position:point,screenOffset:offset}));
}

function select(mesh) {
  if(!mesh||selected.includes(mesh))return;
  selected.push(mesh);
  mesh.setMaterial(pickedMaterial);
}

function value(number,unit,at,offset=[30,-31]) {
  const text=formatter.format(number)+unit;
  element('measure').value=text;
  note(at,text,offset);
  pendingApplication=true;
  schedule();
}

const midpoint=(a,b)=>a.map((item,index)=>(item+b[index])/2);
const planeAngle=(a,b)=>Math.acos(Math.min(1,Math.abs(a[0]*b[0]+a[1]*b[1]+a[2]*b[2])))*180/Math.PI;

function recordDistance(a,b) {
  note(a.point,'A',[-15,-28]);
  note(b.point,'B',[15,-28]);
  value(measureDistance(a,b),' mm',midpoint(a.point,b.point),[0,29]);
}

function recordRadius(bore,point) {
  const dy=Math.max(.002,Math.min(bore.top,point[1]));
  const direction=Math.atan2(point[2]-bore.z,point[0]-bore.x);
  const ideal=[bore.x+Math.cos(direction)*bore.radius,dy,bore.z+Math.sin(direction)*bore.radius];
  value(bore.radius*1000,' mm',ideal,[26,-34]);
}

function choose(next) {
  resetMeasurements();
  mode=next;
  element('kind').textContent=choices[mode].title;
  element('guide').textContent=choices[mode].guide;
  reference.textContent=choices[mode].reference;
  for(const button of buttons)button.setAttribute('aria-pressed',String(mode===button.dataset.tool));
  schedule();
}

function sample() {
  resetMeasurements();
  if(mode==='distance'){
    const [a,b]=model.widthPoints;
    recordDistance({point:a},{point:b});
  } else if(mode==='angle'){
    const faces=[...parts].filter(([,face])=>/:(datum|ramp)$/.test(face.name));
    for(const [mesh,face] of faces){
      select(mesh);
      const center=[0,0,0];
      for(let i=0;i<face.position.length;i++)center[i%3]+=face.position[i]*3/face.position.length;
      note(center,face.name.split(':').at(-1),[face.name.endsWith('datum')?-34:34,22]);
    }
    value(planeAngle(...faces.map(([,face])=>face.normal.slice(0,3))),'°',model.datum,[12,-32]);
  } else {
    const bore=model.cutters[0];
    const face=[...parts.keys()].find(mesh=>mesh.name.startsWith(bore.name+'/'));
    select(face);
    recordRadius(bore,[bore.x+.006,bore.top,bore.z+.010]);
  }
}

async function measure(x,y) {
  if(measuring)return;
  measuring=true;
  const tool=mode;
  try {
    const hit=await picking.pick(x,y);
    if(signal.aborted||tool!==mode)return;
    const face=parts.get(hit?.mesh);
    if(!face||!hit.position)return;
    const p=[...hit.position];
    if(mode==='radius'){
      const bore=model.cutters.find(b=>face.name.startsWith(b.name+'/')||
        Math.abs(Math.hypot(p[0]-b.x,p[2]-b.z)-b.radius)<.0035 && Math.abs(p[1]-b.top)<.005);
      if(!bore){element('guide').textContent='Pick either curved bore wall or its circular rim.';return;}
      resetMeasurements();
      select([...parts.keys()].find(mesh=>mesh.name.startsWith(bore.name+'/')));
      recordRadius(bore,p);
      return;
    }
    if(mode==='angle' && face.name.includes('bore')){
      element('guide').textContent='Choose a flat face. The inside of a bore is curved.';
      return;
    }
    if(points.length===2)resetMeasurements();
    let anchor={point:p};
    if(mode==='distance'){
      anchor=snapAnchor(hit.mesh,p,{kind:'vertex',maxDistance:.0023}) ??
        snapAnchor(hit.mesh,p,{kind:'edge',maxDistance:.0021}) ?? anchor;
    }
    points.push({anchor,mesh:hit.mesh,normal:face.normal.slice(0,3)});
    select(hit.mesh);
    if(points.length===1){
      const instruction=mode==='distance'?'Pick the second point.':'Pick another flat face.';
      element('guide').textContent=instruction;
      note(anchor.point,'A',[18,-26]);
      schedule();
    } else {
      const [first,second]=points;
      element('guide').textContent=choices[mode].guide;
      for(const mark of marks)mark.remove();
      marks=[];
      if(mode==='distance')recordDistance(first.anchor,second.anchor);
      else {
        note(first.anchor.point,'A',[-22,-23]);
        note(second.anchor.point,'B',[22,-23]);
        value(planeAngle(first.normal,second.normal),'°',midpoint(first.anchor.point,second.anchor.point),[2,29]);
      }
    }
  } catch(error) {
    if(!signal.aborted)fail(error);
  } finally {
    measuring=false;
  }
}

function positionCamera() {
  const ratio=Math.min(1.7,devicePixelRatio||1);
  const width=Math.max(1,Math.round(canvas.clientWidth*ratio));
  const height=Math.max(1,Math.round(canvas.clientHeight*ratio));
  if(canvas.width!==width)canvas.width=width;
  if(canvas.height!==height)canvas.height=height;
  const aspect=width/height;
  const radius=.30/Math.min(1,aspect);
  const horizontal=Math.cos(tilt)*radius;
  engine.camera.position=[Math.sin(yaw)*horizontal,.022+Math.sin(tilt)*radius,Math.cos(yaw)*horizontal];
  engine.camera.target=[0,.022,0];
}

function schedule() {
  if(!frame&&!signal.aborted)frame=requestAnimationFrame(draw);
}

function draw() {
  frame=0;
  if(signal.aborted)return;
  try {
    positionCamera();
    engine.render({delta:0});
    if(pendingApplication){
      pendingApplication=false;
      document.body.dataset.measure=element('measure').value;
      performance.mark('measurement-applied');
    }
  } catch(error) {
    fail(error);
  }
}

function connect() {
  tools.addEventListener('click',event=>{
    const button=event.target.closest('[data-tool]');
    if(button)choose(button.dataset.tool);
  },{signal});
  reference.addEventListener('click',sample,{signal});
  reset.addEventListener('click',()=>{yaw=view.yaw;tilt=view.tilt;schedule();},{signal});
  canvas.addEventListener('pointerdown',event=>{
    if(pointer)return;
    pointer={id:event.pointerId,x:event.clientX,y:event.clientY,yaw,tilt,drag:false};
    canvas.setPointerCapture(event.pointerId);
  },{signal});
  canvas.addEventListener('pointermove',event=>{
    if(pointer?.id!==event.pointerId)return;
    const dx=event.clientX-pointer.x,dy=event.clientY-pointer.y;
    if(Math.hypot(dx,dy)>5)pointer.drag=true;
    if(!pointer.drag)return;
    yaw=pointer.yaw-dx*.011;
    tilt=Math.max(.11,Math.min(1.45,pointer.tilt+dy*.010));
    schedule();
  },{signal});
  canvas.addEventListener('pointerup',event=>{
    if(pointer?.id!==event.pointerId)return;
    const wasDrag=pointer.drag;
    pointer=undefined;
    if(!wasDrag){
      const rect=canvas.getBoundingClientRect();
      void measure(event.clientX-rect.x,event.clientY-rect.y);
    }
  },{signal});
  canvas.addEventListener('lostpointercapture',()=>{pointer=undefined;},{signal});
  observer=new ResizeObserver(schedule);
  observer.observe(canvas);
}

async function setup(target) {
  if(!target.gpu)throw Error('The measuring room needs the WebGPU or WebGL2 renderer.');
  engine=target;
  engine.onError=fail;
  engine.scene.background='#162e2d';
  engine.lighting.direction.set([-.43,.72,.52,2.4]);
  engine.lighting.radiance.set([1,.92,.82,.59]);
  engine.lighting.ambient.set([.75,.91,1.10]);
  model=await data;
  signal.throwIfAborted();
  for(const face of model.parts){
    const mesh=mount(new Geometry(face.position,face.normal,face.index),normalMaterial);
    mesh.name=face.name;
    parts.set(mesh,face);
  }
  makeTable();
  labels=LabelRenderer.attach(engine,{parent:figure,zIndex:1,layout:new Callouts({color:'#f0c276',width:1.2,dot:2.4})});
  picking=HitDetails.attach(engine);
}

async function compatibility() {
  const {install}=await import('@margoengine/webgl2-compat');
  return {install:()=>install({force:true,signal})};
}

async function start() {
  applyQualityTier();
  const options={signal,exactSize:true,antialias:true,startupTimeout:4500,camera:{near:.008,far:3,fov:37}};
  if(forced||!navigator.gpu){
    await (await compatibility()).install();
    await autoEngine(canvas,setup,{...options,backend:'webgpu'});
  } else await autoEngine(canvas,setup,{...options,loadCompat:compatibility});
  draw();
  await engine.gpu.queue.onSubmittedWorkDone();
  signal.throwIfAborted();
  connect();
  status.ready();
  document.body.dataset.renderer=engine.gpu.adapterInfo?.vendor==='margo-webgl2'?'webgl2':'webgpu';
  tools.disabled=reference.disabled=reset.disabled=false;
  loading.hidden=true;
  performance.mark('margo-first-usable-frame');
}

function dispose() {
  controller.abort();
  if(frame)cancelAnimationFrame(frame);
  observer?.disconnect();
  engine?.dispose();
}
function fail(error) {
  if(signal.aborted)return;
  status.error(error);
  errors.hidden=false;
  loading.hidden=true;
  console.error(error);
  dispose();
}
addEventListener('pagehide',event=>{if(!event.persisted)dispose();});
start().catch(fail);
