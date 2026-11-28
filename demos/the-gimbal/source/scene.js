import { startEngine } from '@margoengine/webgl2-compat/auto';
import { Shadows } from '@margoengine/shadows';
import { describeCheck } from '@margoengine/machinery/rigs';
import { gimbalPose, openGimbal } from './mechanism.js';
import { prepareGimbal } from './model.js';

const canvas=document.querySelector('#scene');
const angle=document.querySelector('#angle');
const tilt=document.querySelector('#tilt-value');
const guide=document.querySelector('#guide');
const drift=document.querySelector('#drift');
const outer=document.querySelector('#outer');
const inner=document.querySelector('#inner');
const gap=document.querySelector('#check');
const explanation=document.querySelector('#explanation');
const loading=document.querySelector('#loading');
const modes=[...document.querySelectorAll('[data-mode]')];
const controls=[angle,guide,...modes];
const reducedMotion=matchMedia('(prefers-reduced-motion: reduce)');
const stop=new AbortController();
const listen={signal:stop.signal};
const fov=34;
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const degrees=(value,precision)=>(Number(value.toFixed(precision))||0).toFixed(precision).replace('-','−')+'°';

let engine, model, gimbal, observer, frame;
let fitDirty=true, poseDirty=true, guidesDirty=false, locked=false, guides=true;
let lastSpin=0, spin=.19;

function fit() {
  const width=Math.max(1,canvas.clientWidth);
  const height=Math.max(1,canvas.clientHeight);
  const dpr=Math.min(1.5,Math.max(1.25,devicePixelRatio));
  const pixels=[Math.round(width*dpr),Math.round(height*dpr)];
  if(canvas.width!==pixels[0]) canvas.width=pixels[0];
  if(canvas.height!==pixels[1]) canvas.height=pixels[1];

  const yaw=.44,pitch=.32;
  const eye=[Math.sin(yaw)*Math.cos(pitch),Math.sin(pitch),Math.cos(yaw)*Math.cos(pitch)];
  const right=[Math.cos(yaw),0,-Math.sin(yaw)];
  const up=[-Math.sin(yaw)*Math.sin(pitch),Math.cos(pitch),-Math.cos(yaw)*Math.sin(pitch)];
  const target=[0,.251,.013];
  const slope=Math.tan(fov*Math.PI/360);
  const framing=[
    ...[-.417,.417].flatMap((x)=>[-.306,.325].map((z)=>[x,-.06,z])),
    [-.30,.34,0],[.30,.34,0],[0,.626,0],[0,.569,-.13],
    [0,.410,.418],[-.05,.349,.415],[.245,.580,-.16],[.18,.60,.13],
  ];
  let distance=0;
  for(const vertex of framing) {
    const p=vertex.map((value,i)=>value-target[i]);
    const across=Math.abs(dot(right,p))/(slope*.94*width/height);
    const above=Math.abs(dot(up,p))/(slope*.93);
    distance=Math.max(distance,dot(eye,p)+Math.max(across,above));
  }
  engine.camera.target=target;
  engine.camera.position=target.map((value,i)=>value+eye[i]*distance);
}

function report(pose,value) {
  const mountAngle=(value>0?'+':'')+degrees(value,0);
  tilt.textContent=mountAngle;
  angle.setAttribute('aria-valuetext',mountAngle);
  drift.textContent=degrees(pose.deviation,1);
  outer.textContent=degrees(pose.outer*180/Math.PI,1);
  inner.textContent=degrees(pose.inner*180/Math.PI,1);
  document.body.dataset.angle=String(value);
  document.body.dataset.mode=locked?'locked':'free';
  document.body.dataset.drift=pose.deviation.toFixed(5);
  document.body.dataset.axis=pose.axis.map((component)=>component.toFixed(6)).join(',');
  document.body.dataset.check=gap.textContent=describeCheck(gimbal.check);
}

