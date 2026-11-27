import { Clustered } from '@margoengine/clustered';
import { margoError } from '@margoengine/core/extension';
import { Bloom } from '@margoengine/post/bloom';
import { SSR } from '@margoengine/post/ssr';
import { PostStack } from '@margoengine/post/stack';
import { applyQualityTier, qualityPreset } from '@margoengine/quality';
import { Sky } from '@margoengine/sky/base';
import { preetham } from '@margoengine/sky/preetham';
import { night } from '@margoengine/sky/night';
import { lighting } from '@margoengine/sky/lighting';
import { fog } from '@margoengine/sky/fog';
import { look } from '@margoengine/sky/look';
import { degrees, sunPath } from '@margoengine/sky/sun';
import { autoEngine } from '@margoengine/webgl2-compat/auto';
import { demoStatus } from 'margo-demo-status';
import { prepareCity } from './city.js';
import { cityRadiance } from './emissions.js';

let canvas=document.querySelector('#city');
const loading=document.querySelector('#status');
const status=demoStatus(document.body,loading);
const slider=document.querySelector('#time');
const clock=document.querySelector('#clock');
const elevation=document.querySelector('#sun');
const windows=document.querySelector('#windows');
const lamps=document.querySelector('#lamps');
const play=document.querySelector('#play');
const views=[...document.querySelectorAll('[data-view]')];
const controls=[slider,play,...views];
const controller=new AbortController();
const {signal}=controller;
const query=new URLSearchParams(location.search);
const forced=query.get('backend')==='webgl2';
const locale=new Intl.NumberFormat('en-US');
const latitude=degrees(34.6);
const dayOfYear=238;
const quality=applyQualityTier();
const preset=qualityPreset();
let engine,city,lightPass,reflect,sky,cluster,observer,frame;
let view='skyline',running=null,previous,rendered=-1,dirty=true;
let cssWidth=0,cssHeight=0;

function countBefore(list,minute,at=(value)=>value) {
  let a=0,b=list.length;
  while(a<b) {
    const middle=(a+b)>>1;
    if(at(list[middle])<minute) a=middle+1;
    else b=middle;
  }
  return a;
}

function size() {
  const maxRatio=quality==='high'?1.5:1.05;
  const ratio=Math.min(maxRatio,window.devicePixelRatio);
  cssWidth=canvas.clientWidth;
  cssHeight=canvas.clientHeight;
  const w=Math.max(1,Math.round(cssWidth*ratio)),h=Math.max(1,Math.round(cssHeight*ratio));
  if(canvas.width!==w) canvas.width=w;
  if(canvas.height!==h) canvas.height=h;
  const tall=canvas.clientWidth/canvas.clientHeight<1.22;
  if(view==='avenue') {
    engine.camera.position=city.streetEye;
    engine.camera.target=city.streetTarget;
    engine.camera.fov=tall?61:54;
  } else {
    engine.camera.position=[394,185,420];
    engine.camera.target=tall?[18,72,-43]:[23,62,-49];
    engine.camera.fov=tall?49:43;
  }
}

function formatTime(minute) {
  return [Math.floor(minute/60),minute%60].map((n)=>String(n).padStart(2,'0')).join(':');
}

function draw(delta) {
  const minute=Number(slider.value);
  const moved=minute!==rendered;
  if(!moved&&!dirty) return;
  if(dirty) size();
  const position=sunPath({latitude,dayOfYear,hour:minute/60});
  sky.options.sunDirection=position.direction;
  sky.options.hours=minute/60;
  const afterSunset=Math.min(1,Math.max(0,(-position.elevation.degrees+2)/10));
  sky.options.look.horizonStrength=.37*(1-afterSunset);
  sky.options.look.glowStrength=.30*(1-afterSunset);
  lightPass.minute=minute;
  const lampCount=countBefore(city.fixtures,minute,(lamp)=>lamp.delay);
  const windowCount=countBefore(city.windows,minute);
  if(moved) {
    const lights=city.fixtures.slice(0,lampCount).map(({delay,...lamp})=>({
      ...lamp,intensity:lamp.intensity*Math.min(1,(minute-delay)/7),
    }));
    cluster.setLights(lights);
  }
  engine.render({delta});
  clock.textContent=formatTime(minute);
  slider.setAttribute('aria-valuetext',clock.textContent+' local solar time');
  const sun=position.elevation.degrees;
  elevation.textContent=(sun<0?'−':'+')+Math.abs(sun).toFixed(1)+'°';
  windows.textContent=locale.format(windowCount);
  lamps.textContent=locale.format(lampCount);
  if(moved) {
    document.body.dataset.minute=String(minute);
    document.body.dataset.windows=String(windowCount);
    document.body.dataset.lamps=String(lampCount);
  }
  document.body.dataset.view=view;
  rendered=minute;
  dirty=false;
}

function playback(value) {
  running=value;
  play.textContent=running?'Pause':'Play evening';
  document.body.dataset.playing=String(Boolean(running));
}

