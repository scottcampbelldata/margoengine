import { startEngine } from '@margoengine/webgl2-compat/auto';
import { EnvironmentLighting } from '@margoengine/environment';
import { Shadows } from '@margoengine/shadows';
import { describeCheck } from '@margoengine/machinery/rigs';
import { buildInstrument } from './rig.js';
import { apparentSpeed, defaultSpeed, openRotor } from './mechanism.js';

const canvas=document.querySelector('#scene'),loading=document.querySelector('#loading');
const sampling=document.querySelector('#sampling'),rate=document.querySelector('#rate');
const motion=document.querySelector('#motion'),apparent=document.querySelector('#apparent');
const play=document.querySelector('#play'),step=document.querySelector('#step');
const gap=document.querySelector('#check');
const controls=[sampling,play,step];
const lifetime=new AbortController();
const reduced=matchMedia('(prefers-reduced-motion: reduce)');

let engine,instrument,rotor,observer,frame,last,flashRate;
let playing=!reduced.matches, inputQueued=false;

function softboxes() {
  const width=64,height=32,data=new Float32Array(width*height*4);
  const cards=[
    [-.81,.73,.62,.25,[6.9,5.6,4.4]],
    [1.42,.33,.43,.58,[3.2,4.1,5.0]],
    [2.74,.19,.44,.25,[4.5,3.4,2.6]],
  ];
  for(let y=0;y<height;y++){
    const pitch=Math.PI*(.5-(y+.5)/height);
    for(let x=0;x<width;x++){
      const yaw=Math.PI*(2*(x+.5)/width-1);
      const level=.08+.19*Math.max(0,Math.sin(pitch));
      const values=[level,level*.91,level*1.09,1];
      for(const [bearing,elevation,w,h,color] of cards){
        const d=Math.atan2(Math.sin(yaw-bearing),Math.cos(yaw-bearing));
        const f=Math.exp(-1.75*((d/w)**4+((pitch-elevation)/h)**4));
        for(let c=0;c<3;c++) values[c]+=color[c]*f;
      }
      data.set(values,(y*width+x)*4);
    }
  }
  return {width,height,data};
}

function resize() {
  const bounds=canvas.getBoundingClientRect(),density=Math.min(devicePixelRatio,1.5);
  const width=Math.max(1,Math.round(bounds.width*density)),height=Math.max(1,Math.round(bounds.height*density));
  if(canvas.width!==width)canvas.width=width;
  if(canvas.height!==height)canvas.height=height;
  if(!engine)return;
  const distance=Math.max(1,1.55*height/width);
  const target=[0,.125,.024];
  const offset=[.056,.187,.733];
  engine.camera.target=target;
  engine.camera.position=target.map((value,axis)=>value+distance*offset[axis]);
}

function draw(now) {
  const sampleRate=sampling.valueAsNumber;
  if(sampleRate!==flashRate){ rotor.setFlashRate(sampleRate); flashRate=sampleRate; }
  if(playing&&last!==undefined)rotor.advance(Math.max(0,Math.min((now-last)*.001,.1)));
  last=playing?now:undefined;
  const pose=rotor.pose();
  const speed=apparentSpeed(defaultSpeed,sampleRate);
  instrument.pose(pose.reference,pose.sampled);
  engine.render();
  rate.value=sampleRate.toFixed(1)+' Hz';
  sampling.setAttribute('aria-valuetext',sampleRate.toFixed(1)+' hertz');
  motion.value=speed===0?'Stationary':speed>0?'Forward':'Reverse';
  apparent.value=Number(Math.abs(speed).toFixed(1)).toString();
  document.body.dataset.rate=sampling.value;
  document.body.dataset.apparent=String(Number(speed.toFixed(4)));
  document.body.dataset.sample=String(pose.flash);
  document.body.dataset.check=gap.textContent=describeCheck(rotor.check);
  document.body.dataset.phase=pose.sampled.toFixed(6);
  document.body.dataset.reference=pose.reference.toFixed(6);
  document.body.dataset.playing=String(playing);
  if(inputQueued){
    performance.mark('margo-sampling-rendered');
    inputQueued=false;
  }
  if(playing)schedule();
}

function schedule() {
  if(frame!==undefined||lifetime.signal.aborted)return;
  frame=requestAnimationFrame((now)=>{
    frame=undefined;
    try{draw(now);}catch(error){fail(error);}
  });
}

function setPlaying(next) {
  playing=next;
  last=undefined;
  play.textContent=playing?'Pause':'Play';
  step.disabled=playing;
  schedule();
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
  controls.forEach(control=>{control.disabled=true;});
  loading.hidden=false;
  loading.textContent='The stroboscope could not open in this browser.';
  console.error(error);
  dispose();
}

async function start() {
  resize();
  const opening=startEngine(canvas,{
    exactSize:true,antialias:true,capacity:125,
    startupTimeout:9500,signal:lifetime.signal,camera:{fov:35,near:.040,far:19},
    forceCompat:location.search.includes('backend=webgl2'),
    loadCompat:()=>import('@margoengine/webgl2-compat'),
  });
  flashRate=sampling.valueAsNumber;
  const solving=openRotor(defaultSpeed,flashRate,lifetime.signal);
  const {engine:device,renderer}=await opening;
  engine=device;
  rotor=await solving;
  engine.onError=fail;
  engine.scene.background='#6b5866';
  engine.lighting.direction.set([-.46,.80,.39,1.88]);
  engine.lighting.ambient.set([.65,.58,.68]);
  engine.lighting.radiance.set([1,.922,.813,.50]);
  const shadows=Shadows.attach(engine,{
    resolution:1024,filter:'soft',lightSize:.072,normalBias:.0005,
    bounds:{min:[-.39,-.05,-.23],max:[.39,.34,.24]},
  });
  await EnvironmentLighting.load(engine,softboxes(),{
    size:32,specularSize:32,intensity:1.04,signal:lifetime.signal,
  });
  instrument=buildInstrument(engine,shadows);
  resize();
  draw(performance.now());
  await engine.gpu.queue.onSubmittedWorkDone();
  await new Promise(requestAnimationFrame);
  if(lifetime.signal.aborted)return;
  const options={signal:lifetime.signal};
  sampling.addEventListener('input',()=>{inputQueued=true;schedule();},options);
  play.addEventListener('click',()=>setPlaying(!playing),options);
  step.addEventListener('click',()=>{
    rotor.nextFlash();
    schedule();
  },options);
  reduced.addEventListener('change',(event)=>{if(event.matches)setPlaying(false);},options);
  observer=new ResizeObserver(()=>{resize();schedule();});
  observer.observe(canvas);
  sampling.disabled=false;
  play.disabled=false;
  setPlaying(playing);
  loading.hidden=true;
  document.body.dataset.renderer=renderer;
  document.body.dataset.state='ready';
  performance.mark('margo-first-usable-frame');
}

window.addEventListener('pagehide',(event)=>{if(!event.persisted)dispose();},{signal:lifetime.signal});
start().catch(fail);

