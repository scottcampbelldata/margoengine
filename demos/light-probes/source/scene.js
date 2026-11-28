import {SHLight} from '@margoengine/environment';
import {LightProbes} from '@margoengine/environment/probes';
import {buildArchitecture,buildSphere,railTop,radius,zTrack,xLimit} from './art.js';
import {centers,cells} from './irradiance.js';

const by=id=>document.getElementById(id);
const position=value=>xLimit*(value/500-1);
const limits={min:[-3.34,-.02,-1.75],max:[3.34,3.04,2.18]};
const reflectionPoints=[-2.21,0,2.21].map((x,i)=>({
  position:[x,.52,.48],
  min:[[-3.34,-1.18,.99][i],limits.min[1],limits.min[2]],
  max:[[-.99,1.18,3.34][i],limits.max[1],limits.max[2]],
  blend:.47,
}));
const diffuseNormal=[0,-.255,.967];
const clamp=(v,min,max)=>Math.min(max,Math.max(min,v));

function toDisplay(channel){
  const v=clamp(channel,0,1);
  return Math.round(255*(v<=.0031308?12.92*v:1.055*v**(1/2.4)-.055));
}

function coefficients(x){
  const spread=centers[1]-centers[0],t=clamp((x-centers[0])/spread,0,2);
  const start=Math.min(1,Math.floor(t)),mix=t-start;
  return cells[start].map((value,i)=>value+(cells[start+1][i]-value)*mix);
}

function light(scene){
  scene.lighting.direction.set([.24,.67,.74]);
  scene.lighting.radiance.set([.53,.55,.56,.47]);
  scene.lighting.ambient.set([1.06,1.07,1.08]);
}