function tick(now) {
  frame=undefined;
  if(signal.aborted||status.failed)return;
  const delta=previous===undefined?0:Math.min(.065,Math.max(0,(now-previous)/1000));
  previous=now;
  try {
    if(running) {
      running.elapsed+=delta;
      slider.value=String(Math.min(Number(slider.max),Math.round(running.from+running.elapsed*12)));
      if(Number(slider.value)===Number(slider.max)) playback(null);
    }
    draw(delta);
  } catch(error) { fail(error); return; }
  if(running) schedule();
}

function schedule() { frame??=requestAnimationFrame(tick); }

function fail(error) {
  status.error(error);
  loading.hidden=false;
  for(const control of controls) control.disabled=true;
  if(error?.code==='unsupported') {
    document.body.dataset.webgpuRefused='';
    const help=document.createElement('a');
    help.href='https://margoengine.com/webgpu.html';
    help.textContent='WebGPU browser support';
    loading.prepend('This part of the demo needs WebGPU; the WebGL2 compatibility mode cannot run it. ');
    loading.append(help);
    return;
  }
  console.error(error);
}

function assemble(created) {
  if(!created.gpu) throw margoError('unsupported','This city uses clustered lighting and HDR reflections on the compatibility layer');
  canvas=created.canvas;
  engine=created;
  engine.onError=fail;
  cluster=Clustered.attach(engine,{grid:[7,5,13],maxLights:4096});
  city??=prepareCity(signal);
  city.mount(engine);
  performance.mark('margo-city-geometry-ready');
  sky=Sky.attach(engine,{
    model:'preetham',hours:Number(slider.value)/60,timeScale:0,turbidity:3.8,exposure:-.28,
    night:{zenithColor:[.015,.027,.068],horizonColor:[.108,.145,.251],starIntensity:.45,
      glowIntensity:.115,moonColor:[2.0,2.55,3.45],moonDirection:[-.33,.50,-.80],
      moonSize:.006,moonPhase:'waxingGibbous',starTwinkleIntensity:0},
    look:{zenithColor:[.26,.41,.71],zenithStrength:.39,horizonColor:[.76,.44,.48],horizonStrength:.37,
      glowColor:[.88,.35,.23],glowStrength:.30,glowWidth:11.5,glowSunward:.43},
    lighting:{intensity:1.9,twilight:{brightness:9},moon:{intensity:.16},
      ambient:{day:[.32,.37,.46],night:[.075,.10,.17]},ground:.16},
    fog:{density:.00105,start:152,scaleHeight:290,falloff:'exp2'},
  },{preetham,night,lighting,fog,look});
  reflect=new SSR({enabled:true,steps:preset.ssr?.steps??56,maxRoughness:.59,thickness:1.35,maxDistance:187});
  PostStack.attach(engine,[reflect,new Bloom({strength:.19,threshold:1.14})]);
  lightPass=cityRadiance(city.emissions);
  engine.use(lightPass);
  draw(0);
  performance.mark('margo-city-first-submitted');
  return engine.gpu.queue.onSubmittedWorkDone();
}

function connect() {
  slider.addEventListener('input',()=>{ playback(null); schedule(); },{signal});
  play.addEventListener('click',()=>{
    if(running) playback(null);
    else {
      if(Number(slider.value)===Number(slider.max)) slider.value=slider.min;
      playback({from:Number(slider.value),elapsed:0});
      previous=undefined;
    }
    schedule();
  },{signal});
  for(const button of views) button.addEventListener('click',()=>{
    view=button.dataset.view;
    for(const selection of views) selection.setAttribute('aria-pressed',String(selection===button));
    dirty=true;
    schedule();
  },{signal});
  document.addEventListener('visibilitychange',()=>{ if(document.hidden) playback(null); },{signal});
  observer=new ResizeObserver(()=>{
    if(cssWidth===canvas.clientWidth&&cssHeight===canvas.clientHeight)return;
    dirty=true;
    schedule();
  });
  observer.observe(canvas);
}

async function open() {
  status.pending('Building the skyline…');
  const compat=async()=> {
    const module=await import('@margoengine/webgl2-compat');
    return {install:()=>module.install({force:forced,signal})};
  };
  await autoEngine(canvas,assemble,{
    backend:forced?'webgl2':undefined,loadCompat:compat,exactSize:true,signal,
    startupTimeout:5000,camera:{near:2,far:1840,fov:43},
  });
  if(signal.aborted||status.failed)return;
  connect();
  for(const control of controls) control.disabled=false;
  document.body.dataset.renderer=engine.gpu.adapterInfo?.vendor==='margo-webgl2'?'webgl2':'webgpu';
  document.body.dataset.buildings=String(city.buildingCount);
  document.body.dataset.blocks=String(city.blockCount);
  document.body.dataset.quality=quality;
  status.ready();
  loading.hidden=true;
  performance.mark('margo-first-usable-frame');
}

addEventListener('pagehide',(event)=>{
  if(event.persisted)return;
  controller.abort();
  observer?.disconnect();
  if(frame!==undefined) cancelAnimationFrame(frame);
  engine?.dispose();
});
open().catch((error)=>{if(!signal.aborted)fail(error);});
