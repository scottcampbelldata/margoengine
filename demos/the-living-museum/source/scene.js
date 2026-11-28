import { box, PbrMaterial } from '@margoengine/core';
import { Clustered } from '@margoengine/clustered';
import { buildGallery, lighting, rooms } from './gallery.js';
import { createSimulation, alcove, crossing } from './routing.js';
import { buildOpeningActors } from './opening-actors.js';

export async function open({target:engine,bytes,signal,status,overlay,eye,aim,fit,fail}) {
  const canvas=engine.canvas;
  const mode=document.querySelector('#guard'), awareness=document.querySelector('#awareness'), caption=document.querySelector('#scene-mode');
  const cross=document.querySelector('#cross'), recess=document.querySelector('#recess'), reset=document.querySelector('#reset');
  const controls=[cross,recess,reset];
  const world=createSimulation();
  let visitorGroup,observer,requestId,lastFrame,detailsTimer;
  let inflight=false, moves=0, motionMark=0, pointer;
  let inputOrigin, lastReadout='';
  let detailAwaitingFrame=false;

  const vector=(a,b)=>a.map((n,i)=>n-b[i]);
  const unit=v=>{const length=Math.hypot(...v)||1;return v.map(n=>n/length);};
  const product=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];

  function size(){
    fit();
    engine.camera.fov=2*Math.atan(Math.max(.33,.46*canvas.height/canvas.width))*180/Math.PI;
  }

  function floorPoint(clientX,clientY){
    const rect=canvas.getBoundingClientRect(), aspect=rect.width/rect.height;
    const y=(1-2*(clientY-rect.top)/rect.height)*Math.tan(engine.camera.fov*Math.PI/360);
    const x=(2*(clientX-rect.left)/rect.width-1)*aspect*Math.tan(engine.camera.fov*Math.PI/360);
    const forward=unit(vector(aim,eye)),right=unit(product(forward,[0,1,0])),up=product(right,forward);
    const ray=forward.map((n,i)=>n+right[i]*x+up[i]*y);
    if(ray[1]>=0)return;
    const t=-eye[1]/ray[1],position=eye.map((n,i)=>n+ray[i]*t);
    if(position[0]<rooms.minX||position[0]>rooms.maxX||position[2]<rooms.minZ||position[2]>rooms.maxZ)return;
    return position;
  }

  function move(position){
    const path=world.nav.closestPoint(position);
    if(!path)return;
    const destination=Array.isArray(path)?path:path.point;
    if(!destination)return;
    world.move(destination);
    destinationMarker.setPosition([destination[0],.017,destination[2]]);
    moves++;
    inputOrigin=[...world.player.position];
  }

  function frame(){
    if(requestId===undefined&&!status.failed)requestId=requestAnimationFrame(tick);
  }

  function readout(){
    const label=world.awareness==='aware'?'Aware':world.awareness==='suspicious'?'Suspicious':'Unseen';
    const state=world.mode+' '+label;
    if(state!==lastReadout){
      lastReadout=state;
      mode.textContent=world.mode;
      caption.textContent=world.mode==='Patrolling'?'Patrol':world.mode;
      awareness.textContent=label;
    }
    const current=world.player.position;
    canvas.dataset.guard=world.mode;
    canvas.dataset.awareness=world.awareness;
    canvas.dataset.location=current.map(value=>value.toFixed(4)).join(',');
    canvas.dataset.sightings=String(world.seen);
    canvas.dataset.moves=String(moves);
  }

  function tick(now){
    requestId=undefined;
    if(signal.aborted||document.hidden||status.failed)return;
    if(inflight){frame();return;}
    const delta=Math.min(.056,Math.max(0,lastFrame===undefined?1/60:(now-lastFrame)/1000));
    lastFrame=now;
    try{
      world.update(delta);
      for(const [index,visitor] of visitorGroup.entries())visitor.update(delta,index===1?world.focus:undefined);
      const at=world.player.position;
      playerMarker.setPosition([at[0],.014,at[2]]);
      engine.render({delta});
      readout();
      const showDetails=detailAwaitingFrame;
      const action = inputOrigin && Math.hypot(at[0]-inputOrigin[0],at[2]-inputOrigin[2])>.019 ? moves : 0;
      inflight=true;
      engine.gpu.queue.onSubmittedWorkDone().then(()=>{
        inflight=false;
        if(signal.aborted)return;
        if(showDetails){
          detailAwaitingFrame=false;
          canvas.dataset.finish='textured';
          performance.mark('museum-full-detail-ready');
        }
        if(action>motionMark){
          motionMark=action;
          if(!performance.getEntriesByName('museum-first-walk-frame').length)performance.mark('museum-first-walk-frame');
        }
        frame();
      }).catch(fail);
    }catch(error){fail(error);}
  }

  function connect(){
    cross.addEventListener('click',()=>move(crossing),{signal});
    recess.addEventListener('click',()=>move(alcove),{signal});
    reset.addEventListener('click',()=>{
      world.reset();
      moves=0;
      inputOrigin=undefined;
      motionMark=0;
      destinationMarker.setPosition([0,-1,0]);
    },{signal});
    canvas.addEventListener('pointerdown',event=>{
      if(event.isPrimary)pointer={id:event.pointerId,x:event.clientX,y:event.clientY};
    },{signal});
    canvas.addEventListener('pointerup',event=>{
      if(pointer?.id!==event.pointerId)return;
      if(Math.hypot(pointer.x-event.clientX,pointer.y-event.clientY)<8){
        const destination=floorPoint(event.clientX,event.clientY);
        if(destination)move(destination);
      }
      pointer=undefined;
    },{signal});
    canvas.addEventListener('pointercancel',()=>{pointer=undefined;},{signal});
    document.addEventListener('visibilitychange',()=>{
      lastFrame=undefined;
      if(!document.hidden)frame();
    },{signal});
    observer=new ResizeObserver(size);
    observer.observe(canvas);
  }
  engine.onError=fail;
  size();
  engine.scene.background='#343b46';
  engine.lighting.direction.set([.46,.74,.45,.39]);
  engine.lighting.radiance.set([.65,.73,1,.18]);
  engine.lighting.ambient.set([.38,.41,.48]);
  buildGallery(engine);
  const lights=Clustered.attach(engine,{grid:[1,1,1],maxLights:lighting.length});
  lights.setLights(lighting);
  const markerMaterial=new PbrMaterial({color:'#e9b96c',roughness:.55});
  const bracket=box(.30,.012,.065);
  const playerMarker=engine.createMesh().setGeometry(bracket).setMaterial(markerMaterial).setPosition([0,-1,0]);
  const destinationMarker=engine.createMesh().setGeometry(bracket).setMaterial(markerMaterial)
    .setRotation([0,Math.PI*.5,0]).setPosition([0,-1,0]);
  visitorGroup=buildOpeningActors(engine,world,bytes);
  for(const visitor of visitorGroup)visitor.update(0);
  const [x,,z]=world.player.position;
  playerMarker.setPosition([x,.014,z]);
  performance.mark('museum-opening-assembled');
  engine.render({delta:0});
  await engine.gpu.queue.onSubmittedWorkDone();
  signal.throwIfAborted();
  canvas.dataset.renderer=engine.gpu.adapterInfo?.vendor==='margo-webgl2'?'webgl2':'webgpu';
  canvas.dataset.visitors=String(visitorGroup.length);
  canvas.dataset.lights=String(lighting.length);
  canvas.dataset.finish='opening';
  for(const button of controls)button.disabled=false;
  readout();
  connect();
  overlay.hidden=true;
  status.ready();
  performance.mark('margo-first-usable-frame');
  frame();
  detailsTimer=setTimeout(async()=>{
    try{
      const {finishVisitors}=await import('./details.js');
      if(signal.aborted)return;
      const full=await finishVisitors(engine,world,lights,signal);
      if(signal.aborted){for(const visitor of full)visitor.dispose();return;}
      for(const visitor of visitorGroup)visitor.dispose();
      visitorGroup=full;
      for(const [index,visitor] of visitorGroup.entries()){
        visitor.update(0,index===1?world.focus:undefined);
        visitor.model.root.visible=true;
      }
      detailAwaitingFrame=true;
      frame();
    }catch(error){fail(error);}
  },700);
  signal.addEventListener('abort',()=>{
    observer?.disconnect();
    clearTimeout(detailsTimer);
    if(requestId!==undefined)cancelAnimationFrame(requestId);
    for(const visitor of visitorGroup)visitor.dispose();
    world.dispose();
  },{once:true});
}
