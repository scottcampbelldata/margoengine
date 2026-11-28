import { autoEngine } from '@margoengine/webgl2-compat/auto';
import { VoxelPathTracer } from '@margoengine/voxel-pathtracer';
import { loadStudy } from './model.js';

import { camera,imageSize,projection,tracing } from './optics.js';
const nextFrame=()=>new Promise(resolve=>requestAnimationFrame(resolve));

export async function openStudy(initialCanvas,forced,signal,bytes,compatibility,starting,onSamples,onError){
  let engine,tracer,canvas=initialCanvas,error,study,resize,raf,disposed=false,usable=false,paused=false;
  let revision=1;
  function close(){
    if(disposed)return;
    disposed=true;
    cancelAnimationFrame(raf);
    resize?.disconnect();
    tracer?.dispose();
    engine?.dispose();
  }
  signal.addEventListener('abort',close,{once:true});
  const install=async()=>{
    if(compatibility){
      const result=await compatibility;
      if(result.error)throw result.error;
    }else await (await import('./compatibility.js')).installCompatibility(forced,signal);
  };
  function adjust(){
    const ratio=Math.min(devicePixelRatio,2,imageSize[0]/Math.max(1,canvas.clientWidth),imageSize[1]/Math.max(1,canvas.clientHeight));
    const width=Math.max(1,Math.round(canvas.clientWidth*ratio)),height=Math.max(1,Math.round(canvas.clientHeight*ratio));
    if(canvas.width===width&&canvas.height===height)return false;
    canvas.width=width;canvas.height=height;
    return true;
  }
  function paint(){
    signal.throwIfAborted();
    if(error)throw error;
    adjust();
    engine.render({delta:0});
    if(error)throw error;
    onSamples(tracer.stats);
  }
  async function firstSamples(at){
    cancelAnimationFrame(raf);
    const stop=performance.now()+13000;
    for(;;){
      paint();
      if(tracer.stats.sceneRevision===at&&tracer.stats.samples>0){
        await engine.gpu.queue.onSubmittedWorkDone();
        signal.throwIfAborted();
        return tracer.stats;
      }
      if(performance.now()>=stop)throw new Error('The path tracer did not produce a first sample.');
      await nextFrame();
    }
  }
  function refine(){
    if(disposed||paused)return;
    try{
      paint();
      if(!tracer.stats.converged)raf=requestAnimationFrame(refine);
    }catch(cause){onError(cause);}
  }
  async function change(blue,opaque){
    const at=++revision;
    cancelAnimationFrame(raf);
    tracer.setScene(study.state(at,blue,opaque));
    const stats=await firstSamples(at);
    if(!paused)raf=requestAnimationFrame(refine);
    return stats;
  }
  if(compatibility)await install();
  try{
    engine=await autoEngine(initialCanvas,async target=>{
      if(!target.gpu){
        const cause=new Error('This exhibit requires native WebGPU or full Margo WebGL2 compatibility.');
        cause.code='unsupported';
        throw cause;
      }
      engine=target;
      canvas=target.canvas;
      error=undefined;
      target.onError=cause=>{error=cause;if(usable)onError(cause);};
      target.camera.project=projection;
      target.scene.background='#273046';
      performance.mark('trace-device');
      const input=await bytes;
      if(input.error)throw input.error;
      study=loadStudy(input);
      performance.mark('trace-vox-loaded');
      tracer=VoxelPathTracer.attach(target,{...tracing,scene:study.state(1,starting.blue,starting.opaque)});
      performance.mark('trace-attached');
      await tracer.ready;
      performance.mark('trace-compiled');
      await firstSamples(revision);
      performance.mark('trace-first-samples');
    },{
      backend:compatibility?'webgpu':undefined,loadCompat:async()=>({install}),signal,
      exactSize:true,antialias:false,capacity:18,startupTimeout:12000,camera,
    });
    usable=true;
    resize=new ResizeObserver(()=>{
      if(disposed||paused||!adjust())return;
      cancelAnimationFrame(raf);
      raf=requestAnimationFrame(refine);
    });
    resize.observe(canvas);
    raf=requestAnimationFrame(refine);
  }catch(cause){
    close();
    throw cause;
  }
  return {close,change,counts:study.counts,cells:study.cells,canvas,
    pause(){paused=true;cancelAnimationFrame(raf);},
    resume(){paused=false;cancelAnimationFrame(raf);raf=requestAnimationFrame(refine);},
    backend:engine.gpu.adapterInfo?.vendor==='margo-webgl2'?'webgl2':'webgpu'};
}
