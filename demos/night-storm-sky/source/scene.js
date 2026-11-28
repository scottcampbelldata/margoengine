import {Engine} from '@margoengine/core';
import {Weather} from '@margoengine/sky/weather';
import {LightningBolt} from '@margoengine/sky/lightning-bolt';
import {demoStatus} from 'margo-demo-status';
import {prepareHeadland,prepareReflection} from './headland.js';
import {attachProjection,loadPlates,plateWidth,plateHeight,plateFov} from './storm-projection.js';

const by=id=>document.getElementById(id);
const viewport=by('viewport'),canvas=by('storm'),loading=by('loading'),error=by('error');
const trigger=by('strike'),hold=by('hold'),state=by('state');
const page=demoStatus(viewport,loading,error),lifetime=new AbortController(),{signal}=lifetime;
const params=new URLSearchParams(location.search);
const forceGL=params.get('backend')==='webgl2';
const capture=params.get('authoring')==='sky-plates';
const liveVolume=capture||params.get('authoring')==='storm-field';
if(capture)document.documentElement.classList.add('plate-capture');
hold.checked=matchMedia('(prefers-reduced-motion: reduce)').matches;

const eye=[0,57,145],focus=[-25,244,-1290];
const cloudBase=565;
const bearing=Math.PI+.055,strikeDistance=1690;
const strikePoint=[eye[0]+Math.sin(bearing)*strikeDistance,0,eye[2]+Math.cos(bearing)*strikeDistance];
const flash={position:[0,0,0],intensity:0,color:[.76,.70,1],radius:280};
const weather=new Weather({intensity:0,lightning:{
  rate:0,strength:0,seed:2143,link:false,
  cloud:{base:cloudBase,radius:280,peak:480000},
  light:{color:[.75,.82,1]},
  bolt:{top:883,detail:63,branching:.105,spread:45,width:1.25,glow:29,fade:.064,scale:.23},
}});
weather.listener.set(eye);

let engine,project,rendering=false,held=false,serial=0,observer,flashTimer=0,currentFlare=0;
const reflection=[];
const setSize=()=>{
  if(capture){
    canvas.width=plateWidth;
    canvas.height=plateHeight;
    return false;
  }
  const {width,height}=canvas.getBoundingClientRect();
  if(!width||!height)return false;
  const scale=Math.min(window.devicePixelRatio||1,1.5,1380/width);
  const w=Math.round(width*scale),h=Math.round(height*scale);
  if(canvas.width===w&&canvas.height===h)return false;
  canvas.width=w;canvas.height=h;
  if(engine)engine.camera.fov=w/h<1?54:43;
  return true;
};

function fail(cause){
  if(signal.aborted||page.failed)return;
  trigger.disabled=true;
  hold.disabled=true;
  loading.hidden=true;
  error.hidden=false;
  page.error(cause);
}

async function openEngine(){
  const opts={
    backend:'webgpu',exactSize:true,antialias:false,signal,
    camera:{position:eye,target:focus,near:.8,far:26000,fov:capture?plateFov:(canvas.width/canvas.height<1?54:43)},
    startupWarning:3000,startupTimeout:8500,
  };
  if(!forceGL&&navigator.gpu){
    try{
      const value=await Engine.create(canvas,opts);
      viewport.dataset.renderer='webgpu';
      return value;
    }catch(reason){
      signal.throwIfAborted();
      if(reason?.code&& !['unsupported','adapter','device','timeout','startup'].includes(reason.code))throw reason;
    }
  }
  const {install}=await import('@margoengine/webgl2-compat');
  const support=await install({force:true,signal});
  if(!support.installed)throw new Error('This storm needs WebGPU or the Margo WebGL2 compatibility tier.');
  viewport.dataset.renderer='webgl2';
  return Engine.create(canvas,opts);
}

function lighting(amount=0){
  engine.lighting.direction.set([-.29,.27,-.91]);
  engine.lighting.radiance.set([.095+amount*.09,.13+amount*.125,.24+amount*.2]);
  engine.lighting.ambient.set([.6+amount*.09,.67+amount*.11,.83+amount*.15]);
}

