import { autoEngine } from '@margoengine/webgl2-compat/auto';
import { furnish } from './art.js';
import { ballStart,fixed,pivot,start } from './layout.js';

const camera={position:[.19,1.72,1.36],target:[0,.040,-.008],near:.025,far:30};
const bufferLimit=.30;

export async function openScene(input,force,signal,prepared,sample,state,firstPaint,error,onPreview,onPhysics){
  let engine,rig,art,createRig,observer,problem,frame=0,last=0,activeUntil=0,canvas=input;
  let closed=false,initialized=false,scored=false,pendingTime=0,aim=[0,0];
  const pending=[];
  function close(){
    if(closed)return;
    closed=true;
    cancelAnimationFrame(frame);
    observer?.disconnect();
    rig?.dispose();
    engine?.dispose();
  }
  function fail(cause){
    if(signal.aborted||closed)return;
    close();
    error(cause);
  }
  signal.addEventListener('abort',close,{once:true});
  function project(out,aspect,webgpu){
    const {near,far}=engine.camera,d=far-near,span=Math.max(1.14,1.25/aspect);
    out[0]=2/(span*aspect);out[5]=2/span;
    out[10]=webgpu?1/d:-2/d;
    out[14]=webgpu?far/d:-(far+near)/d;
    out[15]=1;
  }
  function paint(onlyIfResized=false){
    signal.throwIfAborted();
    if(problem)throw problem;
    const scale=Math.min(devicePixelRatio,2,1500/Math.max(1,canvas.clientWidth));
    const w=Math.max(1,Math.round(canvas.clientWidth*scale)),h=Math.max(1,Math.round(canvas.clientHeight*scale));
    if(onlyIfResized&&canvas.width===w&&canvas.height===h)return;
    if(canvas.width!==w)canvas.width=w;
    if(canvas.height!==h)canvas.height=h;
    engine.render({delta:0});
  }
  async function fence(){
    if(engine.gpu)await engine.gpu.queue.onSubmittedWorkDone();
    else canvas.getContext('webgl2').finish();
  }
  function show(){
    const view=rig.stats();
    art.shade(view.position);
    paint();
    state(view);
    const length=Math.hypot(...aim);
    const downhill=length&&((view.position[0]-start[0])*aim[0]+(view.position[2]-start[1])*aim[1])/length;
    if(!scored&&downhill>.003&&view.contacts>0){
      scored=true;
      performance.mark('maze-first-roll-submitted');
      void fence().then(()=>{if(!closed)firstPaint();}).catch(fail);
    }
    return view;
  }
  function tick(now){
    frame=0;
    if(closed)return;
    try{
      const dt=last?Math.min(.052,Math.max(0,(now-last)/1000)):fixed;
      last=now;
      const commanded=sample(now);
      const commanding=Math.hypot(...commanded)>.025;
      if(commanding)aim=commanded;
      if(!rig){
        // Keep the real aim history while the Wasm package loads. The solver replays it before any moving frame is painted.
        if((commanding||pending.length)&&pendingTime<bufferLimit){
          const duration=Math.min(dt,bufferLimit-pendingTime);
          pending.push({dt:duration,commanded});
          pendingTime+=duration;
        }
        if(now<activeUntil||commanding)frame=requestAnimationFrame(tick);
        else last=0;
        return;
      }
      rig.aim(...commanded);
      rig.world.update(dt);
      rig.world.sync(1);
      const view=show();
      if(now<activeUntil||commanding||
          Math.hypot(...rig.ball.linearVelocity)>.011||Math.hypot(...view.tilt)>.005){
        frame=requestAnimationFrame(tick);
      }else last=0;
    }catch(cause){fail(cause);}
  }
  function wake(){
    if(closed)return;
    activeUntil=performance.now()+1200;
    if(!frame)frame=requestAnimationFrame(tick);
  }
  function spawnRig(){
    rig?.dispose();
    art.board.setPosition(pivot).setQuaternion([0,0,0,1]);
    art.marble.setPosition(ballStart).setQuaternion([0,0,0,1]);
    rig=createRig(art.board,art.marble);
  }
  function reset(){
    cancelAnimationFrame(frame);
    frame=last=activeUntil=pendingTime=0;
    aim=[0,0];
    pending.length=0;
    if(!createRig)return;
    spawnRig();
    rig.world.sync(1);
    show();
  }
  try{
    engine=await autoEngine(input,async target=>{
      engine=target;
      canvas=target.canvas;
      target.onError=cause=>{problem=cause;if(initialized)fail(cause);};
      target.camera.project=project;
      target.scene.background='#303f43';
      target.lighting.direction.set([-.50,.83,.34,2.72]);
      target.lighting.radiance.set([1,.94,.82,.66]);
      target.lighting.ambient.set([.79,.91,1.0]);
      performance.mark('maze-device');
      art=furnish(engine);
      paint();
      await fence();
      signal.throwIfAborted();
      state({position:[start[0],ballStart[1]-pivot[1],start[1]],velocity:[0,0,0],
        tilt:[0,0],solved:false,crossing:null,contacts:0,steps:0,traveled:0,caught:false});
      onPreview({wake,reset,close,backend:engine.backend});

      const module=await prepared;
      if(module.error)throw module.error;
      signal.throwIfAborted();
      createRig=module.openRig;
      spawnRig();
      for(const {dt,commanded} of pending){
        rig.aim(...commanded);
        rig.world.update(dt);
      }
      pending.length=0;
      pendingTime=0;
      rig.world.sync(1);
      show();
      performance.mark('maze-world-frame');
      await fence();
      onPhysics();
      if(rig.world.stepCount)wake();
    },{
      backend:force?'webgl2':undefined,signal,exactSize:true,antialias:true,capacity:190,startupTimeout:8500,camera,
    });
    initialized=true;
    observer=new ResizeObserver(()=>{
      try{if(!closed)paint(true);}catch(cause){fail(cause);}
    });
    observer.observe(canvas);
  }catch(cause){close();throw cause;}
}
