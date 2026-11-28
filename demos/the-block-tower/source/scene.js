import { autoEngine } from '@margoengine/webgl2-compat/auto';
import { fixedDelta,travel,towerLayout } from './layout.js';
import { sunDirection } from './shadows.js';
import { furnish } from './art.js';

const camera={
  position:[.62,.74,1.10],target:[0,.305,0],near:.035,far:6,
};
const nextFrame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
const norm=v=>{
  const length=Math.hypot(...v);
  return v.map(value=>value/length);
};
const cross=([a,b,c],[x,y,z])=>[b*z-c*y,c*x-a*z,a*y-b*x];
const forward=norm(camera.target.map((value,index)=>value-camera.position[index]));
const right=norm(cross(forward,[0,1,0]));
const up=cross(right,forward);
const dot=(a,b)=>a.reduce((sum,n,i)=>sum+n*b[i],0);
const scale=(ratio)=>Math.max(.972,1.08/ratio);

export async function openScene(inputCanvas,forced,signal,physicsReady,onUpdate,onFirst,onError){
  let engine,tower,createTower,art,raf,error,observer,selected,pointer,auto,last,moved=0,settle=0;
  let canvas=inputCanvas,running=false,destroyed=false,first=false,ready=false,accumulator=0,overview=0;

  function close(){
    if(destroyed)return;
    destroyed=true;
    cancelAnimationFrame(raf);
    observer?.disconnect();
    tower?.dispose();
    engine?.dispose();
  }
  signal.addEventListener('abort',close,{once:true});
  function fail(cause){
    if(signal.aborted)return;
    close();
    onError(cause);
  }
  function project(out,ratio,webgpu){
    const span=scale(ratio)*(1+.32*overview),{far,near}=engine.camera,range=far-near;
    out[0]=2/(span*ratio);out[5]=2/span;
    out[10]=webgpu?1/range:-2/range;
    out[14]=webgpu?far/range:-(far+near)/range;out[15]=1;
  }
  function paint(onlyIfResized=false){
    if(error)throw error;
    signal.throwIfAborted();
    const ratio=Math.min(devicePixelRatio,2,1600/Math.max(1,canvas.clientWidth));
    const width=Math.max(1,Math.round(canvas.clientWidth*ratio)),height=Math.max(1,Math.round(canvas.clientHeight*ratio));
    if(onlyIfResized&&canvas.width===width&&canvas.height===height)return;
    if(canvas.width!==width)canvas.width=width;
    if(canvas.height!==height)canvas.height=height;
    engine.render({delta:0});
    if(error)throw error;
  }
  async function submitted(){
    if(engine.gpu)await engine.gpu.queue.onSubmittedWorkDone();
    else canvas.getContext('webgl2').finish();
  }
  function beams(course){
    return tower.entities.filter(entity=>entity.slot!==null&&!entity.removed&&
      (course===undefined||entity.course===course));
  }
  function direction(entity){
    return dot(entity.axis,camera.position)>=0?1:-1;
  }
  function choose(entity){
    if(entity===selected)return;
    selected=entity;
    art.mark(entity);
  }
  function show(){
    const {held,collapsed,removed,steps,sleeping}=tower.state();
    const crown=tower.entities.at(-1).body.position;
    onUpdate({
      ready,selected:selected?.id??'',course:selected?.course??2,beams:beams().map(beam=>beam.id),
      held:!!held,collapsed,removed,steps,sleeping,millimeters:Math.round(moved*1000),
      crown:crown.map(value=>value.toFixed(4)).join(','),moving:running,
    });
  }
  function pickNext(course){
    const priority=(entity)=>[1,-1,0].indexOf(entity.slot);
    const available=beams(course).sort((a,b)=>priority(b)-priority(a));
    choose(available[0]??beams().find(entity=>entity.slot===0)??beams()[0]);
  }
  function frame(timestamp){
    raf=0;
    if(destroyed)return;
    try{
      const delta=Math.max(0,Math.min(.095,(timestamp-last)/1000||fixedDelta));
      last=timestamp;
      accumulator+=delta;
      const hadStep=accumulator>=fixedDelta;
      while(accumulator>=fixedDelta){
        accumulator-=fixedDelta;
        const {held}=tower.state();
        if(auto&&held){
          auto.tick++;
          const q=Math.min(1,auto.tick/32);
          tower.target(travel*q*(1+q-q*q));
          if(auto.tick>120)tower.release();
        }
        tower.advance();
        if(held){
          const position=held.entity.body.position;
          moved=Math.max(moved,Math.hypot(position[0]-held.start[0],position[2]-held.start[2]));
        }
        const state=tower.state();
        if(!state.held&&auto)auto=null;
        if(state.collapsed)choose(undefined);
        else if(!state.held&&selected?.removed)pickNext(selected.course);
        if(state.held||state.sleeping<tower.entities.length)settle=0;
        else settle++;
      }
      if(tower.state().collapsed&&overview<1){
        overview+=(1-overview)*Math.min(1,delta*7);
        if(overview>.996)overview=1;
        const offset=[-.055,-.062,-.195];
        engine.camera.position=camera.position.map((value,i)=>value+overview*offset[i]);
        engine.camera.target=camera.target.map((value,i)=>value+overview*offset[i]);
      }
      if(hadStep)art.sync();
      paint();
      const firstMotion=!first&&moved>.0028;
      if(firstMotion){
        first=true;
        performance.mark('tower-first-motion-submitted');
      }
      running=settle<4||(tower.state().collapsed&&overview<1);
      show();
      if(firstMotion){
        void submitted().then(()=>{
          if(destroyed)return;
          onFirst();
          if(running&&!raf)raf=requestAnimationFrame(frame);
        }).catch(fail);
      }else if(running)raf=requestAnimationFrame(frame);
    }catch(cause){fail(cause);}
  }
  function wake(){
    settle=0;
    if(running)return;
    running=true;
    accumulator=0;
    last=undefined;
    raf=requestAnimationFrame(frame);
  }
  function startPull(entity=selected,sign=entity?direction(entity):1){
    if(!entity||!tower.grip(entity,sign))return false;
    choose(entity);
    moved=0;
    wake();
    show();
    return true;
  }
  function pull(){
    if(startPull())auto={tick:2};
  }
  function select(id){
    if(tower.state().held||tower.state().collapsed)return;
    const entity=beams().find(item=>item.id===id);
    if(entity){
      choose(entity);
      paint();
      show();
    }
  }
  function pointerRay(event){
    const bounds=canvas.getBoundingClientRect(),h=bounds.height,span=scale(bounds.width/h);
    const dx=(event.clientX-bounds.left-bounds.width/2)*span/h;
    const dy=(bounds.top+h/2-event.clientY)*span/h;
    return camera.position.map((value,index)=>value+right[index]*dx+up[index]*dy);
  }
  function grab(event){
    if(event.button!==0||pointer)return;
    const hit=tower.world.raycast(pointerRay(event),forward);
    const entity=beams().find(beam=>beam.body===hit?.body);
    if(!entity)return;
    const center=entity.body.position;
    const side=hit.point.reduce((sum,value,index)=>sum+(value-center[index])*entity.axis[index],0);
    const sign=Math.abs(side)>.02?Math.sign(side):direction(entity);
    if(!startPull(entity,sign))return;
    const worldPerPixel=scale(canvas.clientWidth/canvas.clientHeight)/canvas.clientHeight;
    pointer={id:event.pointerId,x:event.clientX,y:event.clientY,
      ds:dot(entity.axis,right)*sign,dt:dot(entity.axis,up)*sign,worldPerPixel};
    canvas.setPointerCapture(event.pointerId);
  }
  function drag(event){
    if(event.pointerId!==pointer?.id)return;
    const {x,y,ds,dt,worldPerPixel}=pointer;
    const projected=ds*ds+dt*dt;
    if(projected<.05)return;
    tower.target(((event.clientX-x)*ds+(y-event.clientY)*dt)*worldPerPixel/projected);
  }
  function release(event){
    if(event.pointerId!==pointer?.id)return;
    pointer=null;
    tower.release();
  }
  function reset(){
    cancelAnimationFrame(raf);
    raf=0;
    running=false;
    pointer=null;
    auto=null;
    moved=0;
    overview=0;
    engine.camera.position=camera.position;
    engine.camera.target=camera.target;
    tower.dispose();
    tower=createTower();
    art.swap(tower.entities);
    art.sync();
    choose(beams(2).find(entity=>entity.slot===0));
    paint();
    show();
  }
  try{
    engine=await autoEngine(inputCanvas,async target=>{
      engine=target;
      canvas=target.canvas;
      target.onError=cause=>{error=cause;if(ready)fail(cause);};
      target.camera.project=project;
      target.scene.background='#292e28';
      target.lighting.direction.set(sunDirection);
      target.lighting.radiance.set([1,.92,.81,.9]);
      target.lighting.ambient.set([.83,.94,.93]);
      performance.mark('tower-device');
      art=furnish(target,towerLayout());
      performance.mark('tower-geometry');
      paint();
      await nextFrame();
      const result=await physicsReady;
      if(result.error)throw result.error;
      signal.throwIfAborted();
      createTower=result.createTower;
      tower=createTower();
      art.swap(tower.entities);
      art.sync();
      choose(beams(2).find(entity=>entity.slot===0));
      paint();
      await submitted();
      signal.throwIfAborted();
    },{
      backend:forced?'webgl2':undefined,signal,capacity:320,
      exactSize:true,antialias:true,startupTimeout:11000,camera,
    });
    ready=true;
    observer=new ResizeObserver(()=>{
      if(destroyed||running)return;
      try{paint(true);}catch(cause){fail(cause);}
    });
    observer.observe(canvas);
    canvas.addEventListener('pointerdown',grab,{signal});
    canvas.addEventListener('pointermove',drag,{signal});
    for(const event of ['pointerup','pointercancel','lostpointercapture'])canvas.addEventListener(event,release,{signal});
  }catch(cause){
    close();
    throw cause;
  }
  return {pull,select,reset,show,close,backend:engine.backend};
}
