import { autoEngine } from '@margoengine/webgl2-compat/auto';
import { Tonemap } from '@margoengine/tonemap';
import { Grade } from '@margoengine/tonemap/grade';
import { LocalExposure } from '@margoengine/tonemap/local';
import { signalHouse } from './signal-house.js';

const start={curve:'neutral',tint:0,local:0};

export async function openLook(canvas,force,earlyCompatibility,signal){
  const grade=new Grade();
  const local=new LocalExposure({strength:0,maxStops:2.8,radius:.022,edges:.89});
  const gradeOnly=[grade],regionalGrade=[grade,local];
  let engine,tonemap,closed=false,error,lut=null;
  const close=()=>{
    if(closed)return;
    closed=true;
    engine?.dispose();
    local.dispose();
  };
  signal.addEventListener('abort',close,{once:true});
  const legacy=force||!navigator.gpu;
  const install=async()=>{
    const early=earlyCompatibility?await earlyCompatibility:null;
    if(early?.error)throw early.error;
    if(!early)await (await import('./compatibility.js')).installCompatibility(force,signal);
  };
  async function render({curve,tint,local:strength}){
    signal.throwIfAborted();
    if(error)throw error;
    const ratio=Math.min(devicePixelRatio,2);
    const width=Math.max(4,Math.round(canvas.clientWidth*ratio)),height=Math.max(4,Math.round(canvas.clientHeight*ratio));
    if(canvas.width!==width)canvas.width=width;
    if(canvas.height!==height)canvas.height=height;
    engine.camera.fov=Math.max(27,37.5/(width/height)**.46);
    tonemap.options.curve=curve;
    grade.options.shadows=[-.019*tint,.015*tint,.069*tint];
    grade.options.midtones=[.022*tint,-.009*tint,-.015*tint];
    grade.options.highlights=[.098*tint,.025*tint,-.046*tint];
    local.options.strength=strength*.68;
    tonemap.options.extensions=strength>0?regionalGrade:gradeOnly;
    engine.render({delta:0});
    await engine.gpu.queue.onSubmittedWorkDone();
    if(error)throw error;
  }

  if(legacy)await install();
  try{
    engine=await autoEngine(canvas,async target=>{
      if(!target.gpu){
        const error=new Error('Live colour grading needs native WebGPU or the full Margo WebGL2 compatibility layer.');
        error.code='unsupported';
        throw error;
      }
      performance.mark('margo-device-open');
      engine=target;
      canvas=target.canvas;
      engine.onError=cause=>{error=cause;};
      signalHouse(engine);
      performance.mark('margo-signal-house-ready');
      tonemap=Tonemap.attach(engine,{curve:'neutral',extensions:gradeOnly});
      await render(start);
    },{
      backend:legacy?'webgpu':undefined,loadCompat:async()=>({install}),signal,
      exactSize:true,antialias:true,capacity:256,startupTimeout:12000,
      camera:{position:[2.35,1.72,5.79],target:[.18,1.66,-.14],near:.11,far:140},
    });
  }catch(cause){close();throw cause;}
  return {
    backend:engine.gpu.adapterInfo?.vendor==='margo-webgl2'?'webgl2':'webgpu',
    render,
    load(text){
      if(text===lut)return;
      tonemap.setLUT(text);
      lut=text;
    },
    async save(){
      const {exportCube}=await import('@margoengine/tonemap/export-cube');
      return exportCube(grade,{title:'Signal house grade',size:65});
    },
    close,
  };
}
