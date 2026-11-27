import { Engine } from '@margoengine/core';
import { Shadows } from '@margoengine/shadows';
import { buildHarbor } from './harbor.js';
import { clock, dailyRange, tide } from './tide.js';

const canvas=document.getElementById('scene');
const loading=document.getElementById('loading');
const slider=document.getElementById('hour');
const play=document.getElementById('play');
const spring=document.getElementById('spring');
const neap=document.getElementById('neap');
const [time,water,amplitude,trend,behavior]=['clock','water','amplitude','trend','behavior']
  .map(id=>document.getElementById(id));
const controls=[slider,spring,neap,play];
const range={spring:dailyRange('spring'),neap:dailyRange('neap')};
const stop=new AbortController();
let engine,exhibit,observer,frame,playingSince;
let minutes=Number(slider.value);
let mode='spring';
let renderedMinutes,renderedMode;
let interaction=false;

function size(){
  const ratio=Math.min(1.70,Math.max(1.20,devicePixelRatio));
  const width=Math.max(1,Math.round(canvas.clientWidth*ratio));
  const height=Math.max(1,Math.round(canvas.clientHeight*ratio));
  if(canvas.width===width&&canvas.height===height)return false;
  canvas.width=width;
  canvas.height=height;
  return true;
}

function camera(){
  const aspect=canvas.clientWidth/Math.max(1,canvas.clientHeight);
  const distance=Math.max(40.7,50.4/aspect);
  const yaw=.35;
  const pitch=.445;
  const aim=[0,-1.15,-.80];
  const ground=distance*Math.cos(pitch);
  engine.camera.target=aim;
  engine.camera.position=[aim[0]+Math.sin(yaw)*ground,aim[1]+Math.sin(pitch)*distance,aim[2]+Math.cos(yaw)*ground];
}

function display(model){
  time.value=clock(minutes/60);
  slider.style.setProperty('--progress',(100*minutes/1440)+'%');
  slider.setAttribute('aria-valuetext',time.value+' model time');
  const magnitude=Math.abs(model.height).toFixed(2);
  water.value=magnitude==='0.00'?magnitude:(model.height>0?'+':'−')+magnitude;
  amplitude.value=range[mode].range.toFixed(2);
  trend.textContent=Math.abs(model.rate)<.025?'Near a turning point':model.rate>0?'Rising':'Falling';
  document.body.dataset.level=model.height.toFixed(3);
  document.body.dataset.mode=mode;
  behavior.textContent=mode==='spring'
    ?'Lunar and solar tides mostly reinforce each other.'
    :'Lunar and solar tides partly cancel each other.';
  spring.setAttribute('aria-pressed',String(mode==='spring'));
  neap.setAttribute('aria-pressed',String(mode==='neap'));
}

function render(){
  const hours=minutes/60;
  if(minutes!==renderedMinutes||mode!==renderedMode){
    const value=tide(mode,hours);
    exhibit.update(value.height,hours);
    display(value);
    renderedMinutes=minutes;
    renderedMode=mode;
  }
  camera();
  engine.render({delta:0});
  if(interaction&&!performance.getEntriesByName('margo-first-input-applied').length){
    performance.mark('margo-first-input-applied');
    engine.gpu.queue.onSubmittedWorkDone().then(()=>{
      if(!stop.signal.aborted)performance.mark('margo-first-input-rendered');
    }).catch(fail);
  }
  interaction=false;
}

function cancel(){
  playingSince=undefined;
  play.textContent='Play the day';
}

function update(now){
  frame=undefined;
  if(stop.signal.aborted)return;
  try{
    if(playingSince!==undefined){
      minutes=Math.min(1440,Math.max(0,Math.round((now-playingSince)/43)*5));
      slider.value=String(minutes);
      if(minutes>=1440)cancel();
    }
    render();
    if(playingSince!==undefined)schedule();
  }catch(error){fail(error);}
}

function schedule(){
  if(frame===undefined&&!stop.signal.aborted)frame=requestAnimationFrame(update);
}

function choose(value){
  mode=value;
  interaction=true;
  schedule();
}

function wire(){
  const options={signal:stop.signal};
  slider.addEventListener('input',()=>{
    cancel();
    minutes=Number(slider.value);
    interaction=true;
    schedule();
  },options);
  spring.addEventListener('click',()=>choose('spring'),options);
  neap.addEventListener('click',()=>choose('neap'),options);
  play.addEventListener('click',()=>{
    if(playingSince!==undefined)cancel();
    else {
      minutes=0;
      slider.value='0';
      play.textContent='Stop playback';
      playingSince=performance.now();
    }
    interaction=true;
    schedule();
  },options);
}

function dispose(){
  stop.abort();
  if(frame!==undefined)cancelAnimationFrame(frame);
  observer?.disconnect();
  exhibit?.dispose();
  engine?.dispose();
}

function fail(error){
  if(stop.signal.aborted)return;
  document.body.dataset.state='error';
  loading.hidden=false;
  loading.textContent='The harbor could not open. '+(error?.message??error);
  controls.forEach(control=>{control.disabled=true;});
  dispose();
  console.error(error);
}

async function start(){
  size();
  const forced=new URLSearchParams(location.search).get('backend')==='webgl2';
  const open=()=>Engine.create(canvas,{backend:'webgpu',exactSize:true,antialias:true,
    camera:{near:.38,far:215,fov:39},signal:stop.signal});
  if(!forced){
    try{engine=await open();}
    catch(error){if(error?.code!=='unsupported')throw error;}
  }
  const compatible=!engine;
  if(compatible){
    const {install}=await import('@margoengine/webgl2-compat');
    await install({force:true,signal:stop.signal});
    engine=await open();
  }
  engine.onError=fail;
  engine.scene.background='#698790';
  engine.lighting.direction.set([-.52,.68,.49,2.23]);
  engine.lighting.radiance.set([1,.97,.85,.64]);
  engine.lighting.ambient.set([.54,.70,.77]);
  const shadows=Shadows.attach(engine,{
    bounds:{min:[-17,-3.7,-17],max:[17,9,17]},resolution:1024,filter:'pcf',normalBias:.028,
  });
  exhibit=buildHarbor(engine,shadows);
  render();
  await engine.gpu.queue.onSubmittedWorkDone();
  await new Promise(requestAnimationFrame);
  if(stop.signal.aborted)return;
  wire();
  observer=new ResizeObserver(()=>{if(size())schedule();});
  observer.observe(canvas);
  controls.forEach(control=>{control.disabled=false;});
  loading.hidden=true;
  document.body.dataset.renderer=compatible?'compatibility':'webgpu';
  document.body.dataset.state='ready';
  performance.mark('margo-first-usable-frame');
}
addEventListener('pagehide',event=>{if(!event.persisted)dispose();});
await start().catch(fail);