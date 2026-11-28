import { Engine } from '@margoengine/core';
import { Inspector } from '@margoengine/inspector';
import { Stats } from '@margoengine/stats';
import { Shadows } from '@margoengine/shadows';
import { makeBench,lensRest,lensTravel } from './art.js';
import { dockPanel,revealSelection } from './panel.js';

export async function openBench(canvas,{tree,statsHost,compatibility,timestamps,signal,fail,report,frameReport,frameError,inputRendered}){
  let engine,inspector,stats,shadows,bench,debug,observer,raf=0,last=0;
  let closed=false,first=false,receipt=false,waiting=false,recording=false;

  function close(){
    if(closed)return;
    closed=true;
    cancelAnimationFrame(raf);
    observer?.disconnect();
    debug?.dispose();
    shadows?.dispose();
    inspector?.dispose();
    stats?.dispose();
    engine?.dispose();
  }
  signal.addEventListener('abort',close,{once:true});
  function fit(){
    const dpr=Math.min(devicePixelRatio,2,1440/Math.max(1,canvas.clientWidth));
    const w=Math.max(1,Math.round(canvas.clientWidth*dpr)),h=Math.max(1,Math.round(canvas.clientHeight*dpr));
    if(canvas.width!==w)canvas.width=w;
    if(canvas.height!==h)canvas.height=h;
    // Preserve the horizontal framing as the portrait display narrows.
    const lensFit=Math.min(1,.91*w/h);
    engine.camera.fov=2*Math.atan(.247/lensFit)*180/Math.PI;
  }
  function paint(elapsed){
    engine.render({delta:elapsed});
    const {lens}=bench;
    report({
      position:lens.position.x,extended:lens.position.x>lensRest+lensTravel*.5,
      offset:lens.position.x-lensRest,selection:inspector.selected?.name??'',history:inspector.history.undoCount,
      wireframe:inspector.debug.wireframe,normals:inspector.debug.normals,
      draws:stats.drawCalls,frameTime:stats.frameTime,fps:stats.fps,samples:stats.sampleCount,compatibility,
    });
    if(receipt&&!waiting&&!first){
      waiting=true;
      performance.mark('inspector-edit-submitted');
      void engine.gpu.queue.onSubmittedWorkDone().then(()=>{
        if(closed)return;
        first=true;
        inputRendered();
      }).catch(fail);
    }
  }
  function schedule(){
    if(!raf&&!closed&&!document.hidden)raf=requestAnimationFrame(update);
  }
  function update(timestamp){
    raf=0;
    if(signal.aborted||document.hidden)return;
    try{
      const elapsed=last?Math.max(0,Math.min(.08,(timestamp-last)/1000)):1/60;
      last=timestamp;
      paint(elapsed);
      schedule();
    }catch(error){fail(error);}
  }
  function slide(trusted){
    const {lens}=bench;
    const previous=lens.position.x;
    const next=previous>lensRest+lensTravel*.5?lensRest:lensRest+lensTravel;
    const set=value=>{lens.position.x=value;};
    try{
      inspector.select(lens);
      revealSelection(inspector);
      set(next);
      inspector.history.record({label:'Slide lens cartridge',undo:()=>set(previous),redo:()=>set(next)});
      receipt=receipt||trusted;
      schedule();
    }catch(error){fail(error);}
  }
  function toggle(mode){
    try{inspector.setDebug(mode,!inspector.debug[mode]);schedule();}catch(error){fail(error);}
  }
  async function capture(){
    if(recording||closed)return;
    recording=true;
    let timer;
    try{
      const {FrameDebugger}=await import('@margoengine/inspector/frame');
      signal.throwIfAborted();
      debug=FrameDebugger.attach(engine,{parent:null});
      timer=setTimeout(()=>debug?.dispose(),7000);
      const result=await debug.capture({render:true});
      signal.throwIfAborted();
      frameReport(result);
    }catch(error){
      if(!signal.aborted)frameError(error);
    }finally{
      clearTimeout(timer);
      debug?.dispose();
      debug=null;
      recording=false;
    }
  }
  function visibility(){
    if(document.hidden){cancelAnimationFrame(raf);raf=last=0;}
    else schedule();
  }

  try{
    canvas.width=Math.max(1,canvas.clientWidth);
    canvas.height=Math.max(1,canvas.clientHeight);
    engine=await Engine.create(canvas,{backend:'webgpu',features:timestamps?['timestamp-query']:undefined,
      signal,exactSize:true,antialias:true,capacity:70,startupTimeout:9500,
      camera:{near:.15,far:24,position:[1.69,1.42,2.70],target:[.005,.193,0]}});
    engine.onError=fail;
    performance.mark('inspector-device');
    fit();
    bench=makeBench(engine);
    shadows=Shadows.attach(engine,{resolution:1024,filter:'pcf',
      bounds:{min:[-1.13,-.18,-.51],max:[1.13,.76,.51]}});
    shadows.add(bench.bench);
    inspector=Inspector.attach(engine,{parent:tree});
    stats=Stats.attach(engine,{parent:statsHost,samples:90});
    dockPanel(inspector,stats);
    inspector.select(bench.lens);
    revealSelection(inspector);
    paint(0);
    performance.mark('inspector-first-submitted');
    signal.throwIfAborted();
  }catch(error){close();throw error;}
  observer=new ResizeObserver(()=>{
    try{fit();schedule();}catch(error){fail(error);}
  });
  observer.observe(canvas);
  document.addEventListener('visibilitychange',visibility,{signal});
  schedule();
  return {slide,toggle,capture};
}
