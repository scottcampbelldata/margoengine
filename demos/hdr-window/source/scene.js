import { autoEngine } from '@margoengine/webgl2-compat/auto';
import { ColorOutput, Environment, EnvironmentBackground, EnvironmentLighting } from '@margoengine/environment/main';
import { loadPrefilteredEnvironment } from '@margoengine/environment/prefiltered';
import { parseEXR } from '@margoengine/environment/loaders';
import { Tonemap } from '@margoengine/tonemap';
import { gallery } from './gallery.js';
import bakedStats from './atrium-stats.json';
import { fieldOptions } from './light-field.js';
import bakedUrl from './atrium-ibl-packed.bin?url';

const rec709=[.2126,.7152,.0722];
const hdrMedia=()=>globalThis.matchMedia('(dynamic-range: high)').matches;

function peakLight(image) {
  let peak=0;
  for(let i=0;i<image.data.length;i+=4){
    peak=Math.max(peak,image.data[i]*rec709[0]+image.data[i+1]*rec709[1]+image.data[i+2]*rec709[2]);
  }
  return peak;
}

export async function openWindow(canvas,loadEXR,compatibilityLighting,force,earlyCompatibility,signal){
  let engine,tonemap,background,lighting,output,error,source='exr',mode='sdr';
  const environments=new Map();
  let closed=false,backend,hdr;
  const close=()=>{
    if(closed)return;
    closed=true;
    engine?.dispose();
  };
  signal.addEventListener('abort',close,{once:true});
  const compat=force||!navigator.gpu;
  const install=async()=>{
    const installed=earlyCompatibility?await earlyCompatibility:undefined;
    if(installed?.error)throw installed.error;
    if(!installed)await (await import('./compatibility.js')).installCompatibility(force,signal);
  };

  function setView(key){
    if(mode===key)return;
    mode=key;
    engine.scene.removePlugin('color-output');
    output=ColorOutput.attach(engine,{hdr:key==='extended'&&hdr,gamut:key==='extended'?'p3':'srgb',peak:4});
    tonemap.options.exposure=key==='extended'&&!output.hdr?-1.25:0;
  }
  async function environment(key,image){
    let value;
    if(key==='exr'&&backend==='webgl2'){
      const response=await (compatibilityLighting??fetch(bakedUrl,{signal}));
      if(!response.ok||!response.body)throw new Error('The prefiltered gallery lighting returned HTTP '+response.status);
      const packed=await response.arrayBuffer();
      const delta=new Uint8Array(await new Response(new Blob([packed]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
      // Reconstruct the original KTX2 bytes from four independent delta streams.
      const buffer=new Uint8Array(delta.length);
      let position=0;
      for(let lane=0;lane<4;lane++){
        let prior=0;
        for(let i=lane;i<buffer.length;i+=4){
          prior=(prior+delta[position++])&255;
          buffer[i]=prior;
        }
      }
      value=await loadPrefilteredEnvironment(engine,buffer,{name:'window-'+key,signal});
      engine.use(value);
    }else{
      value=await Environment.attach(engine,image,{...fieldOptions,name:'window-'+key});
    }
    signal.throwIfAborted();
    const environment={value,peak:image?peakLight(image):bakedStats.peak};
    environments.set(key,environment);
    return environment;
  }
  function mount(current){
    background?.dispose();lighting?.dispose();
    background=EnvironmentBackground.attach(engine,current.value,{source:'cube',exposure:1.10});
    lighting=EnvironmentLighting.attach(engine,current.value);
  }
  function lens(){
    const ratio=Math.min(devicePixelRatio,2);
    const width=Math.max(4,Math.round(canvas.clientWidth*ratio)),height=Math.max(4,Math.round(canvas.clientHeight*ratio));
    if(canvas.width!==width)canvas.width=width;
    if(canvas.height!==height)canvas.height=height;
    engine.camera.fov=Math.max(28,36.0/(width/height)**.43);
  }
  async function render(){
    signal.throwIfAborted();
    if(error)throw error;
    lens();
    engine.render({delta:0});
    await engine.gpu.queue.onSubmittedWorkDone();
    if(error)throw error;
  }
  function read(){
    const {peak}=environments.get(source);
    return {
      backend,mode,source,peak,hdr,extension:output.hdr,gamut:output.gamut,
      detail:mode==='extended'&&!output.hdr,
    };
  }
  async function setSource(key){
    if(source===key)return;
    let current=environments.get(key);
    if(!current){
      const {loadEnvironmentImage}=await import('@margoengine/environment/load');
      const img=await loadEnvironmentImage(new URL('./atrium-ultrahdr.jpg',import.meta.url),{signal,weight:1});
      current=await environment(key,img);
    }
    mount(current);
    source=key;
  }

  if(compat)await install();
  try{
    engine=await autoEngine(canvas,async target=>{
      if(!target.gpu){
        const unsupported=new Error('The gallery needs native WebGPU or the full Margo WebGL2 compatibility layer.');
        unsupported.code='unsupported';
        throw unsupported;
      }
      performance.mark('margo-device-open');
      engine=target;
      canvas=target.canvas;
      backend=engine.gpu.adapterInfo?.vendor==='margo-webgl2'?'webgl2':'webgpu';
      engine.onError=cause=>{error=cause;};
      engine.lighting.direction.set([.46,.73,.51,.63]);
      engine.lighting.radiance.set([1,.81,.65,.18]);
      engine.lighting.ambient.set([.88,.95,1]);
      engine.scene.background='#282a30';
      gallery(engine);
      const native=backend==='webgpu';
      let image;
      if(native){
        image=parseEXR(await loadEXR());
        signal.throwIfAborted();
        performance.mark('margo-exr-decoded');
      }
      mount(await environment('exr',image));
      performance.mark('margo-ibl-ready');
      let hdrAvailable=false;
      if(native&&hdrMedia()){
        const probe=ColorOutput.attach(engine,{hdr:true,gamut:'p3',peak:4});
        hdrAvailable=probe.hdr;
        probe.dispose();
      }
      hdr=hdrAvailable;
      output=ColorOutput.attach(engine,{hdr:false,gamut:'srgb'});
      tonemap=Tonemap.attach(engine,{curve:'neutral'});
      await render();
    },{
      backend:compat?'webgpu':undefined,
      loadCompat:async()=>({install}),signal,exactSize:true,antialias:false,
      capacity:256,startupTimeout:12000,
      camera:{position:[2.18,1.77,6.05],target:[-.15,1.71,-.22],near:.10,far:60},
    });
  }catch(cause){close();throw cause;}
  return {
    async update(state){
      await setSource(state.source);
      setView(state.mode);
      await render();
      return read();
    },
    read,
    close,
  };
}
