import {Engine} from '@margoengine/core';
import {ThirdPersonControls} from '@margoengine/controls/third-person';
import {demoStatus} from 'margo-demo-status';
import {hz,stairCount,stairEntrance,stairExit,stairTop,rampHigh,rampLow,ferryHome,ferryY,start} from './layout.js';
import {buildStation,buildFerry,tuneLighting} from './art.js';
import {loadInspector,createInspector} from './avatar.js';
import {primeCourseKernel} from './kernel-transport.js';

const by=id=>document.getElementById(id);
const canvas=by('scene'),viewport=by('viewport'),loading=by('loading'),error=by('error'),guide=by('guide');
const cue=by('cue'),steps=by('steps'),support=by('support'),grade=by('grade');
const status=demoStatus(viewport,loading,error);
const lifecycle=new AbortController(),{signal}=lifecycle;
const forced=new URLSearchParams(location.search).get('backend')==='webgl2';
const actions=['forward','left','back','right','jump'];
const controls=[guide,by('reset'),...actions.map(by)];
const keymap={KeyW:'forward',ArrowUp:'forward',KeyA:'left',ArrowLeft:'left',KeyS:'back',ArrowDown:'back',KeyD:'right',ArrowRight:'right',Space:'jump'};
const keys=new Set(),pointerActions=new Map(),nudges=new Map();
const waitFrame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
const zero=[0,0];
const dt=1/hz;
let engine,course,follow,person,ferry,observer,current,raf=0,last=0,owed=0,lastHeading=zero;
let guided=false,wantJump=false,firstAsked=false,firstPainted=false,firstWorkingOrigin,measureBusy=false,active=false;
let misses=0,quietUntil=0,layoutDirty=true;

