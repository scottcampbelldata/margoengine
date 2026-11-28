import { startEngine } from '@margoengine/webgl2-compat/auto';
import { Shadows } from '@margoengine/shadows';
import { describeCheck, signedReading } from '@margoengine/machinery/rigs';
import { crankAngle, openDrive } from './mechanism.js';
import { prepareDrive } from './model.js';

const canvas=document.querySelector('#scene');
const angle=document.querySelector('#angle');
const crank=document.querySelector('#crank');
const wheel=document.querySelector('#wheel');
const phase=document.querySelector('#phase');
const gap=document.querySelector('#check');
const marker=document.querySelector('#marker');
const play=document.querySelector('#play');
const explanation=document.querySelector('#explanation');
const loading=document.querySelector('#loading');
const stop=new AbortController();
const listen={signal:stop.signal};
const fov=32;
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
let engine,mechanism,move,frame,observer,fitDirty=true,previous=-1,playing=null;

function fit() {
  const width=Math.max(1,canvas.clientWidth);
  const height=Math.max(1,canvas.clientHeight);
  const dpr=Math.min(1.5,Math.max(1.25,devicePixelRatio));
  const pixels=[Math.round(width*dpr),Math.round(height*dpr)];
  if(canvas.width!==pixels[0]) canvas.width=pixels[0];
  if(canvas.height!==pixels[1]) canvas.height=pixels[1];

  const yaw=-.20, pitch=.83;
  const eye=[Math.sin(yaw)*Math.cos(pitch),Math.sin(pitch),Math.cos(yaw)*Math.cos(pitch)];
  const right=[Math.cos(yaw),0,-Math.sin(yaw)];
  const up=[-Math.sin(yaw)*Math.sin(pitch),Math.cos(pitch),-Math.cos(yaw)*Math.sin(pitch)];
  const target=[0,.05,.006];
  const slope=Math.tan(fov*Math.PI/360);
  let distance=0;
  for(const x of [-.432,.432]) for(const y of [-.047,.147]) for(const z of [-.284,.284]) {
    const p=[x-target[0],y-target[1],z-target[2]];
    const across=Math.abs(dot(right,p))/(slope*.91*width/height);
    const above=Math.abs(dot(up,p))/(slope*.88);
    distance=Math.max(distance,dot(eye,p)+Math.max(across,above));
  }
  engine.camera.target=target;
  engine.camera.position=target.map((value,i)=>value+eye[i]*distance);
}

function setPlaying(value) {
  playing=value;
  play.setAttribute('aria-pressed',String(Boolean(playing)));
  play.firstChild.textContent=playing?'Pause the turn':'Play the turn';
}

function update() {
  const value=Number(angle.value);
  if(!fitDirty&&value===previous) return;
  if(fitDirty) fit();
  const pose=mechanism.drive(crankAngle(value));
  move(pose);
  engine.render({delta:0});
  if(value!==previous) {
    const degrees=-pose.turnWheel*180/Math.PI;
    const state=pose.indexing?'index':'dwell';
    crank.textContent=value+'°';
    wheel.textContent=signedReading(-degrees,'°');
    marker.style.left=value/3.6+'%';
    if(document.body.dataset.phase!==state) {
      phase.textContent=pose.indexing?'Indexing':'Dwell';
      explanation.textContent=pose.indexing
        ?'The roller is inside a slot and drives the wheel.'
        :'The cam sits against a scallop and holds the wheel in place.';
    }
    document.body.dataset.phase=state;
    document.body.dataset.angle=String(value);
    document.body.dataset.output=degrees.toFixed(6);
    document.body.dataset.check=gap.textContent=describeCheck(mechanism.check);
  }
  previous=value;
  fitDirty=false;
}

function tick(now) {
  frame=undefined;
  if(stop.signal.aborted) return;
  try {
    if(playing) {
      playing.start??=now;
      angle.value=String(Math.min(360,Math.round(playing.angle+(now-playing.start)*.066)));
      if(angle.value==='360') setPlaying(null);
    }
    update();
  } catch(error) { fail(error); return; }
  if(playing) schedule();
}

function schedule() { frame??=requestAnimationFrame(tick); }

function connect() {
  angle.addEventListener('input',()=>{ setPlaying(null); schedule(); },listen);
  play.addEventListener('click',()=>{
    if(playing) setPlaying(null);
    else {
      if(angle.value==='360') angle.value='0';
      setPlaying({angle:Number(angle.value)});
    }
    schedule();
  },listen);
  document.addEventListener('visibilitychange',()=>{ if(document.hidden) setPlaying(null); },listen);
  observer=new ResizeObserver(()=>{ fitDirty=true; schedule(); });
  observer.observe(canvas);
}

function dispose() {
  stop.abort();
  observer?.disconnect();
  if(frame!==undefined) cancelAnimationFrame(frame);
  engine?.dispose();
}

function fail(error) {
  dispose();
  angle.disabled=play.disabled=true;
  loading.textContent='This browser could not open the Geneva drive.';
  loading.hidden=false;
  document.body.dataset.state='error';
  console.error(error);
}

async function open() {
  const opening=startEngine(canvas,{exactSize:true,antialias:true,signal:stop.signal,startupTimeout:5000,
    camera:{fov,near:.09,far:50},forceCompat:location.search.includes('backend=webgl2'),
    loadCompat:()=>import('@margoengine/webgl2-compat')});
  const assemble=prepareDrive();
  const solving=openDrive(Number(angle.value),stop.signal);
  const {engine:device,renderer}=await opening;
  mechanism=await solving;
  engine=device;
  engine.onError=fail;
  engine.scene.background='#b4bda5';
  engine.lighting.direction.set([-.38,.79,-.47,2.7]);
  engine.lighting.radiance.set([1,.92,.79,.30]);
  engine.lighting.ambient.set([.47,.62,.56]);
  const shadows=Shadows.attach(engine,{resolution:1024,bounds:{min:[-.68,-.065,-.52],max:[.67,.19,.57]},
    normalBias:.0017,filter:'soft',lightSize:.022});
  move=assemble(engine,shadows);
  update();
  await engine.gpu.queue.onSubmittedWorkDone();
  if(stop.signal.aborted) return;
  connect();
  angle.disabled=play.disabled=false;
  loading.hidden=true;
  document.body.dataset.renderer=renderer;
  document.body.dataset.state='ready';
  performance.mark('margo-first-usable-frame');
}

addEventListener('pagehide',(event)=>{ if(!event.persisted) dispose(); });
open().catch((error)=>{ if(!stop.signal.aborted) fail(error); });
