import { startEngine } from '@margoengine/webgl2-compat/auto';
import { Shadows } from '@margoengine/shadows';
import { describeCheck, signedReading } from '@margoengine/machinery/rigs';
import { openTrain } from './mechanism.js';
import { prepareDrive } from './model.js';

const canvas=document.querySelector('#scene');
const angle=document.querySelector('#angle');
const amount=document.querySelector('#amount');
const front=document.querySelector('#front');
const play=document.querySelector('#play');
const inputName=document.querySelector('#input-name');
const note=document.querySelector('#note');
const loading=document.querySelector('#loading');
const choices=[...document.querySelectorAll('[data-hold]')];
const values=Object.fromEntries(['sun','ring','carrier'].map((name)=>[name,document.querySelector('#'+name)]));
const stop=new AbortController();
const listen={signal:stop.signal};
const fov=33;
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const gap=document.querySelector('#check');
let mechanism;
let engine,model,observer,frame,fitDirty=true,previous=-1,previousHold='';
let held='ring',faceOn=false,playing=null;

const notes={
  ring:'The carrier follows the sun at 7/26 of its speed.',
  carrier:'The ring turns at 7/19 of the sun’s speed in the opposite direction.',
  sun:'The carrier follows the ring at 19/26 of its speed.',
};

function fit() {
  const width=Math.max(1,canvas.clientWidth),height=Math.max(1,canvas.clientHeight);
  const dpr=Math.min(1.5,Math.max(1.25,devicePixelRatio));
  const pixelWidth=Math.round(width*dpr),pixelHeight=Math.round(height*dpr);
  if(canvas.width!==pixelWidth) canvas.width=pixelWidth;
  if(canvas.height!==pixelHeight) canvas.height=pixelHeight;

  const yaw=faceOn?0:.263,pitch=faceOn?.020:.237;
  const eye=[Math.sin(yaw)*Math.cos(pitch),Math.sin(pitch),Math.cos(yaw)*Math.cos(pitch)];
  const right=[Math.cos(yaw),0,-Math.sin(yaw)];
  const up=[-Math.sin(yaw)*Math.sin(pitch),Math.cos(pitch),-Math.cos(yaw)*Math.sin(pitch)];
  const target=[0,.304,.020],slope=Math.tan(fov*Math.PI/360);
  const bounds=[...[-.431,.431].flatMap((x)=>[-.256,.348].map((z)=>[x,-.066,z]))];
  for(let i=0;i<24;i++) {
    const a=i*Math.PI/12;
    bounds.push([.334*Math.cos(a),.400+.334*Math.sin(a),.069]);
  }
  let distance=0;
  for(const point of bounds) {
    const v=point.map((value,i)=>value-target[i]);
    const across=Math.abs(dot(right,v))/(slope*.93*width/height);
    const above=Math.abs(dot(up,v))/(slope*.91);
    distance=Math.max(distance,dot(eye,v)+Math.max(across,above));
  }
  engine.camera.target=target;
  engine.camera.position=target.map((value,i)=>value+eye[i]*distance);
}

function update() {
  const value=Number(angle.value);
  const changed=value!==previous||held!==previousHold;
  if(!fitDirty&&!changed) return;
  if(fitDirty) fit();
  const pose=changed?mechanism.drive(value*Math.PI/180,held,false):null;
  if(pose) model(pose);
  engine.render({delta:0});
  if(pose) {
    amount.textContent=value+'°';
    angle.setAttribute('aria-valuetext',value+' degrees');
    for(const [member,output] of Object.entries(values)) {
      output.textContent=member===held?'Held':signedReading(pose[member]*180/Math.PI,'°');
      document.body.dataset[member]=(pose[member]*180/Math.PI).toFixed(6);
    }
    document.body.dataset.angle=String(value);
    document.body.dataset.held=held;
    document.body.dataset.check=gap.textContent=describeCheck(mechanism.check);
  }
  if(fitDirty) document.body.dataset.view=faceOn?'face':'exhibit';
  previous=value;
  previousHold=held;
  fitDirty=false;
}

function setPlay(value) {
  playing=value;
  play.firstChild.textContent=value?'Pause rotation':'Play one turn';
  document.body.dataset.running=String(Boolean(value));
}

function tick(now) {
  frame=undefined;
  if(stop.signal.aborted) return;
  try {
    if(playing) {
      playing.start??=now;
      angle.value=String(Math.min(360,Math.floor(playing.angle+(now-playing.start)*.083)));
      if(angle.value==='360') setPlay(null);
    }
    update();
  } catch(error) { fail(error); return; }
  if(playing) schedule();
}

function schedule() { frame??=requestAnimationFrame(tick); }

function connect() {
  angle.addEventListener('input',()=>{ setPlay(null); schedule(); },listen);
  for(const button of choices) {
    button.addEventListener('click',()=>{
      held=button.dataset.hold;
      setPlay(null);
      inputName.textContent=held==='sun'?'Ring':'Sun';
      note.textContent=notes[held];
      for(const option of choices) option.setAttribute('aria-pressed',String(option===button));
      schedule();
    },listen);
  }
  play.addEventListener('click',()=>{
    if(playing) setPlay(null);
    else {
      if(angle.value==='360') angle.value='0';
      setPlay({angle:Number(angle.value)});
    }
    schedule();
  },listen);
  front.addEventListener('click',()=>{
    faceOn=!faceOn;
    front.textContent=faceOn?'Exhibit view':'Face-on view';
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
  for(const control of [angle,play,front,...choices]) control.disabled=true;
  loading.textContent='This browser could not open the gearbox.';
  loading.hidden=false;
  document.body.dataset.state='error';
  console.error(error);
}

async function open() {
  const opening=startEngine(canvas,{exactSize:true,antialias:true,signal:stop.signal,startupTimeout:5000,
    camera:{fov,near:.095,far:72},forceCompat:location.search.includes('backend=webgl2'),
    loadCompat:()=>import('@margoengine/webgl2-compat')});
  const assemble=prepareDrive();
  const solving=openTrain(stop.signal);
  const {engine:device,renderer}=await opening;
  mechanism=await solving;
  engine=device;
  engine.onError=fail;
  engine.scene.background='#5a6a61';
  engine.lighting.direction.set([-.50,.64,.58,2.75]);
  engine.lighting.radiance.set([1,.935,.84,.25]);
  engine.lighting.ambient.set([.44,.53,.60]);
  const shadows=Shadows.attach(engine,{resolution:1024,bounds:{min:[-.60,-.079,-.53],max:[.63,.77,.57]},
    normalBias:.0019,filter:'soft',lightSize:.026});
  model=assemble(engine,shadows);
  setPlay(null);
  update();
  await engine.gpu.queue.onSubmittedWorkDone();
  if(stop.signal.aborted) return;
  connect();
  for(const control of [angle,play,front,...choices]) control.disabled=false;
  loading.hidden=true;
  document.body.dataset.renderer=renderer;
  document.body.dataset.state='ready';
  performance.mark('margo-first-usable-frame');
}

addEventListener('pagehide',(event)=>{ if(!event.persisted) dispose(); });
open().catch((error)=>{ if(!stop.signal.aborted) fail(error); });
