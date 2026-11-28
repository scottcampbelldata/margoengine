import { Engine,Camera } from '@margoengine/core';
import { LayerCompositor,PixelCamera } from '@margoengine/pixel';
import { Render3D } from '@margoengine/pixel/render3d';
import { PaletteQuantize } from '@margoengine/pixel/palette';
import { CRT } from '@margoengine/pixel/crt';
import { design } from './art.js';
import { flight } from './flight.js';

export const raster=[192,108];
const palette=[
  '#0c101d','#151b31','#202840','#283552','#2c435a','#375a6f','#487480','#5a9290',
  '#6fa9a0','#95c3b2','#bfdfcc','#e2e9d0','#503447','#734858','#9c6169','#bd796f',
  '#c99478','#dcb38f','#ebca9c','#ffe8bb','#7c7b95','#a194a8','#bbafb8','#e0bbc0',
];
const linear=value=>{
  const v=Number.parseInt(value,16)/255;
  return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;
};
const phosphor=palette.map(value=>{
  const l=.2126*linear(value.slice(1,3))+.7152*linear(value.slice(3,5))+.0722*linear(value.slice(5,7));
  const y=Math.sqrt(l);
  return [Math.round(10+152*y),Math.round(20+220*y),Math.round(18+137*y)];
});
const crtLook={curvature:.096,mask:.13,scanlines:.25,glow:.105,brightness:1.20};
const cleanLook={curvature:0,mask:0,scanlines:0,glow:0,brightness:1};

export async function show(canvas,{compatibility,signal,report,onFirst,fail}){
  let engine,raf=0,prior=0,receipt=null,measured=false,disposed=false;
  const game=flight();
  const [width,height]=raster;
  const modes={display:'crt',palette:'color',dither:'bayer4'};
  const stepSize=1/120;
  let carry=0,world,art,small,crt,colors,view;
  function dispose(){
    if(disposed)return;
    disposed=true;
    cancelAnimationFrame(raf);
    engine?.dispose();
  }
  signal.addEventListener('abort',dispose,{once:true});
  function paint(){
    signal.throwIfAborted();
    const state=game.state();
    art.pose(state);
    view.position=[state.follow*.16,3.84,state.z+8.45];
    view.target=[state.follow*.31,1.25,state.z-17];
    engine.render({delta:0,views:[small.view,{camera:view,viewport:[0,0,1,1]}]});
    report(state,compatibility,modes,world.stats.visible,art.meshCount,raster);
  }
  function schedule(){
    if(!raf&&!signal.aborted&&!document.hidden)raf=requestAnimationFrame(tick);
  }
  function tick(now){
    raf=0;
    if(signal.aborted||document.hidden)return;
    try{
      const elapsed=prior?Math.min(.075,Math.max(0,(now-prior)/1000)):1/60;
      prior=now;
      carry+=elapsed;
      while(carry+1e-10>=stepSize){game.step(stepSize);carry-=stepSize;}
      const state=game.state();
      paint();
      if(receipt!==null&&!measured&&receipt-state.z>.083){
        measured=true;
        performance.mark('crt-first-flight-submitted');
        void engine.gpu.queue.onSubmittedWorkDone().then(()=>{if(!signal.aborted)onFirst();}).catch(fail);
      }
      if(state.phase==='running')schedule();
      else carry=prior=0;
    }catch(error){fail(error);}
  }
  function safe(action){
    try{action();}catch(error){fail(error);}
  }
  function toggle(trusted){
    safe(()=>{
      const before=game.state();
      game.toggle();
      const {phase,z}=game.state();
      if(phase==='running'){
        if(trusted&&!measured)receipt=z;
        prior=carry=0;
        schedule();
      }else{
        cancelAnimationFrame(raf);
        raf=prior=carry=0;
        if(before.phase==='running'&&!measured)receipt=null;
      }
      paint();
    });
  }
  function choose(lane){
    safe(()=>{
      game.choose(lane);
      paint();
    });
  }
  function adjust(key,mode){
    safe(()=>{
      modes[key]=mode;
      if(key==='display')Object.assign(crt,mode==='crt'?crtLook:cleanLook);
      if(key==='palette')colors.setSwap(mode==='green'?phosphor:palette);
      if(key==='dither')colors.dither=mode;
      paint();
    });
  }
  function onVisibility(){
    if(!document.hidden)return;
    game.pause();
    cancelAnimationFrame(raf);
    raf=carry=prior=0;
  }

  try{
    engine=await Engine.create(canvas,{backend:'webgpu',exactSize:[width*4,height*4],signal,startupTimeout:9000,capacity:626});
    engine.onError=fail;
    performance.mark('crt-device');
    engine.scene.background='#0c101d';
    world=engine.createScene('Courier approach');
    world.lighting.direction.set([-.37,.73,.58,2.22]);
    world.lighting.radiance.set([1,.94,.84,.52]);
    world.lighting.ambient.set([.83,.92,1.0]);
    art=design(world);
    view=new Camera({fov:39,near:.17,far:300,position:[0,3.84,8.45],target:[0,1.25,-17]});
    const canvasCamera=new PixelCamera({width,height,zoom:4});
    const layer=LayerCompositor.attach(engine,{camera:canvasCamera}).addLayer({visible:false});
    small=Render3D.attach(engine,{scene:world,camera:view,width,height,
      background:'#080d19',outline:{color:'#151b31',depthEdge:7.5,crease:1.30}});
    colors=PaletteQuantize.attach(engine,{palette,source:()=>small.output,target:layer.target,dither:modes.dither,
      spread:.053,order:24});
    crt=CRT.attach(engine,{source:layer.target,...crtLook});
    paint();
    performance.mark('crt-raster-submitted');
    await engine.gpu.queue.onSubmittedWorkDone();
    signal.throwIfAborted();
  }catch(error){dispose();throw error;}
  document.addEventListener('visibilitychange',onVisibility,{signal});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)safe(paint);},{signal});
  return {toggle,choose,adjust,dispose};
}
