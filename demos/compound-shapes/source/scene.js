import { autoEngine } from '@margoengine/webgl2-compat/auto';
import { furnish } from './art.js';
import { fixed,specimens } from './layout.js';
import { light } from './shadows.js';

const camera={position:[2.05,1.68,2.64],target:[0,.48,-.12],near:.055,far:70};
const nextFrame=()=>new Promise(resolve=>requestAnimationFrame(resolve));

export async function openScene(input,force,signal,prepared,onState,onFirst,onError){
  let engine,rig,art,createRig,observer,error,last=0,raf=0,selected=0,run=0;
  let canvas=input,disposed=false,ready=false,playing=false,first=false;
  function close(){
    if(disposed)return;
    disposed=true;
    cancelAnimationFrame(raf);
    observer?.disconnect();
    rig?.dispose();
    engine?.dispose();
  }
  function fail(cause){
    if(signal.aborted)return;
    close();
    onError(cause);
  }
  signal.addEventListener('abort',close,{once:true});
  function project(out,aspect,webgpu){
    const {near,far}=engine.camera,d=far-near,span=Math.max(2.71,3.62/aspect);
    out[0]=2/(span*aspect);out[5]=2/span;
    out[10]=webgpu?1/d:-2/d;
    out[14]=webgpu?far/d:-(far+near)/d;
    out[15]=1;
  }
  function paint(onlyIfResized=false){
    signal.throwIfAborted();
    if(error)throw error;
    const scale=Math.min(devicePixelRatio,2,1440/Math.max(1,canvas.clientWidth));
    const w=Math.max(1,Math.round(canvas.clientWidth*scale)),h=Math.max(1,Math.round(canvas.clientHeight*scale));
    if(onlyIfResized&&canvas.width===w&&canvas.height===h)return;
    if(canvas.width!==w)canvas.width=w;
    if(canvas.height!==h)canvas.height=h;
    engine.render({delta:0});
  }
  async function submitted(){
    if(engine.gpu)await engine.gpu.queue.onSubmittedWorkDone();
    else canvas.getContext('webgl2').finish();
  }
  function status(){
    onState({observations:rig.observations,motion:rig.stats(),selected,run,playing});
  }
  function tick(timestamp){
    raf=0;
    if(disposed||!playing)return;
    try{
      const dt=Math.max(0,Math.min(.07,last?(timestamp-last)/1000:fixed));
      last=timestamp;
      const starting=rig.world.stepCount===0;
      if(starting){
        rig.world.step();
        rig.world.sync(1);
      }else rig.world.update(dt);
      const movement=rig.stats();
      art.shade(rig.bodies,starting?1:rig.world.alpha);
      paint();
      if(movement.every(item=>item.sleeping))playing=false;
      const qualifying=!first&&movement.some((item,index)=>Math.abs(item.height-specimens[index].position[1])>.0008);
      status();
      if(qualifying){
        first=true;
        performance.mark('compound-first-motion-submitted');
        void submitted().then(()=>{
          if(disposed)return;
          onFirst();
          if(playing&&!raf)raf=requestAnimationFrame(tick);
        }).catch(fail);
      }else if(playing)raf=requestAnimationFrame(tick);
    }catch(cause){fail(cause);}
  }
  function reset(){
    cancelAnimationFrame(raf);
    raf=0;
    playing=false;
    last=0;
    rig.dispose();
    for(let i=0;i<specimens.length;i++){
      art.roots[i].setPosition(specimens[i].position).setQuaternion(specimens[i].rotation);
    }
    rig=createRig(art.roots);
    rig.world.sync(1);
    art.mark(selected,rig.observations);
    art.shade(rig.bodies,1);
    paint();
    status();
  }
  function release(){
    if(playing)return;
    if(rig.world.stepCount>0)reset();
    playing=true;
    run++;
    rig.tumble();
    last=0;
    raf=requestAnimationFrame(tick);
    status();
  }
  function select(index){
    selected=index;
    art.mark(selected,rig.observations);
    paint();
    status();
  }
  try{
    engine=await autoEngine(input,async target=>{
      engine=target;
      canvas=target.canvas;
      target.onError=cause=>{error=cause;if(ready)fail(cause);};
      target.camera.project=project;
      target.scene.background='#26363c';
      target.lighting.direction.set(light);
      target.lighting.radiance.set([1,.91,.78,.84]);
      target.lighting.ambient.set([.77,.94,1]);
      performance.mark('compound-device');
      art=furnish(engine);
      paint();
      performance.mark('compound-art');
      const result=await prepared;
      if(result.error)throw result.error;
      signal.throwIfAborted();
      createRig=result.openRig;
      rig=createRig(art.roots);
      rig.world.sync(1);
      art.mark(selected,rig.observations);
      art.shade(rig.bodies,1);
      performance.mark('compound-world');
      await nextFrame();
      paint();
      await submitted();
      signal.throwIfAborted();
    },{
      backend:force?'webgl2':undefined,signal,exactSize:true,antialias:true,capacity:170,startupTimeout:9000,camera,
    });
    ready=true;
    observer=new ResizeObserver(()=>{
      if(disposed)return;
      try{paint(true);}catch(cause){fail(cause);}
    });
    observer.observe(canvas);
  }catch(cause){
    close();
    throw cause;
  }
  return {release,reset,select,status,close,backend:engine.backend};
}
