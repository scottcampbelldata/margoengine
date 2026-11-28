import { Camera, Engine } from '@margoengine/core';
import { SSR } from '@margoengine/post/ssr';
import { PostStack } from '@margoengine/post/stack';
import { setGallery, sculpture, halfHeight } from './gallery.js';
import { comparison } from './comparison.js';

const rad=Math.PI/180;
const cameraOptions={position:[0,2.28,6.54],target:[0,1.0,-2.3],fov:51,near:.13,far:26};
const settings={maxRoughness:.23,thickness:.21,maxDistance:21,steps:42};

function visibility(camera,aspect){
  camera.update(aspect,true);
  const m=camera.matrix;
  const yAt=y=>{
    const [x,,z]=sculpture;
    const w=m[3]*x+m[7]*y+m[11]*z+m[15];
    return (m[1]*x+m[5]*y+m[9]*z+m[13])/w;
  };
  const top=yAt(sculpture[1]+halfHeight),bottom=yAt(sculpture[1]-halfHeight);
  return bottom>=1?'off-camera':top>1?'clipped':'in-frame';
}

function unsupported(text){
  const error=new Error(text);
  error.code='unsupported';
  return error;
}

export async function openHall(canvas,initial,signal,compatibility,earlyCompatibility,earlyTracing){
  let engine,scenes,tiles,lastError,closed=false,accelerationInstances,method,flat;
  const cameras=[new Camera(cameraOptions),new Camera(cameraOptions)];
  const close=()=>{
    if(closed)return;
    closed=true;
    engine?.dispose();
  };
  signal.addEventListener('abort',close,{once:true});

  function draw({tilt,width,height},warm=false){
    signal.throwIfAborted();
    if(lastError)throw lastError;
    if(canvas.width!==width)canvas.width=width;
    if(canvas.height!==height)canvas.height=height;
    const cut=Math.floor(width/2);
    const ride=8.95;
    for(const camera of cameras)camera.target=[0,camera.position[1]-ride*Math.tan(tilt*rad),camera.position[2]-ride];
    const targets=tiles.resize(cut,height);
    const views=scenes.map((scene,i)=>({
      id:i===0?'screen-space':'ray-traced',scene,camera:cameras[i],target:targets[i],
      viewport:[0,0,1,1],clear:{color:'#21312f'},
    }));
    if(warm){
      engine.render({delta:0,views:[views[0]]});
      return;
    }
    views.push({id:'comparison',camera:engine.camera,viewport:[0,0,1,1],clear:{color:'#21312f'}});
    engine.render({delta:0,views});
    return visibility(cameras[0],cut/height);
  }

  const install=async()=>{
    const early=earlyCompatibility?await earlyCompatibility:null;
    if(early?.error)throw early.error;
    if(!early)await (await import('./compatibility.js')).installCompatibility(true,signal);
  };
  if(compatibility)await install();
  const options={backend:'webgpu',signal,exactSize:true,antialias:false,capacity:700,startupTimeout:14000};
  let status;
  try{
    try{engine=await Engine.create(canvas,options);}
    catch(error){
      if(compatibility||(error.code!=='unsupported'&&error.code!=='timeout'))throw error;
      await install();
      engine=await Engine.create(canvas,options);
    }
    engine.onError=error=>{lastError=error;};
    if(!engine.gpu)throw unsupported('This comparison needs native WebGPU or full Margo WebGL2.');
    const compatible=engine.gpu.adapterInfo?.vendor==='margo-webgl2';
    const limit=engine.gpu.limits.maxStorageBuffersInFragmentStage??engine.gpu.limits.maxStorageBuffersPerShaderStage;
    if(limit<(compatible?2:4)){
      throw unsupported('This live reflection comparison needs more fragment-stage storage bindings on this device.');
    }
    performance.mark('mirror-device');
    tiles=comparison(compatible);
    engine.use(tiles);
    scenes=[engine.createScene('Screen-space gallery'),engine.createScene('Ray-traced gallery')];
    for(const scene of scenes)setGallery(scene);
    scenes[0].use(new PostStack([new SSR(settings)]));
    const prepared=compatible===compatibility?await earlyTracing:null;
    if(prepared?.error)throw prepared.error;
    if(compatible){
      const implementation=prepared?.implementation??await import('./local-mirror.js');
      const model=prepared?.model??implementation.prepareMirror();
      flat=implementation.localMirror(model);
      scenes[1].use(flat);
      accelerationInstances=model.instances;
      method='geometry-traced';
    }else{
      const implementation=prepared?.implementation??await import('./stock-mirror.js');
      const model=prepared?.model??implementation.prepareStockMirror();
      accelerationInstances=implementation.attachStockMirror(engine,scenes[1],model,settings);
      method='hybrid';
    }
    performance.mark('mirror-geometry');
    if(flat){
      draw(initial,true);
      performance.mark('mirror-ssr-warmed');
      await flat.ready;
    }
    status=draw(initial);
    performance.mark('mirror-submitted');
    await engine.gpu.queue.onSubmittedWorkDone();
    if(lastError)throw lastError;
  }catch(error){close();throw error;}
  return {
    backend:engine.gpu.adapterInfo?.vendor==='margo-webgl2'?'webgl2':'webgpu',
    accelerationInstances,method,
    programs:engine.gpu.programs?{...engine.gpu.programs}:undefined,
    initialVisibility:status,
    async render(state){
      if(flat)await flat.ready;
      if(closed)return;
      const current=draw(state);
      await engine.gpu.queue.onSubmittedWorkDone();
      if(lastError)throw lastError;
      return current;
    },
    close,
  };
}
