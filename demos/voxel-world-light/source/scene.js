
import { autoEngine } from '@margoengine/webgl2-compat/auto';
import { VoxelLighting } from '@margoengine/voxel/light';
import { VoxelColorLight } from '@margoengine/voxel/light-rgb';
import { meshChunk,meshInput } from '@margoengine/voxel/mesher';
import { BlockTextures,VoxelRenderer } from '@margoengine/voxel/render';
import { buildVault,probe,sourceColors } from './model.js';

// A single chunk can use the package's synchronous greedy kernel on both renderers.
const localMesher={
  async mesh(world,key) {
    const input=meshInput(world,key);
    return input?meshChunk(input):null;
  },
  cancel(){},
  dispose(){},
};

function drainLighting(lighting,colored) {
  for(let pass=0;pass<12;pass++) {
    const scalar=lighting.update(), rgb=colored.update();
    if(scalar+rgb===0)return;
  }
  throw new Error('The chamber lighting did not finish propagating.');
}

const afterPaint=()=>new Promise(resolve=>requestAnimationFrame(resolve));
export async function openVault(canvas,forced,signal,compatibility,onError) {
  const {world,images,setOpen}=buildVault();
  let engine,voxels,colored,lighting,error,initial,resize,disposed=false,ready=false;
  const install=async()=>{
    if(compatibility) {
      const result=await compatibility;
      if(result.error)throw result.error;
    }else {
      await (await import('./compatibility.js')).installCompatibility(forced,signal);
    }
  };
  const cleanup=()=>{
    resize?.disconnect();
    colored?.dispose();
    lighting?.dispose();
    engine?.dispose();
  };
  function close(){
    if(disposed)return;
    disposed=true;
    cleanup();
  }
  signal.addEventListener('abort',close,{once:true});
  const box=()=>{
    const ratio=Math.min(devicePixelRatio,2,1600/Math.max(1,canvas.clientWidth));
    const width=Math.round(canvas.clientWidth*ratio),height=Math.round(canvas.clientHeight*ratio);
    if(canvas.width!==width)canvas.width=width;
    if(canvas.height!==height)canvas.height=height;
  };
  function project(out,aspect,webgpu){
    const near=engine.camera.near,far=engine.camera.far;
    const span=Math.max(34.1,37.4/aspect);
    out[0]=2/(span*aspect);
    out[5]=2/span;
    out[10]=webgpu?1/(far-near):-2/(far-near);
    out[14]=webgpu?far/(far-near):-(far+near)/(far-near);
    out[15]=1;
  }
  function render() {
    signal.throwIfAborted();
    if(error)throw error;
    box();
    engine.render({delta:0});
  }
  async function frame() {
    const limit=performance.now()+8000;
    for(;;){
      render();
      const stats=voxels.stats;
      if(stats.draws>0&&!stats.compiling&&stats.pending===0) {
        await engine.gpu.queue.onSubmittedWorkDone();
        signal.throwIfAborted();
        if(error)throw error;
        return {levels:colored.levels(...probe),quads:stats.quads,draws:stats.draws};
      }
      if(performance.now()>=limit)throw new Error('The voxel renderer did not finish preparing the chamber.');
      await afterPaint();
    }
  }
  if(compatibility)await install();
  try {
    engine=await autoEngine(canvas,async target=>{
      if(!target.gpu){
        const cause=new Error('This exhibit requires native WebGPU or full Margo WebGL2 compatibility.');
        cause.code='unsupported';
        throw cause;
      }
      engine=target;
      canvas=target.canvas;
      error=undefined;
      target.onError=cause=>{
        error=cause;
        if(ready)onError(cause);
      };
      target.camera.project=project;
      target.scene.background='#14262c';
      target.lighting.direction.set([-.37,.80,.47,.92]);
      target.lighting.radiance.set([.87,.91,1,.6]);
      target.lighting.ambient.set([.82,.93,1]);
      performance.mark('voxel-device');
      lighting=VoxelLighting.attach(world,{budget:65536});
      const textures=new BlockTextures({images});
      voxels=VoxelRenderer.attach(target,{world,textures,mesher:localMesher,daylight:.29,maxQuadBytes:4194304});
      voxels.blockLightColor=[0,0,0];
      colored=VoxelColorLight.attach(target,{world,colors:sourceColors,extent:[32,32,32],budget:65536,strength:2.5});
      colored.add(voxels);
      drainLighting(lighting,colored);
      performance.mark('voxel-initial-light');
      initial=await frame();
      if(initial.levels[0]!==0)throw new Error('The amber lamp leaks past the closed shutter.');
    },{
      backend:compatibility?'webgpu':undefined,loadCompat:async()=>({install}),signal,
      exactSize:true,antialias:true,capacity:20,startupTimeout:11000,
      camera:{position:[20.96,29.43,24.55],target:[15.16,3.23,14.05],near:.8,far:110},
    });
    ready=true;
    resize=new ResizeObserver(()=>{if(!disposed)render();});
    resize.observe(canvas);
  }catch(cause){
    close();
    throw cause;
  }
  return {
    initial,close,canvas,backend:engine.gpu.adapterInfo?.vendor==='margo-webgl2'?'webgl2':'webgpu',
    async change(open){
      setOpen(open);
      drainLighting(lighting,colored);
      const sample=await frame();
      if(open?sample.levels[0]===0:sample.levels[0]!==0)throw new Error('The corner probe did not respond to the shutter.');
      return sample;
    },
  };
}
