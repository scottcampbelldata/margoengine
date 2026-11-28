import {autoEngine} from '@margoengine/webgl2-compat/auto';
import {applyQualityTier} from '@margoengine/quality';
import {booleanMeshesExact} from '@margoengine/mesh-edit/boolean-exact';
import {triangulatePolygon} from '@margoengine/mesh-edit/modeling';
import {demoStatus} from 'margo-demo-status';
import {carve, cutter, cuts, measure, metre, stock, triangulated} from './specimen.mjs';
import {mountStage, paintMesh} from './render.js';

const get=id=>document.getElementById(id);
let canvas=get('scene');
const overlay=get('status'), controls=get('controls');
const action=get('carve'), turn=get('rear'), edges=get('wire'), summary=get('explain');
const buttons=[...controls.querySelectorAll('[data-depth]')];
const marker=get('stage-caption');
const status=demoStatus(document.body,overlay,get('error'));
const owner=new AbortController(), {signal}=owner, events={signal};
const force=new URLSearchParams(location.search).get('backend')==='webgl2';
const inputMeshes=new Map(), results=new Map();
const compile=mesh=>triangulated(mesh,triangulatePolygon);

let engine, stage, observer, frame, raw, before;
let depth=2, carved=false, rotated=false, wire=false, pending=false, busy=false, dirty=false, started=false;

function fail(cause) {
  if(signal.aborted||status.failed)return;
  status.error(cause);
  overlay.hidden=false;
  overlay.querySelector('strong').textContent='The exhibit could not open.';
  get('requirements').hidden=!['unsupported','no-adapter'].includes(cause?.code);
  controls.disabled=true;
}

function fit() {
  const scale=Math.max(1,Math.min(devicePixelRatio||1,1.75));
  const w=Math.max(1,Math.round(canvas.clientWidth*scale));
  const h=Math.max(1,Math.round(canvas.clientHeight*scale));
  if(canvas.width!==w)canvas.width=w;
  if(canvas.height!==h)canvas.height=h;
  engine.camera.fov=w/h<1.23?39:35.5;
  const angle=.25+(rotated?Math.PI:0);
  engine.camera.position=[5.65*Math.sin(angle),2.47,5.65*Math.cos(angle)].map(x=>x*metre);
  engine.camera.target=[carved?0:-.255,1.055,0].map(x=>x*metre);
}

function inputs(index) {
  if(inputMeshes.has(index))return inputMeshes.get(index);
  const displayed=paintMesh(compile(cutter(index,true)),()=>3);
  const both=new Float32Array(raw.length+displayed.length);
  both.set(raw);
  both.set(displayed,raw.length);
  inputMeshes.set(index,both);
  return both;
}

function output(index) {
  if(results.has(index))return results.get(index);
  const cut=carve(booleanMeshesExact,compile,index);
  cut.geometry=paintMesh(cut.compiled,face=>cut.sources[face].input==='b'?2:1);
  results.set(index,cut);
  return cut;
}

async function draw() {
  fit();
  const specimen=carved?output(depth):undefined;
  stage.subject(specimen?.geometry??inputs(depth));
  stage.wire(wire);
  engine.render();
  await engine.gpu?.queue.onSubmittedWorkDone();
  return !signal.aborted&&!status.failed;
}

function readout() {
  const counts=carved?output(depth).counts:before;
  const removed=Math.max(0, Math.round(1000*(before.volume-counts.volume)));
  for(const [index,button] of buttons.entries())button.setAttribute('aria-pressed',String(index===depth));
  action.setAttribute('aria-pressed',String(carved));
  action.textContent=carved?'Show both inputs':'Carve mesh';
  turn.setAttribute('aria-pressed',String(rotated));
  turn.textContent=rotated?'Inspect front':'Inspect back';
  edges.setAttribute('aria-pressed',String(wire));
  edges.textContent=wire?'Hide triangles':'Show triangles';
  summary.textContent=cuts[depth].summary;
  const view=rotated?'Back':'Front';
  marker.textContent=carved?cuts[depth].name+' cut · '+view:'Stone and cutter · separated';
  get('triangles').value=counts.triangles.toLocaleString('en-US');
  get('edges').value=String(counts.invalid);
  get('volume').value=removed.toLocaleString('en-US')+' cm³';
  Object.assign(document.body.dataset,{
    depth:String(depth), carved:String(carved), wire:String(wire), back:String(rotated),
    triangles:String(counts.triangles), badEdges:String(counts.invalid), volume:counts.volume.toFixed(12),
    removed:String(removed), euler:String(counts.euler),
  });
}

let revision=0;
function schedule() {
  dirty=true;
  if(frame!==undefined||busy||!started||signal.aborted||status.failed)return;
  frame=requestAnimationFrame(async()=>{
    frame=undefined;
    dirty=false;
    busy=true;
    const requested=revision;
    try {
      const complete=await draw();
      if(complete&&requested===revision){
        readout();
        if(pending&&!performance.getEntriesByName('margo-first-input-rendered').length)
          performance.mark('margo-first-input-rendered');
        pending=false;
      }
    } catch(cause){fail(cause);}
    finally{busy=false;if(dirty)schedule();}
  });
}

function changed() {
  revision++;
  pending=true;
  schedule();
}

function bind() {
  action.addEventListener('click',()=>{carved=!carved;changed();},events);
  turn.addEventListener('click',()=>{rotated=!rotated;changed();},events);
  edges.addEventListener('click',()=>{wire=!wire;changed();},events);
  for(const [index,button] of buttons.entries())button.addEventListener('click',()=>{
    if(index===depth)return;
    depth=index;
    changed();
  },events);
  observer=new ResizeObserver(schedule);
  observer.observe(canvas);
}

async function start() {
  applyQualityTier();
  engine=await autoEngine(canvas,()=>{},{signal,backend:force?'webgl2':undefined,
    exactSize:true,antialias:false,capacity:64,camera:{near:.04,far:6.7}});
  canvas=engine.canvas;
  engine.onError=fail;
  performance.mark('mesh-boolean-device');
  const initialStock=compile(stock());
  raw=paintMesh(initialStock,()=>1);
  before=measure(initialStock);
  stage=mountStage(engine);
  if(!await draw()) return;
  bind();
  started=true;
  document.body.dataset.renderer=engine.backend;
  readout();
  if(status.ready()){
    overlay.hidden=true;
    controls.disabled=false;
    performance.mark('margo-first-usable-frame');
  }
}

addEventListener('pagehide',event=>{
  if(event.persisted)return;
  owner.abort();
  if(frame!==undefined)cancelAnimationFrame(frame);
  observer?.disconnect();
  stage?.dispose();
  engine?.dispose();
},events);
start().catch(fail);
