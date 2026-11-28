import { autoEngine } from '@margoengine/webgl2-compat/auto';
import { furnish } from './art.js';
import { layout } from './layout.js';
import { camera,origin,pace,range } from './view.js';

export async function openRain(initialCanvas,force,signal,worker,prepared,onState,onFirst,onError){
  const entities=layout();
  let engine,art,observer,error,current,previous,queued;
  let canvas=initialCanvas,raf=0,received=0,duration=1000/pace,marked=-1;
  let ready=false,disposed=false,first=false;
  const position=[0,0,0],rotation=[0,0,0,1];
  function close(){
    if(disposed)return;
    disposed=true;
    cancelAnimationFrame(raf);
    observer?.disconnect();
    worker.terminate();
    engine?.dispose();
  }
  signal.addEventListener('abort',close,{once:true});
  function fail(cause){
    if(signal.aborted)return;
    close();
    onError(cause);
  }
  function project(out,aspect,webgpu){
    const {near,far}=engine.camera,span=range(aspect),extent=far-near;
    out[0]=2/(span*aspect);
    out[5]=2/span;
    out[10]=webgpu?1/extent:-2/extent;
    out[14]=webgpu?far/extent:-(far+near)/extent;
    out[15]=1;
  }
  function render(onlyIfResized=false){
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
  function apply(from,to,alpha){
    for(let i=0;i<entities.length;i++){
      const offset=i*7;
      for(let j=0;j<3;j++)position[j]=from[offset+j]+(to[offset+j]-from[offset+j])*alpha;
      let sameSide=0;
      for(let j=3;j<7;j++)sameSide+=from[offset+j]*to[offset+j];
      const sign=sameSide<0?-1:1;
      for(let j=3;j<7;j++)rotation[j-3]=from[offset+j]+(to[offset+j]*sign-from[offset+j])*alpha;
      art.objects[i].setPosition(position).setQuaternion(rotation);
    }
  }
  function show(){
    if(!current){
      const representative=entities[209].position.map(value=>value.toFixed(4)).join(',');
      onState({awake:null,inputs:0,steps:0,work:0,run:1,total:entities.length,representative,queued:!!queued});
      return;
    }
    const id=209*7;
    const {poses,...state}=current;
    const representative=Array.from(poses.subarray(id,id+3),value=>value.toFixed(4)).join(',');
    onState({...state,representative,physicsReady:true});
  }
  function frame(timestamp){
    raf=0;
    if(disposed)return;
    try{
      const qualifying=!first&&current.inputs>0&&current.hit?.observed>.1;
      const alpha=qualifying||current.reset?1:Math.min(1,Math.max(0,(timestamp-received)/duration));
      apply(previous,current.poses,alpha);
      const active=current.highlight?current.hit.id:-1;
      if(active!==marked){
        art.mark(active);
        marked=active;
      }
      render();
      if(qualifying){
        first=true;
        performance.mark('rain-first-motion-submitted');
        void submitted().then(()=>{if(!disposed)onFirst();}).catch(fail);
      }
      if(alpha<1)raf=requestAnimationFrame(frame);
    }catch(cause){fail(cause);}
  }
  function receive(state){
    if(disposed)return;
    const time=performance.now();
    previous=state.reset||!current?state.poses:current.poses;
    duration=Math.max(1000/pace,Math.min(135,time-received));
    received=time;
    current=state;
    show();
    if(!raf)raf=requestAnimationFrame(frame);
  }
  function command(next){
    if(current)worker.postMessage(next);
    else{
      queued=next;
      show();
    }
  }
  function screenRay(x,y){
    const box=canvas.getBoundingClientRect(),units=range(box.width/box.height)/box.height;
    const dx=(x-box.left-box.width/2)*units,dy=(box.top+box.height/2-y)*units;
    command({type:'ray',origin:origin(dx,dy)});
  }
  try{
    engine=await autoEngine(initialCanvas,async target=>{
      engine=target;
      canvas=target.canvas;
      target.onError=cause=>{error=cause;if(ready)fail(cause);};
      target.camera.project=project;
      target.scene.background='#33413e';
      target.lighting.direction.set([-.52,.76,.4,2.42]);
      target.lighting.radiance.set([1,.91,.74,.62]);
      target.lighting.ambient.set([.82,.93,.92]);
      performance.mark('rain-device');
      art=furnish(engine,entities);
      render();
      performance.mark('rain-art');
      await submitted();
      signal.throwIfAborted();
    },{
      backend:force?'webgl2':undefined,capacity:920,signal,exactSize:true,antialias:true,startupTimeout:10000,camera,
    });
    ready=true;
    observer=new ResizeObserver(()=>{
      if(disposed)return;
      try{render(true);}catch(cause){fail(cause);}
    });
    observer.observe(canvas);
    canvas.addEventListener('click',event=>screenRay(event.clientX,event.clientY),{signal});
  }catch(cause){
    close();
    throw cause;
  }

  void prepared.then(result=>{
    if(disposed)return;
    if(result.error)throw result.error;
    signal.throwIfAborted();
    current=result;
    previous=result.poses;
    performance.mark('rain-world');
    if(queued){
      worker.postMessage(queued);
      queued=null;
    }
    show();
  }).catch(fail);
  return {receive,drop:()=>command({type:'drop'}),shoot:()=>command({type:'center'}),show,close,backend:engine.backend};
}