export function mount({opening,viewport,canvas,loading,page,signal,fail,resize}){
  const path=by('path'),field=by('controls'),satin=by('satin'),coordinate=by('position');
  const readout=by('irradiance'),swatch=by('sample'),progress=by('reflection-status');
  let engine,probes,ball,earlyScene,earlyLight,observer,captureTarget,reflectionTimer;
  let reflectionsPreparing=false,running=false,paintAgain=false;
  let x=position(Number(path.value)),brushed=satin.checked;

  function camera(resetX){
    x=resetX;
    const mobile=canvas.width/canvas.height<1.25;
    if(mobile){
      engine.camera.position=[x+.60,1.52,4.46];
      engine.camera.target=[x,.80,-.10];
      engine.camera.fov=39;
    }else{
      engine.camera.position=[x*.11+.45,2.02,7.5];
      engine.camera.target=[x*.08,.98,-.18];
      engine.camera.fov=31;
    }
  }

  function metrics(){
    const local=earlyLight?earlyLight.irradiance(diffuseNormal):probes.irradianceAt([x,radius+railTop,zTrack],diffuseNormal);
    if(!local)throw new Error('The irradiance volume did not provide a sample at the sphere.');
    swatch.style.backgroundColor='rgb('+local.map(toDisplay).join(',')+')';
    readout.textContent=local.map(channel=>channel.toFixed(3)).join(' / ');
    coordinate.textContent=x.toFixed(2).replace('-','−')+' m';
    path.setAttribute('aria-valuetext',coordinate.textContent);
    viewport.dataset.coordinate=x.toFixed(3);
    viewport.dataset.diffuse=local.map(value=>value.toFixed(5)).join(',');
    viewport.dataset.finish=brushed?'satin':'polished';
  }

  function render(){
    if(!earlyScene){engine.render();return;}
    const rect=[0,0,1,1],view=engine.camera;
    earlyLight.coefficients=coefficients(x);
    engine.render({views:[
      {id:'gallery',scene:engine.scene,camera:view,viewport:rect},
      {id:'probe-sphere',scene:earlyScene,camera:view,viewport:rect,clear:{color:false,depth:false}},
    ]});
  }

  async function draw(interactive){
    const next=position(Number(path.value));
    ball.setPosition(next);
    brushed=satin.checked;
    ball.setSatin(brushed);
    camera(next);
    render();
    await engine.gpu.queue.onSubmittedWorkDone();
    await new Promise(resolve=>requestAnimationFrame(resolve));
    signal.throwIfAborted();
    metrics();
    if(interactive){
      performance.mark('roll-frame');
      if(!performance.getEntriesByName('first-control-frame').length){
        performance.mark('first-control-frame');
        if(earlyScene&&!reflectionsPreparing){
          clearTimeout(reflectionTimer);
          reflectionTimer=setTimeout(prepareReflections,570);
        }
      }
    }
  }

  async function input(){
    if(signal.aborted||page.failed)return;
    paintAgain=true;
    if(running)return;
    running=true;
    try{
      while(paintAgain&&!signal.aborted){
        paintAgain=false;
        await draw(true);
      }
    }catch(reason){fail(reason);}
    finally{running=false;}
  }

  function captureFrame(){
    if(!captureTarget)captureTarget=engine.gpu.createTexture({size:[1,1],format:'rgba8unorm',usage:GPUTextureUsage.RENDER_ATTACHMENT});
    engine.render({
      views:[{id:'probe-capture',scene:engine.scene,camera:engine.camera,
        viewport:[0,0,1,1],target:{color:captureTarget}}],
      culling:false,
    });
  }

  async function captureProbes(){
    probes=LightProbes.attach(engine,{
      volume:{...limits,counts:[3,1,1],resolution:16,sh:2,blend:.27},
      reflections:reflectionPoints,resolution:64,reflectionBlend:'weighted',near:.065,far:15,
    });
    performance.mark('probe-capture-start');
    probes.setLiveVolume({probesPerFrame:3});
    try{captureFrame();}
    finally{probes.setLiveVolume(null);}
    await probes.readback();
    if(probes.sweeps!==1)throw new Error('The irradiance probe volume did not finish its first sweep.');
    performance.mark('irradiance-ready');
    for(let i=0;i<3;i++){
      signal.throwIfAborted();
      probes.setLive({facesPerFrame:6,priority:'nearest',samples:64});
      const ready=probes.refresh(i);
      try{captureFrame();}
      finally{probes.setLive(null);}
      await ready;
      await new Promise(resolve=>requestAnimationFrame(resolve));
    }
    await probes.readback();
    signal.throwIfAborted();
    ball=buildSphere(engine);
    if(earlyScene){
      earlyScene.dispose();
      earlyScene=undefined;
      earlyLight=undefined;
    }
    viewport.dataset.probeBytes=String(probes.byteLength);
  }

  function installBakedField(){
    earlyScene=engine.createScene('rolling-probe-sphere');
    earlyScene.background=null;
    light(earlyScene);
    earlyLight=new SHLight({coefficients:coefficients(x)});
    earlyScene.use(earlyLight);
    ball=buildSphere(earlyScene);
    viewport.dataset.probes='3,0';
    viewport.dataset.irradiance='captured';
    progress.hidden=false;
    performance.mark('captured-irradiance-ready');
  }

  function complete(){
    viewport.dataset.probes='3,3';
    viewport.dataset.irradiance='live-capture';
    performance.mark('reflections-ready');
    progress.hidden=true;
  }

  function prepareReflections(){
    if(signal.aborted||page.failed||reflectionsPreparing)return;
    reflectionsPreparing=true;
    captureProbes().then(async()=>{
      await draw(false);
      complete();
    }).catch(fail);
  }

  async function run(){
    const room=buildArchitecture();
    performance.mark('architecture-prepared');
    engine=await opening;
    signal.throwIfAborted();
    engine.scene.background='#465150';
    camera(x);
    light(engine.scene);
    for(const {geometry,material} of room)engine.createMesh().setGeometry(geometry).setMaterial(material);
    const native=viewport.dataset.renderer==='webgpu';
    if(native)await captureProbes();
    else installBakedField();
    await draw(false);
    if(native)complete();
    performance.mark('gallery-frame');
    path.addEventListener('input',()=>void input(),{signal});
    satin.addEventListener('change',()=>void input(),{signal});
    observer=new ResizeObserver(()=>{
      if(!resize()||signal.aborted)return;
      try{camera(x);render();}catch(reason){fail(reason);}
    });
    observer.observe(canvas);
    if(page.ready()){
      field.disabled=false;
      satin.disabled=false;
      loading.hidden=true;
      if(!native)reflectionTimer=setTimeout(prepareReflections,Math.max(1050,3550-performance.now()));
    }
  }

  run().catch(fail);
  return ()=>{
    clearTimeout(reflectionTimer);
    observer?.disconnect();
    captureTarget?.destroy();
  };
}
