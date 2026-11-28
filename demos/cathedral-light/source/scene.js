import { Clustered } from '@margoengine/clustered';
import { VolumetricFog } from '@margoengine/environment/volumetric';
import { Bloom } from '@margoengine/post/bloom';
import { SSGI } from '@margoengine/post/ssgi';
import { PostStack } from '@margoengine/post/stack';
import { applyQualityTier } from '@margoengine/quality';
import { autoEngine } from '@margoengine/webgl2-compat/auto';
import { demoStatus } from 'margo-demo-status';
import { glazings } from './glass.js';
import { createNave } from './nave.js';
import { defaultMinute, formatTime, lightsFor, sunlight } from './sun.js';

let canvas = document.querySelector('#nave');
const statusText = document.querySelector('#status');
const error = document.querySelector('#error');
const message = document.querySelector('#message');
const help = document.querySelector('#help');
const slider = document.querySelector('#hour');
const clock = document.querySelector('#clock');
const elevation = document.querySelector('#altitude');
const bearing = document.querySelector('#azimuth');
const presets = Array.from(document.querySelectorAll('[data-minute]'));
const controls = [slider,...presets];
const controller = new AbortController();
const query = new URLSearchParams(location.search);
const forceCompatibility = query.get('backend') === 'webgl2';
let status = demoStatus(canvas,statusText,message);
let engine, lights, glass, nave, observer, frame;
let minute = defaultMinute;
let last = 0;
let dirty = true;
let firstTouch = false;
let startupError;

function setSize(target) {
  const box = target.getBoundingClientRect();
  const width = Math.max(1,Math.round(box.width*1.35));
  const height = Math.max(1,Math.round(box.height*1.35));
  if(target.width === width && target.height === height)return false;
  target.width = width;
  target.height = height;
  return true;
}

function label(sun) {
  clock.value = formatTime(minute);
  slider.setAttribute('aria-valuetext',formatTime(minute)+' local solar time');
  elevation.value = sun.elevation.toFixed(1)+'°';
  bearing.value = sun.azimuth.toFixed(1)+'°';
  for(const button of presets)button.setAttribute('aria-pressed',String(+button.dataset.minute === minute));
}

function apply(target) {
  const sun = sunlight(minute);
  lights.setLights(lightsFor(sun));
  glass.update(sun);
  target.lighting.radiance.set([.78,.85,1,.21+.075*sun.direct]);
  label(sun);
  Object.assign(canvas.dataset,{
    minute, sunElevation:sun.elevation.toFixed(7), sunBearing:sun.azimuth.toFixed(7),
    beam:sun.floor.map(v=>v.toFixed(6)).join(','),
  });
  dirty = false;
}

function placeCamera(target) {
  const ratio = canvas.width/canvas.height;
  target.camera.position = [-.62,1.72,16.55];
  target.camera.target = [Math.min(2.91,Math.max(.62,(2.50-ratio)*1.82)),6.57,-10.9];
  target.camera.fov = Math.min(63,Math.max(50,61-(ratio-1.0)*6.0));
}

function draw(now) {
  frame = undefined;
  if(controller.signal.aborted || !engine)return;
  const delta = Math.min(.065,Math.max(0,last ? (now-last)/1000 : 0));
  last = now;
  try {
    if(dirty)apply(engine);
    engine.render({delta});
    if(firstTouch && !performance.getEntriesByName('cathedral-sun-applied').length){
      firstTouch = false;
      engine.gpu.queue.onSubmittedWorkDone().then(()=>{
        if(!controller.signal.aborted)performance.mark('cathedral-sun-applied');
      }).catch(fail);
    }
  } catch(reason){fail(reason);}
}

function cue(value) {
  minute = value;
  slider.value = value;
  dirty = true;
  firstTouch = true;
  if(frame === undefined)frame = requestAnimationFrame(draw);
}

function stop() {
  if(controller.signal.aborted)return;
  controller.abort();
  observer?.disconnect();
  if(frame !== undefined)cancelAnimationFrame(frame);
  engine?.dispose();
}
function fail(reason) {
  if(controller.signal.aborted)return;
  if(engine?.canvas)canvas=engine.canvas;
  else canvas=document.querySelector('#nave');
  status = demoStatus(canvas,statusText,message);
  status.error(reason);
  statusText.hidden = true;
  error.hidden = false;
  help.hidden = reason?.code !== 'unsupported';
  for(const control of controls)control.disabled = true;
  if(reason?.code !== 'unsupported')console.error(reason);
  stop();
}

async function start() {
  setSize(canvas);
  applyQualityTier();
  engine = await autoEngine(canvas,async target=>{
    const clustered = Clustered.attach(target,{
      maxLights:12,grid:[12,8,18],
      shadows:{maxLights:6,resolution:384,bias:.67,normalBias:.22},
    });
    canvas = target.canvas;
    target.onError = reason=>{startupError ??= reason;};
    target.scene.background = '#423530';
    target.lighting.direction.set([0,1,0,0]);
    target.lighting.ambient.set([.80,.85,1]);
    lights = clustered;
    PostStack.attach(target,[
      new SSGI({rays:2,maxDistance:6,steps:23,intensity:.55}),
      new Bloom({strength:.13,threshold:1.35,radius:.56,exposure:-.27}),
    ]);
    VolumetricFog.attach(target,{
      enabled:true,lights,grid:[80,47,36],range:42,density:.034,heightFalloff:.022,height:1.4,
      anisotropy:.62,color:[.96,.88,.73],ambient:[.036,.047,.064],temporal:0,
      noise:.18,noiseScale:1.06,
    });
    nave = createNave(target,lights);
    glass = glazings(target);
    placeCamera(target);
    apply(target);
    target.render({delta:0});
    await glass.ready();
    target.render({delta:0});
    await target.gpu.queue.onSubmittedWorkDone();
    if(startupError)throw startupError;
  },{
    backend:forceCompatibility ? 'webgl2' : 'auto',
    exactSize:true,antialias:true,capacity:80,signal:controller.signal,startupTimeout:10000,
    camera:{fov:50,near:.16,far:64},
    loadCompat:async ()=>{
      const compat = await import('@margoengine/webgl2-compat');
      return {install:()=>compat.install({force:forceCompatibility,signal:controller.signal})};
    },
  });
  if(controller.signal.aborted)return;
  engine.onError = fail;
  status = demoStatus(canvas,statusText,message);
  const options = {signal:controller.signal};
  slider.addEventListener('input',()=>cue(Number(slider.value)),options);
  for(const button of presets)button.addEventListener('click',()=>cue(Number(button.dataset.minute)),options);
  addEventListener('pagehide',event=>{if(!event.persisted)stop();},options);
  observer = new ResizeObserver(()=>{
    if(!setSize(canvas))return;
    placeCamera(engine);
    if(frame === undefined)frame = requestAnimationFrame(draw);
  });
  observer.observe(canvas);
  for(const control of controls)control.disabled = false;
  Object.assign(canvas.dataset,{
    renderer:engine.gpu.adapterInfo?.vendor === 'margo-webgl2' ? 'compatibility' : 'webgpu',
    meshes:nave.pieces.length, triangles:nave.triangles,
  });
  if(status.ready())statusText.hidden = true;
  performance.mark('margo-first-usable-frame');
}
await start().catch(fail);
