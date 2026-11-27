import { Engine } from '@margoengine/core';
import { EnvironmentLighting } from '@margoengine/environment';
import { measure, soundSpeed } from './model.js';
import { makeSurvey } from './rig.js';

const canvas=document.querySelector('#scene'),loading=document.querySelector('#loading');
const receiver=document.querySelector('#receiver'),position=document.querySelector('#position');
const west=document.querySelector('#west-delay'),east=document.querySelector('#east-delay');
const send=document.querySelector('#send'),view=document.querySelector('#view'),sound=document.querySelector('#sound');
const arrivals=document.querySelector('#arrivals');
const lifetime=new AbortController(),reduced=matchMedia('(prefers-reduced-motion: reduce)');
const Audio=window.AudioContext??window.webkitAudioContext;
let engine,survey,observer,frame,measurement,pulseTime=null;
let detail=false,changed=false,audio,impulse;

function skyMap() {
  const width=64,height=32,data=new Float32Array(width*height*4);
  for(let y=0;y<height;y++){
    const altitude=Math.sin(Math.PI*(.5-(y+.5)/height));
    for(let x=0;x<width;x++){
      const azimuth=2*Math.PI*((x+.5)/width-.5);
      const sky=Math.max(0,altitude),rim=Math.exp(-6*Math.abs(altitude));
      const sun=Math.max(0,Math.cos(azimuth+.7))*Math.exp(-((altitude-.56)**2)*17);
      data.set([.17+.22*sky+.28*rim+sun*1.13,.17+.32*sky+.20*rim+sun*.72,
        .16+.43*sky+.13*rim+sun*.40,1],(y*width+x)*4);
    }
  }
  return {width,height,data};
}

function size() {
  const bounds=canvas.getBoundingClientRect(),density=Math.min(devicePixelRatio,1.5);
  const width=Math.max(1,Math.round(bounds.width*density)),height=Math.max(1,Math.round(bounds.height*density));
  if(canvas.width!==width)canvas.width=width;
  if(canvas.height!==height)canvas.height=height;
  if(engine){
    const scale=Math.max(1,1.48*height/width);
    const target=[0,13,-7];
    const offset=detail?[0,190,1.1]:[15,130,151];
    engine.camera.target=target;
    engine.camera.position=target.map((value,i)=>value+offset[i]*scale);
  }
}

function preparePaths() {
  const x=receiver.valueAsNumber;
  measurement=measure(x);
  pulseTime=null;
  survey.configure(measurement);
  position.value=x===0?'Center':Math.abs(x)+' m '+(x<0?'west':'east');
  receiver.setAttribute('aria-valuetext',x===0?'Center':Math.abs(x)+' meters '+(x<0?'west':'east'));
  west.value=String(Math.round(measurement.reflected[0].delay*1000));
  east.value=String(Math.round(measurement.reflected[1].delay*1000));
}

function draw(now) {
  const paths=[measurement.direct,...measurement.reflected];
  const distance=pulseTime===null?-1:Math.max(0,(now-pulseTime)*.001*soundSpeed*.25);
  survey.pose(distance);
  engine.render();
  document.body.dataset.receiver=receiver.value;
  document.body.dataset.delays=west.value+','+east.value;
  const count=paths.filter(path=>path.length<=distance).length;
  document.body.dataset.arrivals=String(count);
  const status=pulseTime===null?'Ready':['Pulse sent','Direct sound arrived','Two arrivals','All three arrived'][count];
  if(arrivals.textContent!==status)arrivals.textContent=status;
  if(changed) {
    performance.mark('margo-echo-input-rendered');
    changed=false;
  }
  if(pulseTime!==null&&distance<Math.max(...paths.map(path=>path.length)))schedule();
}

function schedule() {
  if(frame!==undefined||lifetime.signal.aborted)return;
  frame=requestAnimationFrame(now=>{
    frame=undefined;
    try{draw(now);}catch(error){fail(error);}
  });
}

