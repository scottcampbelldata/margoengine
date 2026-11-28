import { OrbitControls } from '@margoengine/controls';
import { Bloom } from '@margoengine/post/bloom';
import { PostStack } from '@margoengine/post/stack';
import { applyQualityTier } from '@margoengine/quality';
import { BlackHole, kerrHorizon, kerrIsco } from '@margoengine/shader/black-hole';
import { Tonemap } from '@margoengine/tonemap';
import { autoEngine } from '@margoengine/webgl2-compat/auto';
import { demoStatus } from 'margo-demo-status';

const exhibit=document.querySelector('#exhibit');
const notice=document.querySelector('#status');
const status=demoStatus(exhibit,notice);
const brightness=document.querySelector('#brightness');
const radius=document.querySelector('#radius');
const brightnessLabel=document.querySelector('#brightness-label');
const radiusLabel=document.querySelector('#radius-label');
const elevation=document.querySelector('#elevation');
const horizon=document.querySelector('#horizon');
const stable=document.querySelector('#isco');
const edge=document.querySelector('#edge');
const above=document.querySelector('#above');
const controls=[brightness,radius,edge,above];
const reduced=matchMedia('(prefers-reduced-motion: reduce)');
const lifetime=new AbortController();
const {signal}=lifetime;
const listeners={signal};
const quality=applyQualityTier();
const forced=new URLSearchParams(location.search).get('backend')==='webgl2';
const origin=[0,0,0];
const spin=.9;
let canvas=document.querySelector('#sky');
let engine,hole,orbit,observer,frame,last;
let dirty=true,diskEdited=false,time=3,renderedTime=time;
let compatibility=false;
let previousDistance=-1,previousElevation=-90;

function resize() {
  const maxDensity=quality==='high'?1.25:1.05;
  const density=Math.min(devicePixelRatio,maxDensity);
  const width=Math.max(1,Math.round(canvas.clientWidth*density));
  const height=Math.max(1,Math.round(canvas.clientHeight*density));
  if(canvas.width!==width) canvas.width=width;
  if(canvas.height!==height) canvas.height=height;
  if(engine) {
    const slope=Math.tan(40*Math.PI/360)*Math.max(1,1.42*height/width);
    engine.camera.fov=Math.min(62,Math.atan(slope)*360/Math.PI);
  }
  dirty=true;
}

function telemetry() {
  const [x,y,z]=engine.camera.position;
  const distance=Math.hypot(x,y,z);
  const pitch=Math.asin(y/distance)*180/Math.PI;
  if(Math.abs(distance-previousDistance)>.035) {
    radius.value=distance.toFixed(1);
    radiusLabel.textContent=distance.toFixed(1)+' M';
    radius.setAttribute('aria-valuetext',radiusLabel.textContent);
    previousDistance=distance;
    exhibit.dataset.distance=distance.toFixed(3);
  }
  if(Math.abs(pitch-previousElevation)>.12) {
    elevation.textContent=pitch.toFixed(1)+'°';
    previousElevation=pitch;
    exhibit.dataset.elevation=pitch.toFixed(3);
  }
}

function aim(pitch,bearing=0,minimumDistance=0) {
  const distance=Math.max(minimumDistance,Math.hypot(...engine.camera.position));
  const angle=pitch*Math.PI/180;
  const y=Math.sin(angle)*distance;
  const planar=Math.cos(angle)*distance;
  engine.camera.position=[Math.sin(bearing)*planar,y,Math.cos(bearing)*planar];
  dirty=true;
}

function schedule() {
  if(frame===undefined&&!signal.aborted) frame=requestAnimationFrame(tick);
}

function tick(now) {
  frame=undefined;
  const dt=last===undefined?0:Math.min(.065,Math.max(0,(now-last)/1000));
  last=now;
  try {
    time+=reduced.matches?0:dt;
    const moved=orbit.update(dt);
    if(dirty||moved||time-renderedTime>=1/32) {
      hole.diskTime=time;
      engine.render({delta:dt});
      renderedTime=time;
      telemetry();
      dirty=false;
      if(diskEdited&&exhibit.dataset.ready) {
        performance.mark('margo-disk-brightness-applied');
        exhibit.dataset.brightness=brightness.value;
        diskEdited=false;
      }
    }
    schedule();
  } catch(error) { fail(error); }
}

