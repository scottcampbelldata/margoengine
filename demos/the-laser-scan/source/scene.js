import { PbrMaterial, box } from '@margoengine/core';
import { autoEngine } from '@margoengine/webgl2-compat/auto';
import { applyQualityTier } from '@margoengine/quality';
import { PointsPlugin } from '@margoengine/points';
import { OctreeCloud } from '@margoengine/points/octree';
import { LabelRenderer } from '@margoengine/labels';
import { Callouts } from '@margoengine/labels/callouts';
import { demoStatus } from 'margo-demo-status';
import metadata from './assets/site.json';

const sourceUrls=import.meta.glob('./assets/cloud-*.tile',{eager:true,query:'?url',import:'default'});
const id=name=>document.getElementById(name);
const zoom=id('zoom'), clear=id('clear'), sample=id('sample'), guide=id('guide'), canvas=id('cloud');
const status=demoStatus(document.body,id('status'),id('error'));
const controller=new AbortController();
const {signal}=controller;
const forced=new URLSearchParams(location.search).get('backend')==='webgl2';
const nodes=new Map(metadata.nodes.map(n=>[n.id,{...n,bounds:Float64Array.from(n.bounds)}]));
for(const node of nodes.values()){
  node.parent=node.parent?nodes.get(node.parent):null;
  node.children=node.children.map(key=>nodes.get(key)??null);
}
const root=nodes.get(metadata.root);
const format=new Intl.NumberFormat(undefined,{maximumFractionDigits:1});
let engine,points,cloud,labels,opening,frame,last,pointer,arms=[],tags=[],measure=[],current='';
let tilt=.60,yaw=.57,requestedAction=false,totalLoaded=0,refinementAllowedAt=Infinity,refined=false;
const amber = new PbrMaterial({color:'#f4d27d',roughness:.72,metalness:.06});

async function readTile(node,abortSignal) {
  const url=sourceUrls['./assets/cloud-'+node.id+'.tile'];
  if(!url)throw Error('Missing survey node '+node.id);
  const response=await fetch(url,{signal:abortSignal});
  if(!response.ok)throw Error('Survey node '+node.id+' could not be loaded.');
  const inflated=new Response(response.body.pipeThrough(new DecompressionStream('gzip')));
  const bytes=await inflated.arrayBuffer();
  if(bytes.byteLength!==node.count*9)throw Error('Invalid survey node '+node.id);
  const data=new DataView(bytes);
  const positions=new Float32Array(node.count*3);
  const colors=new Uint8Array(node.count*3);
  for(let i=0;i<node.count;i++)for(let k=0;k<3;k++){
    positions[i*3+k]=data.getInt16(i*9+k*2,true)*metadata.meter;
    colors[i*3+k]=data.getUint8(i*9+6+k);
  }
  totalLoaded+=node.count;
  return {positions,colors,colorComponents:3};
}
const initial=readTile(root,signal);
initial.catch(()=>{});
const source={
  root,
  load(node,abortSignal){return node===root&&opening?opening:readTile(node,abortSignal);},
};
function camera(){
  const dpr=Math.min(1.65,devicePixelRatio||1);
  const width=Math.max(1,Math.round(canvas.clientWidth*dpr));
  const height=Math.max(1,Math.round(canvas.clientHeight*dpr));
  if(canvas.width!==width)canvas.width=width;
  if(canvas.height!==height)canvas.height=height;
  const factor=Number(zoom.value)/10;
  id('zoom-text').value=factor.toFixed(1)+'×';
  const distance=(width/height<1.46?10300:9400)/factor;
  const ground=distance*Math.cos(tilt);
  engine.camera.position=[Math.sin(yaw)*ground,430+distance*Math.sin(tilt),Math.cos(yaw)*ground];
  engine.camera.target=[0,Math.min(720,430+(factor-1)*140),0];
}

function badge(position,name,direction,vertical=-27){
  const node=document.createElement('span');
  node.className='pin';
  node.textContent=name;
  tags.push(labels.add(node,{position,screenOffset:[direction*21,vertical]}));
}

