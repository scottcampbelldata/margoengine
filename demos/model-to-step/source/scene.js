import { applyQualityTier } from '@margoengine/quality';
import { autoEngine } from '@margoengine/webgl2-compat/auto';
import { demoStatus } from 'margo-demo-status';
import { defaultDiameter } from './flange.mjs';
import { makeStudio } from './studio.js';

const get=id=>document.getElementById(id);
const canvas=get('part');
const loading=get('loading');
const renderError=get('render-error');
const status=demoStatus(document.body,loading,renderError);
const slider=get('diameter');
const exportButton=get('export');
const drop=get('drop');
const fileInput=get('file');
const exchangeStatus=get('exchange-status');
const views=get('views');
const report=get('comparison');
const lifetime=new AbortController();
const {signal}=lifetime;
const events={signal};
const info=document.body.dataset;
const defaultYaw=.60, defaultTilt=.92;
const units=new Intl.NumberFormat(undefined,{maximumFractionDigits:3});
const force=new URLSearchParams(location.search).get('backend')==='webgl2';

let engine, studio, observer, worker, paintFrame, exactTimer, warmTimer, drag, baseline, active, received;
let yaw=defaultYaw, tilt=defaultTilt, diameter=defaultDiameter, selection='model', pendingDraw=false, busy=false;
let sequence=0, importGeneration=0, firstInput=false, exporting=false;
const waiting=new Map();

async function loadBaseline() {
  const resource=await fetch(new URL('./aster-flange.mesh',import.meta.url),{signal});
  if (!resource.ok) throw new Error('The flange mesh could not load.');
  const stream=resource.body.pipeThrough(new DecompressionStream('gzip'));
  const buffer=await new Response(stream).arrayBuffer();
  const header=new DataView(buffer);
  if (header.getUint32(0)!==0x41535431) throw new Error('The flange mesh format is invalid.');
  const components=header.getUint32(4,true), count=header.getUint32(8,true);
  if (24+components*8+count*4!==buffer.byteLength || !components || components%3!==0 || count%3!==0) {
    throw new Error('The flange mesh is incomplete.');
  }
  return {
    diameter:defaultDiameter,
    properties:{faces:header.getUint32(12,true),volume:header.getFloat64(16,true)},
    mesh:{
      positions:new Float32Array(buffer,24,components),
      normals:new Float32Array(buffer,24+components*4,components),
      indices:new Uint32Array(buffer,24+components*8,count),
    },
  };
}

function openWorker() {
  if (worker) return worker;
  worker=new Worker(new URL('./cad-worker.js',import.meta.url),{type:'module'});
  worker.addEventListener('message',({data})=>{
    const target=waiting.get(data.id);
    if (!target) return;
    waiting.delete(data.id);
    if (data.error) target.reject(new Error(data.error));
    else target.resolve(data.result);
  },events);
  worker.addEventListener('error',event=>{
    const error=event.error ?? new Error(event.message || 'The CAD worker could not open.');
    for (const request of waiting.values()) request.reject(error);
    waiting.clear();
    worker?.terminate();
    worker=undefined;
  },events);
  return worker;
}

function request(type,bore,buffer) {
  return new Promise((resolve,reject)=>{
    if (signal.aborted) { reject(signal.reason); return; }
    const id=++sequence;
    const service=openWorker();
    waiting.set(id,{resolve,reject});
    service.postMessage({id,type,diameter:bore,buffer},buffer?[buffer]:[]);
  });
}

function stageSize() {
  const dpr=Math.max(1,Math.min(devicePixelRatio || 1,1.38));
  const width=Math.max(1,Math.round(canvas.clientWidth*dpr));
  const height=Math.max(1,Math.round(canvas.clientHeight*dpr));
  if (canvas.width!==width) canvas.width=width;
  if (canvas.height!==height) canvas.height=height;
  const ratio=width/height;
  engine.camera.fov=ratio<1.22?42:38;
}

function render() {
  stageSize();
  const radius=.222, rest=.009;
  const horizontal=radius*Math.cos(tilt);
  engine.camera.position=[horizontal*Math.sin(yaw),rest+radius*Math.sin(tilt),horizontal*Math.cos(yaw)];
  engine.camera.target=[0,rest,0];
  engine.render();
  return engine.gpu?.queue.onSubmittedWorkDone();
}

function refresh() {
  pendingDraw=true;
  if (paintFrame!==undefined || busy || status.failed || signal.aborted) return;
  paintFrame=requestAnimationFrame(async ()=>{
    paintFrame=undefined;
    pendingDraw=false;
    busy=true;
    const marker=firstInput;
    try {
      await render();
      if (marker && !signal.aborted && !performance.getEntriesByName('margo-first-input-rendered').length) {
        performance.mark('margo-first-input-rendered');
      }
    } catch (error) { fail(error); }
    finally { busy=false; if (pendingDraw) refresh(); }
  });
}

