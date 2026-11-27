import { Engine } from '@margoengine/core';
import { worldToScreen } from '@margoengine/math';
import { Shadows } from '@margoengine/shadows';
import { buildScrew } from './machine.js';
import { litersPerTurn,phaseInTurn,phaseRate,pitch,read,tau } from './screw.js';

const canvas=document.getElementById('scene');
const loading=document.getElementById('loading');
const speed=document.getElementById('drive');
const button=document.getElementById('pause');
const labels=['intake','outlet'].map(id=>document.getElementById(id));
const [rpm,flow,volume,travel]=['speed','flow','volume','pitch'].map(id=>document.getElementById(id));
const motion=matchMedia('(prefers-reduced-motion: reduce)');
const stop=new AbortController();
const projected={x:0,y:0,z:0};
let engine,exhibit,observer,frame,previous;
let phase=tau*.17;
let drive=Number(speed.value);
let paused=false;
let sent=false;
let framing=true;

function size(){
  const ratio=Math.min(1.70,Math.max(1.20,devicePixelRatio));
  const width=Math.max(1,Math.round(canvas.clientWidth*ratio));
  const height=Math.max(1,Math.round(canvas.clientHeight*ratio));
  if(width===canvas.width&&height===canvas.height)return false;
  canvas.width=width;canvas.height=height;
  framing=true;
  return true;
}

function aim(){
  const aspect=canvas.clientWidth/Math.max(1,canvas.clientHeight);
  const width=3.04+1.06*Math.max(0,1.53-aspect);
  const distance=Math.max(2.10,width/aspect);
  const yaw=.11;
  const pitch=.30;
  const target=[.646,.438,-.02];
  const ground=distance*Math.cos(pitch);
  engine.camera.target=target;
  engine.camera.position=[target[0]+Math.sin(yaw)*ground,target[1]+Math.sin(pitch)*distance,target[2]+Math.cos(yaw)*ground];
}

function readouts(){
  const output=read(paused?0:drive);
  rpm.value=drive+' rpm';
  flow.value=output.litersPerMinute.toFixed(1);
  speed.style.setProperty('--progress',(100*drive/55)+'%');
  speed.setAttribute('aria-valuetext',drive+' revolutions per minute');
  button.textContent=motion.matches?'Advance an eighth turn':paused||drive===0?'Resume rotor':'Pause rotor';
  document.body.dataset.running=String(!paused&&drive>0&&!motion.matches);
}

function placeLabels(){
  const width=canvas.clientWidth,height=canvas.clientHeight;
  exhibit.anchors.forEach(([x,y,z],i)=>{
    const item=labels[i];
    worldToScreen({x,y,z},engine.camera,width,height,projected);
    const left=Math.max(8,Math.min(width-item.offsetWidth-8,projected.x-item.offsetWidth*.58));
    const top=Math.max(8,Math.min(height-36,projected.y-29));
    item.style.transform='translate('+left+'px,'+top+'px)';
  });
}

function draw(){
  if(framing)aim();
  exhibit.update(phase,motion.matches||paused?0:drive);
  engine.render({delta:0});
  if(framing){placeLabels();framing=false;}
  if(sent&&!performance.getEntriesByName('margo-first-input-applied').length){
    performance.mark('margo-first-input-applied');
    engine.gpu.queue.onSubmittedWorkDone().then(()=>{
      if(!stop.signal.aborted)performance.mark('margo-first-input-rendered');
    }).catch(fail);
  }
  sent=false;
}

function animate(now){
  frame=undefined;
  if(stop.signal.aborted)return;
  const moving=!paused&&drive>0&&!motion.matches&&!document.hidden;
  if(moving&&previous!==undefined)phase=phaseInTurn(phase+phaseRate(drive)*Math.min(.09,(now-previous)/1000));
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
  speed.addEventListener('input',()=>{
    drive=Number(speed.value);
    paused=false;
    if(motion.matches)phase=phaseInTurn(phase+tau/18);
    sent=true;readouts();schedule();
  },options);
  button.addEventListener('click',()=>{
    if(motion.matches)phase=phaseInTurn(phase+tau/8);
    else if(drive===0){drive=22;speed.value='22';paused=false;}
    else paused=!paused;
    previous=undefined;sent=true;readouts();schedule();
  },options);
  motion.addEventListener('change',()=>{previous=undefined;readouts();schedule();},options);
  document.addEventListener('visibilitychange',()=>{previous=undefined;schedule();},options);
}

function dispose(){
  stop.abort();
  if(frame!==undefined)cancelAnimationFrame(frame);
  observer?.disconnect();exhibit?.dispose();engine?.dispose();
}

function fail(error){
  if(stop.signal.aborted)return;
  document.body.dataset.state='error';
  loading.hidden=false;loading.textContent='The screw could not open. '+(error?.message??error);
  speed.disabled=button.disabled=true;
  dispose();console.error(error);
}

async function start(){
  size();
  const force=new URLSearchParams(location.search).get('backend')==='webgl2';
  const open=()=>Engine.create(canvas,{backend:'webgpu',exactSize:true,antialias:true,
    camera:{near:.063,far:16,fov:38},signal:stop.signal});
  if(!force){
    try{engine=await open();}
    catch(error){if(error?.code!=='unsupported')throw error;}
  }
  const fallback=!engine;
  if(fallback){
    const {install}=await import('@margoengine/webgl2-compat');
    await install({force:true,signal:stop.signal});engine=await open();
  }
  engine.onError=fail;
  engine.scene.background='#3d5965';
  engine.lighting.direction.set([-.40,.78,.48,2.58]);
  engine.lighting.radiance.set([1,.937,.822,.57]);
  engine.lighting.ambient.set([.54,.70,.82]);
  const shadows=Shadows.attach(engine,{bounds:{min:[-.47,-.045,-.32],max:[1.79,1.05,.32]},
    resolution:1024,filter:'pcf',normalBias:.0030});
  exhibit=buildScrew(engine,shadows);
  volume.value=litersPerTurn.toFixed(2);travel.value=(100*pitch).toFixed(1);
  readouts();draw();
  await engine.gpu.queue.onSubmittedWorkDone();
  await new Promise(requestAnimationFrame);
  if(stop.signal.aborted)return;
  wire();
  observer=new ResizeObserver(()=>{if(size())schedule();});
  observer.observe(canvas);
  speed.disabled=button.disabled=false;
  loading.hidden=true;
  document.body.dataset.renderer=fallback?'compatibility':'webgpu';
  document.body.dataset.state='ready';
  performance.mark('margo-first-usable-frame');
  schedule();
}
addEventListener('pagehide',event=>{if(!event.persisted)dispose();});
await start().catch(fail);