function audioImpulse(context) {
  const values=context.createBuffer(1,Math.round(context.sampleRate*.045),context.sampleRate);
  const samples=values.getChannelData(0);
  let last=0;
  for(let i=0;i<samples.length;i++){
    const t=i/context.sampleRate;
    const noise=(((Math.sin(i*12.9898)*43758.5453)%1)+1)%1-.5;
    last=.70*last+.30*noise;
    const transient=.67*Math.sin(t*2*Math.PI*1160)+.22*Math.sin(t*2*Math.PI*552)+.45*last;
    samples[i]=transient*Math.min(1,t*950)*Math.exp(-t*135);
  }
  return values;
}

async function playArrivals(snapshot) {
  if(!Audio||!sound.checked)return;
  try{
    audio??=new Audio();
    impulse??=audioImpulse(audio);
    await audio.resume();
    if(lifetime.signal.aborted||!sound.checked)return;
    const begin=audio.currentTime+.030;
    for(const [i,path] of [snapshot.direct,...snapshot.reflected].entries()){
      const track=audio.createBufferSource(),gain=audio.createGain(),pan=audio.createStereoPanner();
      track.buffer=impulse;
      gain.gain.value=path.gain*.10;
      pan.pan.value=i===0?0:i===1?-.54:.54;
      track.connect(gain).connect(pan).connect(audio.destination);
      track.start(begin+path.time-snapshot.direct.time);
    }
  }catch{
    sound.checked=false;
    sound.disabled=true;
  }
}

function dispose() {
  lifetime.abort();
  observer?.disconnect();
  if(frame!==undefined)cancelAnimationFrame(frame);
  engine?.dispose();
  audio?.close().catch(()=>{});
}
function fail(error) {
  if(lifetime.signal.aborted)return;
  document.body.dataset.state='error';
  for(const control of [receiver,send,view,sound])control.disabled=true;
  loading.hidden=false;
  loading.textContent='The canyon could not open in this browser.';
  console.error(error);
  dispose();
}

async function start() {
  const force=new URLSearchParams(location.search).get('backend')==='webgl2';
  const open=()=>Engine.create(canvas,{
    backend:'webgpu',exactSize:true,antialias:true,capacity:225,
    startupTimeout:9500,signal:lifetime.signal,camera:{fov:37,near:2.1,far:530},
  });
  size();
  if(!force){
    try{engine=await open();}
    catch(error){if(error?.code!=='unsupported')throw error;}
  }
  const compat=!engine;
  if(compat){
    const {install}=await import('@margoengine/webgl2-compat');
    await install({force:true,signal:lifetime.signal});
    engine=await open();
  }
  engine.onError=fail;
  engine.scene.background='#9caaa5';
  engine.lighting.direction.set([-.54,.71,.45,1.94]);
  engine.lighting.ambient.set([.68,.66,.63]);
  engine.lighting.radiance.set([1,.91,.76,.51]);
  await EnvironmentLighting.load(engine,skyMap(),{
    size:32,specularSize:32,intensity:.88,signal:lifetime.signal,
  });
  survey=makeSurvey(engine);
  size();
  preparePaths();
  draw(performance.now());
  await engine.gpu.queue.onSubmittedWorkDone();
  await new Promise(requestAnimationFrame);
  if(lifetime.signal.aborted)return;
  const options={signal:lifetime.signal};
  receiver.addEventListener('input',()=>{preparePaths();changed=true;schedule();},options);
  send.addEventListener('click',()=>{
    if(reduced.matches) {
      pulseTime=performance.now()-4000;
    } else pulseTime=performance.now();
    changed=true;
    schedule();
    playArrivals(measurement);
  },options);
  view.addEventListener('click',()=>{
    detail=!detail;
    view.setAttribute('aria-pressed',String(detail));
    view.textContent=detail?'Canyon view':'Overhead';
    size();
    schedule();
  },options);
  observer=new ResizeObserver(()=>{size();schedule();});
  observer.observe(canvas);
  for(const control of [receiver,send,view])control.disabled=false;
  sound.disabled=!Audio;
  loading.hidden=true;
  document.body.dataset.renderer=compat?'compatibility':'webgpu';
  document.body.dataset.state='ready';
  performance.mark('margo-first-usable-frame');
}

window.addEventListener('pagehide',event=>{if(!event.persisted)dispose();},{signal:lifetime.signal});
start().catch(fail);