function dispose() {
  lifetime.abort();
  observer?.disconnect();
  orbit?.dispose();
  if(frame!==undefined) cancelAnimationFrame(frame);
  engine?.dispose();
}

function fail(error) {
  if(signal.aborted) return;
  notice.hidden=false;
  for(const control of controls) control.disabled=true;
  status.error(error);
  if(error?.code!=='unsupported') console.error(error);
  dispose();
}

async function open() {
  resize();
  engine=await autoEngine(canvas, ready=>{
    PostStack.attach(ready,[
      new Bloom({strength:.17,threshold:1.05}),
      new Tonemap({curve:'agx',exposure:.15,contrast:1.055}),
    ]);
    hole=BlackHole.attach(ready,{spin,accretion:1,jet:.16,turbulence:.5,peakTemperature:4700,
      galaxy:1.22,stars:1.05,diskOuter:6.0,steps:260,diskTime:time});
  },{
    ...(forced?{backend:'webgl2'}:{}),exactSize:true,antialias:false,signal,startupTimeout:8500,
    camera:{position:[.58,1.58,13.496],target:origin,near:.05,far:1500,fov:40},
    loadCompat:async()=>{
      const {install}=await import('@margoengine/webgl2-compat');
      compatibility=true;
      status.pending('Preparing the WebGL2 ray tracer…');
      return {install:()=>install({force:forced,signal})};
    },
  });
  canvas=engine.canvas;
  engine.onError=fail;
  resize();
  orbit=new OrbitControls(engine.camera,canvas);
  orbit.enablePan=false;
  orbit.enableDamping=!reduced.matches;
  orbit.dampingFactor=.17;
  orbit.minDistance=Number(radius.min);
  orbit.maxDistance=Number(radius.max);
  orbit.minPolarAngle=.06;
  orbit.maxPolarAngle=Math.PI-.06;
  orbit.addEventListener('change',()=>{dirty=true;});
  canvas.addEventListener('keydown',event=>{
    const amount=Math.PI/60;
    switch(event.key) {
      case 'ArrowUp': orbit.rotateUp(amount); break;
      case 'ArrowDown': orbit.rotateUp(-amount); break;
      case 'ArrowLeft': orbit.rotateLeft(amount); break;
      case 'ArrowRight': orbit.rotateLeft(-amount); break;
      default: return;
    }
    event.preventDefault();
    dirty=true;
  },listeners);
  reduced.addEventListener('change',()=>{orbit.enableDamping=!reduced.matches;dirty=true;},listeners);
  radius.addEventListener('input',()=>{
    const p=engine.camera.position,norm=Math.hypot(...p),distance=Number(radius.value);
    engine.camera.position=p.map(x=>distance*x/norm);
    dirty=true;
  },listeners);
  brightness.addEventListener('input',()=>{
    hole.accretion=Number(brightness.value);
    brightnessLabel.textContent=hole.accretion.toFixed(2)+'×';
    brightness.setAttribute('aria-valuetext',brightnessLabel.textContent);
    dirty=true;
    diskEdited=true;
  },listeners);
  for(const [button,pitch,minimum] of [[edge,3.2,0],[above,61,19.5]]) button.addEventListener('click',()=>{
    const [x,,z]=engine.camera.position;
    aim(pitch,Math.atan2(x,z),minimum);
  },listeners);
  horizon.textContent=kerrHorizon(spin).toFixed(2)+' M';
  stable.textContent=kerrIsco(spin).toFixed(2)+' M';
  observer=new ResizeObserver(resize);
  observer.observe(canvas);
  addEventListener('pagehide',event=>{if(!event.persisted) dispose();},listeners);

  const deadline=performance.now()+(compatibility?48000:9500);
  do {
    signal.throwIfAborted();
    engine.render({delta:0});
    await new Promise(requestAnimationFrame);
    if(performance.now()>deadline) throw new Error('The first ray-traced frame timed out.');
  } while(hole.raw.stats.drawCalls<1||hole.raw.stats.pending>0);
  await engine.gpu.queue.onSubmittedWorkDone();
  if(signal.aborted) return;
  telemetry();
  exhibit.dataset.brightness=brightness.value;
  for(const control of controls) control.disabled=false;
  if(status.ready()) notice.hidden=true;
  performance.mark('margo-first-usable-frame');
  schedule();
}

open().catch(fail);
