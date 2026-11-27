import {AnisotropicPainterly} from '@margoengine/creative/paint-aniso';
import {prepareLand} from './land.js';
import {animateLand} from './land-view.js';

export {prepareLand};

const profiles={
  fine:{radius:3,anisotropy:.77,strength:.90,note:'Fine strokes preserve the edges of grass and stone.'},
  broad:{radius:7,anisotropy:.95,strength:1,note:'Broad strokes gather the cliffs and water into larger patches of colour.'},
  plain:{radius:3,anisotropy:0,strength:0,note:'The same moving landscape with its brush filter off.'},
};

const frame=()=>new Promise(resolve=>requestAnimationFrame(resolve));

export async function show({engine,land,canvas,notice,status,size,signal,fail}){
  const brush=document.querySelector('fieldset');
  const motion=document.querySelector('#motion');
  const detail=document.querySelector('#detail');
  const phone=matchMedia('(max-width:650px)');
  const reduced=matchMedia('(prefers-reduced-motion: reduce)');
  const compat=engine.gpu.adapterInfo?.vendor==='margo-webgl2';
  let brushName='fine',paused=reduced.matches,seconds=1.4,prior=0,animation=0,busy=false,serial=0;
  let inputPending=false,dirty=false,first=true;
  document.querySelector('#renderer').textContent=compat?'Margo WebGL2':'Margo WebGPU';
  canvas.dataset.renderer=compat?'compatibility':'webgpu';
  canvas.dataset.triangles=String(land.indices.length/3);
  engine.scene.background='#bd9e93';
  engine.use(animateLand(land,()=>seconds));
  const paint=AnisotropicPainterly.attach(engine,{radius:3,strength:profiles.fine.strength,
    anisotropy:profiles.fine.anisotropy,sharpness:7});

  function compose(){
    const camera=engine.camera;
    camera.position=phone.matches?[12.22,12.29,23.8]:[12.00,12.29,23.8];
    camera.target=phone.matches?[-9.25,2.82,-75]:[-11.03,3.12,-75];
    camera.fov=phone.matches?52:44;
  }
  function labels(){
    motion.textContent=paused?'Play motion':'Pause motion';
    canvas.dataset.motion=paused?'paused':'playing';
    detail.textContent=profiles[brushName].note;
  }

  async function draw(now){
    animation=0;
    if(signal.aborted||busy)return;
    busy=true;
    const commit=inputPending;
    inputPending=false;
    dirty=false;
    if(!paused&&prior)seconds+=Math.min((now-prior)*.001,.075);
    prior=paused?0:now;
    try{
      const renderedBrush=brushName;
      engine.render(0);
      await engine.gpu.queue.onSubmittedWorkDone();
      if(signal.aborted)return;
      canvas.dataset.time=seconds.toFixed(4);
      canvas.dataset.brush=renderedBrush;
      canvas.dataset.frame=String(++serial);
      if(commit){
        await frame();
        if(signal.aborted)return;
        performance.mark('painting-input-rendered');
        if(first){
          first=false;
          performance.mark('painting-first-input-rendered');
        }
      }
    }catch(error){
      fail(error);
    }finally{
      busy=false;
      if(!paused||dirty)schedule();
    }
  }
  function schedule(){
    if(signal.aborted||animation||busy)return;
    animation=requestAnimationFrame(draw);
  }
  function invalidate(event){
    inputPending||=event.isTrusted;
    dirty=true;
    schedule();
  }

  compose();
  labels();
  engine.render(0);
  await engine.gpu.queue.onSubmittedWorkDone();
  signal.throwIfAborted();
  canvas.dataset.brush=brushName;
  canvas.dataset.time=seconds.toFixed(4);
  canvas.dataset.frame=String(++serial);
  if(status.ready()){
    notice.hidden=true;
    for(const button of document.querySelectorAll('button,input'))button.disabled=false;
    performance.mark('painting-ready');
  }
  brush.addEventListener('change',event=>{
    const profile=profiles[event.target.value];
    if(!profile)return;
    brushName=event.target.value;
    paint.options.radius=profile.radius;
    paint.options.anisotropy=profile.anisotropy;
    paint.options.strength=profile.strength;
    labels();
    invalidate(event);
  },{signal});
  motion.addEventListener('click',event=>{
    paused=!paused;
    prior=0;
    labels();
    invalidate(event);
  },{signal});
  reduced.addEventListener('change',()=>{
    if(reduced.matches){
      paused=true;
      prior=0;
      labels();
    }
  },{signal});
  const observer=new ResizeObserver(()=>{
    if(!size())return;
    compose();
    dirty=true;
    schedule();
  });
  observer.observe(canvas);
  signal.addEventListener('abort',()=>{
    cancelAnimationFrame(animation);
    observer.disconnect();
  },{once:true});
  if(!paused)schedule();
}
