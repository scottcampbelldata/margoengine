import { autoEngine } from '@margoengine/webgl2-compat/auto';
import { buildGallery } from './gallery.js';

export async function openGallery(canvas,art,force,earlyCompatibility,signal){
  let engine,portals,closed=false,error;
  const close=()=>{
    if(closed)return;
    closed=true;
    portals?.dispose();
    engine?.dispose();
  };
  signal.addEventListener('abort',close,{once:true});
  const legacy=force||!navigator.gpu;
  const install=async()=>{
    const early=earlyCompatibility?await earlyCompatibility:null;
    if(early?.error)throw early.error;
    if(!early)await (await import('./compatibility.js')).installCompatibility(force,signal);
  };
  async function render(eye){
    signal.throwIfAborted();
    if(error)throw error;
    const ratio=Math.min(devicePixelRatio,2);
    const width=Math.max(4,Math.round(canvas.clientWidth*ratio)),height=Math.max(4,Math.round(canvas.clientHeight*ratio));
    if(canvas.width!==width)canvas.width=width;
    if(canvas.height!==height)canvas.height=height;
    const camera=engine.camera;
    camera.fov=Math.max(28.5,39.9/(width/height)**.55);
    camera.position=[eye,1.67,6.70];
    camera.target=[0,1.46,.03];
    portals.render(0);
    await engine.gpu.queue.onSubmittedWorkDone();
    if(error)throw error;
  }
  if(legacy)await install();
  try{
    engine=await autoEngine(canvas,async target=>{
      if(!target.gpu){
        const error=new Error('These stencil portals need native WebGPU or the full Margo WebGL2 compatibility layer.');
        error.code='unsupported';
        throw error;
      }
      performance.mark('margo-device-open');
      engine=target;
      canvas=target.canvas;
      engine.onError=cause=>{error=cause;};
      const description=await art;
      signal.throwIfAborted();
      portals=buildGallery(engine,description);
      performance.mark('margo-chambers-ready');
      await render(0);
    },{
      backend:legacy?'webgpu':undefined,loadCompat:async()=>({install}),signal,
      exactSize:true,antialias:true,capacity:156,startupTimeout:12000,
      camera:{position:[0,1.67,6.7],target:[0,1.46,.03],near:.09,far:30},
    });
  }catch(cause){close();throw cause;}
  return {
    backend:engine.gpu.adapterInfo?.vendor==='margo-webgl2'?'webgl2':'webgpu',
    references:portals.portals.map(portal=>portal.ref),
    render,close,
  };
}
