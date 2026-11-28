import {Engine} from '@margoengine/core';
import {PointCloud,PointsPlugin} from '@margoengine/points';
import {demoStatus} from 'margo-demo-status';
import {buildRelief} from './relief.js';
import {cell,floorY,makeFlow,targets,unitCount} from './flow-data.js';

const el=id=>document.getElementById(id);
const canvas=el('scene'),view=el('viewport'),loading=el('loading'),error=el('error'),hint=el('hint');
const controls=Object.fromEntries(['target','vectors','pause','reset'].map(id=>[id,el(id)]));
const status=demoStatus(view,loading,error),life=new AbortController(),{signal}=life;
const query=new URLSearchParams(location.search),prefersQuiet=matchMedia('(prefers-reduced-motion: reduce)');
const forced=query.get('backend')==='webgl2',inspect=query.has('inspect');
const waitFrame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
const magnitude=v=>Math.hypot(...v)||1;
const unit=v=>{const n=magnitude(v);return v.map(x=>x/n);};
const dot=(a,b)=>a.reduce((s,v,i)=>s+v*b[i],0);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const toward=(a,b)=>b.map((v,i)=>v-a[i]);
const fmt=new Intl.NumberFormat('en-US');
let engine,flow,art,cloud,trail,trailPositions,observer,raf,frameId=0,firstEffect=false,pending=0,targetIndex=0;
let ready=false,paused=false,directions=false,last=0,lastHUD=-1,carry=0,hintUntil=0,wallClock=0;
const fixed=1/36;

