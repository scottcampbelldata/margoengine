import {autoEngine} from '@margoengine/webgl2-compat/auto';
import {applyQualityTier} from '@margoengine/quality';
import {Spline} from '@margoengine/splines';
import {closestPointOnSpline} from '@margoengine/splines/closest';
import {SplineFrames} from '@margoengine/splines/frames';
import {demoStatus} from 'margo-demo-status';
import {createInstrument} from './instrument.js';
import {initialProbe, initialStation, makeCurves, methods, probeAt, space} from './study.mjs';

const get=id=>document.getElementById(id);
let canvas=get('lab');
const overlay=get('status'), controls=get('controls'), probe=get('probe'), station=get('station');
const overheadButton=get('overhead'), family=[...controls.querySelectorAll('[data-curve]')];
const status=demoStatus(document.body,overlay,get('error'));
const disposal=new AbortController(), {signal}=disposal, events={signal};
const force=new URLSearchParams(location.search).get('backend')==='webgl2';
const curves=makeCurves(Spline,SplineFrames);
let engine, instrument, observer, frame;
let chosen=0, probeFraction=initialProbe, stationFraction=initialStation, overhead=false;
let revision=0, dirty=false, started=false, pending=false, busy=false;
const xy=value=>Array.from(value,v=>v.toPrecision(13)).join(',');
const millimeters=number=>(number*1000).toFixed(1)+' mm';
const percent=number=>(number*100).toFixed(1)+'%';

function fail(reason) {
  if(signal.aborted||status.failed)return;
  status.error(reason);
  overlay.hidden=false;
  overlay.querySelector('strong').textContent='The instrument could not open.';
  get('requirements').hidden=!['unsupported','no-adapter'].includes(reason?.code);
  controls.disabled=true;
}

function fitCamera() {
  const dpr=Math.max(1,Math.min(1.75,devicePixelRatio||1));
  const w=Math.max(1,Math.round(canvas.clientWidth*dpr));
  const h=Math.max(1,Math.round(canvas.clientHeight*dpr));
  if(w!==canvas.width)canvas.width=w;
  if(h!==canvas.height)canvas.height=h;
  const narrow=w/h<1.25;
  engine.camera.fov=overhead?(narrow?43:36.5):(narrow?47:37.5);
  engine.camera.position=space(overhead?[0,7.68,.05]:[1.92,4.72,5.47]);
  engine.camera.up=overhead?[0,0,-1]:[0,1,0];
  engine.camera.target=space([0,overhead?.224:-.13,.05]);
}

function measure() {
  const {spline,frames}=curves[chosen];
  const worldProbe=probeAt(probeFraction);
  const closest=closestPointOnSpline(spline,worldProbe,{samples:96});
  const s=stationFraction*spline.length;
  const local=frames.frameAt(s);
  return {spline,worldProbe,closest,s,local};
}

async function draw() {
  fitCamera();
  const values=measure();
  instrument.update(chosen,values.worldProbe,values.closest,values.local);
  engine.render();
  await engine.gpu?.queue.onSubmittedWorkDone();
  return values;
}

function readout({spline,worldProbe,closest,s,local}) {
  get('kind-note').textContent=methods[chosen].hint;
  get('probe-position').value=percent(probeFraction);
  get('station-position').value=percent(stationFraction);
  get('length').value=millimeters(spline.length);
  get('gap').value=millimeters(closest.distance);
  get('nearest').value=millimeters(closest.arc);
  station.setAttribute('aria-valuetext',millimeters(s)+' along the curve');
  probe.setAttribute('aria-valuetext',percent(probeFraction)+' across the scale');
  for(const [i,button] of family.entries())button.setAttribute('aria-pressed',String(chosen===i));
  overheadButton.setAttribute('aria-pressed',String(overhead));
  overheadButton.textContent=overhead?'View from the side':'View from above';
  Object.assign(document.body.dataset,{
    curve:methods[chosen].kind, probe:String(probeFraction), station:String(stationFraction),
    overhead:String(overhead), length:spline.length.toPrecision(13), gap:closest.distance.toPrecision(13),
    nearest:closest.arc.toPrecision(13), nearestParameter:closest.t.toPrecision(13), probeVector:xy(worldProbe),
    closestVector:xy(closest.point), frameAt:s.toPrecision(13), framePosition:xy(local.position),
    tangent:xy(local.tangent), normal:xy(local.normal), binormal:xy(local.binormal),
  });
}

function schedule() {
  dirty=true;
  if(frame!==undefined||busy||!started||status.failed||signal.aborted)return;
  frame=requestAnimationFrame(async()=>{
    frame=undefined;
    busy=true;
    dirty=false;
    const requested=revision;
    try {
      const result=await draw();
      if(!signal.aborted&&!status.failed&&requested===revision){
        readout(result);
        if(pending&&!performance.getEntriesByName('margo-first-input-rendered').length)
          performance.mark('margo-first-input-rendered');
        pending=false;
      }
    } catch(reason){fail(reason);}
    finally{busy=false;if(dirty)schedule();}
  });
}

function changed() {
  revision++;
  pending=true;
  schedule();
}

function bind() {
  for(const [i,button] of family.entries())button.addEventListener('click',()=>{
    if(chosen===i)return;
    chosen=i;
    changed();
  },events);
  probe.addEventListener('input',()=>{probeFraction=probe.valueAsNumber/1000;changed();},events);
  station.addEventListener('input',()=>{stationFraction=station.valueAsNumber/1000;changed();},events);
  overheadButton.addEventListener('click',()=>{overhead=!overhead;changed();},events);
  observer=new ResizeObserver(schedule);
  observer.observe(canvas);
}

async function start() {
  applyQualityTier();
  engine=await autoEngine(canvas,()=>{},{backend:force?'webgl2':undefined,signal,
    exactSize:true,antialias:false,capacity:128,camera:{near:.045,far:4}});
  canvas=engine.canvas;
  engine.onError=fail;
  performance.mark('curve-lab-device');
  instrument=createInstrument(engine,curves);
  performance.mark('curve-lab-geometry');
  const opening=await draw();
  if(signal.aborted||status.failed)return;
  bind();
  started=true;
  readout(opening);
  document.body.dataset.renderer=engine.backend;
  if(status.ready()){
    overlay.hidden=true;
    controls.disabled=false;
    performance.mark('margo-first-usable-frame');
  }
}

addEventListener('pagehide',event=>{
  if(event.persisted)return;
  disposal.abort();
  if(frame!==undefined)cancelAnimationFrame(frame);
  observer?.disconnect();
  engine?.dispose();
},events);
start().catch(fail);