function fail(error) {
  if (signal.aborted || status.failed) return;
  status.error(error);
  loading.hidden=true;
  renderError.hidden=false;
  [slider,exportButton,drop,get('reset')].forEach(element=>element.disabled=true);
}

function volumeText(metres) { return units.format(metres*1e6)+' cm³'; }

function measure() {
  get('bore').value='Ø '+diameter+' mm';
  slider.setAttribute('aria-valuetext',diameter+' millimetres');
  get('volume').textContent=volumeText(active.properties.volume);
  get('faces').textContent=String(active.properties.faces);
  info.diameter=String(diameter);
  info.volume=String(active.properties.volume);
}
function exchange(message,tone='') {
  exchangeStatus.textContent=message;
  exchangeStatus.dataset.tone=tone;
  exchangeStatus.hidden=!message;
}

function choose(view,redraw=true) {
  selection=view;
  const fromImport=selection==='import';
  const selected=fromImport?received:active;
  if (!selected) return;
  studio.shape(selected.mesh,selected.center,selected.scale,fromImport && !received.comparison.equivalent?undefined:diameter);
  get('show-model').setAttribute('aria-pressed',String(!fromImport));
  get('show-import').setAttribute('aria-pressed',String(fromImport));
  get('part-label').textContent=fromImport?'Imported solid':'Aster indexing flange';
  info.view=view;
  if (redraw) refresh();
}

function remapBore(next) {
  if (next===defaultDiameter) return baseline;
  const original=defaultDiameter/2000, requested=next/2000;
  const flange=.032, lip=.002;
  const {positions,normals,indices}=baseline.mesh;
  const deformed=positions.slice();
  for (let i=0; i<positions.length; i+=3) {
    const r=Math.hypot(positions[i],positions[i+2]);
    if (r<=0 || r>=flange) continue;
    const value=r<=original+lip+1e-7
      ? r+requested-original
      : requested+lip+(r-original-lip)*(flange-requested-lip)/(flange-original-lip);
    const scale=value/r;
    deformed[i]*=scale;
    deformed[i+2]*=scale;
  }
  const boreVolume=r=>Math.PI*(.022*r*r+(lip/3)*(r*r+r*(r+lip)+(r+lip)**2));
  return {
    diameter:next,mesh:{positions:deformed,normals,indices},
    properties:{...baseline.properties,volume:baseline.properties.volume+boreVolume(original)-boreVolume(requested)},
  };
}

async function rebuild(bore) {
  try {
    const result=await request('model',bore);
    if (bore!==diameter || signal.aborted) return;
    active={...result,diameter:bore};
    info.exact=String(bore);
    if (selection==='model') choose('model');
    measure();
  } catch (error) {
    if (!signal.aborted && diameter===bore) exchange(error.message,'error');
  }
}

function edit() {
  diameter=slider.valueAsNumber;
  firstInput=true;
  importGeneration++;
  received=undefined;
  views.hidden=report.hidden=true;
  delete info.comparison;
  delete info.exact;
  exchange('');
  active=remapBore(diameter);
  measure();
  choose('model');
  clearTimeout(warmTimer);
  clearTimeout(exactTimer);
  exactTimer=setTimeout(()=>void rebuild(diameter),110);
}

async function download() {
  if (exporting) return;
  const bore=diameter;
  exporting=true;
  exportButton.disabled=true;
  exchange('Preparing Ø '+bore+' mm STEP…');
  try {
    const {step}=await request('export',bore);
    const url=URL.createObjectURL(new Blob([step],{type:'model/step'}));
    const link=document.createElement('a');
    link.href=url;
    link.download='Aster-flange-'+bore+'mm.step';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(()=>URL.revokeObjectURL(url),5000);
    info.exported=String(bore);
    exchange('STEP ready. Open the downloaded file here to compare.','pass');
  } catch (error) {
    if (!signal.aborted) exchange(error.message,'error');
  } finally {
    exporting=false;
    if (!status.failed && !signal.aborted) exportButton.disabled=false;
  }
}

function fitImported(mesh) {
  const low=[Infinity,Infinity,Infinity], high=[-Infinity,-Infinity,-Infinity];
  const {positions}=mesh;
  for (let i=0; i<positions.length; i++) {
    const axis=i%3;
    low[axis]=Math.min(low[axis],positions[i]);
    high[axis]=Math.max(high[axis],positions[i]);
  }
  const size=Math.max(...high.map((value,index)=>value-low[index]));
  if (!(size>0) || !Number.isFinite(size)) throw new Error('The imported solid has invalid dimensions.');
  return {scale:.108/size,center:[-(high[0]+low[0])/2,-low[1],-(high[2]+low[2])/2]};
}

