import {Camera} from '@margoengine/core';
import {LiveTransitions} from '@margoengine/transitions/live';
import {prepareWorlds} from './worlds.js';
import {landscape} from './world-view.js';

export {prepareWorlds};

const swipe=/* wgsl */`
fn transition(a:texture_2d<f32>,b:texture_2d<f32>,uv:vec2f,p:f32)->vec4f {
  let x=uv.x+(uv.y-0.5)*0.145;
  let k=sin(p*3.141592654);
  let near=1.0-smoothstep(0.02,0.18,abs(x-p));
  let fringe=near*k*0.047;
  let softness=0.012;
  let u=vec2f(fringe,0.0);
  let outgoing=sample(a,uv);
  let left=sample(b,uv+u);
  let middle=sample(b,uv);
  let right=sample(b,uv-u);
  let maskR=1.0-smoothstep(p-softness+fringe,p+softness+fringe,x);
  let maskG=1.0-smoothstep(p-softness,p+softness,x);
  let maskB=1.0-smoothstep(p-softness-fringe,p+softness-fringe,x);
  return vec4f(mix(outgoing.rgb,vec3f(left.r,middle.g,right.b),vec3f(maskR,maskG,maskB)),1.0);
}
`;
const frame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
const duration=2.3;

export async function show({engine,worlds,canvas,notice,status,size,signal,fail}){
  const choices=[...document.querySelectorAll('[name="effect"]')];
  const slider=document.querySelector('#progress'), amount=document.querySelector('#amount');
  const play=document.querySelector('#play'), mobile=matchMedia('(max-width:650px)');
  const compat=engine.gpu.adapterInfo?.vendor==='margo-webgl2';
  canvas.dataset.renderer=compat?'compatibility':'webgpu';
  document.querySelector('#renderer').textContent=compat?'Margo WebGL2':'Margo WebGPU';
  canvas.dataset.dune=String(worlds.dune.indices.length/3);
  canvas.dataset.glacier=String(worlds.glacier.indices.length/3);

  let clock=.56, progress=0, effect='wipe', playing=false;
  let busy=false, dirty=false, requested=0, input=false, first=true, timestamp=0;
  const dune=engine.createScene('Dune Station');
  const ice=engine.createScene('Glacier Relay');
  const beforeCamera=new Camera({near:.85,far:900});
  const afterCamera=new Camera({near:.83,far:900});
  const captures={beforeCamera,afterCamera}, compiler=new WeakMap();
  dune.use(landscape(worlds.dune,false,()=>clock,compiler));
  ice.use(landscape(worlds.glacier,true,()=>clock,compiler));
  const normal=LiveTransitions.attach(engine,dune,ice,captures);
  const prism=LiveTransitions.custom(engine,dune,ice,swipe,{...captures,signal});

  function cameras(){
    beforeCamera.position=mobile.matches?[12.91,8.62,29.7]:[13.6,8.14,29.4];
    beforeCamera.target=[0,7.24,-14.25];
    beforeCamera.fov=mobile.matches?44:38;
    afterCamera.position=mobile.matches?[9.1,7.16,28.9]:[10.34,7.47,29.2];
    afterCamera.target=[.3,8.15,-15.88];
    afterCamera.fov=mobile.matches?44:38;
  }
  function labels(){
    const percent=Math.round(progress*100);
    slider.value=String(percent);
    slider.setAttribute('aria-valuetext',percent+' percent');
    amount.value=percent+'%';
    play.textContent=playing?'Pause':progress===1?'Replay':'Play';
  }
  cameras();
  normal.start('wipe');
  normal.render({delta:0});
  performance.mark('transitions-still-submitted');
  const chromatic=await prism;
  await engine.gpu.queue.onSubmittedWorkDone();
  signal.throwIfAborted();
  performance.mark('transitions-prism-ready');

  function display(){
    const selected=effect==='chromatic'?chromatic:normal;
    selected.start(effect==='chromatic'?'wipe':effect,1);
    selected.render({delta:progress});
    canvas.dataset.effect=effect;
    canvas.dataset.progress=progress.toFixed(3);
    canvas.dataset.motion=playing?'playing':'paused';
    canvas.dataset.time=clock.toFixed(4);
  }
  function request(){
    if(busy||requested||signal.aborted)return;
    requested=requestAnimationFrame(draw);
  }
  async function draw(now){
    requested=0;
    if(busy||signal.aborted)return;
    busy=true;
    dirty=false;
    const accepted=input;
    input=false;
    try{
      if(playing){
        const elapsed=timestamp?Math.min(.08,(now-timestamp)*.001):.026;
        timestamp=now;
        clock+=elapsed;
        progress=Math.min(1,progress+elapsed/duration);
        if(progress===1){playing=false;timestamp=0;}
      }
      labels();
      display();
      await engine.gpu.queue.onSubmittedWorkDone();
      if(signal.aborted)return;
      if(accepted){
        await frame();
        if(signal.aborted)return;
        performance.mark('transitions-input-rendered');
        if(first){
          first=false;
          performance.mark('transitions-first-input');
        }
      }
    }catch(reason){
      fail(reason);
    }finally{
      busy=false;
      if(playing||dirty)request();
    }
  }
  function update(event){
    dirty=true;
    input||=event.isTrusted;
    request();
  }

  canvas.dataset.effect=effect;
  canvas.dataset.progress=progress.toFixed(3);
  canvas.dataset.motion='paused';
  canvas.dataset.time=clock.toFixed(4);
  labels();
  await frame();
  if(status.ready()){
    notice.hidden=true;
    for(const control of [...choices,slider,play])control.disabled=false;
    performance.mark('transitions-ready');
  }
  slider.addEventListener('input',event=>{
    playing=false;
    timestamp=0;
    progress=Number(slider.value)/100;
    update(event);
  },{signal});
  for(const field of choices)field.addEventListener('change',event=>{
    if(!field.checked)return;
    playing=false;
    timestamp=0;
    effect=field.value;
    if(progress===0||progress===1)progress=.5;
    update(event);
  },{signal});
  play.addEventListener('click',event=>{
    if(progress===1)progress=0;
    timestamp=0;
    playing=!playing;
    update(event);
  },{signal});
  const observer=new ResizeObserver(()=>{
    if(!size())return;
    cameras();
    dirty=true;
    request();
  });
  observer.observe(canvas);
  signal.addEventListener('abort',()=>{
    observer.disconnect();
    cancelAnimationFrame(requested);
  },{once:true});
}
