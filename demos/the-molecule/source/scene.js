import {Engine} from '@margoengine/core';
import {applyQualityTier} from '@margoengine/quality';
import {parsePDB} from '@margoengine/loaders/pdb';
import {demoStatus} from 'margo-demo-status';
import {createChamber} from './chamber.js';
import {modeTitles,structureView} from './structure.mjs';

const by=id=>document.getElementById(id);
const canvas=by('molecule'), controls=by('controls'), overlay=by('status');
const orbit=by('orbit'), hint=by('hint'), caption=by('pick-label');
const choices=[...controls.querySelectorAll('[data-mode]')];
const status=demoStatus(document.body,overlay,by('error'));

const lifetime=new AbortController(),{signal}=lifetime,events={signal};
const force=new URLSearchParams(location.search).get('backend')==='webgl2';
const initialYaw=23, initialPitch=.205;
const captions=[
  'Colored atom spheres and bonds show how the protein folds.',
  'Van der Waals spheres show which parts of the protein pack together.',
  'Only the 22 atoms in the deposited chromophore residue remain in this view.',
];
const styles=['ball-and-stick','space-filling','ball-and-stick'];
let engine,specimen,sample,chamber,frame,observer,result;
let active=0,rendered=-1,yaw=initialYaw,pitch=initialPitch,revision=0;
let dirty=false,busy=false,started=false,pending=false,compatibility=false,pointer;
const layers=[];

function fail(reason) {
  if(signal.aborted||status.failed)return;
  status.error(reason);
  overlay.hidden=false;
  overlay.querySelector('strong').textContent='The structure could not open.';
  by('requirements').hidden=!['unsupported','no-adapter'].includes(reason?.code);
  controls.disabled=true;
}

async function structure() {
  const response=await fetch(new URL('./assets/1ema-gfp.pdbz',import.meta.url),{signal});
  if(!response.ok||!response.body)throw new Error('The experimental coordinate file is unavailable.');
  const pdb=await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).text();
  return structureView(parsePDB(pdb,{maxVertices:2500}));
}

async function startRenderer() {
  const options={backend:'webgpu',signal,exactSize:true,antialias:false,capacity:96,
    camera:{near:.06,far:28}};

  if(!force&&navigator.gpu){
    try{return await Engine.create(canvas,options);}
    catch(reason){
      if(!['unsupported','no-adapter'].includes(reason?.code))throw reason;
    }
  }
  const {install}=await import('@margoengine/webgl2-compat');
  const result=await install({force,signal});
  compatibility=result.installed;
  return Engine.create(canvas,options);
}

function fit() {
  const ratio=Math.max(1,Math.min(1.75,devicePixelRatio||1));
  const w=Math.max(1,Math.round(canvas.clientWidth*ratio));
  const h=Math.max(1,Math.round(canvas.clientHeight*ratio));
  if(canvas.width!==w)canvas.width=w;
  if(canvas.height!==h)canvas.height=h;
  const tight=w/h<1.24;
  const close=active===2;
  const target=close?specimen.focus:[0,tight?-.222:-.175,0];
  const angle=yaw*Math.PI/180;
  const distance=close?(tight?1.33:1.52):(tight?4.68:4.74);
  engine.camera.fov=tight?44:close?37:39.5;
  engine.camera.position=target.map((v,k)=>v+distance*[
    Math.sin(angle)*Math.cos(pitch),Math.sin(pitch),Math.cos(angle)*Math.cos(pitch),
  ][k]);
  engine.camera.target=target;
  const measure=close?2:10;
  const size=canvas.clientHeight*.5/Math.tan(engine.camera.fov*Math.PI/360)/distance;
  by('scale-label').textContent=measure+' Å';
  document.querySelector('.rule span').style.width=(measure*size*2.42/sample.span)+'px';
}

function layerFor(index) {
  if(layers[index])return layers[index];
  const layer=specimen.layer(index,styles[index]);
  layers[index]=layer;
  return layer;
}

async function draw() {
  if(active!==rendered){
    chamber.setClose(active===2);
    const layer=layerFor(active);
    for(const item of layers)if(item)item.visible=item===layer;
    rendered=active;
  }
  fit();
  engine.render();
  await engine.gpu?.queue.onSubmittedWorkDone();
}