function setGuided(value){
  guided=value;
  guide.setAttribute('aria-pressed',String(value));
  guide.textContent=value?'Pause guided walk':'Start guided walk';
}
function fail(reason){
  if(signal.aborted||status.failed)return;
  controls.forEach(el=>{el.disabled=true;});
  active=false;loading.hidden=true;error.hidden=false;
  status.error(reason);
}
function size(){
  const {width,height}=canvas.getBoundingClientRect(),ratio=Math.min(devicePixelRatio||1,1.65,1350/width);
  const w=Math.round(width*ratio),h=Math.round(height*ratio);
  if(!w||!h||canvas.width===w&&canvas.height===h)return false;
  canvas.width=w;canvas.height=h;
  return true;
}
async function openEngine(){
  const options={backend:'webgpu',exactSize:true,antialias:true,signal,startupTimeout:9000,startupWarning:3500,
    camera:{position:[.64,3.0,12.0],target:[0,1.01,7.3],near:.10,far:100,fov:48}};
  if(!forced&&navigator.gpu){
    try{
      const gpu=await Engine.create(canvas,options);
      viewport.dataset.renderer='webgpu';return gpu;
    }catch(error){
      signal.throwIfAborted();
      if(error?.code&&!['unsupported','adapter','device','timeout','startup'].includes(error.code))throw error;
    }
  }
  const {webglRenderer}=await import('@margoengine/webgl2-compat/preview');
  const gl=await Engine.create(canvas,{...options,backend:'webgl2',fallback:webglRenderer});
  viewport.dataset.renderer='webgl2';return gl;
}
function add(parts,parent=null){
  return parts.map(part=>{
    const mesh=engine.createMesh(parent).setGeometry(part.geometry).setMaterial(part.material);
    mesh.name='Station_'+part.name;
    return mesh;
  });
}
function modelPose(){
  ferry.setPosition([0,ferryY,current.ferryZ]);
}
function description({foot,stairs,onFerry,ride,seenSlope,finished,fell}){
  const z=foot[2];
  if(finished)return 'Course complete';
  if(fell>misses)return 'Back at the checkpoint';
  if(onFerry)return ride==='outbound'?'Riding the ferry':ride==='far'?'Leave the ferry':'Stand on the brass ring';
  if(z<-11.93)return 'Lower deck';
  if(seenSlope&&z<rampHigh+.08)return 'Descending the ramp';
  if(z<-6.23)return 'Across the gorge';
  if(z<stairExit+.18)return ride==='home'?'Board the ferry':'Wait for the ferry';
  if(stairs||z<stairEntrance+.52)return 'Climb the steps';
  return 'Arrival deck';
}
function readout(){
  const {foot,stairs,seenSlope,crossed,finished,fell,ride,onFerry,grounded,slope,walked,collisions,ferryZ}=current;
  const surface=onFerry?'Ferry deck':grounded?'Grounded':'Airborne';
  if(steps.value!==(stairs+' / '+stairCount))steps.value=stairs+' / '+stairCount;
  if(support.value!==surface)support.value=surface;
  const angle=grounded?(slope*180/Math.PI).toFixed(1)+'°':'—';
  if(angle!==grade.value)grade.value=angle;
  const words=description(current);
  if(cue.value!==words)cue.value=words;
  misses=fell;
  Object.assign(viewport.dataset,{
    x:foot[0].toFixed(4),y:foot[1].toFixed(4),z:foot[2].toFixed(4),stairs:String(stairs),surface,seenSlope:String(seenSlope),
    slope:(slope*180/Math.PI).toFixed(2),crossed:String(crossed),finished:String(finished),ride,onFerry:String(onFerry),fall:String(fell),
    ferry:ferryZ.toFixed(4),walked:walked.toFixed(3),collisions:String(collisions),guided:String(guided),
    cameraYaw:follow.yaw.toFixed(3),cameraArm:follow.armLength.toFixed(3),...person.stats(),
  });
}
function nearInput(){
  if(firstAsked)return;
  firstAsked=true;owed=Math.max(owed,dt);firstWorkingOrigin=[...current.foot];performance.mark('first-course-input');
}
async function painted(){
  if(engine.gpu)await engine.gpu.queue.onSubmittedWorkDone();
  else canvas.getContext('webgl2')?.finish();
  await waitFrame();
  signal.throwIfAborted();
}
function resetRun(){
  setGuided(false);
  course.reset();
  course.step();
  current=course.state();
  owed=0;misses=0;
  modelPose();
  follow.yaw=.30;follow.pitch=.365;follow.snap();
  person.advance(current,dt,[0,-1],performance.now(),true);
  readout();
}
function connect(){
  const onKey=(event,down)=>{
    const action=keymap[event.code];
    if(!action||event.altKey||event.ctrlKey||event.metaKey||event.target?.tagName==='BUTTON'&&event.code==='Space')return;
    event.preventDefault();
    if(!active)return;
    if(down){
      if(action==='jump')wantJump=true;
      else keys.add(action);
      setGuided(false);nearInput();
    }else keys.delete(action);
  };
  addEventListener('keydown',event=>onKey(event,true),{signal});
  addEventListener('keyup',event=>onKey(event,false),{signal});
  addEventListener('blur',()=>{keys.clear();pointerActions.clear();nudges.clear();wantJump=false;actions.forEach(id=>delete by(id).dataset.held);},{signal});
  for(const id of actions){
    const button=by(id);
    button.addEventListener('pointerdown',event=>{
      if(!active)return;
      button.setPointerCapture(event.pointerId);
      pointerActions.set(event.pointerId,id);
      nudges.set(id,performance.now()+115);
      button.dataset.held='true';
      if(id==='jump')wantJump=true;
      setGuided(false);nearInput();
    },{signal});
    const clear=event=>{
      pointerActions.delete(event.pointerId);
      if(![...pointerActions.values()].includes(id))delete button.dataset.held;
    };
    button.addEventListener('lostpointercapture',clear,{signal});
    button.addEventListener('pointerup',clear,{signal});
    button.addEventListener('pointercancel',clear,{signal});
    button.addEventListener('click',event=>{
      if(!active||event.detail!==0)return;
      if(id==='jump')wantJump=true;
      else nudges.set(id,performance.now()+140);
      setGuided(false);nearInput();
    },{signal});
  }
  guide.addEventListener('click',()=>{
    if(active&&current.finished)resetRun();
    setGuided(!guided);
    if(guided)nearInput();
    if(!active)loading.textContent=guided?'Guided walk queued while movement loads…':'Preparing movement…';
  },{signal});
  by('reset').addEventListener('click',resetRun,{signal});
}
function input(now){
  const down=key=>keys.has(key)||[...pointerActions.values()].includes(key)||(nudges.get(key)??0)>now;
  const forward=Number(down('forward'))-Number(down('back'));
  const side=Number(down('right'))-Number(down('left'));
  const [hx,,hz]=follow.heading;
  return {x:hx*forward-hz*side,z:hz*forward+hx*side,guide:guided,jump:wantJump};
}
function animate(now){
  raf=0;
  if(signal.aborted||status.failed||!active)return;
  const elapsed=last?Math.min(.064,Math.max(0,(now-last)/1000)):dt;
  last=now;
  try{
    if(!firstAsked&&now<quietUntil){
      const looked=follow.update(elapsed);
      if(layoutDirty||looked){engine.render({delta:0});layoutDirty=false;}
      raf=requestAnimationFrame(animate);
      return;
    }
    owed+=elapsed;
    const choose=input(now);
    let moved=false;
    while(owed>=dt){
      const before=current;
      course.step(choose);
      choose.jump=false;
      wantJump=false;
      current=course.state();
      owed-=dt;moved=true;
      if(current.stepDistance>.0015){
        lastHeading=[current.foot[0]-before.foot[0],current.foot[2]-before.foot[2]].map(v=>v/dt);
      }else lastHeading=zero;
    }
    if(guided&&current.finished)setGuided(false);
    modelPose();
    person.advance(current,elapsed,lastHeading,now);
    follow.update(elapsed);
    engine.render({delta:0});layoutDirty=false;
    if(moved)readout();
    const changed=firstWorkingOrigin&&Math.hypot(...current.foot.map((v,i)=>v-firstWorkingOrigin[i]))>.020;
    if(changed&&!firstPainted&&!measureBusy){
      measureBusy=true;
      painted().then(()=>{
        firstPainted=true;performance.mark('first-control-frame');
      }).catch(fail);
    }
  }catch(error){fail(error);return;}
  raf=requestAnimationFrame(animate);
}

