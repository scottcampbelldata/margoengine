import {Engine} from '@margoengine/core';
import {demoStatus} from 'margo-demo-status';
import {buildExhibit} from './stage-art.js';
import {sampleInfo} from './surface-art.js';

const by=id=>document.getElementById(id);
const viewport=by('viewport'),canvas=by('scene'),loading=by('loading'),error=by('error');
const specimenPanel=by('control'),lightPanel=by('light-control'),lightInput=by('light'),check=by('sss');
const details=by('sample-description'),degrees=by('angle');
const buttons=Array.from(specimenPanel.querySelectorAll('[data-sample]'));
const life=new AbortController(),{signal}=life,page=demoStatus(viewport,loading,error);
const query=new URLSearchParams(location.search);
const forceGL=query.get('backend')==='webgl2';
let engine,model,workshop,diffuse,watch,scheduled=false,dirty=false,interactivePending=false,preparePost=false,postTimer;
let selection='wax',requestedSample='wax',angle=103,enabled=true;

function fail(reason){
  if(signal.aborted||page.failed)return;
  specimenPanel.disabled=true;lightPanel.disabled=true;check.disabled=true;
  loading.hidden=true;error.hidden=false;
  page.error(reason);
}

function framing(){
  const aspect=canvas.width/canvas.height;
  const tall=aspect<1.1;
  const x=sampleInfo[selection].x;
  return {
    position:[tall?x+.105:.16+x*.36,.359,.740],
    target:[tall?x: x*.30,.136,-.034],
    fov:tall?35:42,near:.035,far:5,
  };
}

function aim(){
  if(!engine)return;
  const view=framing();
  engine.camera.position=view.position;
  engine.camera.target=view.target;
  engine.camera.fov=view.fov;
}

function resize(){
  const {width,height}=canvas.getBoundingClientRect();
  if(!width||!height)return false;
  const ratio=Math.min(devicePixelRatio||1,2,1440/width);
  const w=Math.round(width*ratio),h=Math.round(height*ratio);
  if(canvas.width===w&&canvas.height===h)return false;
  canvas.width=w;canvas.height=h;
  aim();
  return true;
}

async function openEngine(){
  const options={backend:'webgpu',exactSize:true,antialias:false,signal,camera:framing(),startupWarning:3000,startupTimeout:7500};
  if(!forceGL&&navigator.gpu){
    try{
      const out=await Engine.create(canvas,options);
      viewport.dataset.renderer='webgpu';
      return out;
    }catch(reason){
      signal.throwIfAborted();
      if(reason?.code&&!['unsupported','adapter','device','timeout','startup'].includes(reason.code))throw reason;
    }
  }
  const {install}=await import('@margoengine/webgl2-compat');
  await install({force:true,minimumTier:'half-float',signal});
  const out=await Engine.create(canvas,options);
  viewport.dataset.renderer='webgl2';
  return out;
}

function lighting(){
  const theta=angle*Math.PI/180;
  engine.lighting.direction.set([Math.sin(theta)*.91,.26,Math.cos(theta)*.91]);
  engine.lighting.radiance.set([1.35,1.26,1.08]);
  engine.lighting.ambient.set([.49,.52,.54]);
}

function describe(){
  for(const button of buttons)button.setAttribute('aria-pressed',String(button.dataset.sample===selection));
  const info=sampleInfo[selection];
  degrees.textContent=angle+'°';
  lightInput.setAttribute('aria-valuetext',angle+' degrees from the front');
  details.textContent=info.about;
  viewport.dataset.sample=selection;
  viewport.dataset.angle=String(angle);
  viewport.dataset.scatter=String(enabled);
}

async function paint(first=false){
  lighting();aim();
  diffuse?.update(selection,enabled);
  engine.render();
  await engine.gpu.queue.onSubmittedWorkDone();
  await new Promise(resolve=>requestAnimationFrame(resolve));
  signal.throwIfAborted();
  describe();
  if(!first){
    performance.mark('interaction-frame');
    if(!performance.getEntriesByName('first-control-frame').length){
      performance.mark('first-control-frame');
      if(!diffuse&&!preparePost){
        clearTimeout(postTimer);
        postTimer=setTimeout(queueDiffusion,450);
      }
    }
  }
}

function queueDiffusion(){
  if(signal.aborted||page.failed||diffuse)return;
  preparePost=true;
  void schedule(false);
}

async function schedule(interactive=true){
  dirty=true;
  interactivePending||=interactive;
  if(scheduled||signal.aborted||page.failed)return;
  scheduled=true;
  try{
    while(dirty&&!signal.aborted){
      dirty=false;
      const fromControl=interactivePending;
      interactivePending=false;
      selection=requestedSample;
      angle=Number(lightInput.value);
      const nextEnabled=check.checked;
      if(nextEnabled!==enabled){enabled=nextEnabled;workshop.setScattering(model,enabled);}
      const finishing=preparePost&&!diffuse;
      if(finishing){
        preparePost=false;
        diffuse=workshop.diffuseSpecimen(engine,model);
      }
      await paint(!fromControl);
      if(finishing){
        viewport.dataset.diffusion='ready';
        performance.mark('diffusion-frame');
      }
    }
  }catch(reason){fail(reason);}
  finally{scheduled=false;}
}

async function run(){
  resize();
  const opening=openEngine().then(value=>{
    engine=value;
    if(signal.aborted){value.dispose();signal.throwIfAborted();}
    value.onError=fail;
    performance.mark('engine-ready');
  });
  const prepared=import('./scene.js').then(module=>{
    workshop=module;
    const assets=workshop.prepareSpecimens();
    performance.mark('art-prepared');
    return assets;
  });
  const [,assets]=await Promise.all([opening,prepared]);
  engine.scene.background='#24342d';
  buildExhibit(engine);
  model=workshop.installSpecimens(engine,assets);
  const native=viewport.dataset.renderer==='webgpu';
  if(native)diffuse=workshop.diffuseSpecimen(engine,model);
  performance.mark('specimens-built');
  await paint(true);
  performance.mark('specimens-frame');
  if(native){
    viewport.dataset.diffusion='ready';
    performance.mark('diffusion-frame');
  }else{
    postTimer=setTimeout(queueDiffusion,Math.max(700,3400-performance.now()));
  }
  for(const button of buttons)button.addEventListener('click',()=>{
    requestedSample=button.dataset.sample;
    void schedule();
  },{signal});
  check.addEventListener('change',()=>void schedule(),{signal});
  lightInput.addEventListener('input',()=>void schedule(),{signal});
  watch=new ResizeObserver(()=>{
    if(!resize()||signal.aborted)return;
    try{engine.render();}catch(reason){fail(reason);}
  });
  watch.observe(canvas);
  if(page.ready()){
    specimenPanel.disabled=false;
    lightPanel.disabled=false;
    check.disabled=false;
    loading.hidden=true;
  }
}

addEventListener('pagehide',event=>{
  if(event.persisted)return;
  life.abort();
  clearTimeout(postTimer);
  watch?.disconnect();
  engine?.dispose();
  model?.cleanup();
});
run().catch(fail);
