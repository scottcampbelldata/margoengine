import {denoiseMeshLightmap} from '@margoengine/lightmap/denoise';
import {buildRoom,roomCamera,width,height} from './room.js';
import {prepareQuick,readyQuick} from './quick-bake.js';
import {bakedSurfaces} from './room-view.js';

export function prepareRoom(){
  const room=buildRoom();
  return {room,paths:prepareQuick(room)};
}

const nextFrame=()=>new Promise(done=>requestAnimationFrame(done));

export async function show({engine,prepared,starter,canvas,notice,status,size,signal,fail}){
  const {room,paths}=prepared;
  const bake=document.querySelector('#bake'),denoise=document.querySelector('#denoise');
  const passes=document.querySelector('#passes'),guide=document.querySelector('#guide'),route=document.querySelector('#route');
  const compatibility=engine.gpu.adapterInfo?.vendor==='margo-webgl2';
  const limits=engine.gpu.limits;
  if((limits.maxStorageBuffersInFragmentStage??limits.maxStorageBuffersPerShaderStage)<3){
    const error=new Error('This lightmap preview needs three fragment storage buffers on the GPU.');
    error.code='unsupported';
    throw error;
  }
  canvas.dataset.renderer=compatibility?'compatibility':'webgpu';
  route.textContent=compatibility?'Margo WebGL2':'Margo WebGPU';
  canvas.dataset.atlas=width+'×'+height;
  engine.scene.background='#a79673';

  room.starter=starter;
  const surface=bakedSurfaces(room);
  engine.use(surface);
  let accelerator,worker,raw=starter,filtered=false,working=false,phase='reference',first=false;
  let recentStock;
  function updateControls(){
    const count=raw.passes;
    passes.value=(phase==='reference'?'Reference':'Live')+' · '+count+(count===1?' pass':' passes');
    denoise.setAttribute('aria-pressed',String(filtered));
    Object.assign(canvas.dataset,{passes:String(count),phase,filtered:String(filtered)});
  }
  function draw(){
    roomCamera(engine,canvas.clientWidth<690);
    engine.render(0);
  }
  async function apply(map,kind){
    surface.setAtlas(map);
    phase=kind;
    draw();
    await engine.gpu.queue.onSubmittedWorkDone();
    if(signal.aborted)return;
    updateControls();
  }
  async function markMain(name){
    await nextFrame();
    await nextFrame();
    if(!signal.aborted)performance.mark(name);
    if(!signal.aborted&&!first){
      first=true;
      performance.mark('baked-first-input-rendered');
    }
  }
  async function changeFilter(){
    working=true;
    bake.disabled=denoise.disabled=true;
    try{
      if(filtered){
        filtered=false;
        await apply(raw,phase);
      }else{
        const current=raw.texture?await accelerator.read():raw;
        const result=await denoiseMeshLightmap(current,room.mesh,{iterations:2,sigmaLuminance:2.3,signal});
        filtered=true;
        await apply(result,phase);
      }
      if(signal.aborted)return;
      guide.textContent=filtered?'Filtered with the same lightmap’s surface and chart boundaries.':'The unfiltered lightmap is visible.';
      await markMain('baked-denoise-applied');
    }finally{
      working=false;
      if(!signal.aborted)bake.disabled=denoise.disabled=false;
    }
  }

  async function previewPass(target){
    await accelerator.step(target-accelerator.passes);
    if(signal.aborted)return;
    raw={texture:accelerator.texture,passes:accelerator.passes};
    await apply(raw,'preview');
  }
  function stopWorker(){
    worker?.terminate();
    worker=undefined;
  }
  async function showStock(message){
    if(!message||filtered||working)return;
    working=true;
    bake.disabled=denoise.disabled=true;
    try{
      raw=message.result;
      await apply(raw,'baker');
      if(message.complete){
        guide.textContent='64 GPU passes complete. Filter the remaining grain without adding samples.';
        performance.mark('baked-stock-complete');
      }
    }finally{
      working=false;
      if(!signal.aborted)bake.disabled=denoise.disabled=false;
    }
  }
  async function runLive(){
    stopWorker();
    recentStock=undefined;
    delete canvas.dataset.bakeError;
    delete canvas.dataset.stockPasses;
    accelerator.reset();
    working=true;
    bake.disabled=denoise.disabled=true;
    filtered=false;
    guide.textContent='Tracing a fresh lightmap…';
    await previewPass(1);
    signal.throwIfAborted();
    await markMain('baked-live-first-pass');
    guide.textContent='Each pass adds one sampled light path per covered texel.';
    for(const target of [2,4,8,16]){
      await nextFrame();
      await previewPass(target);
      signal.throwIfAborted();
    }
    performance.mark('baked-preview-complete');
    guide.textContent='16 live passes shown. The full bake continues in the background.';
    bake.textContent='Bake again';
    working=false;
    bake.disabled=denoise.disabled=false;
    const gpuWorker=new Worker(new URL('./bake-worker.js',import.meta.url),{type:'module'});
    worker=gpuWorker;
    let presentation=Promise.resolve();
    function workerError(message){
      canvas.dataset.bakeError=message;
      guide.textContent='The full bake stopped. You can still filter the completed live passes.';
      stopWorker();
    }
    gpuWorker.addEventListener('message',({data})=>{
      presentation=presentation.then(async()=>{
        if(signal.aborted||worker!==gpuWorker)return;
        if(data.error){workerError(data.error);return;}
        recentStock=data;
        canvas.dataset.stockPasses=String(data.result.passes);
        if(data.result.passes===24)performance.mark('baked-stock-first-batch');
        await showStock(data);
        if(data.complete){
          if(phase==='preview')guide.textContent='The full bake finished. Turn off Denoise to see all 64 passes.';
          stopWorker();
        }
      }).catch(fail);
    },{signal});
    gpuWorker.addEventListener('error',error=>{
      if(worker===gpuWorker)workerError(error.message);
    },{signal,once:true});
    gpuWorker.postMessage({compatibility});
  }
  bake.addEventListener('click',()=>{
    if(!working)runLive().catch(fail);
  },{signal});
  denoise.addEventListener('click',()=>{
    if(!working)changeFilter().then(()=>{
      if(!filtered&&recentStock?.result.passes>raw.passes)return showStock(recentStock);
    }).catch(fail);
  },{signal});
  const observer=new ResizeObserver(()=>{
    if(!size())return;
    try{draw();}catch(reason){fail(reason);}
  });
  observer.observe(canvas);
  signal.addEventListener('abort',()=>{
    observer.disconnect();
    stopWorker();
    accelerator?.dispose();
  },{once:true});
  accelerator=readyQuick(engine.gpu,paths);
  await Promise.all([apply(starter,'reference'),accelerator.ready]);
  performance.mark('baked-compact-ready');
  if(!signal.aborted&&status.ready()){
    notice.hidden=true;
    bake.disabled=denoise.disabled=false;
    performance.mark('baked-first-frame');
  }
}
