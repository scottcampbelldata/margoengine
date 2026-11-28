
import {PbrMaterial} from '@margoengine/core';
import {dayLight} from '@margoengine/sky/day-presets';
import {ImageBackground,Fog} from '@margoengine/environment/main';
import {Tonemap} from '@margoengine/tonemap';
import {modes,lookFamilies} from './presets.js';

const skyFiles={
  golden:new URL('./assets/sky-golden.webp',import.meta.url).href,
  clear:new URL('./assets/sky-clear.webp',import.meta.url).href,
  haze:new URL('./assets/sky-haze.webp',import.meta.url).href,
  overcast:new URL('./assets/sky-overcast.webp',import.meta.url).href,
};

export async function loadSkies(signal){
  const request=(resource,options)=>fetch(resource,{...options,signal});
  return Object.fromEntries(await Promise.all(Object.entries(skyFiles).map(async ([key,source])=>[
    key,await ImageBackground.load({shape:'cylinder',images:[source],height:1.22,fetch:request}),
  ])));
}

export async function show({engine,canvas,status,notice,size,terrain,skies,signal,fail}){
  const buttons=[...document.querySelectorAll('[data-day]')];
  const select=document.querySelector('#look'), description=document.querySelector('#description');
  const sun=document.querySelector('#sun'), cloud=document.querySelector('#cloud');
  const route=document.querySelector('#renderer');
  const mist=Fog.attach(engine,{density:.00021,height:64,heightFalloff:.0021});
  const tonemap=Tonemap.attach(engine,{curve:'agx',exposure:.82});
  for(const layer of terrain){
    const mesh=engine.createMesh();
    mesh.name=layer.family+' '+layer.color;
    mesh.setGeometry(layer.geometry).setMaterial(new PbrMaterial({
      color:layer.color,roughness:layer.family==='foliage'?.86:.97,metalness:0,
    }));
  }

  let active='golden', grade='agx', clock=0, revision=0, controlMarked=false, background;
  let resizeFrame=0;
  engine.use({
    name:'daylight-background',
    setup(){background=skies[active];},
    registerPasses(graph){
      graph.add({name:'daylight-background',order:.5,execute(context){background?.record(context);}});
    },
    onDeviceRestored(){
      for(const sky of Object.values(skies))sky.onDeviceRestored();
    },
    dispose(){
      for(const sky of Object.values(skies))sky.dispose();
    },
  });
  canvas.dataset.renderer=engine.gpu.adapterInfo?.vendor==='margo-webgl2'?'compatibility':'webgpu';
  route.textContent=canvas.dataset.renderer==='compatibility'?'Margo WebGL2':'Margo WebGPU';

  function render(){
    const narrow=canvas.clientWidth<720;
    engine.camera.fov=narrow?36:32;
    engine.camera.target=[48,narrow?112:117,-650];
    engine.render(clock++);
  }

  function configure(){
    const {preset,fill,fogColor,exposure}=modes[active], family=lookFamilies[grade];
    const light=dayLight(preset.day);
    engine.lighting.direction.set([...light.direction,light.intensity]);
    engine.lighting.radiance.set([...light.color,1]);
    engine.lighting.ambient.set(fill);

    mist.density=preset.fog;
    mist.color=fogColor;
    Object.assign(tonemap.options,{curve:family.curve,exposure,contrast:family.contrast*preset.tonemap.contrast});
  }

  async function update(mark){
    const serial=++revision;
    background=skies[active];
    configure();
    render();
    await engine.gpu.queue.onSubmittedWorkDone();
    if(signal.aborted||serial!==revision)return;
    const {preset,text}=modes[active];
    description.textContent=text;
    sun.textContent=preset.day.elevation+'°';
    cloud.textContent=Math.round(100*preset.day.clouds)+'%';
    for(const button of buttons)button.setAttribute('aria-pressed',String(button.dataset.day===active));
    Object.assign(canvas.dataset,{preset:active,look:grade,sun:String(preset.day.elevation),
      clouds:String(preset.day.clouds),revision:String(serial)});
    if(mark&&!controlMarked){
      await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));
      if(!signal.aborted&&!controlMarked){
        controlMarked=true;
        performance.mark('golden-preset-applied');
      }
    }
  }

  for(const button of buttons)button.addEventListener('click',()=>{
    if(active===button.dataset.day)return;
    active=button.dataset.day;
    update(true).catch(fail);
  },{signal});
  select.addEventListener('change',()=>{
    grade=select.value;
    update(false).catch(fail);
  },{signal});
  const observer=new ResizeObserver(()=>{
    if(!size())return;
    cancelAnimationFrame(resizeFrame);
    resizeFrame=requestAnimationFrame(()=>{
      try{if(!signal.aborted)render();}
      catch(reason){fail(reason);}
    });
  });
  observer.observe(canvas);
  signal.addEventListener('abort',()=>{
    observer.disconnect();
    cancelAnimationFrame(resizeFrame);
  },{once:true});

  await update(false);
  if(status.ready()){
    notice.hidden=true;
    for(const control of [...buttons,select])control.disabled=false;
    performance.mark('golden-frame-ready');
  }
}