size();
if(typeof __COURSE_KERNEL_TRANSPORT__!=='undefined'&&__COURSE_KERNEL_TRANSPORT__)primeCourseKernel(signal).catch(fail);
const physics=import('./physics.js').then(({createCourse})=>createCourse(signal)).then(world=>{
  if(signal.aborted){world.dispose();signal.throwIfAborted();}
  course=world;performance.mark('course-kernel-ready');return world;
});
physics.catch(fail);
const inspector=loadInspector(signal);
inspector.catch(fail);
const artwork=Promise.resolve().then(()=>[buildStation(),buildFerry()]);
async function boot(){
  engine=await openEngine();signal.throwIfAborted();
  engine.onError=fail;performance.mark('engine-ready');
  tuneLighting(engine);
  const [{structure,arches},ferryArt]=await artwork;
  add(structure);
  const overhead=add(arches);
  ferry=engine.createMesh().setPosition([0,ferryY,ferryHome]);
  ferry.name='Gauge_TransferDeck';
  add(ferryArt,ferry);
  engine.render({delta:0});
  await painted();performance.mark('station-frame');
  person=createInspector(engine,await inspector);
  current={foot:[...start],walked:0,grounded:true,slope:0};
  person.advance(current,dt,[0,-1],performance.now(),true);
  follow=new ThirdPersonControls(engine,person.root,{distance:4.45,minDistance:3.12,maxDistance:6.2,
    pivotOffset:[0,1.02,0],shoulder:.54,lag:.11,minPitch:.10,maxPitch:.62,colliders:overhead,element:canvas});
  follow.yaw=.30;follow.pitch=.365;follow.snap();follow.update(dt);
  engine.render({delta:0});
  await painted();performance.mark('inspector-frame');
  loading.textContent='Preparing movement…';connect();guide.disabled=false;
  const openingFoot=current.foot;
  current=(await physics).state();
  modelPose();
  if(Math.hypot(...current.foot.map((value,i)=>value-openingFoot[i]))>.001){
    person.advance(current,dt,[0,-1],performance.now(),true);
    follow.snap();follow.update(dt);
    engine.render({delta:0});
    await painted();
  }
  performance.mark('course-frame');
  readout();
  observer=new ResizeObserver(()=>{if(size())layoutDirty=true;});observer.observe(canvas);
  if(status.ready()){
    active=true;quietUntil=performance.now()+410;controls.forEach(el=>{el.disabled=false;});
    loading.hidden=true;
    if(guided)animate(performance.now());
    else raf=requestAnimationFrame(animate);
  }
}
boot().catch(fail);
addEventListener('pagehide',event=>{
  if(event.persisted)return;
  lifecycle.abort();if(raf)cancelAnimationFrame(raf);
  observer?.disconnect();follow?.dispose();course?.dispose();engine?.dispose();
});
