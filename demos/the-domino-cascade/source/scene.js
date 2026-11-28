import { Cinematic } from '@margoengine/cinematic';
import { Physics } from '@margoengine/physics';
import { applyQualityTier } from '@margoengine/quality';
import { Shadows } from '@margoengine/shadows';
import { autoEngine } from '@margoengine/webgl2-compat/auto';
import { demoStatus } from 'margo-demo-status';
import { buildGallery } from './gallery.js';
import { count, layout, length, pitch, sample, zones } from './route.js';
import { populate, reset, track, trigger } from './world.js';

let canvas=document.querySelector('#scene');
const loader=document.querySelector('#status');
const error=document.querySelector('#error');
const message=document.querySelector('#message');
const help=document.querySelector('#help');
const start=document.querySelector('#start');
const restart=document.querySelector('#reset');
const view=document.querySelector('#view');
const speed=document.querySelector('#speed');
const tipped=document.querySelector('#tipped');
const velocity=document.querySelector('#velocity');
const section=document.querySelector('#section');
const runStatus=document.querySelector('#run-status');
const controls=[start,restart,view,speed];
const controller=new AbortController();
const reduced=matchMedia('(prefers-reduced-motion: reduce)');
const forceCompatibility=new URLSearchParams(location.search).get('backend')==='webgl2';
const formatter=new Intl.NumberFormat('en-US');
const cameraOptions={damping:12.5,lookDamping:13.5};
let status=demoStatus(canvas,loader,message);
let engine,physics,scene,bodies,wave,rig,observer,frame,startupError;
let mode='ready',cameraMode='overview',last=0,elapsed=0,endAt=0,cameraUntil=0;
let data={leading:-1,total:0,speed:0,since:0};
let interacted=false,insideRender=false,resetRequested=false;
let fov=48;

function size(target) {
  const width=Math.max(1,Math.round(target.clientWidth*1.5));
  const height=Math.max(1,Math.round(target.clientHeight*1.5));
  if(width===target.width && height===target.height)return false;
  target.width=width;
  target.height=height;
  return true;
}

function pose() {
  const ratio=canvas.width/canvas.height;
  if(cameraMode==='overview'){
    const spread=Math.max(1,1.23/ratio);
    const aim=[1.22,.10,.43];
    return {aim,offset:[4.2*spread,13.30*spread,15.2*spread],fov:Math.min(51,Math.max(41,49-(ratio-1)*4.0))};
  }
  const progress=Math.max(0,data.leading)*pitch;
  const foot=sample(progress);
  const look=sample(Math.min(length,progress+.30));
  const x=Math.sin(foot.yaw),z=Math.cos(foot.yaw);
  const spread=Math.max(1,1.05/ratio);
  return {aim:[look.x,look.y+.08,look.z],offset:[(-.72*x+.53*z)*spread,.49*spread,(-.72*z-.53*x)*spread],fov:52};
}

function place(target,delta) {
  const shot=pose();
  rig.offset.set(shot.offset);
  rig.follow(shot.aim);
  rig.update(delta);
  const jump=delta===0||reduced.matches;
  const blend=jump?1:1-Math.exp(-8*delta);
  fov+=(shot.fov-fov)*blend;
  target.camera.fov=fov;
  target.camera.position=jump?shot.aim.map((c,i)=>c+shot.offset[i]):Array.from(rig.cameraPosition);
  target.camera.target=jump?shot.aim:Array.from(rig.cameraTarget);
}

function label() {
  const active=mode==='running';
  tipped.value=formatter.format(data.total)+' / '+formatter.format(count);
  velocity.value=active&&data.speed>0 ? data.speed.toFixed(2)+' m/s' : '—';
  const selected=layout[Math.max(0,data.leading)];
  section.value=mode==='complete'?'Finished':zones[selected.zone];
  view.textContent=cameraMode==='follow'?'Show overview':'Follow wave';
  view.setAttribute('aria-pressed',String(cameraMode==='follow'));
  start.textContent=mode==='ready'?'Tip the first domino':mode==='running'?'Pause':
    mode==='paused'?'Resume':'Run again';
  restart.disabled=!engine||mode==='ready';
  Object.assign(canvas.dataset,{
    mode, view:cameraMode, total:data.total, leading:data.leading,
    simulation:elapsed.toFixed(4), zone:selected.zone, velocity:data.speed.toFixed(6),
  });
}

function resetAll() {
  physics.paused=true;
  reset(bodies);
  wave.reset();
  data=wave.observe(0);
  elapsed=0;
  endAt=0;
  mode='ready';
  cameraMode='overview';
  rig=new Cinematic(cameraOptions);
  last=0;
  runStatus.textContent='The dominoes are reset.';
}

function afterStep(dt) {
  if(mode!=='running')return;
  elapsed+=dt;
  data=wave.observe(elapsed);
  if(data.total===count){
    endAt ||= elapsed;
    if(elapsed-endAt>.70){
      mode='complete';
      physics.paused=true;
      runStatus.textContent='All 2,000 dominoes toppled.';
    }
  }else if(elapsed-data.since>4.2){
    mode='stalled';
    physics.paused=true;
    runStatus.textContent='The wave stopped. Reset to run the cascade again.';
  }
}

