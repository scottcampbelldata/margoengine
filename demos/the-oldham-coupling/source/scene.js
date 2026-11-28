import { startEngine } from '@margoengine/webgl2-compat/auto';
import { Shadows } from '@margoengine/shadows';
import { describeCheck } from '@margoengine/machinery/rigs';
import { openCoupling } from './mechanism.js';
import { prepareCoupling } from './model.js';

const canvas=document.querySelector('#scene');
const offset=document.querySelector('#offset');
const offsetValue=document.querySelector('#offset-value');
const turn=document.querySelector('#turn');
const inputTurn=document.querySelector('#input-turn');
const outputTurn=document.querySelector('#output-turn');
const orbit=document.querySelector('#orbit');
const gap=document.querySelector('#check');
const explode=document.querySelector('#explode');
const reverse=document.querySelector('#reverse');
const play=document.querySelector('#play');
const loading=document.querySelector('#loading');
const stop=new AbortController();
const listen={signal:stop.signal};
const fov=32;
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
let engine,mechanism,model,observer,frame,fitDirty=true,poseDirty=true,exploded=false,otherSide=false,playing=null;
let lastOffset=-1,lastTurn=-1;

function fit() {
  const width=Math.max(1,canvas.clientWidth),height=Math.max(1,canvas.clientHeight);
  const dpr=Math.min(1.5,Math.max(1.25,devicePixelRatio));
  const pixelWidth=Math.round(width*dpr),pixelHeight=Math.round(height*dpr);
  if(canvas.width!==pixelWidth) canvas.width=pixelWidth;
  if(canvas.height!==pixelHeight) canvas.height=pixelHeight;
  const yaw=exploded?(otherSide?-.62:.620):.505,pitch=.352;
  const eye=[Math.sin(yaw)*Math.cos(pitch),Math.sin(pitch),Math.cos(yaw)*Math.cos(pitch)];
  const right=[Math.cos(yaw),0,-Math.sin(yaw)];
  const up=[-Math.sin(yaw)*Math.sin(pitch),Math.cos(pitch),-Math.cos(yaw)*Math.sin(pitch)];
  const target=[0,.172,.047],slope=Math.tan(fov*Math.PI/360);
  const points=[
    ...[-.718,.718].flatMap((x)=>[-.232,.355].map((z)=>[x,-.067,z])),
    [-.695,.361,.052],[.698,.474,.065],[.404,.571,.112],[.116,.588,.136],
  ];
  let distance=0;
  for(const p of points) {
    const v=p.map((value,i)=>value-target[i]);
    const across=Math.abs(dot(right,v))/(slope*.93*width/height);
    const above=Math.abs(dot(up,v))/(slope*.88);
    distance=Math.max(distance,dot(eye,v)+Math.max(across,above));
  }
  engine.camera.target=target;
  engine.camera.position=target.map((value,i)=>value+eye[i]*distance);
}

function update() {
  const separation=Number(offset.value),angle=Number(turn.value);
  const changed=separation!==lastOffset||angle!==lastTurn;
  if(!fitDirty&&!poseDirty&&!changed) return;
  if(fitDirty) fit();
  const pose=changed||poseDirty?mechanism.drive(angle*Math.PI/180,separation/1000,false):null;
  if(pose) model(pose,separation/1000,exploded);
  engine.render({delta:0});
  if(pose) {
    offsetValue.textContent=separation+' mm';
    inputTurn.textContent=angle+'°';
    outputTurn.textContent=Math.round(pose.output*180/Math.PI)+'°';
    orbit.textContent=(pose.orbitRadius*1000).toFixed(1)+' mm';
    offset.setAttribute('aria-valuetext',offsetValue.textContent);
    turn.setAttribute('aria-valuetext',angle+' degrees');
    document.body.dataset.offset=String(separation);
    document.body.dataset.angle=String(angle);
    document.body.dataset.center=pose.center.map((value)=>value.toFixed(7)).join(',');
    document.body.dataset.view=exploded?'exploded':'assembly';
    document.body.dataset.check=gap.textContent=describeCheck(mechanism.check);
  }
  if(fitDirty) document.body.dataset.side=otherSide?'reverse':'default';
  lastOffset=separation;
  lastTurn=angle;
  fitDirty=poseDirty=false;
}

function setPlay(value) {
  playing=value;
  play.firstChild.textContent=value?'Pause turn':'Play a turn';
  document.body.dataset.running=String(Boolean(value));
}

function tick(now) {
  frame=undefined;
  if(stop.signal.aborted) return;
  try {
    if(playing) {
      playing.start??=now;
      turn.value=String(Math.min(360,Math.floor(playing.angle+(now-playing.start)*.081)));
      if(turn.value==='360') setPlay(null);
    }
    update();
  } catch(error) { fail(error); return; }
  if(playing) schedule();
}

function schedule() { frame??=requestAnimationFrame(tick); }

function connect() {
  for(const range of [offset,turn]) range.addEventListener('input',()=>{ setPlay(null); schedule(); },listen);
  play.addEventListener('click',()=>{
    if(playing) setPlay(null);
    else {
      if(turn.value==='360') turn.value='0';
      setPlay({angle:Number(turn.value)});
    }
    schedule();
  },listen);
  explode.addEventListener('click',()=>{
    exploded=!exploded;
    if(!exploded) otherSide=false;
    reverse.hidden=!exploded;
    reverse.setAttribute('aria-pressed',String(otherSide));
    explode.setAttribute('aria-pressed',String(exploded));
    poseDirty=fitDirty=true;
    schedule();
  },listen);
  reverse.addEventListener('click',()=>{
    otherSide=!otherSide;
    reverse.setAttribute('aria-pressed',String(otherSide));
    fitDirty=true;
    schedule();
  },listen);
  document.addEventListener('visibilitychange',()=>{ if(document.hidden) setPlay(null); },listen);
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
  for(const control of [offset,turn,play,explode,reverse]) control.disabled=true;
  loading.textContent='This browser could not open the coupling.';
  loading.hidden=false;
  document.body.dataset.state='error';
  console.error(error);
}

async function open() {
  const opening=startEngine(canvas,{exactSize:true,antialias:true,signal:stop.signal,startupTimeout:5000,
    camera:{fov,near:.11,far:72},forceCompat:location.search.includes('backend=webgl2'),
    loadCompat:()=>import('@margoengine/webgl2-compat')});
  const assemble=prepareCoupling();
  const solving=openCoupling(stop.signal);
  const {engine:device,renderer}=await opening;
  mechanism=await solving;
  engine=device;
  engine.onError=fail;
  engine.scene.background='#4d5a6d';
  engine.lighting.direction.set([-.40,.74,.53,2.75]);
  engine.lighting.radiance.set([1,.94,.85,.24]);
  engine.lighting.ambient.set([.46,.52,.63]);
  const shadows=Shadows.attach(engine,{resolution:1024,bounds:{min:[-.88,-.077,-.54],max:[.88,.63,.64]},
    normalBias:.0021,filter:'soft',lightSize:.026});
  model=assemble(engine,shadows);
  setPlay(null);
  update();
  await engine.gpu.queue.onSubmittedWorkDone();
  if(stop.signal.aborted) return;
  connect();
  for(const control of [offset,turn,play,explode,reverse]) control.disabled=false;
  loading.hidden=true;
  document.body.dataset.renderer=renderer;
  document.body.dataset.state='ready';
  performance.mark('margo-first-usable-frame');
}

addEventListener('pagehide',(event)=>{ if(!event.persisted) dispose(); });
open().catch((error)=>{ if(!stop.signal.aborted) fail(error); });
