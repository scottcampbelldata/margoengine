import {Clustered} from '@margoengine/clustered';
import {ProjectorLights} from '@margoengine/clustered/projector';
import {lamp,aim,prepareGallery} from './gallery.js';
import {labels,makeSlide} from './slides.js';

const axis=aim.map((value,i)=>value-lamp[i]);
const projectorAngle=.335;

export function mount({opening,viewport,canvas,loading,page,signal,fail,sizeScene,expectNative}){
  const field=document.getElementById('slides'),current=document.getElementById('current'),caption=document.getElementById('caption');
  const buttons=Array.from(field.querySelectorAll('[data-slide]'));
  const gels=new Map(),casters=[];
  let engine,lights,projector,watch,shadowTimer,shadowModule,shadows,rendering=false,requested=0,selected=-1;

  function slide(index){
    if(!gels.has(index))gels.set(index,makeSlide(index));
    const image=gels.get(index);
    return {image,angle:projectorAngle,aspect:image.width/image.height};
  }

  function describe(index){
    current.textContent=labels[index][0];
    caption.textContent=labels[index][1];
    for(const button of buttons)button.setAttribute('aria-pressed',String(Number(button.dataset.slide)===index));
    viewport.dataset.slide=String(index);
  }

  function fixture(occlusion){
    const spot={position:lamp,direction:axis,range:19,outerAngle:.56,innerAngle:.533,intensity:164};
    if(occlusion)Object.assign(spot,{castShadow:true,shadow:{near:.08,far:16}});
    return [
      spot,
      {position:[2.78,3.65,3.85],range:10,color:[1,.83,.68],intensity:23},
      {position:[-2.5,2.95,3.6],range:4.8,color:[1,.70,.42],intensity:8.3},
    ];
  }

  function startShadows(LocalShadows){
    shadows=LocalShadows.attach(engine,{lights,maxLights:1,resolution:832,bias:.65,normalBias:.36});
    for(const caster of casters)shadows.add(caster);
    lights.setLights(fixture(true));
  }

  function showShadowMap(){
    const map=shadows.shadowMap('spot',0);
    if(!map)throw new Error('The projector’s local shadow map is unavailable.');
    viewport.dataset.shadowMap=map.rect.slice(2).join('x');
    performance.mark('shadow-frame');
  }

  async function paint(index){
    projector.setProjectors([slide(index),null,null]);
    engine.render();
    await engine.gpu.queue.onSubmittedWorkDone();
    await new Promise(resolve=>requestAnimationFrame(resolve));
    signal.throwIfAborted();
  }

  async function finishShadows(){
    if(!shadowModule||signal.aborted||rendering||shadows)return;
    rendering=true;
    try{
      startShadows(shadowModule.LocalShadows);
      await paint(selected);
      showShadowMap();
    }catch(reason){fail(reason);}
    finally{
      rendering=false;
      if(requested!==selected&&!page.failed)void select(requested);
    }
  }

  function prepareShadows(){
    clearTimeout(shadowTimer);
    import('@margoengine/clustered/shadows').then(value=>{
      shadowModule=value;
      return finishShadows();
    }).catch(fail);
  }

  async function select(index){
    if(signal.aborted||page.failed)return;
    requested=index;
    if(rendering)return;
    rendering=true;
    try{
      while(selected!==requested&&!signal.aborted){
        const next=requested;
        await paint(next);
        selected=next;
        describe(next);
        performance.mark('slide-frame');
        if(!performance.getEntriesByName('first-control-frame').length){
          performance.mark('first-control-frame');
          if(!shadows&&!shadowModule){
            clearTimeout(shadowTimer);
            shadowTimer=setTimeout(prepareShadows,550);
          }
        }
      }
    }catch(reason){fail(reason);}
    finally{
      rendering=false;
      if(shadowModule&&!shadows)void finishShadows();
    }
  }

  async function start(){
    const nativeShadows=expectNative?import('@margoengine/clustered/shadows'):null;
    const gallery=prepareGallery();
    slide(0);
    performance.mark('gallery-geometry');
    const [opened,nativeShadowModule]=await Promise.all([opening,nativeShadows]);
    engine=opened;
    signal.throwIfAborted();
    engine.scene.background='#17161b';
    engine.lighting.direction.set([.16,.58,.80]);
    engine.lighting.radiance.set([.16,.184,.23]);
    engine.lighting.ambient.set([.55,.50,.47]);
    lights=Clustered.attach(engine,{grid:[8,6,12],maxLights:3});
    projector=ProjectorLights.attach(engine,{lights});
    for(const {geometry,material,caster} of gallery){
      const mesh=engine.createMesh().setGeometry(geometry).setMaterial(material);
      if(caster)casters.push(mesh);
    }
    viewport.dataset.casters=String(casters.length);
    viewport.dataset.projector='clustered';
    const native=viewport.dataset.renderer==='webgpu';
    if(native)startShadows(nativeShadowModule.LocalShadows);
    else lights.setLights(fixture(false));
    performance.mark('lights-ready');
    await paint(0);
    if(shadows)showShadowMap();
    selected=0;
    describe(0);
    performance.mark('gallery-frame');
    for(const button of buttons)button.addEventListener('click',()=>void select(Number(button.dataset.slide)),{signal});
    watch=new ResizeObserver(()=>{
      if(!sizeScene(engine)||signal.aborted)return;
      try{engine.render();}catch(reason){fail(reason);}
    });
    watch.observe(canvas);
    if(page.ready()){
      field.disabled=false;
      loading.hidden=true;
    }
    if(!native)shadowTimer=setTimeout(prepareShadows,Math.max(800,3550-performance.now()));
  }

  start().catch(fail);
  return ()=>{
    clearTimeout(shadowTimer);
    watch?.disconnect();
  };
}
