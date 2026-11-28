import { Engine } from '@margoengine/core';
import { EnvironmentLighting } from '@margoengine/environment';
import { Shadows } from '@margoengine/shadows';
import { makeHardware } from './hardware.js';
import { advance, ambient, equilibrium, modelRate, rejectedHeat } from './thermal.js';

const canvas=document.querySelector('#scene');
const loading=document.querySelector('#loading');
const slider=document.querySelector('#fan');
const fanValue=document.querySelector('#fan-value');
const view=document.querySelector('#view');
const scale=document.querySelector('#scale');
const powers=[...document.querySelectorAll('[data-watts]')];
const chip=document.querySelector('#chip'),tip=document.querySelector('#tip'),heat=document.querySelector('#heat');
const reduce=matchMedia('(prefers-reduced-motion: reduce)');
const lifetime=new AbortController();
const controls=[slider,view,...powers];

let engine,rig,frame,observer,last;
let targetFan=0,fan=0,power=65,thermal=true,fanMark=false;
let state=equilibrium(fan,power),goal=state,angle=.24,airClock=0;
let integrationTime=0;
const interval=.12;

function studio() {
  const width=64,height=32,data=new Float32Array(width*height*4);
  const panels=[
    [2.89,.03,.58,.26,[4.9,5.34,5.70]],
    [-.51,.70,.46,.28,[7.50,6.48,5.38]],
    [1.39,.40,.31,.41,[3.05,4.17,5.05]],
    [.92,-.36,.48,.31,[2.05,2.65,3.12]],
  ];
  for(let j=0;j<height;j++){
    const elevation=Math.PI*(.5-(j+.5)/height);
    for(let i=0;i<width;i++){
      const longitude=Math.PI*2*((i+.5)/width-.5);
      const base=.10+.12*Math.max(0,Math.sin(elevation));
      const rgb=[base*.88,base,base*1.09];
      for(const [bearing,tilt,wide,high,intensity] of panels){
        const offset=Math.atan2(Math.sin(longitude-bearing),Math.cos(longitude-bearing));
        const sample=Math.exp(-1.8*((offset/wide)**4+((elevation-tilt)/high)**4));
        for(let k=0;k<3;k++)rgb[k]+=sample*intensity[k];
      }
      data.set([...rgb,1],(j*width+i)*4);
    }
  }
  return {width,height,data};
}

function size() {
  const box=canvas.getBoundingClientRect();
  const dpr=Math.min(devicePixelRatio,1.5);
  const width=Math.max(1,Math.round(box.width*dpr));
  const height=Math.max(1,Math.round(box.height*dpr));
  if(canvas.width!==width)canvas.width=width;
  if(canvas.height!==height)canvas.height=height;
  if(engine){
    const fit=Math.max(1,1.32*height/width);
    const target=[-.005,.057,.008];
    engine.camera.target=target;
    engine.camera.position=[target[0]+.302*fit,target[1]+.274*fit,target[2]+.381*fit];
  }
}

function settings() {
  fanValue.textContent=targetFan?String(Math.round(targetFan*100))+'%':'Off';
  slider.setAttribute('aria-valuetext',targetFan?Math.round(targetFan*100)+' percent':'Off');
  powers.forEach((button)=>button.setAttribute('aria-pressed',String(Number(button.dataset.watts)===power)));
  view.setAttribute('aria-pressed',String(thermal));
  scale.hidden=!thermal;
}
function writeResults() {
  const chipTemp=state[0]+ambient,tipTemp=state.at(-1)+ambient;
  const loss=rejectedHeat(state,fan);
  chip.textContent=chipTemp.toFixed(1);
  tip.textContent=tipTemp.toFixed(1);
  heat.textContent=loss.toFixed(1);
  document.body.dataset.chip=chipTemp.toFixed(3);
  document.body.dataset.tip=tipTemp.toFixed(3);
  document.body.dataset.heat=loss.toFixed(3);
  document.body.dataset.fan=String(Math.round(100*targetFan));
  document.body.dataset.view=thermal?'thermal':'material';
}

