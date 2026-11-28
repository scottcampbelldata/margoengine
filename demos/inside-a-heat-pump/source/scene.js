import { createStage } from '@margoengine/stage';
import { EnvironmentLighting } from '@margoengine/environment';
import { worldToScreen } from '@margoengine/math';
import { ExplodedView } from '@margoengine/machinery/exploded';
import { PostStack } from '@margoengine/post/stack';
import { Shadows } from '@margoengine/shadows';
import { Tonemap } from '@margoengine/tonemap';
import { cutaway } from './model.js';

const canvas = document.querySelector('#scene');
const loading = document.querySelector('#loading');
const modes = [...document.querySelectorAll('[data-mode]')];
const explosion = document.querySelector('#explode');
const amount = document.querySelector('#amount');
const reset = document.querySelector('#reset-view');
const trace = document.querySelector('#trace');
const detail = document.querySelector('#cycle');
const stop = new AbortController();
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const initial = {yaw:.20, pitch:.32};
const view = {...initial};
const labels = [
  [document.querySelector('#outdoor'),[-1.47,1.86,.16],[-.48,.57,-.17]],
  [document.querySelector('#valve'),[0,1.40,.59],[0,0,0]],
  [document.querySelector('#indoor'),[1.47,1.86,.16],[.48,.57,-.17]],
];
let stage, model, exploded, timeline = 0, last, frame, resize;
let heating = true, tracing = false, pixelRatio = 1, selected = -1;
const framing = { x:0,y:.69,distance:0 };
const macro = [[-1.47,.88,3.05],[0,.77,2.72],[1.47,.88,3.05]];
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function studio() {
  const width=96, height=48, data=new Float32Array(width*height*4);
  const lights=[
    [-.73,.70,.49,.25,[7.8,6.55,5.6]],
    [1.23,.27,.25,.56,[3.3,5.25,6.8]],
    [-2.29,.44,.64,.19,[2.72,3.50,3.95]],
  ];
  for(let j=0;j<height;j++){
    const latitude=Math.PI*(.5-(j+.5)/height);
    for(let i=0;i<width;i++){
      const longitude=2*Math.PI*((i+.5)/width-.5);
      const base=.12+.12*Math.max(0,Math.sin(latitude)), rgb=[base*.92,base,base*1.14];
      for(const [angle,el,w,h,power] of lights){
        const dx=Math.atan2(Math.sin(longitude-angle),Math.cos(longitude-angle));
        const l=Math.exp(-2*((dx/w)**4+((latitude-el)/h)**4));
        for(let c=0;c<3;c++)rgb[c]+=l*power[c];
      }
      data.set([...rgb,1],(j*width+i)*4);
    }
  }
  return {width,height,data};
}

function fail(error) {
  stop.abort();
  loading.hidden=false;
  loading.textContent='The cutaway could not open. '+(error?.message??error);
  document.body.dataset.state='error';
  console.error(error);
}

function sizeCanvas() {
  const width=Math.max(1,Math.round(canvas.clientWidth*pixelRatio));
  const height=Math.max(1,Math.round(canvas.clientHeight*pixelRatio));
  if(canvas.width!==width)canvas.width=width;
  if(canvas.height!==height)canvas.height=height;
}

function pins(amount) {
  const screen={x:0,y:0,z:0};
  for(const [element,point,move] of labels){
    const [x,y,z]=point.map((p,i)=>p+move[i]*amount);
    if(!worldToScreen({x,y,z},stage.engine.camera,canvas.clientWidth,canvas.clientHeight,screen))continue;
    element.style.left=screen.x+'px';
    element.style.top=screen.y+'px';
  }
}

function draw(now) {
  if(stop.signal.aborted)return;
  const dt=last?Math.min(.050,(now-last)/1000):0;
  last=now;
  timeline+=reduced.matches?0:dt;
  const open=Number(explosion.value)/100;
  const width=canvas.clientWidth, height=Math.max(1,canvas.clientHeight), aspect=width/height;
  const portrait=Math.max(1,1.16/aspect);
  const [cx,cy,zoom]=macro[selected]??[0,.69+open*.23,Math.max(5.85,9.80/aspect)];
  const easing=reduced.matches||framing.distance===0 ? 1 : Math.min(1,dt*8);
  framing.x+=(cx-framing.x)*easing;
  framing.y+=(cy-framing.y)*easing;
  const distanceAim=selected===-1?zoom*(1+open*.21):zoom*portrait*(1+open*.08);
  framing.distance+=(distanceAim-framing.distance)*easing;
  const distance=framing.distance;
  const target=[framing.x,framing.y,0];
  stage.engine.camera.target=target;
  stage.engine.camera.position=[
    target[0]+Math.sin(view.yaw)*Math.cos(view.pitch)*distance,
    target[1]+Math.sin(view.pitch)*distance,
    Math.cos(view.yaw)*Math.cos(view.pitch)*distance,
  ];
  exploded.amount=open;
  model.flow(timeline,open,heating,tracing);
  for(const [i,fan] of model.fans.entries())fan.setRotation([0,0,timeline*(i?8.3:-9.6)]);
  stage.engine.render({delta:dt});
  pins(open);
}

