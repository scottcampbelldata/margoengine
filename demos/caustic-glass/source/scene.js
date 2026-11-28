import {cameraFor,fabrication} from './art.js';
import {leanBench} from './receiver.js';
import {modeNames,modes,photonCount} from './optics.js';
import baked from './bakes/stats.json';
import causticSpectrum from './bakes/spectrum.png?url';
import causticPolished from './bakes/clear.png?url';
import causticGround from './bakes/ground.png?url';

const urls={spectrum:causticSpectrum,clear:causticPolished,ground:causticGround};
const by=id=>document.getElementById(id);
function slate(){
  const width=128,height=width,data=new Uint8Array(width*height*4);
  let seed=58073;
  const random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const a=x/width,b=y/height;
    const crease=Math.pow(Math.abs(Math.sin(b*34+a*5+.4*Math.sin(a*16))),6);
    const grit=(random()-.5)*8+2*Math.cos(a*31+b*81)+3*Math.cos(a*16+b*14)-2.2*crease;
    const key=(y*width+x)*4;
    data.set([106+grit,112+grit,120+grit,255],key);
  }
  return {width,height,data};
}

async function readMap(key){
  const image=new Image();
  image.src=urls[key];
  await image.decode();
  const {naturalWidth:width,naturalHeight:height}=image;
  const decode=new OffscreenCanvas(width,height).getContext('2d',{willReadFrequently:true});
  decode.drawImage(image,0,0);
  return {data:decode.getImageData(0,0,width,height).data,width,height};
}
function light(engine){
  engine.scene.background='#26313a';
  engine.scene.lighting.direction.set([-.38,.79,.48,3.00]);
  engine.scene.lighting.radiance.set([.97,.92,.87,.63]);
  engine.scene.lighting.ambient.set([.96,1,1.09]);
}

export function mount({opening,viewport,canvas,field,rebake,loading,page,signal,fail,resize}){
  const buttons=[...field.querySelectorAll('button')],power=by('power'),spread=by('spread'),progress=by('progress');
  const initialMode='spectrum';
  const maps={},stats=structuredClone(baked);
  let engine,bench,observer,worker,working=false,wanted='spectrum',active='spectrum',dirty=false;
  let fullTimer,settle,completedBake,enhancementRequested=false;
  const stone=slate();

  function camera(){
    const view=cameraFor(canvas.width,canvas.height);
    engine.camera.position=view.position;
    engine.camera.target=view.target;
    engine.camera.fov=view.fov;
    engine.camera.near=view.near;
    engine.camera.far=view.far;
  }
  async function frame(){
    engine.render();
    await engine.gpu.queue.onSubmittedWorkDone();
    await new Promise(resolve=>requestAnimationFrame(resolve));
    signal.throwIfAborted();
  }
  function describe(){
    viewport.dataset.mode=active;
    for(const button of buttons)button.setAttribute('aria-pressed',String(button.dataset.mode===active));
    power.value=(stats[active].collected*100).toFixed(1)+'%';
    spread.value=(stats[active].spread*100).toFixed(1)+' cm';
  }
  function stop(result=''){
    if(!worker)return;
    worker.terminate();
    worker=undefined;
    rebake.textContent='Rebake light';
    progress.textContent=result;
  }
  function rerender(){
    if(working||signal.aborted||page.failed)return;
    working=true;
    (async()=>{
      while(dirty){
        dirty=false;
        active=wanted;
        resize();
        camera();
        if(settle){
          const renderFull=settle;
          settle=undefined;
          bench.dispose();
          bench=renderFull(engine,stone,maps,active);
          viewport.dataset.glass='refracted';
        }
        bench.update(active);
        await frame();
        describe();
        if(viewport.dataset.glass==='refracted'&&!performance.getEntriesByName('full-optics-frame').length){
          performance.mark('full-optics-frame');
          viewport.dataset.opticsReady='true';
        }
        if(completedBake){
          viewport.dataset.rebaked=completedBake;
          completedBake=undefined;
          performance.mark('rebake-frame');
        }
        if(active!==initialMode){
          performance.mark('comparison-frame');
          if(!performance.getEntriesByName('first-control-frame').length){
            performance.mark('first-control-frame');
            startRefraction();
          }
        }
      }
    })().catch(fail).finally(()=>{working=false;});
  }
  function switchTo(key){
    if(!Object.hasOwn(modes,key)||wanted===key)return;
    stop();
    wanted=key;
    progress.textContent='';
    dirty=true;
    rerender();
  }
  function bake(){
    if(worker){stop('Bake canceled.');return;}
    const run=wanted;
    worker=new Worker(new URL('./bake-worker.js',import.meta.url),{type:'module'});
    viewport.dataset.rebaked='';
    performance.mark('bake-start');
    rebake.textContent='Cancel bake';
    progress.textContent='Preparing the photon bake…';
    worker.addEventListener('error',()=>stop('The bake could not start.'),{signal});
    worker.addEventListener('message',({data})=>{
      if(data.error){stop(data.error);return;}
      if(data.progress!==undefined){
        progress.textContent='Tracing photons · '+data.progress+'%';
        return;
      }
      maps[run]={data:data.rgba,width:256,height:256};
      stats[run]=data.stats;
      stop('Baked '+photonCount.toLocaleString('en-US')+' photons in this browser.');
      completedBake=run;
      dirty=true;
      rerender();
    },{signal});
    worker.postMessage(run);
  }
  async function run(){
    const assets=Promise.all(modeNames.map(async key=>[key,await readMap(key)]));
    const parts=fabrication();
    performance.mark('art-ready');
    const [value,images]=await Promise.all([opening,assets]);
    signal.throwIfAborted();
    engine=value;
    Object.assign(maps,Object.fromEntries(images));
    performance.mark('bakes-decoded');
    camera();
    light(engine);
    for(const {key,geometry,material} of parts){
      const part=engine.createMesh().setGeometry(geometry).setMaterial(material);
      part.name='SM_Bench_'+key;
    }
    bench=leanBench(engine,stone,maps,active);
    viewport.dataset.glass='opening';
    performance.mark('assembled');
    await frame();
    describe();
    performance.mark('optics-frame');
    for(const button of buttons)button.addEventListener('click',()=>switchTo(button.dataset.mode),{signal});
    rebake.addEventListener('click',bake,{signal});
    observer=new ResizeObserver(()=>{
      if(resize()&&!signal.aborted&&!working&&!page.failed){
        camera();
        try{engine.render();}catch(reason){fail(reason);}
      }
    });
    observer.observe(canvas);
    if(page.ready()){field.disabled=false;rebake.disabled=false;loading.hidden=true;}
    fullTimer=setTimeout(startRefraction,Math.max(230,3100-performance.now()));
  }
  function startRefraction(){
    if(enhancementRequested||signal.aborted||page.failed)return;
    enhancementRequested=true;
    clearTimeout(fullTimer);
    import('./glass-view.js').then(({fullBench})=>{
      if(signal.aborted||page.failed)return;
      settle=fullBench;
      dirty=true;
      rerender();
    }).catch(fail);
  }
  run().catch(fail);
  return ()=>{
    clearTimeout(fullTimer);
    observer?.disconnect();
    worker?.terminate();
    bench?.dispose();

  };
}
