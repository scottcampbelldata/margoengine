import { autoEngine } from '@margoengine/webgl2-compat/auto';
import { parsePreparedPBR } from '@margoengine/gltf/pbr-model';
import { applyLightmap } from '@margoengine/lightmap/apply';
import { buildCase } from './case.js';
import exhibit from './exhibit.json';

function loadPanel(engine,images){
  const {width,height,centerY}=exhibit;
  const x=width/2,y0=centerY-height/2,y1=centerY+height/2;
  const corners=[[-x,y0,0,1],[x,y0,1,1],[x,y1,1,0],[-x,y1,0,0]];
  const vertices=new Float32Array(corners.flatMap(([px,py,u,v])=>[
    px,py,0,1, 0,0,1,0, 1,0,0,-1, u,v,u,v, 1,1,1,1,
  ]));
  return parsePreparedPBR(engine,{
    asset:{version:'2.0'},scene:0,scenes:[{nodes:[0]}],
    nodes:[{name:'Tide Register enamel face',mesh:0}],
    meshes:[{primitives:[{attributes:{},material:0}]}],
    materials:[{name:'Glaze over pressed ceramic',pbrMetallicRoughness:{
      baseColorTexture:{index:0},metallicFactor:0,roughnessFactor:.72,
    },normalTexture:{index:1}}],
    images:[{},{}],textures:[{source:0,sampler:0},{source:1,sampler:0}],
    samplers:[{magFilter:9729,minFilter:9987,wrapS:33071,wrapT:33071}],
  },[[{vertices,indices:new Uint32Array([0,1,2,0,2,3])}]],images);
}

export async function openRegister(canvas,asset,force,compatibility,signal){
  let engine,application,views,pending,factors,litDirection;
  let disposed=false;
  const close=()=>{
    if(disposed)return;
    disposed=true;
    application?.dispose();
    engine?.dispose();
  };
  signal.addEventListener('abort',close,{once:true});
  const legacy=force||!navigator.gpu;
  const install=async()=>{
    const early=compatibility?await compatibility:null;
    if(early?.error)throw early.error;
    if(!early)await (await import('./compatibility.js')).installCompatibility(force,signal);
  };

  async function paint(){
    signal.throwIfAborted();
    if(pending)throw pending;
    const ratio=Math.min(devicePixelRatio,2);
    const w=Math.max(4,Math.round(canvas.clientWidth*ratio)),h=Math.max(4,Math.round(canvas.clientHeight*ratio));
    if(canvas.width!==w)canvas.width=w;
    if(canvas.height!==h)canvas.height=h;
    const aspect=w/h;
    engine.camera.fov=Math.max(35,42.7/(aspect**.67));
    engine.render({delta:0,views});
    await engine.gpu.queue.onSubmittedWorkDone();
    if(pending)throw pending;
  }
  if(legacy)await install();
  try{
    engine=await autoEngine(canvas,async target=>{
      if(!target.gpu){
        const error=new Error('The directional sample needs native WebGPU or the full Margo WebGL2 compatibility layer.');
        error.code='unsupported';
        throw error;
      }
      performance.mark('margo-device-open');
      engine=target;
      canvas=target.canvas;
      engine.onError=cause=>{pending=cause;};
      engine.lighting.direction.set([0,0,1,0]);
      engine.lighting.radiance.set([1,1,1,0]);
      engine.lighting.ambient.set([1,1,1]);
      const frame=buildCase(engine);
      performance.mark('margo-case-built');
      const viewport=[0,0,1,1];
      const camera=engine.camera;
      views=[{camera,scene:frame,viewport},{camera,scene:engine.scene,viewport,clear:{color:false,depth:false}}];
      const records=await asset;
      signal.throwIfAborted();
      const model=loadPanel(engine,records.images);
      performance.mark('margo-model-open');
      application=applyLightmap(model,records.bake,{directional:true});
      factors=model.primitives[0].material.extension?.factors;
      litDirection=factors?.[1];
      if(!application.directional||!(litDirection>0)){
        throw new Error('The directional lightmap has no adjustable directional contribution.');
      }
      performance.mark('margo-bake-mounted');
      await paint();
    },{
      backend:legacy?'webgpu':undefined,loadCompat:async()=>({install}),signal,
      exactSize:true,antialias:true,capacity:128,startupTimeout:12000,
      camera:{position:[.35,.275,2.94],target:[.022,.221,0],near:.07,far:18},
    });
  }catch(cause){close();throw cause;}
  return {
    backend:engine.gpu.adapterInfo?.vendor==='margo-webgl2'?'webgl2':'webgpu',
    async render(choice){
      // The stored intensity is factor 0. Factor 1 controls only the directional term.
      factors[1]=choice==='directional'?litDirection:0;
      await paint();
      return factors[1]>0;
    },
    close,
  };
}