function ruler(a,b){
  const delta=b.map((n,i)=>n-a[i]);
  const span=Math.hypot(...delta);
  if(span<.1)return span;
  const index=delta.map(x=>x/span);
  const rotation=[index[2],0,-index[0],1+index[1]];
  const q=Math.hypot(...rotation);
  const mesh=engine.createMesh().setGeometry(box(8,span,8)).setMaterial(amber)
    .setPosition(a.map((n,i)=>(n+b[i])/2))
    .setQuaternion(q>1e-7?rotation.map(v=>v/q):[1,0,0,0]);
  arms.push(mesh);
  return span;
}

function showMeasurement(){
  for(const tag of tags)tag.remove();
  for(const mesh of arms)mesh.dispose();
  tags=[];
  arms=[];
  const [a,b]=measure;
  id('point-a').value=a?format.format(a[1]+metadata.heightOrigin)+' m':'—';
  id('point-b').value=b?format.format(b[1]+metadata.heightOrigin)+' m':'—';
  if(a)badge(a,'A',-1);
  if(b)badge(b,'B',1);
  id('rise').value=b?format.format(b[1]-a[1])+' m':'—';
  const span=b?ruler(a,b):null;
  if(span!==null){
    const value=format.format(span)+' m';
    id('distance').value=value;
    badge(a.map((k,i)=>(k+b[i])/2),value,0,28);
    document.body.dataset.distance=span.toFixed(4);
  } else {
    id('distance').value='—';
    delete document.body.dataset.distance;
  }
  document.body.dataset.selected=String(measure.length);
  guide.textContent=!a?'Tap the scan to set point A. Drag to turn it.':b?'Tap again to start another measurement.':'Tap another return for point B.';
}

function pick(x,y){
  const found=points.pick(x,y,{radius:15});
  if(!found)return;
  if(measure.length===2)measure=[];
  measure.push([...found.position]);
  showMeasurement();
  requestedAction=true;
}

function nearest(target) {
  const all=opening.positions;
  let best=Infinity,at=0;
  for(let i=0;i<all.length;i+=3){
    const dx=all[i]-target[0],dy=all[i+1]-target[1],dz=all[i+2]-target[2];
    const d=dx*dx+dy*dy+dz*dz;
    if(d<best){best=d;at=i;}
  }
  return [...all.subarray(at,at+3)];
}

function sampleSurvey() {
  const [x,h,z]=metadata.peak;
  measure=[nearest([x,h-metadata.heightOrigin,z]),nearest([x-880,h-metadata.heightOrigin-360,z+480])];
  showMeasurement();
  requestedAction=true;
  refinementAllowedAt=Math.min(refinementAllowedAt,performance.now());
}

function paint(now){
  const elapsed=last===undefined?0:Math.min(.065,Math.max(0,(now-last)/1000));
  last=now;
  camera();
  if(!refined&&now>=refinementAllowedAt){
    cloud.minNodePixels=76;
    refined=true;
  }
  engine.render({delta:elapsed});
  if(requestedAction){
    requestedAction=false;
    performance.mark('scan-control-applied');
  }
  const count=cloud.stats.drawn;
  const update=count+'/'+cloud.stats.loaded+'/'+totalLoaded;
  if(current!==update){
    current=update;
    document.body.dataset.points=String(count);
    document.body.dataset.loaded=String(cloud.stats.loaded);
    id('returns').textContent=count.toLocaleString()+' returns';
  }
}
function tick(now){
  if(signal.aborted)return;
  try{paint(now);frame=requestAnimationFrame(tick);}
  catch(error){fail(error);}
}

