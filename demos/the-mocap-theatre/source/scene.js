import {theatre} from './theatre.js';
import {performer,readPerformer} from './performer.js';
import {capture,readCapture,recordings} from './captures.js';
import {showRig} from './source-rig.js';

const nextFrame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
export async function mount({engine,actor,takes,canvas,notice,signal,size,fail}){
  const get=id=>document.getElementById(id),data=canvas.dataset;
  data.renderer=engine.backend==='webgl2'?'compatibility':'webgpu';
  get('renderer').textContent=data.renderer==='webgpu'?'Margo WebGPU':'Margo WebGL2';
  engine.scene.background='#3d2d32';
  engine.lighting.direction.set([-.48,.72,.62,3.32]);
  engine.lighting.radiance.set([1,.84,.71,.36]);
  engine.lighting.ambient.set([.61,.65,.83]);

  theatre(engine);
  const lead=performer(engine,readPerformer(actor));
  const ghost=showRig(engine);
  const clips=Object.fromEntries(Object.entries(takes).map(([name,text])=>
    [name,capture(name,readCapture(name,text),lead.skeleton)]));
  performance.mark('mocap-stage');
  const keys=Object.keys(clips);
  const play=get('play'),seek=get('seek'),timeText=get('time'),caption=get('take'),counts=get('rig-count'),angle=get('angle');
  let active=clips.walk,time=.420,playing=false,previous,renderAt=0,frame=0,draws=0,queued=0,applied=0,dirty=true;

  function trackInfo(){
    const name=active.name;
    const recording=recordings[name];
    for(const key of keys)get(key).setAttribute('aria-pressed',String(key===name));
    seek.max=active.duration.toFixed(3);
    caption.textContent=recording.credit;
    counts.textContent=active.mapped+' joints mapped · '+recording.width;
    data.clip=name;
    data.joints=String(active.mapped);
    data.sourceJoints=String(active.bones.length);
  }
  function playState(){
    play.textContent=playing?'Pause':time>=active.duration-.001?'Replay':'Play';
    data.playing=String(playing);
  }
  function setView(side){
    const yaw=side?-1.57:-.26;
    angle.setAttribute('aria-pressed',String(side));
    angle.textContent=side?'Front view':'Side view';
    data.view=side?'side':'front';
    lead.setAngle(yaw);
    ghost.setAngle(yaw);
  }
  function pose(){
    active.draw(time);
    const trace=ghost.draw(active),height=lead.draw();
    engine.render(0);
    seek.value=String(time);
    timeText.textContent=time.toFixed(2)+' s';
    data.time=time.toFixed(3);
    data.height=height.toFixed(4);
    data.sourcePose=trace.map(v=>v.toFixed(4)).join(',');
    data.frame=String(++draws);
  }
  function animate(now){
    if(signal.aborted)return;
    frame=requestAnimationFrame(animate);
    try{
      if(playing&&(now-renderAt>=32||dirty)){
        time=Math.min(active.duration,time+(previous===undefined?0:(now-previous)/1000));
        if(time>=active.duration){playing=false;playState();}
        dirty=true;
      }
      if(!dirty)return;
      dirty=false;renderAt=now;previous=now;
      pose();
      if(queued>applied){
        const revision=queued;applied=revision;
        Promise.resolve(engine.gpu?.queue.onSubmittedWorkDone()).then(nextFrame).then(()=>{
          if(signal.aborted)return;
          performance.mark('mocap-input-rendered');
          if(revision===1)performance.mark('mocap-first-input');
        }).catch(fail);
      }
    }catch(error){fail(error);}
  }
  function receive(event,change){
    if(change()===false)return;
    if(event.isTrusted)queued++;
    dirty=true;
  }
  for(const key of keys)get(key).addEventListener('click',event=>receive(event,()=>{
    if(active===clips[key])return false;
    active=clips[key];time=.420;previous=undefined;
    trackInfo();playState();
  }),{signal});
  seek.addEventListener('input',event=>receive(event,()=>{
    playing=false;time=Number(seek.value);previous=undefined;
    playState();
  }),{signal});
  angle.addEventListener('click',event=>receive(event,()=>setView(data.view!=='side')),{signal});
  play.addEventListener('click',event=>receive(event,()=>{
    if(time>=active.duration-.001)time=0;
    playing=!playing;previous=undefined;playState();
  }),{signal});
  const resize=new ResizeObserver(()=>{if(!signal.aborted&&size())dirty=true;});
  signal.addEventListener('abort',()=>{cancelAnimationFrame(frame);resize.disconnect();},{once:true});
  trackInfo();playState();setView(new URLSearchParams(location.search).get('view')==='side');pose();
  if(engine.gpu)await engine.gpu.queue.onSubmittedWorkDone();
  await nextFrame();
  signal.throwIfAborted();
  notice.hidden=true;
  for(const button of [...keys.map(get),play,seek,angle])button.disabled=false;
  data.ready='true';performance.mark('mocap-ready');
  resize.observe(canvas);
  frame=requestAnimationFrame(animate);
}