function draw(flare=0){
  const cloud=weather.cloudFlash;
  flash.position.splice(0,3,...cloud.position);
  flash.intensity=cloud.intensity*16*flare;
  currentFlare=flare;
  project?.(flare);
  for(const mesh of reflection)mesh.visible=flare>.65;
  lighting(flare);
  engine.render();
  performance.mark("draw-submitted");
}

async function presented(){
  await engine.gpu.queue.onSubmittedWorkDone();
  await new Promise(resolve=>requestAnimationFrame(resolve));
  signal.throwIfAborted();
}

function endStrike(){
  clearTimeout(flashTimer);
  weather.options.lightning.hold=undefined;
  weather.advanceTime(.8);
  held=false;
  viewport.dataset.phase='night';
  draw();
  trigger.textContent='Trigger a strike';
  trigger.disabled=false;
  state.textContent='';
}

async function startStrike(){
  weather.resetTime();
  weather.listener.set(eye);
  const strike=weather.strike({distance:strikeDistance,azimuth:bearing,strength:.94});
  weather.options.lightning.hold=.84;
  weather.advanceTime(.018);
  held=hold.checked;
  draw(1);
  viewport.dataset.phase='illuminated';
  viewport.dataset.strike=String(++serial);
  viewport.dataset.strikePoint=strike.position.map(Math.round).join(',');
  await presented();
  performance.mark('strike-frame');
  if(!performance.getEntriesByName('first-control-frame').length)performance.mark('first-control-frame');
  if(held){
    trigger.textContent='Return to night';
    state.textContent='Illuminated frame held.';
    trigger.disabled=false;
  }else{
    flashTimer=setTimeout(()=>{
      if(signal.aborted)return;
      try{
        weather.options.lightning.hold=.21;
        weather.advanceTime(.085);
        draw(.4);
        flashTimer=setTimeout(()=>{if(!signal.aborted)try{endStrike();}catch(reason){fail(reason);}},95);
      }catch(reason){fail(reason);}
    },115);
  }
}

async function action(){
  if(rendering||signal.aborted)return;
  rendering=true;
  trigger.disabled=true;
  try{
    if(held)endStrike();
    else await startStrike();
  }catch(reason){fail(reason);}
  finally{rendering=false;}
}

async function start(){
  setSize();
  const openingEngine=openEngine().then(opened=>{
    engine=opened;
    if(signal.aborted){engine.dispose();signal.throwIfAborted();}
  });
  const opening=Promise.all([openingEngine,liveVolume?null:loadPlates(signal)]);
  const coast=capture?[]:prepareHeadland();
  const marks=capture?[]:prepareReflection(eye,strikePoint);
  performance.mark('coast-built');
  const [,image]=await opening;
  signal.throwIfAborted();
  engine.onError=fail;
  performance.mark('engine-ready');
  engine.scene.background='#0b1528';
  lighting();
  if(capture)weather.options.lightning.bolt.scale=0;
  LightningBolt.attach(engine,{weather,coreRadiance:48,glowRadiance:2.2});
  for(const {geometry,material} of coast)engine.createMesh().setGeometry(geometry).setMaterial(material);
  for(const {geometry,material} of marks)reflection.push(engine.createMesh().setGeometry(geometry).setMaterial(material));
  if(liveVolume){
    const {buildStormField}=await import('./storm-field.js');
    await buildStormField(engine,cloudBase,flash);
  }else{
    project=attachProjection(engine,image);
  }
  performance.mark('storm-field-ready');
  viewport.dataset.stormField=liveVolume?'volumetric':'projection';
  signal.throwIfAborted();
  draw();
  await presented();
  performance.mark('night-frame');
  viewport.dataset.phase='night';
  trigger.addEventListener('click',()=>void action(),{signal});
  hold.addEventListener('change',()=>{
    if(!hold.checked&&held&&!rendering)void action();
  },{signal});
  observer=new ResizeObserver(()=>{
    if(!setSize()||signal.aborted)return;
    try{draw(currentFlare);}catch(reason){fail(reason);}
  });
  observer.observe(canvas);
  if(page.ready()){
    trigger.disabled=false;
    hold.disabled=false;
    loading.hidden=true;
  }
}

addEventListener('pagehide',event=>{
  if(event.persisted)return;
  lifetime.abort();
  clearTimeout(flashTimer);
  observer?.disconnect();
  engine?.dispose();
  weather.dispose();
});
start().catch(fail);
