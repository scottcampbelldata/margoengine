import { autoEngine } from '@margoengine/webgl2-compat/auto';
import { Shadows } from '@margoengine/shadows';
import { buildCourt } from './court.js';
import { material } from './mesh.js';

const clearGlass=material('#b9b5a4',.42);
const warmSun=[-.49,.87,-.44,3.83];

export async function openScene(canvas,initial,signal,forced,earlyCompatibility) {
  let engine, shadows, court, gpuError, closed=false, appliedGlass, appliedLeaves;
  let glassCasters=[],leafCasters=[];
  const close=()=>{
    if(closed)return;
    closed=true;
    engine?.dispose();
  };
  signal.addEventListener('abort',close,{once:true});

  function draw(state){
    signal.throwIfAborted();
    if(gpuError)throw gpuError;
    const {size,glass,leaves}=state;
    if(appliedGlass!==glass){
      for(const remove of glassCasters)remove();
      glassCasters=court.glass.map(entry=>{
        entry.part.setMaterial(glass?entry.material:clearGlass);
        return shadows.add(entry.part,{tint:glass?entry.pass:entry.clear});
      });
      appliedGlass=glass;
    }
    if(appliedLeaves!==leaves){
      for(const remove of leafCasters)remove();
      leafCasters=court.leaves.map(entry=>shadows.add(entry.part,leaves?{tint:entry.pass}:{static:true}));
      appliedLeaves=leaves;
    }
    shadows.options.lightSize=Math.tan(size*Math.PI/1800);
    const scale=Math.min(devicePixelRatio,2);
    const width=Math.max(4,Math.round(canvas.clientWidth*scale)),height=Math.max(4,Math.round(canvas.clientHeight*scale));
    if(canvas.width!==width)canvas.width=width;
    if(canvas.height!==height)canvas.height=height;
    engine.camera.fov=Math.max(32,44/(width/height)**.64);
    engine.render({delta:0});
  }

  const compat=forced||!navigator.gpu;
  const install=async()=>{
    const early=earlyCompatibility?await earlyCompatibility:null;
    if(early?.error)throw early.error;
    if(!early)await (await import('./compatibility.js')).installCompatibility(forced,signal);
  };
  if(compat)await install();
  try{
    engine=await autoEngine(canvas,async target=>{
      engine=target;
      canvas=target.canvas;
      engine.onError=error=>{gpuError=error;};
      if(!engine.gpu){
        const error=new Error('This colored shadow study requires native WebGPU or the full Margo WebGL2 compatibility layer.');
        error.code='unsupported';
        throw error;
      }
      engine.scene.background='#292e39';
      engine.lighting.direction.set(warmSun);
      engine.lighting.radiance.set([1,.90,.78,.29]);
      engine.lighting.ambient.set([.83,.91,1]);
      court=buildCourt(engine);
      for(const entry of court.glass)entry.material=entry.part.material;
      shadows=Shadows.attach(engine,{
        resolution:1024,cascades:1,colored:true,filter:'soft',jitter:false,
        samples:42,blockerSamples:20,lightSize:Math.tan(initial.size*Math.PI/1800),
        bounds:{min:[-5.05,.05,-3.28],max:[5.05,4.03,4.20]},
      });
      for(const part of court.opaque)shadows.add(part,{static:true});
      await shadows.ready;
      draw(initial);
      await engine.gpu.queue.onSubmittedWorkDone();
      if(gpuError)throw gpuError;
    },{
      backend:compat?'webgpu':undefined,loadCompat:async()=>({install}),signal,exactSize:true,
      antialias:true,capacity:640,startupTimeout:12000,
      camera:{position:[6.68,6.47,10.39],target:[-.14,.94,.37],near:.18,far:98},
    });
  }catch(error){close();throw error;}
  return {
    backend:engine.gpu.adapterInfo?.vendor==='margo-webgl2'?'webgl2':'webgpu',
    passes:{filter:'pcss',opaqueCasters:court.opaque.length,glassCasters:court.glass.length,leafCasters:court.leaves.length},
    async render(state){
      if(closed)return;
      draw(state);
      await engine.gpu.queue.onSubmittedWorkDone();
      if(gpuError)throw gpuError;
    },
    close,
  };
}
