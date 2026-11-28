import { startEngine } from '@margoengine/webgl2-compat/auto';
import { Shadows } from '@margoengine/shadows';
import { describeCheck } from '@margoengine/machinery/rigs';
import { openPress, pressPose } from './mechanism.js';
import { preparePress } from './model.js';

const canvas=document.querySelector('#scene');
const travel=document.querySelector('#travel');
const input=document.querySelector('#input');
const descent=document.querySelector('#descent');
const advantage=document.querySelector('#advantage');
const angle=document.querySelector('#angle');
const play=document.querySelector('#play');
const gap=document.querySelector('#check');
const loading=document.querySelector('#loading');
const stop=new AbortController();
const listen={signal:stop.signal};
const fov=34;
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
let engine,model,press,observer,frame,fitDirty=true,previous=-1,playing=null;

function fit() {
  const width=Math.max(1,canvas.clientWidth),height=Math.max(1,canvas.clientHeight);
  const dpr=Math.min(1.5,Math.max(1.25,devicePixelRatio));
  const pixelWidth=Math.round(width*dpr),pixelHeight=Math.round(height*dpr);
  if(canvas.width!==pixelWidth) canvas.width=pixelWidth;
  if(canvas.height!==pixelHeight) canvas.height=pixelHeight;

  const yaw=.385,pitch=.30;
  const eye=[Math.sin(yaw)*Math.cos(pitch),Math.sin(pitch),Math.cos(yaw)*Math.cos(pitch)];
  const right=[Math.cos(yaw),0,-Math.sin(yaw)];
  const up=[-Math.sin(yaw)*Math.sin(pitch),Math.cos(pitch),-Math.cos(yaw)*Math.sin(pitch)];
  const target=[.056,.340,.086],slope=Math.tan(fov*Math.PI/360);
  const vertices=[
    ...[-.523,.620].flatMap((x)=>[-.219,.353].map((z)=>[x,-.077,z])),
    [-.205,.833,.161],[.134,.846,.174],[.294,.73,.292],[.692,.608,.195],[-.393,.401,.109],
  ];
  let distance=0;
  for(const point of vertices) {
    const v=point.map((value,i)=>value-target[i]);
    const across=Math.abs(dot(right,v))/(slope*.90*width/height);
    const above=Math.abs(dot(up,v))/(slope*.87);
    distance=Math.max(distance,dot(eye,v)+Math.max(across,above));
  }
  engine.camera.target=target;
  engine.camera.position=target.map((value,i)=>value+eye[i]*distance);
}

function update() {
  const value=Number(travel.value);
  if(!fitDirty&&value===previous) return;
  if(fitDirty) fit();
  const pose=value===previous?null:pressPose(press,value/1000);
  if(pose) model(pose);
  engine.render({delta:0});
  if(pose) {
    input.textContent=(pose.input*1000).toFixed(1)+' mm';
    travel.setAttribute('aria-valuetext',input.textContent);
    descent.textContent=(pose.descent*1000).toFixed(1)+' mm';
    advantage.textContent=pose.advantage.toFixed(2)+' : 1';
    angle.textContent=pose.angle.toFixed(1)+'°';
    document.body.dataset.progress=String(value);
    document.body.dataset.gain=pose.advantage.toFixed(6);
    document.body.dataset.ram=(pose.descent*1000).toFixed(6);
    document.body.dataset.check=gap.textContent=describeCheck(press.check);
  }
  previous=value;
  fitDirty=false;
}

function setPlay(value) {
  playing=value;
  play.firstChild.textContent=value?'Pause stroke':'Play closing stroke';
  document.body.dataset.running=String(Boolean(value));
}

function tick(now) {
  frame=undefined;
  if(stop.signal.aborted) return;
  try {
    if(playing) {
      playing.started??=now;
      travel.value=String(Math.min(1000,Math.floor(playing.from+(now-playing.started)*.28)));
      if(travel.value==='1000') setPlay(null);
    }
    update();
  } catch(error) { fail(error); return; }
  if(playing) schedule();
}

function schedule() { frame??=requestAnimationFrame(tick); }

function connect() {
  travel.addEventListener('input',()=>{ setPlay(null); schedule(); },listen);
  play.addEventListener('click',()=>{
    if(playing) setPlay(null);
    else {
      if(travel.value==='1000') travel.value='0';
      setPlay({from:Number(travel.value)});
    }
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
  travel.disabled=play.disabled=true;
  loading.textContent='This browser could not open the toggle press.';
  loading.hidden=false;
  document.body.dataset.state='error';
  console.error(error);
}

async function open() {
  const opening=startEngine(canvas,{exactSize:true,antialias:true,signal:stop.signal,
    startupTimeout:5000,camera:{fov,near:.105,far:62},forceCompat:location.search.includes('backend=webgl2'),
    loadCompat:()=>import('@margoengine/webgl2-compat')});
  const assemble=preparePress();
  const solving=openPress(Number(travel.value)/1000,stop.signal);
  const {engine:device,renderer}=await opening;
  press=await solving;
  engine=device;
  engine.onError=fail;
  engine.scene.background='#7f7461';
  engine.lighting.direction.set([-.39,.78,.49,2.65]);
  engine.lighting.radiance.set([1,.94,.86,.23]);
  engine.lighting.ambient.set([.40,.47,.56]);
  const shadows=Shadows.attach(engine,{resolution:1024,bounds:{min:[-.70,-.092,-.57],max:[.80,.89,.68]},
    normalBias:.0020,filter:'soft',lightSize:.027});
  model=assemble(engine,shadows);
  setPlay(null);
  update();
  await engine.gpu.queue.onSubmittedWorkDone();
  if(stop.signal.aborted) return;
  connect();
  travel.disabled=play.disabled=false;
  loading.hidden=true;
  document.body.dataset.renderer=renderer;
  document.body.dataset.state='ready';
  performance.mark('margo-first-usable-frame');
}

addEventListener('pagehide',(event)=>{ if(!event.persisted) dispose(); });
open().catch((error)=>{ if(!stop.signal.aborted) fail(error); });
