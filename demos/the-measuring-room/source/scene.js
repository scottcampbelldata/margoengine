import { PbrMaterial } from '@margoengine/core';
import { loadGLTF } from '@margoengine/gltf';
import { meshopt } from '@margoengine/gltf/meshopt';
import { LabelRenderer } from '@margoengine/labels';
import { Callouts } from '@margoengine/labels/callouts';
import { CadBench } from '@margoengine/machinery/bench';
import { measureDistance, snapAnchor } from '@margoengine/machinery/metrology';
import { applyQualityTier } from '@margoengine/quality';
import { HitDetails } from '@margoengine/selection/hit-details';
import { openBench } from '@margoengine/studio/bench';
import { startEngine } from '@margoengine/webgl2-compat/auto';
import { demoStatus } from 'margo-demo-status';
import facts from './facts.json';

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
const formatter = new Intl.NumberFormat(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
const choices = {
  distance:{title:'Distance',guide:'Pick two points. Taps near edges or corners snap to the feature.',reference:'Measure block width'},
  angle:{title:'Angle',guide:'Pick two flat faces to measure the smaller angle between them.',reference:'Measure ramp angle'},
  radius:{title:'Radius',guide:'Pick the inner wall or the rim of either bore.',reference:'Measure main bore'},
};
// The surface plate is 4 cm thick with its top at y 0, where the coupon's sole sits, so a picked point is already in
// the part's own frame; the cove floor drops by the plate's thickness to stay under it.
const plate = 0.04;
const model = facts;
const parts = new Map();
const pickedMaterial = new PbrMaterial({color:'#d7b768',roughness:.56,metalness:.34});
let bench,labels,picking,normalMaterial;
let mode = 'distance';
let points = [];
let marks = [];
let selected = [];
let measuring = false, pendingApplication = false;
function schedule() {
  bench.request();
  if(pendingApplication)requestAnimationFrame(()=>requestAnimationFrame(()=>{
    if(!pendingApplication)return;
    pendingApplication=false;
    document.body.dataset.measure=element('measure').value;
    performance.mark('measurement-applied');
  }));
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
      note(face.center,face.name.split(':').at(-1),[face.name.endsWith('datum')?-34:34,22]);
    }
    value(planeAngle(...faces.map(([,face])=>face.normal)),'°',model.datum,[12,-32]);
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
    points.push({anchor,mesh:hit.mesh,normal:face.normal});
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

function fail(error) {
  if(signal.aborted)return;
  status.error(error);
  loading.hidden=true;
  errors.hidden=false;
  tools.disabled=reference.disabled=reset.disabled=true;
  console.error(error);
  controller.abort();
}
function connect() {
  tools.addEventListener('click',event=>{
    const button=event.target.closest('[data-tool]');
    if(button)choose(button.dataset.tool);
  },{signal});
  reference.addEventListener('click',sample,{signal});
  reset.addEventListener('click',()=>{bench.orbit.reset();bench.request();},{signal});
  // The orbit turns the view on a drag; a tap (under 5 px of travel) measures.
  let down;
  canvas.addEventListener('pointerdown',event=>{down={id:event.pointerId,x:event.clientX,y:event.clientY};},{signal});
  canvas.addEventListener('pointerup',event=>{
    if(down?.id!==event.pointerId)return;
    const tap=Math.hypot(event.clientX-down.x,event.clientY-down.y)<5;
    down=undefined;
    if(tap){
      const rect=canvas.getBoundingClientRect();
      void measure(event.clientX-rect.x,event.clientY-rect.y);
    }
  },{signal});
}
async function start() {
  applyQualityTier();
  bench = await openBench(canvas,{
    start:startEngine,
    loadCompat:()=>import('@margoengine/webgl2-compat'),
    signal,
    exhibit:document.body,
    camera:{position:[.2,.2,.22],target:[0,.022,0],fov:37,near:.008,far:40},
    environment:{preset:'tent',intensity:1},
    backdrop:{width:24,depth:3,height:3,radius:.8,material:{color:'#4a4743'}},
    contact:{size:.5,height:.1,opacity:.6,blur:.02,position:[0,.0005,0]},
    ao:true,
    orbit:{target:[0,.022,0],minDistance:.1,maxDistance:1.2},
    fit:false,
    onError:fail,
  });
  bench.backdrop.mesh.setPosition([0,-plate,0]);
  const cad = CadBench.attach(bench.engine,{deck:{size:[.36,.26],thickness:plate,top:0},casters:bench});
  const loaded = await loadGLTF(bench.engine,new URL('./assets/coupon.glb',import.meta.url),{extensions:[meshopt],signal});
  // A hardened steel gauge block; each B-rep face is its own mesh, so a pick names the face.
  loaded.meshes.forEach((mesh,index)=>{
    const face=model.faces[index];
    normalMaterial=cad.show(mesh,{metal:'steel',roughness:.3}).material;
    mesh.name=face.name;
    parts.set(mesh,face);
  });
  labels=LabelRenderer.attach(bench.engine,{parent:figure,zIndex:1,layout:new Callouts({color:'#f0c276',width:1.2,dot:2.4})});
  picking=HitDetails.attach(bench.engine);
  connect();
  if(!(await bench.ready())||!status.ready())return;
  tools.disabled=reference.disabled=reset.disabled=false;
  loading.hidden=true;
  performance.mark('margo-first-usable-frame');
}
start().catch(fail);
