import { autoEngine } from '@margoengine/webgl2-compat/auto';
import { HeatHaze } from '@margoengine/post/heat-haze';
import { Sky } from '@margoengine/sky/base';
import { preetham } from '@margoengine/sky/preetham';
import { look } from '@margoengine/sky/look';
import { buildRoad } from './road.js';

const sun=[.46,.68,.567];
// Desert noon: 34 C air at 98.6 kPa over a sunlit road whose surface air runs the slider's kelvin hotter.
const ambient=307.15;
export async function openRoad(canvas,initial,signal,force,earlyCompatibility){
  let engine,haze,pending,closed=false;
  const layer={excess:0,height:.04,depth:.025,fluctuation:.25,wind:[.6,1.8],eddy:.5,pressure:98600,time:0};
  const close=()=>{
    if(closed)return;
    closed=true;
    engine?.dispose();
  };
  signal.addEventListener('abort',close,{once:true});

  function draw({contrast,time}){
    signal.throwIfAborted();
    if(pending)throw pending;
    const ratio=Math.min(devicePixelRatio,2);
    const width=Math.max(4,Math.round(canvas.clientWidth*ratio)),height=Math.max(4,Math.round(canvas.clientHeight*ratio));
    if(canvas.width!==width)canvas.width=width;
    if(canvas.height!==height)canvas.height=height;
    engine.camera.fov=Math.max(4.2,6.2/(width/height)**.48);
    layer.excess=contrast;
    layer.time=time;
    engine.render({delta:0});
  }

  const compat=force||!navigator.gpu;
  const install=async()=>{
    const early=earlyCompatibility?await earlyCompatibility:null;
    if(early?.error)throw early.error;
    if(!early)await (await import('./compatibility.js')).installCompatibility(force,signal);
  };
  if(compat)await install();
  try{
    engine=await autoEngine(canvas,async target=>{
      if(!target.gpu){
        const error=new Error('The heat shimmer needs native WebGPU or the full Margo WebGL2 compatibility layer.');
        error.code='unsupported';
        throw error;
      }
      performance.mark('margo-device-open');
      engine=target;
      canvas=target.canvas;
      engine.onError=error=>{pending=error;};
      engine.lighting.direction.set([...sun,2.23]);
      engine.lighting.radiance.set([1,.83,.66,.62]);
      engine.lighting.ambient.set([.70,.80,1]);
      engine.scene.background='#ddb491';
      Sky.attach(engine,{timeScale:0,sunDirection:sun,turbidity:3.4,exposure:-.13,
        look:{gradientStrength:.91,gradientIntensity:1.04,gradient:[
          {elevation:-90,color:[.13,.087,.076]},{elevation:0,color:[.75,.59,.441]},
          {elevation:3.5,color:[.50,.454,.42]},{elevation:10,color:[.299,.424,.515]},
          {elevation:22,color:[.113,.230,.351]},{elevation:90,color:[.06,.12,.26]},
        ],glowWidth:7,glowColor:[1,.75,.44],glowStrength:.041,glowSunward:.36},
      },{preetham,look});
      buildRoad(engine);
      haze=HeatHaze.attach(engine,{ambient,ground:layer});
      performance.mark('margo-scene-built');
      draw(initial);
      performance.mark('margo-first-submit');
      await engine.gpu.queue.onSubmittedWorkDone();
      if(pending)throw pending;
    },{
      backend:compat?'webgpu':undefined,loadCompat:async()=>({install}),signal,exactSize:true,antialias:false,
      capacity:840,startupTimeout:12000,camera:{position:[.70,1.19,17],target:[6.4,1.0,-330],near:.19,far:1520},
    });
  }catch(error){close();throw error;}
  return {
    backend:engine.gpu.adapterInfo?.vendor==='margo-webgl2'?'webgl2':'webgpu',
    async render(state){
      if(closed)return;
      draw(state);
      await engine.gpu.queue.onSubmittedWorkDone();
      if(pending)throw pending;
    },
    close,
  };
}