function showComparison(c) {
  get('delta-volume').textContent=units.format(c.volume*1e6)+' cm³';
  get('delta-area').textContent=units.format(c.area*1e4)+' cm²';
  get('delta-center').textContent=units.format(c.centroid*1000)+' mm';
  get('delta-surface').textContent=c.samples?'Matches':'Different';
  info.comparison=c.equivalent?'match':'different';
  info.comparisonTriangles=String(c.triangles);
  views.hidden=false;
  report.hidden=false;
}

async function importFile(file) {
  if (!file) return;
  const generation=++importGeneration, bore=diameter;
  if (file.size<24 || file.size>2_000_000) {
    exchange('Choose a STEP file smaller than 2 MB.','error');
    return;
  }
  received=undefined;
  views.hidden=report.hidden=true;
  delete info.comparison;
  delete info.comparisonTriangles;
  choose('model');
  exchange('Reading '+file.name+'…');
  try {
    const buffer=await file.arrayBuffer();
    const result=await request('import',bore,buffer);
    if (generation!==importGeneration || signal.aborted) return;
    received=result.comparison.equivalent?result:{...result,...fitImported(result.mesh)};
    showComparison(result.comparison);
    choose('import');
    exchange(result.comparison.equivalent?'Round-trip match. '+file.name:'The imported solid differs. '+file.name,
      result.comparison.equivalent?'pass':'');
  } catch (error) {
    if (!signal.aborted && generation===importGeneration) exchange(error.message,'error');
  }
}

function bind() {
  slider.addEventListener('input',edit,events);
  exportButton.addEventListener('click',download,events);
  drop.addEventListener('click',()=>fileInput.click(),events);
  fileInput.addEventListener('change',()=>{
    const selected=fileInput.files[0];
    fileInput.value='';
    void importFile(selected);
  },events);
  drop.addEventListener('dragover',event=>{
    event.preventDefault();
    event.dataTransfer.dropEffect='copy';
    drop.classList.add('dragging');
  },events);
  drop.addEventListener('dragleave',()=>drop.classList.remove('dragging'),events);
  drop.addEventListener('drop',event=>{
    event.preventDefault();
    drop.classList.remove('dragging');
    void importFile(event.dataTransfer.files[0]);
  },events);
  get('show-model').addEventListener('click',()=>choose('model'),events);
  get('show-import').addEventListener('click',()=>choose('import'),events);
  get('reset').addEventListener('click',()=>{ yaw=defaultYaw; tilt=defaultTilt; refresh(); },events);
  canvas.addEventListener('pointerdown',event=>{
    if (!event.isPrimary || event.button!==0) return;
    drag={id:event.pointerId,x:event.clientX,y:event.clientY};
    canvas.setPointerCapture(event.pointerId);
  },events);
  canvas.addEventListener('pointermove',event=>{
    if (drag?.id!==event.pointerId) return;
    yaw+=(event.clientX-drag.x)*.012;
    tilt=Math.max(.16,Math.min(1.48,tilt+(event.clientY-drag.y)*.01));
    drag.x=event.clientX;
    drag.y=event.clientY;
    refresh();
  },events);
  canvas.addEventListener('lostpointercapture',()=>{ drag=undefined; },events);
  observer=new ResizeObserver(refresh);
  observer.observe(canvas);
}

async function start() {
  applyQualityTier();
  const geometry=loadBaseline();
  void geometry.catch(()=>undefined);
  engine=await autoEngine(canvas,()=>{},{
    backend:force?'webgl2':undefined,signal,exactSize:true,antialias:true,camera:{near:.020,far:3,fov:38},
  });
  engine.onError=fail;
  baseline=await geometry;
  active=baseline;
  studio=makeStudio(engine);
  choose('model',false);
  measure();
  await render();
  if (signal.aborted || status.failed) return;
  bind();
  info.renderer=engine.backend;
  info.exact=String(defaultDiameter);
  [slider,exportButton,drop,get('reset')].forEach(element=>element.disabled=false);
  status.ready();
  loading.hidden=true;
  performance.mark('margo-first-usable-frame');
  warmTimer=setTimeout(()=>{
    if (!signal.aborted) void rebuild(diameter);
  },450);
}

function dispose() {
  lifetime.abort();
  clearTimeout(warmTimer);
  clearTimeout(exactTimer);
  if (paintFrame!==undefined) cancelAnimationFrame(paintFrame);
  observer?.disconnect();
  for (const request of waiting.values()) request.reject(signal.reason);
  waiting.clear();
  worker?.terminate();
  engine?.dispose();
}
addEventListener('pagehide',event=>{ if (!event.persisted) dispose(); },events);
if (import.meta.hot) import.meta.hot.dispose(dispose);
void start().catch(fail);