function output(id,text){const node=el(id);if(node.textContent!==text)node.textContent=text;}
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
  const ratio=Math.min(devicePixelRatio||1,1.6,1600/w);
  const x=Math.round(w*ratio),y=Math.round(h*ratio);
  if(canvas.width!==x||canvas.height!==y){canvas.width=x;canvas.height=y;}
  if(!engine)return;
  const aspect=w/h,portrait=Math.max(0,1.52-aspect);
  engine.camera.position=[3.64-5.5*portrait,10.68+13.3*portrait+Math.max(0,1-portrait*2)*.55,11.00-5.64*portrait];
  engine.camera.target=[0,.43,.67];
  engine.camera.fov=40.5+portrait*5.4;
}
async function createEngine(){
  const options={backend:'webgpu',exactSize:true,antialias:true,signal,
    camera:{position:[4.14,9.82,10.52],target:[0,.38,.13],fov:40.5,near:.31,far:78}};
  if(!forced&&navigator.gpu){
    try{
      const instance=await Engine.create(canvas,options);
      view.dataset.renderer='webgpu';return instance;
    }catch(reason){
      signal.throwIfAborted();
      if(reason?.code&&!['unsupported','adapter','device','timeout','startup'].includes(reason.code))throw reason;
    }
  }
  const {install}=await import('./compatibility.js');
  await install({force:true,signal,minimumTier:'half-float'});
  const instance=await Engine.create(canvas,options);
  view.dataset.renderer='webgl2';return instance;
}
function projectBasis(){
  const position=engine.camera.position;
  const ahead=unit(toward(position,engine.camera.target));
  const horizontal=unit(cross(ahead,engine.camera.up));
  const vertical=cross(horizontal,ahead);
  const slope=Math.tan(engine.camera.fov*Math.PI/360),bounds=canvas.getBoundingClientRect();
  return {position,ahead,horizontal,vertical,slope,bounds,ratio:bounds.width/bounds.height};
}
function pointer(clientX,clientY){
  const {position,ahead,horizontal,vertical,slope,bounds,ratio}=projectBasis();
  const x=(2*(clientX-bounds.left)/bounds.width-1)*slope*ratio;
  const y=(1-2*(clientY-bounds.top)/bounds.height)*slope;
  const ray=ahead.map((v,i)=>v+horizontal[i]*x+vertical[i]*y);
  if(ray[1]>=0)return null;
  const t=(floorY-position[1])/ray[1];
  const p=[0,0,0];
  // Reject a tap whose ray hits a raised rock before it reaches the navigable plane.
  for(let y=2.18;y>.07;y-=.070){
    const at=(y-position[1])/ray[1];
    p[0]=position[0]+ray[0]*at;p[2]=position[2]+ray[2]*at;
    const i=flow.field.cellAt(p),tile=flow.shapes[i];
    if(tile&&tile.cost===255&&tile.height>=y)return null;
  }
  return [position[0]+ray[0]*t,floorY,position[2]+ray[2]*t];
}
function worldToPage(point){
  const {position,ahead,horizontal,vertical,slope,bounds,ratio}=projectBasis();
  const d=toward(position,point),depth=dot(d,ahead);
  return [bounds.left+bounds.width*(.5+.5*dot(d,horizontal)/(depth*slope*ratio)),
    bounds.top+bounds.height*(.5-.5*dot(d,vertical)/(depth*slope))];
}
function setTarget(point,label){
  if(!ready)return false;
  if(!point||!flow.setGoal(point,label)){
    hint.textContent='Choose an open cell';hintUntil=wallClock+1.9;
    view.dataset.rejected=String((Number(view.dataset.rejected)||0)+1);
    return false;
  }
  hint.textContent='';hintUntil=0;
  art.updateField();pending=flow.stats().sequence;
  return true;
}
function controlsEvents(){
  controls.target.addEventListener('click',()=>{
    targetIndex=(targetIndex+1)%targets.length;
    const target=targets[targetIndex];setTarget(target.point,target.label);
  });
  controls.vectors.addEventListener('click',()=>{
    directions=!directions;
    controls.vectors.textContent=directions?'Hide directions':'Show directions';
    controls.vectors.setAttribute('aria-pressed',String(directions));art.showField(directions);
  });
  controls.pause.addEventListener('click',()=>{
    paused=!paused;
    controls.pause.textContent=paused?'Resume':'Pause';controls.pause.setAttribute('aria-pressed',String(paused));
  });
  controls.reset.addEventListener('click',()=>{
    const first=targets[0];targetIndex=0;setTarget(first.point,first.label);
    flow.reset();captureTrail();trail.markDirty('positions');cloud.markDirty('positions');update(true);
  });
  canvas.addEventListener('click',event=>{if(ready)setTarget(pointer(event.clientX,event.clientY));});
  canvas.addEventListener('keydown',event=>{
    if(!ready)return;
    const vector={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[event.code];
    if(!vector)return;
    event.preventDefault();
    const [x,,z]=flow.stats().goal.point,amount=event.shiftKey?4:1;
    setTarget([x+vector[0]*cell*amount,floorY,z+vector[1]*cell*amount]);
  });
}
function update(force=false){
  const stats=flow.stats();
  if(!force&&wallClock-lastHUD<.08)return;
  lastHUD=wallClock;
  if(hintUntil&&wallClock>=hintUntil){hintUntil=0;hint.textContent='';}
  output('units',fmt.format(unitCount));output('arrivals',fmt.format(stats.arrived));
  output('reachable',fmt.format(stats.reachable));output('place',stats.goal.label);
  Object.assign(view.dataset,{target:stats.goal.label,cell:String(stats.targetCell),solves:String(stats.solves),
    moved:String(stats.moved),arrived:String(stats.arrived),points:String(cloud.stats.pointsDrawn),
    time:stats.time.toFixed(3),paused:String(paused),directions:String(directions),
    x:stats.goal.point[0].toFixed(3),z:stats.goal.point[2].toFixed(3),frame:String(frameId)});
}
async function working(sequence){
  await engine.gpu.queue.onSubmittedWorkDone();await waitFrame();
  if(!status.failed){
    performance.mark('flow-first-target',{detail:sequence});
    view.dataset.firstControl='painted';
  }
}
function captureTrail(){
  const p=flow.positions;
  for(let i=0;i<trailPositions.length;i+=3){
    trailPositions[i]=p[3*i];trailPositions[i+1]=p[3*i+1]-.017;trailPositions[i+2]=p[3*i+2];
  }
}
function fixTrailRebirth(){
  const p=flow.positions;
  for(let i=0;i<trailPositions.length;i+=3){
    const x=p[3*i],z=p[3*i+2],u=trailPositions[i],v=trailPositions[i+2];
    if((x-u)*(x-u)+(z-v)*(z-v)>.105){
      trailPositions[i]=x;trailPositions[i+1]=p[3*i+1]-.017;trailPositions[i+2]=z;
    }
  }
}
function draw(now){
  if(signal.aborted||status.failed)return;
  try{
    const dt=last?Math.min(.065,Math.max(.001,(now-last)*.001)):fixed;last=now;wallClock+=dt;
    if(!paused){
      carry+=dt;
      if(pending>0)carry=Math.max(carry,fixed);
      let updated=false,ticks=0;
      if(carry>=fixed)captureTrail();
      while(carry>=fixed&&ticks<3){flow.step(fixed);carry-=fixed;ticks++;updated=true;}
      if(updated){fixTrailRebirth();trail.markDirty('positions');cloud.markDirty('positions');}
    }
    art.animate(prefersQuiet.matches?0:flow.stats().time);
    engine.render({delta:dt});frameId++;
    if(pending){
      if(!firstEffect&&cloud.stats.pointsDrawn>0){
        firstEffect=true;void working(pending).catch(fail);
      }
      pending=0;update(true);
    }else update();
    raf=requestAnimationFrame(draw);
  }catch(reason){fail(reason);}
}
async function launch(){
  size();
  const opening=createEngine();
  flow=makeFlow();
  performance.mark('flow-data');
  engine=await opening;
  performance.mark('flow-device');
  size();
  engine.onError=fail;
  art=buildRelief(engine,flow);
  const trailCount=unitCount/3,points=PointsPlugin.attach(engine,{pointBudget:unitCount+trailCount});
  trailPositions=new Float32Array(trailCount*3);
  const trailColors=new Uint8Array(trailCount*4);
  for(let i=0;i<trailCount;i++){
    trailColors[i*4]=flow.colors[i*12];trailColors[i*4+1]=flow.colors[i*12+1];
    trailColors[i*4+2]=flow.colors[i*12+2];trailColors[i*4+3]=122;
  }
  captureTrail();
  trail=points.add(new PointCloud({positions:trailPositions,colors:trailColors,blockSize:trailCount,
    material:{size:.055,sizeUnits:'world',shape:'round',transparent:true,blending:'additive',opacity:.46},
    name:'Soft motion traces',
  }));
  cloud=points.add(new PointCloud({positions:flow.positions,colors:flow.colors,sizes:flow.sizes,
    blockSize:unitCount,material:{size:.035,sizeUnits:'world',shape:'round',transparent:true,blending:'normal',opacity:.92},
    name:'Flow Field units',
  }));
  performance.mark('flow-model');
  engine.render({delta:fixed});
  await engine.gpu.queue.onSubmittedWorkDone();await waitFrame();
  if(cloud.stats.pointsDrawn!==unitCount)throw new Error('The opening relief did not draw all twelve thousand lights.');
  update(true);
  if(!status.ready())return;
  performance.mark('flow-ready');
  loading.hidden=true;ready=true;
  for(const control of Object.values(controls))control.disabled=false;
  controlsEvents();
  observer=new ResizeObserver(size);observer.observe(canvas);
  if(inspect)Object.defineProperty(globalThis,'flowInspection',{configurable:true,value:{
    project:worldToPage,read:()=>({...flow.stats(),positions:Array.from(flow.positions.subarray(0,90)),
      drawCount:cloud.stats.pointsDrawn,view:cameraReport()}),
    occupied:point=>flow.field.cost[flow.field.cellAt(point)]===255,
  }});
  raf=requestAnimationFrame(draw);
}
function cameraReport(){
  return {position:[...engine.camera.position],target:[...engine.camera.target],pixels:[canvas.width,canvas.height]};
}
addEventListener('pagehide',()=>{
  life.abort();cancelAnimationFrame(raf);observer?.disconnect();engine?.dispose();
},{once:true});
launch().catch(fail);
