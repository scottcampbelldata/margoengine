import { Engine } from '@margoengine/core';
import { worldToScreen } from '@margoengine/math';
import { Shadows } from '@margoengine/shadows';
import { makeMeter } from './meter.js';
import { internalVolume,readFlow } from './flow.js';

const canvas=document.getElementById('scene');
const loading=document.getElementById('loading');
const slider=document.getElementById('rate');
const button=document.getElementById('show-head');
const overlay=document.getElementById('head-layer');
const markers=['upstream','neck'].map(id=>document.getElementById(id));
const [rate,pressure,head,inlet,throat]=['rate-value','pressure','head','inlet-speed','throat-speed'].map(id=>document.getElementById(id));
const stop=new AbortController();
const reduced=matchMedia('(prefers-reduced-motion: reduce)');
const point={x:0,y:0,z:0};
let engine,meter,observer,frame,previous;
let settings=readFlow(Number(slider.value));
let volume=0;
let guide=false;
let changed=false;
let framing=true;

function size(){
  const ratio=Math.min(1.70,Math.max(1.20,devicePixelRatio));
  const width=Math.max(1,Math.round(canvas.clientWidth*ratio));
  const height=Math.max(1,Math.round(canvas.clientHeight*ratio));
  if(canvas.width===width&&canvas.height===height)return false;
  canvas.width=width;canvas.height=height;framing=true;
  return true;
}

function camera(){
  const aspect=canvas.clientWidth/Math.max(1,canvas.clientHeight);
  const fit=2.08+.42*Math.max(0,1.43-aspect);
  const distance=Math.max(1.325,fit/aspect);
  const yaw=.14,pitch=.265;
  const aim=[-.016,.236,0];
  const depth=distance*Math.cos(pitch);
  engine.camera.target=aim;
  engine.camera.position=[aim[0]+Math.sin(yaw)*depth,aim[1]+Math.sin(pitch)*distance,aim[2]+Math.cos(yaw)*depth];
}

function locate(){
  const width=canvas.clientWidth,height=canvas.clientHeight;
  const positions=meter.anchors.map(([x,y,z],index)=>{
    const label=markers[index];
    worldToScreen({x,y,z},engine.camera,width,height,point);
    const size=label.offsetWidth;
    return {
      label,size,
      left:Math.max(8,Math.min(width-size-8,point.x-size*.50)),
      top:Math.max(8,Math.min(height-34,point.y-24)),
    };
  });
  const [upstream,throat]=positions;
  const space=throat.left-upstream.left-upstream.size;
  if(space<7){
    const shift=Math.min(upstream.left-8,(7-space)/2);
    upstream.left-=shift;
    throat.left=Math.min(width-throat.size-8,throat.left+7-space-shift);
  }
  for(const {label,left,top} of positions)label.style.transform='translate('+left+'px,'+top+'px)';
}

function show(){
  rate.value=settings.literRate+' L/min';
  pressure.value=Math.round(settings.pressureDrop).toString();
  head.value=(settings.dropHead*100).toFixed(1);
  inlet.value=settings.inletSpeed.toFixed(2);
  throat.value=settings.throatSpeed.toFixed(2);
  slider.style.setProperty('--progress',(settings.literRate*2)+'%');
  slider.setAttribute('aria-valuetext',settings.literRate+' liters per minute');
  document.body.dataset.flow=String(settings.literRate);
  button.setAttribute('aria-pressed',String(guide));
  button.lastChild.textContent=guide?'Hide water head':'Show water head';
  overlay.hidden=!guide;
}

function draw(){
  if(framing)camera();
  meter.update(settings,volume,guide);
  engine.render({delta:0});
  if(framing){locate();framing=false;}
  if(changed&&!performance.getEntriesByName('margo-first-input-applied').length){
    performance.mark('margo-first-input-applied');
    engine.gpu.queue.onSubmittedWorkDone().then(()=>{
      if(!stop.signal.aborted)performance.mark('margo-first-input-rendered');
    }).catch(fail);
  }
  changed=false;
}

function animate(now){
  frame=undefined;
  if(stop.signal.aborted)return;
  const moving=!reduced.matches&&!document.hidden&&settings.volumeRate>0;
  if(moving&&previous!==undefined)volume=(volume+settings.volumeRate*Math.min(.09,(now-previous)/1000))%internalVolume;
  previous=moving?now:undefined;
  try{draw();}
  catch(error){fail(error);return;}
  if(moving)schedule();
}
function schedule(){
  if(frame===undefined&&!stop.signal.aborted)frame=requestAnimationFrame(animate);
}
function wire(){
  const options={signal:stop.signal};
  slider.addEventListener('input',()=>{
    settings=readFlow(Number(slider.value));
    if(reduced.matches)volume=(volume+internalVolume/41)%internalVolume;
    changed=true;show();schedule();
  },options);
  button.addEventListener('click',()=>{
    guide=!guide;changed=true;show();schedule();
  },options);
  reduced.addEventListener('change',()=>{previous=undefined;schedule();},options);
  document.addEventListener('visibilitychange',()=>{previous=undefined;schedule();},options);
}
function dispose(){
  stop.abort();
  if(frame!==undefined)cancelAnimationFrame(frame);
  observer?.disconnect();meter?.dispose();engine?.dispose();
}
function fail(error){
  if(stop.signal.aborted)return;
  document.body.dataset.state='error';
  loading.hidden=false;loading.textContent='The meter could not open. '+(error?.message??error);
  slider.disabled=button.disabled=true;
  dispose();console.error(error);
}
async function start(){
  size();
  const forced=new URLSearchParams(location.search).get('backend')==='webgl2';
  const open=()=>Engine.create(canvas,{backend:'webgpu',exactSize:true,antialias:true,
    camera:{near:.040,far:9,fov:39},signal:stop.signal});
  if(!forced){
    try{engine=await open();}
    catch(error){if(error?.code!=='unsupported')throw error;}
  }
  const fallback=!engine;
  if(fallback){
    const {install}=await import('@margoengine/webgl2-compat');
    await install({force:true,signal:stop.signal});engine=await open();
  }
  engine.onError=fail;
  engine.scene.background='#435a61';
  engine.lighting.direction.set([-.49,.76,.45,2.23]);
  engine.lighting.radiance.set([1,.94,.83,.57]);
  engine.lighting.ambient.set([.54,.67,.79]);
  const shadows=Shadows.attach(engine,{bounds:{min:[-.70,-.03,-.20],max:[.70,.534,.20]},
    resolution:1024,filter:'pcf',normalBias:.0012});
  meter=makeMeter(engine,shadows);
  show();draw();
  await engine.gpu.queue.onSubmittedWorkDone();
  await new Promise(requestAnimationFrame);
  if(stop.signal.aborted)return;
  wire();
  observer=new ResizeObserver(()=>{if(size())schedule();});
  observer.observe(canvas);
  slider.disabled=button.disabled=false;
  loading.hidden=true;
  document.body.dataset.renderer=fallback?'compatibility':'webgpu';
  document.body.dataset.state='ready';
  performance.mark('margo-first-usable-frame');
  schedule();
}
addEventListener('pagehide',event=>{if(!event.persisted)dispose();});
await start().catch(fail);