function schedule(){if(frame===undefined)frame=requestAnimationFrame(draw);}
function draw(now) {
  frame=undefined;
  if(controller.signal.aborted)return;
  const delta=Math.min(.065,Math.max(0,last?(now-last)/1000:1/60));
  last=now;
  try{
    if(resetRequested){resetRequested=false;resetAll();place(engine,0);}
    place(engine,delta);
    insideRender=true;
    engine.render({delta});
    insideRender=false;
    label();
    if(interacted && data.total>0 && !performance.getEntriesByName('domino-trigger-applied').length){
      interacted=false;
      engine.gpu.queue.onSubmittedWorkDone().then(()=>{
        if(!controller.signal.aborted)performance.mark('domino-trigger-applied');
      }).catch(fail);
    }
    if(mode==='running'||now<cameraUntil)schedule();
  }catch(reason){insideRender=false;fail(reason);}
}

function toggle() {
  if(mode==='running'){
    physics.paused=true;
    mode='paused';
    runStatus.textContent='Cascade paused.';
  }else if(mode==='paused'){
    mode='running';
    physics.paused=false;
    last=0;
  }else{
    if(mode!=='ready')resetAll();
    trigger(bodies);
    mode='running';
    physics.paused=false;
    interacted=true;
    last=0;
    if(!reduced.matches)cameraMode='follow';
    runStatus.textContent='The first domino is falling.';
  }
  schedule();
}

function dispose() {
  if(controller.signal.aborted)return;
  controller.abort();
  observer?.disconnect();
  if(frame!==undefined)cancelAnimationFrame(frame);
  engine?.dispose();
}
function fail(reason) {
  if(controller.signal.aborted)return;
  canvas=engine?.canvas??document.querySelector('#scene');
  status=demoStatus(canvas,loader,message);
  status.error(reason);
  loader.hidden=true;
  error.hidden=false;
  help.hidden=reason?.code!=='unsupported';
  for(const control of controls)control.disabled=true;
  if(reason?.code!=='unsupported')console.error(reason);
  if(insideRender)queueMicrotask(dispose);else dispose();
}

async function open() {
  size(canvas);
  applyQualityTier();
  const kernel=Physics.load();
  engine=await autoEngine(canvas,async target=>{
    const shadows=Shadows.attach(target,{
      filter:'soft',resolution:1024,lightSize:.029,blockerSamples:12,samples:24,normalBias:.0010,jitter:false,
      cascades:3,distance:30,bounds:{min:[-9,-.64,-6.1],max:[11.3,3.1,6.1]},
    });
    canvas=target.canvas;
    target.onError=reason=>{startupError ??= reason;};
    target.scene.background='#405c5a';
    target.lighting.direction.set([-.54,1.12,.69,3.7]);
    target.lighting.radiance.set([1,.91,.77,.52]);
    target.lighting.ambient.set([.65,.83,1.0]);
    scene=buildGallery(target,shadows);
    await kernel;
    physics=new Physics(target,{fidelity:'standard',paused:true,maxSubsteps:14});
    bodies=populate(physics,scene.tileAt);
    wave=track(bodies);
    physics.on('afterstep',afterStep);
    rig=new Cinematic(cameraOptions);
    place(target,0);
    target.render({delta:0});
    await target.gpu.queue.onSubmittedWorkDone();
    if(startupError)throw startupError;
  },{
    backend:forceCompatibility?'webgl2':'auto',exactSize:true,antialias:true,capacity:2200,
    startupTimeout:10000,signal:controller.signal,
    camera:{fov:47,near:.038,far:65},
    loadCompat:async()=>{
      const compatibility=await import('@margoengine/webgl2-compat');
      return {install:()=>compatibility.install({force:forceCompatibility,signal:controller.signal})};
    },
  });
  if(controller.signal.aborted)return;
  engine.onError=fail;
  status=demoStatus(canvas,loader,message);
  document.querySelector('#route-length').textContent=length.toFixed(1)+' m course · '+count.toLocaleString('en-US')+' rigid bodies';
  const opts={signal:controller.signal};
  start.addEventListener('click',toggle,opts);
  restart.addEventListener('click',()=>{resetRequested=true;schedule();},opts);
  view.addEventListener('click',()=>{cameraMode=cameraMode==='overview'?'follow':'overview';last=0;cameraUntil=performance.now()+650;schedule();},opts);
  speed.addEventListener('change',()=>{physics.timeScale=Number(speed.value);},opts);
  addEventListener('pagehide',event=>{if(!event.persisted)dispose();},opts);
  observer=new ResizeObserver(()=>{if(size(canvas))schedule();});
  observer.observe(canvas);
  for(const control of controls)control.disabled=false;
  label();
  Object.assign(canvas.dataset,{
    renderer:engine.gpu.adapterInfo?.vendor==='margo-webgl2'?'compatibility':'webgpu',
    bodies:bodies.length, meshes:scene.pieces.length+scene.piecesOfCourse.length,
  });
  if(status.ready())loader.hidden=true;
  performance.mark('margo-first-usable-frame');
}
await open().catch(fail);
