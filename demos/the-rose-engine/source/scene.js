import { EngineKernel } from '@margoengine/core';
import { Shadows } from '@margoengine/shadows';
import { rosettes, spindlePose } from './mechanism.js';
import { prepareRoseEngine } from './model.js';

const canvas=document.querySelector('#scene');
const turn=document.querySelector('#turn');
const angle=document.querySelector('#angle');
const detail=document.querySelector('#detail');
const run=document.querySelector('#run');
const shift=document.querySelector('#shift');
const repeat=document.querySelector('#repeat');
const pass=document.querySelector('#pass');
const loading=document.querySelector('#loading');
const choices=[...document.querySelectorAll('[data-rosette]')];
const stop=new AbortController();
const listen={signal:stop.signal};
const fov=33;
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
let engine,model,observer,frame,viewDirty=true,close=false,index=0,playing=null;
let previous=-1,previousIndex=-1;

function fit() {
  const width=Math.max(1,canvas.clientWidth),height=Math.max(1,canvas.clientHeight);
  const dpr=Math.min(1.5,Math.max(1.25,devicePixelRatio));
  const pixelWidth=Math.round(width*dpr),pixelHeight=Math.round(height*dpr);
  if(canvas.width!==pixelWidth) canvas.width=pixelWidth;
  if(canvas.height!==pixelHeight) canvas.height=pixelHeight;
  const yaw=close?.065:.436,pitch=close?.084:.34;
  const eye=[Math.sin(yaw)*Math.cos(pitch),Math.sin(pitch),Math.cos(yaw)*Math.cos(pitch)];
  const right=[Math.cos(yaw),0,-Math.sin(yaw)];
  const up=[-Math.sin(yaw)*Math.sin(pitch),Math.cos(pitch),-Math.cos(yaw)*Math.sin(pitch)];
  const target=close?[.007,.358,.177]:[.024,.198,-.022],slope=Math.tan(fov*Math.PI/360);
  const points=close
    ?[-.184,.184].flatMap((x)=>[.185,.533].map((y)=>[x,y,.192]))
    :[
      ...[-.442,.509].flatMap((x)=>[-.283,.333].map((z)=>[x,-.073,z])),
      [0,.573,-.033],[-.213,.435,-.036],[.211,.435,.190],[.388,.378,.224],[-.141,.511,-.274],
    ];
  let distance=0;
  for(const p of points) {
    const v=p.map((value,i)=>value-target[i]);
    const horizontal=Math.abs(dot(right,v))/(slope*.915*width/height);
    const vertical=Math.abs(dot(up,v))/(slope*(close?.86:.93));
    distance=Math.max(distance,dot(eye,v)+Math.max(horizontal,vertical));
  }
  engine.camera.target=target;
  engine.camera.position=target.map((value,i)=>value+eye[i]*distance);
}

function signed(value) {
  const mm=Math.round(value*10000)/10;
  return (mm<0?'−':mm>0?'+':'')+Math.abs(mm).toFixed(1)+' mm';
}

function update() {
  const degrees=Number(turn.value);
  const changed=degrees!==previous||index!==previousIndex;
  if(!viewDirty&&!changed) return;
  if(viewDirty) fit();
  const pose=changed?spindlePose(degrees,rosettes[index]):null;
  if(pose) model(pose,index,degrees);
  engine.render({delta:0});
  if(pose) {
    angle.textContent=degrees+'°';
    turn.setAttribute('aria-valuetext',degrees+' degrees');
    shift.textContent=signed(pose.shift);
    repeat.textContent=pose.period+'°';
    pass.textContent=degrees===360?'Closed':Math.round(degrees/3.6)+'%';
    document.body.dataset.angle=String(degrees);
    document.body.dataset.rosette=String(rosettes[index].lobes);
    document.body.dataset.period=String(pose.period);
    document.body.dataset.shift=pose.shift.toFixed(8);
  }
  if(viewDirty) document.body.dataset.view=close?'detail':'exhibit';
  previous=degrees;
  previousIndex=index;
  viewDirty=false;
}

function setRun(value) {
  playing=value;
  run.firstChild.textContent=value?'Pause engraving':'Run engraving pass';
  document.body.dataset.running=String(Boolean(value));
}

function tick(now) {
  frame=undefined;
  if(stop.signal.aborted) return;
  try {
    if(playing) {
      playing.start??=now;
      turn.value=String(Math.min(360,Math.floor(playing.angle+(now-playing.start)*.069)));
      if(turn.value==='360') setRun(null);
    }
    update();
  } catch(error) { fail(error); return; }
  if(playing) schedule();
}

function schedule() { frame??=requestAnimationFrame(tick); }

function connect() {
  turn.addEventListener('input',()=>{ setRun(null); schedule(); },listen);
  for(const button of choices) {
    button.addEventListener('click',()=>{
      index=Number(button.dataset.rosette);
      setRun(null);
      for(const choice of choices) choice.setAttribute('aria-pressed',String(choice===button));
      schedule();
    },listen);
  }
  run.addEventListener('click',()=>{
    if(playing) setRun(null);
    else {
      if(turn.value==='360') turn.value='0';
      setRun({angle:Number(turn.value)});
    }
    schedule();
  },listen);
  detail.addEventListener('click',()=>{
    close=!close;
    detail.setAttribute('aria-pressed',String(close));
    viewDirty=true;
    schedule();
  },listen);
  document.addEventListener('visibilitychange',()=>{ if(document.hidden) setRun(null); },listen);
  observer=new ResizeObserver(()=>{ viewDirty=true; schedule(); });
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
  for(const control of [turn,detail,run,...choices]) control.disabled=true;
  loading.textContent='This browser could not open the rose engine.';
  loading.hidden=false;
  document.body.dataset.state='error';
  console.error(error);
}

async function open() {
  const options={
    backend:'webgpu',exactSize:true,antialias:true,signal:stop.signal,
    startupTimeout:5000,camera:{fov,near:.099,far:67},
  };
  const force=new URLSearchParams(location.search).get('backend')==='webgl2';
  async function create() {
    if(!force) {
      try { return [await EngineKernel.create(canvas,options),'webgpu']; }
      catch(error) { if(error?.code!=='unsupported'&&error?.code!=='timeout') throw error; }
    }
    const {install}=await import('@margoengine/webgl2-compat');
    await install({force:true});
    return [await EngineKernel.create(canvas,options),'compatibility'];
  }
  const opening=create();
  const assemble=prepareRoseEngine();
  const [device,renderer]=await opening;
  engine=device;
  engine.onError=fail;
  engine.scene.background='#68585c';
  engine.lighting.direction.set([-.36,.78,.52,2.75]);
  engine.lighting.radiance.set([1,.95,.86,.24]);
  engine.lighting.ambient.set([.41,.50,.60]);
  const shadows=Shadows.attach(engine,{resolution:1024,bounds:{min:[-.61,-.078,-.55],max:[.64,.64,.56]},
    normalBias:.0020,filter:'soft',lightSize:.022});
  model=assemble(engine,shadows);
  setRun(null);
  update();
  await engine.gpu.queue.onSubmittedWorkDone();
  if(stop.signal.aborted) return;
  connect();
  for(const control of [turn,detail,run,...choices]) control.disabled=false;
  loading.hidden=true;
  document.body.dataset.renderer=renderer;
  document.body.dataset.state='ready';
  performance.mark('margo-first-usable-frame');
}

addEventListener('pagehide',(event)=>{ if(!event.persisted) dispose(); });
open().catch((error)=>{ if(!stop.signal.aborted) fail(error); });
