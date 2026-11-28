import { Clustered } from '@margoengine/clustered';
import { buildHall } from './hall.js';
import { createFixtures, lightCount, shadowCount } from './fixtures.js';
import { lightLenses } from './lenses.js';

const canvas=document.querySelector('#hall');
const slider=document.querySelector('#phase');
const phaseLabel=document.querySelector('#phase-value');
const play=document.querySelector('#play');
const inspect=document.querySelector('#inspect');
const meter=document.querySelector('#meter');
const loading=document.querySelector('#status');
const lightCounter=document.querySelector('#light-count');
const shadowCounter=document.querySelector('#shadow-count');
const reduced=matchMedia('(prefers-reduced-motion: reduce)');
const controls=[slider,play,inspect];

function cameraFor(engine){
  const tall=canvas.width/canvas.height<1.22;
  engine.camera.position=tall?[-3.64,3.4,17.3]:[-6.7,3.65,14.8];
  engine.camera.target=tall?[.30,4.02,-1.9]:[.63,4.0,-2.38];
  engine.camera.fov=tall?58:51;
}

export async function open({engine,status,resize,signal,fail}){
  engine.onError=fail;
  engine.scene.background='#101220';
  engine.lighting.direction.set([0,1,0,0]);
  engine.lighting.radiance.set([.56,.57,.70,.30]);
  engine.lighting.ambient.set([.74,.82,1]);
  cameraFor(engine);
  const compatibility=engine.gpu.adapterInfo?.vendor==='margo-webgl2';
  // One conservative cell avoids repeated index-list construction on the compatibility device.
  // The fragment lighting still evaluates each light's physical range in the same order.
  const geometry={maxLights:lightCount,grid:compatibility?[1,1,1]:[6,4,8]};
  let cluster=Clustered.attach(engine,geometry);
  let realShadows=false;
  const shadowQuality={maxLights:shadowCount,resolution:320,bias:.61,normalBias:.16};
  const number=new Intl.NumberFormat('en-US');
  const motion=createFixtures();
  const lenses=lightLenses(motion.lenses,canvas);
  engine.use(lenses);
  const preparing=lenses.prepare(engine);
  void preparing.catch(()=>{});
  const {casters}=buildHall(engine);

  let playActive=false,previous=0,raf,drawn=Number(slider.value),requested=drawn;
  let input=false,pendingRender,finishTimer,showStats=false,stats,detailStarted=false;
  function pose(value){
    const lights=motion.update(value,realShadows);
    cluster.setLights(lights);
    if(lightCounter.textContent==='—')lightCounter.textContent=number.format(lights.length);
    const activeShadows=String(realShadows?shadowCount:0);
    if(shadowCounter.textContent!==activeShadows)shadowCounter.textContent=activeShadows;
    const percent=Math.round(value);
    const label=percent+'%';
    if(phaseLabel.value!==label){
      phaseLabel.value=label;
      slider.setAttribute('aria-valuetext',percent+' percent');
    }
    canvas.dataset.phase=value.toFixed(3);
    const first=lights[0].position;
    canvas.dataset.source=first.map(lane=>lane.toFixed(4)).join(',');
    canvas.dataset.lights=String(lights.length);
    canvas.dataset.shadows=String(realShadows?shadowCount:0);
  }

  function schedule(){
    if(raf===undefined&&!pendingRender&&!signal.aborted)raf=requestAnimationFrame(draw);
  }
  function setPlay(value){
    playActive=value;
    previous=0;
    play.textContent=value?'Pause sweep':'Play sweep';
    canvas.dataset.playing=String(value);
    if(value)schedule();
  }
  function draw(now){
    raf=undefined;
    if(signal.aborted)return;
    const dt=Math.min(.08,Math.max(0,previous?(now-previous)/1000:0));
    previous=now;
    try {
      if(playActive){
        requested=(requested+dt*16)%100;
        slider.value=String(Math.round(requested));
      }
      const changed=requested!==drawn;
      if(changed){drawn=requested;pose(drawn);}
      engine.render({delta:dt});
      if(input&&changed){
        input=false;
        const submission=engine.gpu.queue.onSubmittedWorkDone();
        pendingRender=submission;
        submission.then(()=>{
          pendingRender=undefined;
          if(signal.aborted)return;
          if(!performance.getEntriesByName('thousand-lights-sweep-rendered').length)
            performance.mark('thousand-lights-sweep-rendered');
          if(playActive||requested!==drawn)schedule();
        }).catch(fail);
      }else if(playActive)schedule();
    } catch(reason){fail(reason);}
  }

  function finish(){
    if(detailStarted||signal.aborted)return;
    detailStarted=true;
    void Promise.all([import('@margoengine/post/bloom'),import('@margoengine/post/stack')])
      .then(([{Bloom},{PostStack}])=>{
        if(signal.aborted)return;
        engine.removePlugin('clustered');
        cluster=Clustered.attach(engine,{...geometry,shadows:shadowQuality});
        for(const caster of casters)cluster.addShadowCaster(caster);
        realShadows=true;
        pose(drawn);
        PostStack.attach(engine,[new Bloom({strength:.26,threshold:1.18,radius:.52,exposure:-.11})]);
        engine.render({delta:0});
        return engine.gpu.queue.onSubmittedWorkDone();
      }).then(()=>{
        if(signal.aborted)return;
        canvas.dataset.finish='bloom';
        performance.mark('thousand-lights-finish');
      }).catch(fail);
  }

  const observer=new ResizeObserver(()=>{
    if(!resize())return;
    cameraFor(engine);
    schedule();
  });
  signal.addEventListener('abort',()=>{
    observer.disconnect();
    clearTimeout(finishTimer);
    if(raf!==undefined)cancelAnimationFrame(raf);
  },{once:true});
  await preparing;
  if(signal.aborted)return;
  pose(drawn);
  engine.render({delta:0});
  await engine.gpu.queue.onSubmittedWorkDone();
  if(signal.aborted)return;
  observer.observe(canvas);
  const listener={signal};
  slider.addEventListener('input',()=>{
    setPlay(false);
    requested=Number(slider.value);
    input=true;
    if(!pendingRender&&raf===undefined&&!performance.getEntriesByName('thousand-lights-sweep-rendered').length)
      draw(performance.now());
    else schedule();
  },listener);
  play.addEventListener('click',()=>setPlay(!playActive),listener);
  document.addEventListener('visibilitychange',()=>{if(document.hidden)setPlay(false);},listener);
  reduced.addEventListener('change',()=>{if(reduced.matches)setPlay(false);},listener);
  inspect.addEventListener('click',async()=>{
    showStats=!showStats;
    inspect.setAttribute('aria-pressed',String(showStats));
    meter.hidden=!showStats;
    if(!showStats)return;
    try{
      const {Stats}=await import('@margoengine/stats');
      if(!signal.aborted&&showStats&&!stats)stats=Stats.attach(engine,{parent:meter,samples:96});
      schedule();
    }catch(reason){fail(reason);}
  },listener);
  canvas.dataset.renderer=compatibility?'compatibility':'webgpu';
  for(const control of controls)control.disabled=false;
  if(status.ready())loading.hidden=true;
  performance.mark('margo-first-usable-frame');
  finishTimer=setTimeout(finish,1650);
}
