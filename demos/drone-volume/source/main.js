import {Engine} from '@margoengine/core';
import {demoStatus} from 'margo-demo-status';
import {createAirspace,flightRadius,span,stations} from './airspace.js';
import {makeConservatory} from './conservatory.js';

const by=id=>document.getElementById(id);
const canvas=by('scene'),view=by('viewport'),loading=by('loading'),error=by('error');
const controls=Object.fromEntries(['site','dispatch','routes','view','track','reset'].map(id=>[id,by(id)]));
const status=demoStatus(view,loading,error),session=new AbortController(),{signal}=session;
const query=new URLSearchParams(location.search),forced=query.get('backend')==='webgl2',inspect=query.has('inspect');
const reduced=matchMedia('(prefers-reduced-motion: reduce)');
const waitFrame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
let engine,airspace,art,observer,raf,last=0,lastHUD=-1,clock=0;
let ready=false,side=false,track=false,show=true,current=null,sortie=0,inFlight=false,pending=false,firstEffect=false;
let focusDirection=0,cameraSwap=false;
let cameraAt=[5.3,6.82,12.48],focus=[0,2.69,.13],report='The dashes show the planned paths.';
function text(id,value){const el=by(id);if(el.textContent!==value)el.textContent=value;}
function fail(reason){
  if(signal.aborted||status.failed)return;
  ready=false;loading.hidden=true;error.hidden=false;
  for(const control of Object.values(controls))control.disabled=true;
  status.error(reason);
  if(inspect)console.error(reason?.stack??reason);
}
function size(){
  const w=canvas.clientWidth,h=canvas.clientHeight;
  if(!w||!h)return;
  const dpi=Math.min(devicePixelRatio||1,1.6,1500/w),x=Math.round(w*dpi),y=Math.round(h*dpi);
  if(x!==canvas.width||y!==canvas.height){canvas.width=x;canvas.height=y;}
}
async function engineRoute(){
  const options={backend:'webgpu',exactSize:true,antialias:true,signal,
    camera:{position:cameraAt,target:focus,near:.29,far:80,fov:42}};
  if(!forced&&navigator.gpu){
    try{
      const native=await Engine.create(canvas,options);view.dataset.renderer='webgpu';return native;
    }catch(reason){
      signal.throwIfAborted();
      if(reason?.code&&!['unsupported','adapter','device','timeout','startup'].includes(reason.code))throw reason;
    }
  }
  const {webglRenderer}=await import('@margoengine/webgl2-compat/preview');
  const gl=await Engine.create(canvas,{...options,backend:'webgl2',fallback:webglRenderer});
  view.dataset.renderer='webgl2';return gl;
}
function camera(delta,force=false){
  const p=Math.max(0,1.47-canvas.width/canvas.height),y=side?3.12:7.63+p*.60;
  let eye=side?[0,y,13.9+7.4*p]:[5.45-3.52*p,y,13.14+9.50*p],target=[0,3.01,.20];
  if(track&&current){
    const at=current.drones[0].position,offsets=[[.85,.96,2.33],[-1.27,.75,2.27],[1.37,.82,-1.98],
      [-1.41,.81,-1.95],[-2.01,.59,.39],[2.10,.71,.42],[.31,-.94,1.66]];
    for(let i=0;i<offsets.length;i++){
      const j=(focusDirection+i)%offsets.length,p=at.map((u,k)=>u+offsets[j][k]);
      if(!airspace.volume.isFree(p)||!airspace.volume.lineOfSight(p,at))continue;
      eye=p;target=at;
      if(j!==focusDirection)cameraSwap=true;
      focusDirection=j;break;
    }
  }
  const n=force||cameraSwap||reduced.matches?1:1-Math.exp(-(track?7:5)*delta);cameraSwap=false;
  for(let i=0;i<3;i++){cameraAt[i]+=(eye[i]-cameraAt[i])*n;focus[i]+=(target[i]-focus[i])*n;}
  engine.camera.position=cameraAt;engine.camera.target=focus;
  engine.camera.fov=track?44:42.2+1.9*p;
}
function selected(){return stations[Number(controls.site.value)]??stations[0];}
function isAt(state,station){
  return state.drones.every((drone,i)=>span(drone.position,station.ports[i])<.006);
}
function present(state,force=false){
  if(!force&&clock-lastHUD<.079)return;
  lastHUD=clock;
  const flight=state.airborne?'In flight':sortie&&isAt(state,state.site)?'At destination':'Plan ready';
  text('flight-state',flight);text('note',report);
  text('distance',state.distance.toFixed(1)+' m');
  text('clearance',Math.max(0,state.clearance-flightRadius).toFixed(2)+' m');
  text('elevation',state.drones.map(drone=>drone.position[1].toFixed(1)).join(' / ')+' m');
  const at=isAt(state,selected());
  controls.dispatch.textContent=state.airborne?'Send again':at?'At destination':'Send drones';
  if(ready)controls.dispatch.disabled=at&&!state.airborne;
  Object.assign(view.dataset,{
    airborne:String(state.airborne),destination:state.site.label,revision:String(state.revision),sortie:String(sortie),
    distance:state.distance.toFixed(2),clearance:state.clearance.toFixed(3),lengths:state.plans.map(p=>p.points.length).join(','),
    vertical:Math.max(...state.plans.map(p=>p.maximumY-p.minimumY)).toFixed(2),
    side:String(side),track:String(track),routes:String(show),time:state.time.toFixed(3),
  });
}
async function painted(){
  await engine.gpu?.queue.onSubmittedWorkDone();await waitFrame();
  if(!status.failed){
    performance.mark('drone-first-flight');
    view.dataset.firstControl='painted';
  }
}
function draw(dt,force=false){
  airspace.step(dt);clock+=dt;current=airspace.stats();
  art.update(current,show);camera(dt,force);
  engine.render({delta:dt});present(current,force);
  if(inFlight&&!current.airborne){
    inFlight=false;report='All three drones reached '+current.site.label.toLowerCase()+'.';present(current,true);
  }
  if(pending&&!firstEffect&&current.drones.some(drone=>drone.speed>.13)){
    firstEffect=true;pending=false;present(current,true);void painted().catch(fail);
  }
}
function tick(now){
  if(signal.aborted||status.failed)return;
  try{
    const dt=last?Math.min(.065,Math.max(.002,(now-last)*.001)):1/60;
    last=now;draw(dt);raf=requestAnimationFrame(tick);
  }catch(reason){fail(reason);}
}
controls.dispatch.addEventListener('click',()=>{
  if(!ready)return;
  const target=selected();
  if(!airspace.launch(target)){report='That departure conflicts with an active route. Try after arrival.';present(current,true);return;}
  sortie++;inFlight=true;pending=true;report='Following the '+target.label.toLowerCase()+' routes.';
});
controls.site.addEventListener('change',()=>{
  if(!ready)return;
  if(current.airborne)report='Send again to use this destination.';
  else if(airspace.preview(selected()))report='Review the planned paths, then send the drones.';
  else report='A route is unavailable from the current positions.';
  present(airspace.stats(),true);
});
controls.routes.addEventListener('click',()=>{
  show=!show;controls.routes.textContent=show?'Hide routes':'Show routes';
  controls.routes.setAttribute('aria-pressed',String(show));
});
controls.view.addEventListener('click',()=>{
  side=!side;track=false;cameraSwap=true;controls.track.setAttribute('aria-pressed','false');
  controls.view.textContent=side?'Perspective':'Side view';
  controls.view.setAttribute('aria-pressed',String(side));
});
controls.track.addEventListener('click',()=>{
  track=!track;side=false;cameraSwap=true;focusDirection=0;
  controls.track.setAttribute('aria-pressed',String(track));
  controls.view.setAttribute('aria-pressed','false');controls.view.textContent='Side view';
});
controls.reset.addEventListener('click',()=>{
  if(!ready)return;
  controls.site.value='0';airspace.reset();sortie=0;inFlight=false;pending=false;
  report='The dashes show the planned paths.';draw(0,true);
});
async function launch(){
  size();
  const opening=engineRoute();
  airspace=createAirspace();performance.mark('drone-volume-ready');
  engine=await opening;performance.mark('drone-device');
  engine.onError=fail;
  art=makeConservatory(engine,airspace.stats());performance.mark('drone-model');
  draw(0,true);
  await engine.gpu?.queue.onSubmittedWorkDone();await waitFrame();
  if(!status.ready())return;
  performance.mark('drone-ready');
  loading.hidden=true;ready=true;
  for(const control of Object.values(controls))control.disabled=false;
  present(current,true);
  observer=new ResizeObserver(size);observer.observe(canvas);
  if(inspect)Object.defineProperty(globalThis,'flightInspection',{configurable:true,value:()=>{
    return {...current,camera:{eye:[...cameraAt],focus:[...focus]},stats:engine.stats};
  }});
  raf=requestAnimationFrame(tick);
}
addEventListener('pagehide',()=>{session.abort();cancelAnimationFrame(raf);observer?.disconnect();engine?.dispose();},{once:true});
launch().catch(fail);
