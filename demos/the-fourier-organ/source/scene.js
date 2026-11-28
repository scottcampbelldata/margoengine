import { Engine } from '@margoengine/core';
import { EnvironmentLighting } from '@margoengine/environment';
import { Shadows } from '@margoengine/shadows';
import { harmonicOrders, fundamentalHz } from './model.js';
import { makeOrgan } from './rig.js';
import { soundEngine } from './audio.js';

const canvas=document.querySelector('#scene'),loading=document.querySelector('#loading');
const partials=document.querySelector('#partials'),countLabel=document.querySelector('#partial-count');
const highest=document.querySelector('#highest'),frequencies=document.querySelector('#frequencies');
const listen=document.querySelector('#listen'),audioStatus=document.querySelector('#audio-status');
const lifetime=new AbortController();
const Audio=window.AudioContext??window.webkitAudioContext;
let engine,organ,observer,frame,context,sound;
let listening=false,opening=false,changed=false;

function reflectorMap() {
  const width=64,height=32,data=new Float32Array(width*height*4);
  const reflectors=[
    [-.76,.59,.51,.42,[7.0,5.9,4.5]],
    [1.13,.28,.51,.54,[3.2,4.4,5.6]],
    [2.81,.40,.48,.25,[5.0,4.3,3.0]],
  ];
  for(let y=0;y<height;y++){
    const elevation=Math.PI*(.5-(y+.5)/height);
    for(let x=0;x<width;x++){
      const bearing=Math.PI*(2*(x+.5)/width-1);
      const ambient=.08+.17*Math.max(0,Math.sin(elevation));
      const pixel=[ambient*.91,ambient,ambient*1.09,1];
      for(const [angle,pitch,w,h,radiance] of reflectors){
        const delta=Math.atan2(Math.sin(bearing-angle),Math.cos(bearing-angle));
        const mask=Math.exp(-1.7*((delta/w)**4+((elevation-pitch)/h)**4));
        for(let c=0;c<3;c++)pixel[c]+=radiance[c]*mask;
      }
      data.set(pixel,(y*width+x)*4);
    }
  }
  return {width,height,data};
}

function size() {
  const bounds=canvas.getBoundingClientRect(),density=Math.min(devicePixelRatio,1.5);
  const width=Math.max(1,Math.round(bounds.width*density)),height=Math.max(1,Math.round(bounds.height*density));
  if(canvas.width!==width)canvas.width=width;
  if(canvas.height!==height)canvas.height=height;
  if(!engine)return;
  const scale=Math.max(1,1.48*height/width);
  const target=[0,.173,.006];
  const offset=[.157,.656,.898];
  engine.camera.target=target;
  engine.camera.position=target.map((v,i)=>v+scale*offset[i]);
}

function draw() {
  const count=partials.valueAsNumber;
  organ.setCount(count);
  engine.render();
  countLabel.value=String(count);
  partials.setAttribute('aria-valuetext',count+(count===1?' harmonic':' harmonics'));
  const parts=harmonicOrders.slice(0,count).map(order=>order*fundamentalHz);
  highest.value=String(parts.at(-1));
  frequencies.value=parts.join(' · ');
  document.body.dataset.partials=String(count);
  document.body.dataset.highest=highest.value;
  if(changed){
    sound?.update(count,listening);
    performance.mark('margo-organ-rendered');
    changed=false;
  }
}

function schedule() {
  if(frame!==undefined||lifetime.signal.aborted)return;
  frame=requestAnimationFrame(()=>{
    frame=undefined;
    try{draw();}catch(error){fail(error);}
  });
}

function setListening(value) {
  listening=value;
  sound?.update(partials.valueAsNumber,listening);
  listen.textContent=value?'Mute':'Listen';
  listen.setAttribute('aria-pressed',String(value));
  document.body.dataset.audio=value?'playing':'muted';
}

async function toggleAudio() {
  if(opening||!Audio)return;
  if(listening){setListening(false);return;}
  opening=true;
  listen.disabled=true;
  try {
    if(!context){
      context=new Audio();
      sound=soundEngine(context);
    }
    await context.resume();
    if(!lifetime.signal.aborted&&!document.hidden)setListening(true);
  } catch {
    setListening(false);
    audioStatus.hidden=false;
  } finally {
    opening=false;
    if(!lifetime.signal.aborted)listen.disabled=false;
  }
}

function dispose() {
  lifetime.abort();
  observer?.disconnect();
  if(frame!==undefined)cancelAnimationFrame(frame);
  engine?.dispose();
  sound?.stop().catch(()=>{});
}
function fail(error) {
  if(lifetime.signal.aborted)return;
  document.body.dataset.state='error';
  partials.disabled=true;
  listen.disabled=true;
  loading.hidden=false;
  loading.textContent='The Fourier organ could not open in this browser.';
  console.error(error);
  dispose();
}

async function start() {
  const forced=new URLSearchParams(location.search).get('backend')==='webgl2';
  const open=()=>Engine.create(canvas,{
    backend:'webgpu',exactSize:true,antialias:true,capacity:145,
    startupTimeout:9500,signal:lifetime.signal,camera:{fov:34,near:.07,far:19},
  });
  size();
  if(!forced){
    try{engine=await open();}
    catch(error){if(error?.code!=='unsupported')throw error;}
  }
  const compatibility=!engine;
  if(compatibility){
    const {install}=await import('@margoengine/webgl2-compat');
    await install({force:true,signal:lifetime.signal});
    engine=await open();
  }
  engine.onError=fail;
  engine.scene.background='#78645d';
  engine.lighting.direction.set([-.52,.78,.45,1.71]);
  engine.lighting.ambient.set([.64,.63,.69]);
  engine.lighting.radiance.set([1,.937,.842,.47]);
  const shadows=Shadows.attach(engine,{
    resolution:1024,filter:'soft',lightSize:.085,normalBias:.00064,
    bounds:{min:[-.45,-.052,-.29],max:[.45,.52,.29]},
  });
  await EnvironmentLighting.load(engine,reflectorMap(),{
    size:32,specularSize:32,intensity:1.06,signal:lifetime.signal,
  });
  organ=makeOrgan(engine,shadows);
  size();
  draw();
  await engine.gpu.queue.onSubmittedWorkDone();
  await new Promise(requestAnimationFrame);
  if(lifetime.signal.aborted)return;
  const options={signal:lifetime.signal};
  partials.addEventListener('input',()=>{changed=true;schedule();},options);
  listen.addEventListener('click',toggleAudio,options);
  document.addEventListener('visibilitychange',()=>{
    if(document.hidden&&listening)setListening(false);
  },options);
  observer=new ResizeObserver(()=>{size();schedule();});
  observer.observe(canvas);
  partials.disabled=false;
  listen.disabled=!Audio;
  audioStatus.hidden=!!Audio;
  setListening(false);
  loading.hidden=true;
  document.body.dataset.renderer=compatibility?'compatibility':'webgpu';
  document.body.dataset.state='ready';
  performance.mark('margo-first-usable-frame');
}

window.addEventListener('pagehide',(event)=>{if(!event.persisted)dispose();},{signal:lifetime.signal});
start().catch(fail);



