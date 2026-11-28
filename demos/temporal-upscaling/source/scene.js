import {TAAUpscale} from '@margoengine/taa/upscale';
import {cameraAt,lightSky} from './art.js';

const by=id=>document.getElementById(id);
const names=['native','spatial','temporal'];
const half=.5;
const warmFrames=80;

export function mount({opening,art,viewport,canvas,loading,page,signal,fail,resize,field,cameraControls}){
  const buttons=[...field.querySelectorAll('button')],view=by('view'),play=by('play');
  const sceneSize=by('scene-size'),outputSize=by('output-size'),history=by('history');
  let engine,effect,observer,request=0,remaining=0,frameNumber=0;
  let selected='native',shown='native',playing=false,busy=false,publishing=false;
  let phase=0,angle=0,previous=0,lastDescription='';

  function photo(){
    const camera=cameraAt(canvas.width,canvas.height,phase);
    engine.camera.position=camera.position;
    engine.camera.target=camera.target;
    engine.camera.fov=camera.fov;
  }
  function dimensions(){
    const w=canvas.width,h=canvas.height;
    const size=shown==='native'?[w,h]:[Math.round(w*half),Math.round(h*half)];
    viewport.dataset.raster=size.join('x');
    viewport.dataset.output=[w,h].join('x');
    sceneSize.value=size.join(' × ');
    outputSize.value=[w,h].join(' × ');
  }
  function describe(){
    viewport.dataset.mode=shown;
    viewport.dataset.playing=String(playing);
    play.setAttribute('aria-pressed',String(playing));
    play.textContent=playing?'Pause sweep':'Sweep camera';
    for(const button of buttons)button.setAttribute('aria-pressed',String(button.dataset.mode===shown));
    dimensions();
    const text=shown==='temporal'?(playing?'Reprojecting moving frames':remaining?'Accumulating history': 'History accumulated'):
      shown==='spatial'?'Lanczos filter':'';
    if(text!==lastDescription){
      history.textContent=text;
      lastDescription=text;
    }
  }
  function select(key){
    if(key===shown)return;
    if(key==='native'){
      effect?.dispose();
      effect=undefined;
    }else if(effect){
      effect.options.temporal=key==='temporal';
      effect.reset();
    }else{
      effect=TAAUpscale.attach(engine,{
        scale:half,temporal:key==='temporal',historyWeight:.90,sharpen:.18,settle:true,
      });
    }
    remaining=key==='temporal'?warmFrames:0;
    shown=key;
  }
  function schedule(){
    if(request||busy||signal.aborted||page.failed)return;
    request=requestAnimationFrame(draw);
  }
  async function draw(time){
    request=0;
    if(signal.aborted||page.failed)return;
    busy=true;
    try{
      const change=shown!==selected;
      select(selected);
      const resized=resize();
      if(resized&&shown==='temporal')remaining=warmFrames;
      const delta=previous?Math.min(.050,Math.max(.004,(time-previous)/1000)):1/60;
      previous=time;
      if(playing){
        angle+=delta*.46;
        phase=Math.sin(angle)*.86;
        view.value=String(Math.round((phase+1)*500));
      }
      photo();
      engine.render({delta});
      frameNumber++;
      if(remaining>0)remaining--;
      if(change||publishing||(!playing&&remaining===0)){
        publishing=false;
        await engine.gpu.queue.onSubmittedWorkDone();
        if(change)await new Promise(resolve=>requestAnimationFrame(resolve));
        signal.throwIfAborted();
      }
      viewport.dataset.frame=String(frameNumber);
      viewport.dataset.phase=phase.toFixed(4);
      viewport.dataset.remaining=String(remaining);
      describe();
      if(change){
        performance.mark('comparison-frame');
        if(!performance.getEntriesByName('first-control-frame').length)performance.mark('first-control-frame');
      }
    }catch(reason){fail(reason);}
    finally{
      busy=false;
      if(playing||remaining>0||shown!==selected||publishing)schedule();
    }
  }
  function setMode(key){
    if(!names.includes(key)||selected===key)return;
    selected=key;
    performance.mark('comparison-request');
    schedule();
  }
  async function run(){
    engine=await opening;
    signal.throwIfAborted();
    engine.scene.background='#a6b7b6';
    lightSky(engine);
    engine.lighting.direction.set([-.44,.57,.70,2.2]);
    engine.lighting.radiance.set([.99,.87,.70,.54]);
    engine.lighting.ambient.set([.89,.98,1.09]);
    for(const {name,geometry,material} of art){
      engine.createMesh().setGeometry(geometry).setMaterial(material).name='SM_Cableway_'+name;
    }
    photo();
    engine.render();
    await engine.gpu.queue.onSubmittedWorkDone();
    await new Promise(resolve=>requestAnimationFrame(resolve));
    signal.throwIfAborted();
    performance.mark('cableway-frame');
    describe();
    observer=new ResizeObserver(()=>{
      if(!engine||!resize()||signal.aborted)return;
      if(shown==='temporal')remaining=warmFrames;
      publishing=true;
      schedule();
    });
    observer.observe(canvas);
    for(const b of buttons)b.addEventListener('click',()=>setMode(b.dataset.mode),{signal});
    view.addEventListener('input',()=>{
      const next=Number(view.value)/500-1;
      if(Math.abs(next-phase)>.22)effect?.reset();
      phase=next;
      angle=Math.asin(Math.max(-1,Math.min(1,phase/.86)));
      playing=false;
      publishing=true;
      if(shown==='temporal')remaining=warmFrames;
      schedule();
    },{signal});
    play.addEventListener('click',()=>{
      playing=!playing;
      previous=0;
      publishing=true;
      if(!playing&&shown==='temporal')remaining=warmFrames;
      schedule();
    },{signal});
    if(page.ready()){field.disabled=false;cameraControls.disabled=false;loading.hidden=true;}
  }
  run().catch(fail);
  return ()=>{
    observer?.disconnect();
    if(request)cancelAnimationFrame(request);
    effect?.dispose();
  };
}
