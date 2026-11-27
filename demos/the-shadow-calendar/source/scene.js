import { EngineKernel } from '@margoengine/core';
import { Shadows } from '@margoengine/shadows';
import { days, solarPosition } from './solar.js';
import { prepareCourtyard } from './dial.js';

const canvas = document.querySelector('#scene');
const clock = document.querySelector('#clock');
const clockValue = document.querySelector('#clock-value');
const overhead = document.querySelector('#overhead');
const sweep = document.querySelector('#sweep');
const elevation = document.querySelector('#elevation');
const reach = document.querySelector('#reach');
const loading = document.querySelector('#loading');
const choices = [...document.querySelectorAll('[data-season]')];
const stop = new AbortController();
const listener = {signal:stop.signal};
const fov = 34, deckCenterY = .35;
const radius = [4.35,1.28,3.99];
const dot = (a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
let engine,courtyard,resize,frame,layoutDirty=true;
let season=1,plan=false,playStart=null,lastMinute=null;

function fit() {
  const width = Math.max(1,canvas.clientWidth), height = Math.max(1,canvas.clientHeight);
  const dpr = Math.min(1.5,Math.max(1.25,devicePixelRatio));
  const pixels = [Math.round(width*dpr),Math.round(height*dpr)];
  if(canvas.width!==pixels[0]) canvas.width=pixels[0];
  if(canvas.height!==pixels[1]) canvas.height=pixels[1];
  const slope=Math.tan(fov*Math.PI/360);
  if(plan) {
    const scale=Math.min(1,width/height);
    engine.camera.target = [0,deckCenterY,-.19];
    // A one-centimetre south offset fixes the view-up reference at the pole.
    engine.camera.position = [0,(2.82/scale+.25)/slope+deckCenterY, -.18];
    return;
  }
  const yaw=.36,pitch=.69;
  const eye=[Math.sin(yaw)*Math.cos(pitch),Math.sin(pitch),Math.cos(yaw)*Math.cos(pitch)];
  const right=[Math.cos(yaw),0,-Math.sin(yaw)];
  const up=[-Math.sin(yaw)*Math.sin(pitch),Math.cos(pitch),-Math.cos(yaw)*Math.sin(pitch)];
  const target=[0,.10,-.16];
  let distance=0;
  for(const x of [-radius[0],radius[0]]) for(const z of [-radius[2],3.32]) {
    for(const y of [-.55,z<0?radius[1]:.19]) {
      const p=[x-target[0],y-target[1],z-target[2]];
      distance=Math.max(distance,dot(eye,p)+Math.max(Math.abs(dot(p,right))/(slope*.94*width/height),Math.abs(dot(p,up))/(slope*.89)));
    }
  }
  engine.camera.target=target;
  engine.camera.position=target.map((value,i)=>value+eye[i]*distance);
}

function updateSun() {
  const minute=Number(clock.value);
  if (minute===lastMinute && season===Number(document.body.dataset.season)) return false;
  const solar=solarPosition(days[season].ordinal,minute);
  const height=Math.max(0,solar.direction[1]);
  const light=Math.min(1,height/.58);
  engine.lighting.direction.set([...solar.direction, height>0 ? 1.5+light*1.25 : 0]);
  engine.lighting.radiance.set([1,.72+.20*light,.49+.31*light,.18]);
  engine.lighting.ambient.set([.23,.27,.34]);
  const leading=(n)=>String(n).padStart(2,'0');
  clockValue.textContent=leading(Math.floor(minute/60))+':'+leading(minute%60);
  elevation.textContent=solar.elevation.toFixed(1)+'°';
  reach.textContent=solar.shadow ? Math.hypot(...solar.shadow).toFixed(2)+' m' : 'Below horizon';
  reach.title='Horizontal distance from the style foot to the projected tip.';
  document.body.dataset.minute=String(minute);
  document.body.dataset.season=String(season);
  document.body.dataset.tip=solar.shadow ? solar.shadow.map((v)=>v.toFixed(4)).join(',') : '';
  lastMinute=minute;
  return true;
}

function setPlaying(value) {
  sweep.setAttribute('aria-pressed',String(value));
  sweep.textContent=value?'Pause the day':'Play the day';
  if(!value) playStart=null;
}

function draw(now) {
  frame=undefined;
  if(stop.signal.aborted) return;
  try {
    if(playStart!==null) {
      if(playStart===0) playStart=now;
      clock.value=String(480+Math.min(480,Math.floor((now-playStart)/125)*5));
      if (clock.value==='960') setPlaying(false);
    }
    const solarChanged=updateSun();
    if(layoutDirty) fit();
    if(layoutDirty || solarChanged) engine.render({delta:0});
    layoutDirty=false;
  } catch(error) { fail(error); }
  if(playStart!==null) schedule();
}

function schedule() { frame??=requestAnimationFrame(draw); }

function connect() {
  clock.addEventListener('input',()=>{ setPlaying(false); schedule(); },listener);
  overhead.addEventListener('click',()=>{
    plan=!plan;
    overhead.setAttribute('aria-pressed',String(plan));
    overhead.textContent=plan?'Courtyard view':'Overhead view';
    document.body.dataset.view=plan?'overhead':'courtyard';
    layoutDirty=true;
    schedule();
  },listener);
  sweep.addEventListener('click',()=>{
    if(playStart!==null) setPlaying(false);
    else { playStart=0; setPlaying(true); schedule(); }
  },listener);
  choices.forEach((button,i)=>button.addEventListener('click',()=>{
    season=i;
    choices.forEach((choice,j)=>choice.setAttribute('aria-pressed',String(i===j)));
    schedule();
  },listener));
  document.addEventListener('visibilitychange',()=>{ if(document.hidden) setPlaying(false); },listener);
  resize=new ResizeObserver(()=>{ layoutDirty=true; schedule(); });
  resize.observe(canvas);
}

function dispose() {
  stop.abort();
  if(frame!==undefined) cancelAnimationFrame(frame);
  resize?.disconnect();
  courtyard?.dispose();
  engine?.dispose();
}

function fail(error) {
  dispose();
  document.body.dataset.state='error';
  loading.textContent='This browser could not open the sundial.';
  loading.hidden=false;
  console.error(error);
}

async function open() {
  const options={backend:'webgpu',exactSize:true,antialias:false,signal:stop.signal,startupTimeout:5000,camera:{fov,near:.5,far:95}};
  const force=new URLSearchParams(location.search).get('backend')==='webgl2';
  const create=async()=>{
    if(!force) {
      try { return [await EngineKernel.create(canvas,options),'webgpu']; }
      catch(error) { if(error?.code!=='unsupported' && error?.code!=='timeout') throw error; }
    }
    const {install}=await import('@margoengine/webgl2-compat');
    await install({force:true});
    return [await EngineKernel.create(canvas,options),'compatibility'];
  };
  const opening=create();
  const assemble=prepareCourtyard();
  const [device,renderer]=await opening;
  engine=device;
  document.body.dataset.renderer=renderer;
  engine.scene.background='#37362e';
  engine.onError=fail;
  const shadows=Shadows.attach(engine,{resolution:1024,bounds:{min:[-5,-.64,-5],max:[5,2.3,5]},normalBias:.019,filter:'pcf'});
  courtyard=assemble(engine,shadows);
  updateSun();
  fit();
  engine.render({delta:0});
  await engine.gpu.queue.onSubmittedWorkDone();
  if(stop.signal.aborted) return;
  connect();
  for(const control of [clock,overhead,sweep,...choices]) control.disabled=false;
  loading.hidden=true;
  document.body.dataset.view='courtyard';
  document.body.dataset.state='ready';
  performance.mark('margo-first-usable-frame');
}

addEventListener('pagehide',(event)=>{ if(!event.persisted) dispose(); });
open().catch((error)=>{ if(!stop.signal.aborted) fail(error); });