function draw(now) {
  frame=undefined;
  const dt=last===undefined?1/60:Math.min(.082,(now-last)/1000);
  last=now;
  const fanGap=targetFan-fan;
  fan=Math.abs(fanGap)<.001?targetFan:fan+fanGap*(1-Math.exp(-dt*9.5));
  const unsettled=state.some((value,index)=>Math.abs(value-goal[index])>.023);
  if(unsettled||fan!==targetFan){
    integrationTime+=dt*modelRate;
    while(integrationTime>=interval){
      state=advance(state,fan,power,interval);
      integrationTime-=interval;
    }
  }
  if(!reduce.matches){
    angle-=dt*fan*15.1;
    airClock+=dt*fan*1.63;
  }
  rig.render(state,fan,angle,airClock,thermal,reduce.matches);
  writeResults();
  engine.render({delta:dt});
  if(fanMark){
    fanMark=false;
    performance.mark('margo-fan-applied');
  }
  if(unsettled||fan!==targetFan||(fan>0&&!reduce.matches))schedule();
  else last=undefined;
}

function schedule() {
  if(frame===undefined&&!lifetime.signal.aborted)frame=requestAnimationFrame((now)=>{
    try{draw(now);}catch(error){fail(error);}
  });
}
function dispose() {
  lifetime.abort();
  observer?.disconnect();
  if(frame!==undefined)cancelAnimationFrame(frame);
  engine?.dispose();
}
function fail(error) {
  if(lifetime.signal.aborted)return;
  document.body.dataset.state='error';
  controls.forEach((control)=>{control.disabled=true;});
  loading.hidden=false;
  loading.textContent='The thermal bench could not open in this browser.';
  console.error(error);
  dispose();
}

async function start() {
  const forced=new URLSearchParams(location.search).get('backend')==='webgl2';
  const open=()=>Engine.create(canvas,{
    backend:'webgpu',exactSize:true,antialias:true,capacity:340,startupTimeout:9000,signal:lifetime.signal,
    camera:{fov:35,near:.064,far:12},
  });
  size();
  if(!forced){
    try{engine=await open();}
    catch(error){if(error?.code!=='unsupported')throw error;}
  }
  const fallback=!engine;
  if(fallback){
    const {install}=await import('@margoengine/webgl2-compat');
    await install({force:true,signal:lifetime.signal});
    engine=await open();
  }
  engine.onError=fail;
  engine.scene.background='#4c646d';
  engine.lighting.direction.set([-.48,.82,.32,1.8]);
  engine.lighting.radiance.set([.92,.96,1,.48]);
  engine.lighting.ambient.set([.62,.73,.82]);
  const shadows=Shadows.attach(engine,{
    resolution:1024,filter:'soft',normalBias:.00026,lightSize:.09,
    bounds:{min:[-.22,-.04,-.18],max:[.22,.20,.18]},
  });
  await EnvironmentLighting.load(engine,studio(),{size:32,specularSize:32,intensity:.84,signal:lifetime.signal});
  rig=makeHardware(engine,shadows);
  size();
  settings();
  draw(performance.now());
  await engine.gpu.queue.onSubmittedWorkDone();
  await new Promise(requestAnimationFrame);
  if(lifetime.signal.aborted)return;

  const options={signal:lifetime.signal};
  slider.addEventListener('input',()=>{
    targetFan=slider.valueAsNumber/100;
    goal=equilibrium(targetFan,power);
    fanMark=true;
    settings();
    schedule();
  },options);
  powers.forEach((button)=>button.addEventListener('click',()=>{
    power=Number(button.dataset.watts);
    goal=equilibrium(targetFan,power);
    settings();
    schedule();
  },options));
  view.addEventListener('click',()=>{
    thermal=!thermal;
    settings();
    schedule();
  },options);
  reduce.addEventListener('change',schedule,options);
  observer=new ResizeObserver(()=>{size();schedule();});
  observer.observe(canvas);
  controls.forEach((control)=>{control.disabled=false;});
  loading.hidden=true;
  document.body.dataset.renderer=fallback?'compatibility':'webgpu';
  document.body.dataset.state='ready';
  performance.mark('margo-first-usable-frame');
}
window.addEventListener('pagehide',(event)=>{if(!event.persisted)dispose();},{signal:lifetime.signal});
start().catch(fail);