function loop(now) {
  try { draw(now); } catch(error) { fail(error); }
  if(!stop.signal.aborted)frame=requestAnimationFrame(loop);
}

function setTracing(enabled) {
  tracing=enabled;
  trace.setAttribute('aria-pressed',String(enabled));
}

function connect() {
  const listener={signal:stop.signal};
  for(const button of modes)button.addEventListener('click',()=>{
    heating=button.dataset.mode==='heating';
    document.body.dataset.mode=button.dataset.mode;
    for(const choice of modes)choice.setAttribute('aria-pressed',String(choice===button));
    model.changeMode(heating);
    setTracing(true);
    detail.textContent=heating
      ? 'In heating mode, the indoor coil releases heat and the outdoor coil absorbs it.'
      : 'In cooling mode, the outdoor coil releases heat and the indoor coil absorbs it.';
  },listener);
  explosion.addEventListener('input',()=>{
    amount.value=explosion.value+'%';
    document.body.dataset.explode=explosion.value;
  },listener);
  trace.addEventListener('click',()=>setTracing(!tracing),listener);
  const choose=(index)=>{
    selected=selected===index ? -1 : index;
    document.body.dataset.inspect=labels[selected]?.[0].id??'all';
    labels.forEach(([element],i)=>{
      element.setAttribute('aria-pressed',String(i===selected));
      element.hidden=selected!==-1 && i!==selected;
    });
  };
  labels.forEach(([element],index)=>element.addEventListener('click',()=>choose(index),listener));
  reset.addEventListener('click',()=>{
    choose(-1);
    Object.assign(view,initial);
  },listener);
  let contact;
  canvas.addEventListener('pointerdown',(event)=>{
    if(event.button!==0||contact)return;
    contact={id:event.pointerId,x:event.clientX,y:event.clientY};
    canvas.setPointerCapture(event.pointerId);
  },listener);
  canvas.addEventListener('pointermove',(event)=>{
    if(contact?.id!==event.pointerId)return;
    view.yaw=clamp(view.yaw-(event.clientX-contact.x)*.006,-.92,.92);
    view.pitch=clamp(view.pitch+(event.clientY-contact.y)*.007,.10,.82);
    contact.x=event.clientX;
    contact.y=event.clientY;
  },listener);
  canvas.addEventListener('lostpointercapture',()=>{contact=undefined;},listener);
  canvas.addEventListener('keydown',(event)=>{
    const move={ArrowLeft:[-.10,0],ArrowRight:[.10,0],ArrowUp:[0,.06],ArrowDown:[0,-.06]}[event.key];
    if(!move)return;
    event.preventDefault();
    view.yaw=clamp(view.yaw+move[0],-.92,.92);
    view.pitch=clamp(view.pitch+move[1],.10,.82);
  },listener);
}

async function start() {
  const compatibility=new URLSearchParams(location.search).get('backend')==='webgl2'||
    !navigator.gpu||!(await navigator.gpu.requestAdapter());
  if(compatibility)await(await import('@margoengine/webgl2-compat')).install({force:Boolean(navigator.gpu)});
  const mobile=matchMedia('(pointer: coarse)').matches;
  pixelRatio=Math.min(devicePixelRatio, compatibility?1:mobile?1.42:1.6);
  sizeCanvas();
  stage=await createStage(canvas,{autoStart:false, controls:false, backend:'webgpu', exactSize:true,
    label:'Heat pump cutaway', background:'#182b34', antialias:!compatibility, camera:{fov:34,near:.03,far:350}, onError:fail});
  const {engine}=stage;
  performance.mark('margo-engine-ready');
  engine.lighting.direction.set([-.57,.71,.4,2.73]);
  engine.lighting.radiance.set([1,.91,.81,.21]);
  engine.lighting.ambient.set([.39,.49,.52]);
  PostStack.attach(engine,[new Tonemap({curve:'agx',exposure:.11,contrast:1.13})]);
  const shadows=Shadows.attach(engine,{resolution:mobile||compatibility?512:1024,filter:'pcf',normalBias:.004,
    bounds:{min:[-3.2,-.5,-1.15],max:[3.2,2.52,1.55]}});
  const environment=await EnvironmentLighting.load(engine,studio(),{
    size:64,specularSize:64,intensity:.79,signal:stage.signal,
  });
  model=cutaway(engine,shadows,environment);
  exploded=ExplodedView.attach(engine,model.exploded);
  draw(performance.now());
  await engine.gpu.queue.onSubmittedWorkDone();
  await new Promise(requestAnimationFrame);
  await new Promise(requestAnimationFrame);
  if(stop.signal.aborted)return;
  performance.mark('margo-first-usable-frame');
  document.body.dataset.state='ready';
  document.body.dataset.renderer=compatibility?'compatibility':'webgpu';
  document.body.dataset.mode='heating';
  loading.hidden=true;
  for(const control of [...modes,explosion,reset,trace,...labels.map(([element])=>element)])control.disabled=false;
  connect();
  resize=new ResizeObserver(sizeCanvas);
  resize.observe(canvas);
  frame=requestAnimationFrame(loop);
  addEventListener('pagehide',(event)=>{
    if(event.persisted)return;
    stop.abort();
    resize.disconnect();
    cancelAnimationFrame(frame);
    stage.dispose();
  });
}

await start().catch(fail);