function connect(){
  clear.addEventListener('click',()=>{measure=[];showMeasurement();},{signal});
  sample.addEventListener('click',sampleSurvey,{signal});
  zoom.addEventListener('input',()=>{requestedAction=true;refinementAllowedAt=performance.now();},{signal});
  canvas.addEventListener('pointerdown',event=>{
    if(pointer)return;
    pointer={id:event.pointerId,x:event.clientX,y:event.clientY,yaw,tilt,drag:false};
    canvas.setPointerCapture(event.pointerId);
  },{signal});
  canvas.addEventListener('pointermove',event=>{
    if(pointer?.id!==event.pointerId)return;
    const dx=event.clientX-pointer.x,dy=event.clientY-pointer.y;
    if(Math.hypot(dx,dy)>6)pointer.drag=true;
    if(!pointer.drag)return;
    yaw=pointer.yaw-dx*.0075;
    tilt=Math.max(.20,Math.min(1.24,pointer.tilt+dy*.007));
    requestedAction=true;
  },{signal});
  canvas.addEventListener('pointerup',event=>{
    if(pointer?.id!==event.pointerId)return;
    const drag=pointer.drag;
    pointer=undefined;
    if(!drag){
      const rect=canvas.getBoundingClientRect();
      pick(event.clientX-rect.x,event.clientY-rect.y);
    }
  },{signal});
  canvas.addEventListener('lostpointercapture',()=>{pointer=undefined;},{signal});
}

async function setup(target) {
  if(!target.gpu)throw Error('This lidar viewer needs a WebGPU or WebGL2 canvas.');
  engine=target;
  engine.onError=fail;
  engine.scene.background='#11282f';
  engine.lighting.direction.set([-.55,.74,.47,2.0]);
  engine.lighting.radiance.set([1,.89,.73,.83]);
  opening=await initial;
  signal.throwIfAborted();
  points=PointsPlugin.attach(engine,{pointBudget:400000});
  cloud=OctreeCloud.attach(engine,points,source,{
    pointBudget:360000,minNodePixels:100000,maxLoadedPoints:480000,maxConcurrentLoads:3,
    adaptiveSize:{scale:1.13},
    material:{size:2,minPixelSize:1.7,maxPixelSize:8,shape:'round'},
  });
  cloud.onError((node,error)=>fail(error));
  labels=LabelRenderer.attach(engine,{parent:canvas.parentElement,zIndex:1,layout:new Callouts({color:'#edd08a',dot:3,width:1.2})});
}
async function compatibility() {
  const {install}=await import('@margoengine/webgl2-compat');
  return {install:()=>install({force:true,signal})};
}
async function start() {
  applyQualityTier();
  const options={signal,exactSize:true,antialias:false,camera:{near:15,far:40000,fov:40},startupTimeout:4700};
  if(forced||!navigator.gpu) {
    await (await compatibility()).install();
    await autoEngine(canvas,setup,{...options,backend:'webgpu'});
  } else await autoEngine(canvas,setup,{...options,loadCompat:compatibility});
  for(let i=0;i<5&&!points.stats.pointsDrawn;i++){
    paint(performance.now());
    await engine.gpu.queue.onSubmittedWorkDone();
    if(!points.stats.pointsDrawn)await new Promise(requestAnimationFrame);
  }
  signal.throwIfAborted();
  if(!points.stats.pointsDrawn)throw Error('The graphics device did not draw the survey points.');
  connect();
  zoom.disabled=clear.disabled=sample.disabled=false;
  status.ready();
  document.body.dataset.renderer=engine.gpu.adapterInfo?.vendor==='margo-webgl2'?'webgl2':'webgpu';
  id('status').hidden=true;
  performance.mark('margo-first-usable-frame');
  refinementAllowedAt=performance.now()+530;
  frame=requestAnimationFrame(tick);
}
function dispose(){
  controller.abort();
  cancelAnimationFrame(frame);
  engine?.dispose();
}
function fail(error){
  if(signal.aborted)return;
  status.error(error);
  id('status').hidden=true;
  id('error').hidden=false;
  console.error(error);
  dispose();
}
addEventListener('pagehide',event=>{if(!event.persisted)dispose();});
start().catch(fail);