function readout() {
  const atoms=active===2?sample.chromophore.length:sample.molecule.atoms.length;
  const bonds=active===2?sample.chromophoreBonds:active===1?0:sample.molecule.bonds.length/2;
  const number=Math.round(yaw)%360;
  by('angle').value=number+'°';
  orbit.value=String(number);
  orbit.setAttribute('aria-valuetext',number+' degrees');
  by('atom-count').textContent=atoms.toLocaleString('en-US');
  by('bond-count').textContent=bonds.toLocaleString('en-US');
  hint.textContent=captions[active];
  caption.textContent=result?result.residue.name+' '+result.residue.chain+':'+result.residue.id+' · '+result.atom.name+
    (result.bond?' · bond':''):'Drag to rotate. Tap an atom to inspect it.';
  for(const [index,choice] of choices.entries())choice.setAttribute('aria-pressed',String(index===active));
  canvas.setAttribute('aria-label',modeTitles[active]+' view of the GFP structure. Use arrow keys to orbit.');
  Object.assign(document.body.dataset,{mode:String(active), style:styles[active], angle:String(number),
    pitch:pitch.toFixed(5), atoms:String(atoms), bonds:String(bonds), residues:String(sample.residueCount),
    picked:result?String(result.atom.serial):'', primitiveCount:String(layers[active].primitiveCount)});
}

function schedule() {
  dirty=true;
  if(frame!==undefined||busy||!started||status.failed||signal.aborted)return;
  frame=requestAnimationFrame(async()=>{
    frame=undefined;
    dirty=false;
    busy=true;
    const requested=revision;
    try{
      await draw();
      if(!signal.aborted&&!status.failed&&requested===revision){
        readout();
        if(pending&&!performance.getEntriesByName('margo-first-input-rendered').length)
          performance.mark('margo-first-input-rendered');
        pending=false;
      }
    }catch(reason){fail(reason);}
    finally{busy=false;if(dirty)schedule();}
  });
}

function changed() {
  revision++;
  pending=true;
  schedule();
}

const wrap=value=>(value%360+360)%360;

function select(index) {
  if(active===index)return;
  active=index;
  result=undefined;
  changed();
}

function setCamera(angle,tilt=pitch) {
  yaw=wrap(angle);
  pitch=Math.min(.64,Math.max(-.16,tilt));
  result=undefined;
  changed();
}

function testPick(x,y) {
  result=layers[rendered]?.pick(x,y);
  readout();
}

function bind() {
  for(const [index,choice] of choices.entries())choice.addEventListener('click',()=>select(index),events);
  orbit.addEventListener('input',()=>setCamera(orbit.valueAsNumber),events);
  by('reset').addEventListener('click',()=>{
    active=0;
    setCamera(initialYaw,initialPitch);
  },events);
  canvas.addEventListener('pointerdown',event=>{
    if(pointer||event.button!==0)return;
    canvas.setPointerCapture(event.pointerId);
    pointer={id:event.pointerId,x:event.clientX,y:event.clientY,yaw,pitch,moved:false};
  },events);
  canvas.addEventListener('pointermove',event=>{
    if(pointer?.id!==event.pointerId)return;
    const dx=event.clientX-pointer.x,dy=event.clientY-pointer.y;
    if(Math.hypot(dx,dy)>4)pointer.moved=true;
    if(pointer.moved)setCamera(pointer.yaw-dx*.48,pointer.pitch+dy*.0042);
  },events);
  canvas.addEventListener('pointerup',event=>{
    if(pointer?.id!==event.pointerId)return;
    if(!pointer.moved&&!busy&&active===rendered){
      const box=canvas.getBoundingClientRect();
      testPick(event.clientX-box.left,event.clientY-box.top);
    }
    pointer=undefined;
  },events);
  for(const event of ['pointercancel','lostpointercapture'])
    canvas.addEventListener(event,({pointerId})=>{if(pointer?.id===pointerId)pointer=undefined;},events);
  canvas.addEventListener('keydown',event=>{
    if(!['ArrowLeft','ArrowRight','Enter'].includes(event.key))return;
    event.preventDefault();
    if(event.key==='Enter'){
      if(!busy&&active===rendered)testPick(canvas.clientWidth*.5,canvas.clientHeight*.5);
      return;
    }
    setCamera(yaw+(event.key==='ArrowRight'?9:-9));
  },events);
  observer=new ResizeObserver(schedule);
  observer.observe(canvas);
}

async function start() {
  applyQualityTier();
  const programs=import('./specimen-render.js');
  const [module]=await Promise.all([
    programs,
    structure().then(value=>{sample=value;}),
    startRenderer().then(value=>{engine=value;}),
  ]);
  performance.mark('molecule-coordinates-and-device');
  engine.onError=fail;
  chamber=createChamber(engine);
  specimen=module.mountSpecimen(engine,sample);
  specimen.figure.addEventListener('pickerror',event=>fail(event.detail),events);
  await specimen.figure.ready();
  await draw();
  if(signal.aborted||status.failed)return;
  bind();
  started=true;
  document.body.dataset.renderer=compatibility?'webgl2':'webgpu';
  readout();
  if(status.ready()){
    overlay.hidden=true;
    controls.disabled=false;
    performance.mark('margo-first-usable-frame');
  }
}

addEventListener('pagehide',event=>{
  if(event.persisted)return;
  lifetime.abort();
  if(frame!==undefined)cancelAnimationFrame(frame);
  observer?.disconnect();
  specimen?.figure.dispose();
  engine?.dispose();
},events);
start().catch(fail);
