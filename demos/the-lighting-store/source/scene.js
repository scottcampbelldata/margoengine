import { Camera } from '@margoengine/core';
import { Clustered } from '@margoengine/clustered';
import { IESLights } from '@margoengine/clustered/ies';
import { exposureFromEV100 } from '@margoengine/clustered/units';
import { autoEngine } from '@margoengine/webgl2-compat/auto';
import { buildBay } from './bay.js';
import { both, peakAt, readings, sourceHeight } from './photometry.js';

export async function openScene(canvas, first, signal, forced, earlyCompatibility) {
  let engine, bays, pending, closed=false;
  const dispose=()=>{
    if(closed)return;
    closed=true;
    engine?.dispose();
  };
  signal.addEventListener('abort',dispose,{once:true});
  const cameras=[0,1].map(()=>new Camera({position:[2.19,2.41,8.53],target:[.03,1.48,.50],near:.14,far:25,fov:30}));

  function draw({distance,mode}){
    const dpr=Math.min(2,devicePixelRatio);
    const width=Math.max(2,Math.round(canvas.clientWidth*dpr)), height=Math.max(2,Math.round(canvas.clientHeight*dpr));
    if(canvas.width!==width)canvas.width=width;
    if(canvas.height!==height)canvas.height=height;
    const left=Math.floor(width/2);
    for(let i=0;i<bays.length;i++){
      const {light,carriage,profile}=bays[i];
      carriage.setPosition([0,0,distance]);
      light.setLights([{
        position:[0,sourceHeight,distance], direction:[0,0,-1],
        outerAngle:Math.PI/2, innerAngle:Math.PI/2,
        range:0, decay:2, intensity:peakAt(profile,mode),
      }]);
      cameras[i].fov=Math.max(30,25/(left/height));
    }
    engine.render({delta:0,views:bays.map((item,i)=>({
      id:'bay-'+i,camera:cameras[i],scene:item.scene,pixels:true,
      viewport:i===0?[0,0,left,height]:[left,0,width-left,height],clear:{color:'#17231f'},
    }))});
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
      engine.onError=error=>{pending=error;};
      if(!engine.gpu){
        const err=new Error('IES profiles require native WebGPU or the full Margo WebGL2 compatibility layer.');
        err.code='unsupported';
        throw err;
      }
      bays=both.map((profile,i)=>{
        const scene=engine.createScene('Photometry station '+(i+1));
        scene.lighting.direction.set([-.53,.82,.82,.82]);
        scene.lighting.radiance.set([1,.93,.80,.29]);
        scene.lighting.ambient.set([.64,.74,.70]);
        const carriage=buildBay(scene);
        const light=new Clustered({grid:[4,4,6],maxLights:1});
        scene.use(light);
        const ies=new IESLights({lights:light});
        scene.use(ies);
        ies.setProfiles([profile]);
        light.intensityScale=exposureFromEV100(7.08);
        return {scene,light,carriage,profile};
      });
      draw(first);
      await engine.gpu.queue.onSubmittedWorkDone();
      if(pending)throw pending;
    },{
      loadCompat:async()=>({install}),signal,
      backend:compat?'webgpu':undefined,exactSize:true,antialias:true,startupTimeout:11000,capacity:768,
    });
  }catch(error){dispose();throw error;}
  return {
    backend:engine.gpu.adapterInfo?.vendor==='margo-webgl2'?'webgl2':'webgpu',
    lighting:both.map(({peak,flux})=>({peak,flux})),
    readings,
    async render(state){
      if(pending)throw pending;
      if(closed)return;
      draw(state);
      await engine.gpu.queue.onSubmittedWorkDone();
      if(pending)throw pending;
    },
    close:dispose,
  };
}