function render(now) {
  const animate=!reducedMotion.matches&&!document.hidden;
  const spinDirty=animate&&now-lastSpin>=1000/30;
  if(spinDirty) {
    const elapsed=lastSpin===0?0:Math.min(60,now-lastSpin);
    spin=(spin+elapsed*.0078)%(Math.PI*2);
    lastSpin=now;
    model.spin(spin);
  }
  if(fitDirty) fit();
  const value=Number(angle.value);
  const pose=poseDirty?gimbalPose(gimbal,value,locked):null;
  if(pose) model.pose(pose);
  if(guidesDirty) model.showGuides(guides);
  if(fitDirty||poseDirty||guidesDirty||spinDirty) engine.render({delta:0});
  if(pose) report(pose,value);
  if(guidesDirty||document.body.dataset.guides===undefined) document.body.dataset.guides=String(guides);
  fitDirty=poseDirty=guidesDirty=false;
}

function tick(now) {
  frame=undefined;
  if(stop.signal.aborted) return;
  try { render(now); }
  catch(error) { fail(error); return; }
  if(!document.hidden&&!reducedMotion.matches) schedule();
}

function schedule() { frame??=requestAnimationFrame(tick); }

function connect() {
  angle.addEventListener('input',()=>{ poseDirty=true; schedule(); },listen);
  guide.addEventListener('click',()=>{
    guides=!guides;
    guidesDirty=true;
    guide.setAttribute('aria-pressed',String(guides));
    schedule();
  },listen);
  for(const mode of modes) {
    mode.addEventListener('click',()=>{
      locked=mode.dataset.mode==='locked';
      for(const choice of modes) choice.setAttribute('aria-pressed',String(choice===mode));
      explanation.textContent=locked
        ?'Both pivots are clamped at their neutral setting. The rotor tilts with the mount.'
        :'The rings move around the rotor. Its axis stays on target.';
      poseDirty=true;
      schedule();
    },listen);
  }
  reducedMotion.addEventListener('change',()=>{ lastSpin=0; schedule(); },listen);
  document.addEventListener('visibilitychange',()=>{
    lastSpin=0;
    if(!document.hidden) schedule();
  },listen);
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
  controls.forEach((control)=>{ control.disabled=true; });
  loading.textContent='This browser could not open the gyroscope.';
  loading.hidden=false;
  document.body.dataset.state='error';
  console.error(error);
}

async function open() {
  const opening=startEngine(canvas,{exactSize:true,antialias:true,signal:stop.signal,
    startupTimeout:5000,camera:{fov,near:.07,far:70},forceCompat:location.search.includes('backend=webgl2'),
    loadCompat:()=>import('@margoengine/webgl2-compat')});
  // Start adapter negotiation before constructing the offline geometric batches.
  const assemble=prepareGimbal();
  const solving=openGimbal(stop.signal);
  const {engine:device,renderer}=await opening;
  gimbal=await solving;
  engine=device;
  engine.onError=fail;
  engine.scene.background='#28353a';
  engine.lighting.direction.set([-.32,.54,.78,2.65]);
  engine.lighting.radiance.set([1,.91,.81,.17]);
  engine.lighting.ambient.set([.36,.49,.61]);
  const shadows=Shadows.attach(engine,{
    resolution:1024,
    bounds:{min:[-.62,-.07,-.62],max:[.58,.675,.60]},
    normalBias:.0028,filter:'soft',lightSize:.024,
  });
  model=assemble(engine,shadows);
  model.spin(spin);
  render(performance.now());
  await engine.gpu.queue.onSubmittedWorkDone();
  if(stop.signal.aborted) return;
  connect();
  controls.forEach((control)=>{ control.disabled=false; });
  document.body.dataset.renderer=renderer;
  document.body.dataset.state='ready';
  loading.hidden=true;
  performance.mark('margo-first-usable-frame');
  schedule();
}

addEventListener('pagehide',(event)=>{ if(!event.persisted) dispose(); });
open().catch((error)=>{ if(!stop.signal.aborted) fail(error); });
