import {autoEngine} from '@margoengine/webgl2-compat/auto';
import {applyQualityTier} from '@margoengine/quality';
import {GlobeControls} from '@margoengine/controls/globe';
import {demoStatus} from 'margo-demo-status';
import record from './assets/record.json';
import coastURL from './assets/coast.png?url';
import {decodeFields,indexOfCell} from './fields.mjs';
import {installGlobe,polar,world} from './globe.js';

const files=import.meta.glob('./assets/*.field',{eager:true,query:'?url',import:'default'});
const {first,last,groupSize,scale,groups,dates}=record;
const id=name=>document.getElementById(name);
const canvas=id('view'),overlay=id('annotation'),status=id('status'),tools=id('tools');
const timeline=id('year'),play=id('play'),previous=id('previous'),coast=id('coast'),grid=id('grid');
const ready=demoStatus(document.body,status,id('error')),state=document.body.dataset;
const lifetime=new AbortController(),{signal}=lifetime;
const forced=new URLSearchParams(location.search).get('backend')==='webgl2';
const downloaded=new Map();
const initial=loadYear(last);
initial.catch(()=>{});
let engine,view,controls,resize,designFrame,coastTimer,yearTimer,gesture;
let data,year=last,picked,requestVersion=0,autoPlay=false;

async function loadYear(year){
  const group=groups[Math.floor((year-first)/groupSize)];
  if(!group)throw new RangeError('Year is outside the calendar record.');
  let pending=downloaded.get(group.key);
  if(!pending){
    pending=(async()=>{
      const url=files['./assets/'+group.key];
      const response=await fetch(url,{signal});
      if(!response.ok)throw Error('Annual data could not be loaded.');
      const unpack=new Response(response.body.pipeThrough(new DecompressionStream('gzip')));
      const bytes=new Uint8Array(await unpack.arrayBuffer());
      return decodeFields(bytes,group.end-group.start+1,180,90,scale);
    })();
    downloaded.set(group.key,pending);
    pending.catch(()=>{if(downloaded.get(group.key)===pending)downloaded.delete(group.key);});
  }
  return (await pending)[year-group.start];
}
function geometry(){
  const ratio=Math.min(1.65,devicePixelRatio||1);
  const w=Math.max(1,Math.round(canvas.clientWidth*ratio)),h=Math.max(1,Math.round(canvas.clientHeight*ratio));
  if(canvas.width!==w)canvas.width=w;
  if(canvas.height!==h)canvas.height=h;
  if(overlay.width!==w)overlay.width=w;
  if(overlay.height!==h)overlay.height=h;
  return {w,h,ratio};
}
function projection(point){
  const matrix=engine.camera.matrix,[x,y,z]=point;
  const p=Array.from({length:4},(_,i)=>matrix[i]*x+matrix[i+4]*y+matrix[i+8]*z+matrix[i+12]);
  return [p[0]/p[3],p[1]/p[3]];
}
function annotate({w,h,ratio}){
  const g=overlay.getContext('2d');
  g.clearRect(0,0,w,h);
  if(!picked)return;
  const ray=controls.normal(picked.point);
  if(ray.reduce((n,v,i)=>n+v*(engine.camera.position[i]-picked.point[i]),0)<0)return;
  const [u,v]=projection(picked.point),x=(u+1)*w/2,y=(1-v)*h/2;
  g.lineWidth=1.4*ratio;
  g.strokeStyle='#14313a';
  g.beginPath();g.arc(x,y,7*ratio,0,2*Math.PI);g.stroke();
  g.strokeStyle='#f1ddba';
  g.beginPath();g.arc(x,y,5.2*ratio,0,2*Math.PI);g.stroke();
  g.beginPath();g.moveTo(x-9*ratio,y);g.lineTo(x+9*ratio,y);g.moveTo(x,y-9*ratio);g.lineTo(x,y+9*ratio);g.stroke();
}
function present(){
  const size=geometry();
  view.style(grid.checked,coast.checked);
  engine.render({delta:0});
  annotate(size);
  state.camera=engine.camera.position.map(n=>n.toFixed(4)).join(',');
}
function onFrame(){
  if(designFrame||signal.aborted)return;
  designFrame=requestAnimationFrame(()=>{
    designFrame=undefined;
    try{present();}catch(error){fail(error);}
  });
}
function launchOrientation(){
  engine.camera.position=world(-67,26).map((n,i)=>n*(i===1?2.87:2.74));
  engine.camera.target=[0,0,0];
  engine.camera.up=[0,1,0];
}
function decimal(num){
  const copy=(Math.round(num*100)/100).toFixed(2);
  return !Number(copy)?'0.00':num>0?'+'+copy:copy.replace('-','−');
}
function inspect(){
  if(!picked){
    id('selected').value='Tap the globe';
    id('reading').value='—';
    delete state.cell;
    delete state.anomaly;
    return;
  }
  const {latitude,longitude,cell}=picked;
  const a=data[cell];
  id('selected').value=Math.abs(latitude).toFixed(1)+'° '+(latitude>=0?'N':'S')+' · '+Math.abs(longitude).toFixed(1)+'° '+(longitude>=0?'E':'W');
  id('reading').value=Number.isFinite(a)?decimal(a)+' °C':'Missing';
  state.cell=String(cell);
  state.anomaly=Number.isFinite(a)?a.toFixed(2):'missing';
}
function publishYear(value,field){
  year=value;
  data=field;
  view.field(field);
  id('display-year').value=id('year-control').value=String(value);
  if(+timeline.value!==value)timeline.value=String(value);
  previous.disabled=value===first;
  const row=dates[value-first];
  id('coverage').value=(100*row.cells/(180*90)).toFixed(1)+'%';
  inspect();
  present();
  state.year=String(value);
  state.cells=String(row.cells);
}
async function choose(value){
  const version=++requestVersion;
  id('data-status').textContent=value===year?'':'Loading '+value+'…';
  try{
    const field=value===year?data:await loadYear(value);
    if(version!==requestVersion||signal.aborted)return;
    const changed=value!==year;
    publishYear(value,field);
    id('data-status').textContent='';
    await engine.gpu.queue.onSubmittedWorkDone();
    if(version!==requestVersion||signal.aborted)return;
    state.revision=String(version);
    if(changed&&!performance.getEntriesByName('climate-year-applied').length)performance.mark('climate-year-applied');
    if(autoPlay)scheduleYear();
  }catch(error){
    if(version!==requestVersion||signal.aborted)return;
    setPlay(false);
    timeline.value=String(year);
    id('data-status').textContent='This year could not be loaded. '+error.message;
  }
}
function setPlay(active){
  autoPlay=active;
  clearTimeout(yearTimer);
  play.setAttribute('aria-pressed',String(active));
  play.textContent=active?'Pause':'Play years';
  state.playing=String(active);
}
function scheduleYear(){
  clearTimeout(yearTimer);
  if(year===last){setPlay(false);return;}
  if(year+1<=last)loadYear(year+1).catch(()=>{});
  yearTimer=setTimeout(()=>choose(year+1),180);
}
function pointAt(event){
  const r=canvas.getBoundingClientRect();
  const point=controls.pick(event.clientX-r.x,event.clientY-r.y);
  if(!point)return;
  const [x,y,z]=point;
  const degrees=180/Math.PI;
  const latitude=Math.atan2(y,Math.hypot(x,z)*polar*polar)*degrees,longitude=Math.atan2(-z,x)*degrees;
  picked={point,latitude,longitude,cell:indexOfCell(latitude,longitude)};
  inspect();
  onFrame();
}
function connect(){
  timeline.addEventListener('input',()=>{setPlay(false);choose(+timeline.value);},{signal});
  previous.addEventListener('click',()=>{setPlay(false);choose(Math.max(first,year-1));},{signal});
  for(const [button,target] of [['beginning',first],['today',last]])id(button).addEventListener('click',()=>{setPlay(false);choose(target);},{signal});
  play.addEventListener('click',()=>{
    setPlay(!autoPlay);
    if(autoPlay)choose(year===last?first:year);
  },{signal});
  id('reset').addEventListener('click',()=>{launchOrientation();picked=undefined;inspect();onFrame();},{signal});
  for(const checkbox of [coast,grid])checkbox.addEventListener('input',()=>onFrame(),{signal});
  canvas.addEventListener('pointerdown',event=>{
    gesture={id:event.pointerId,x:event.clientX,y:event.clientY,moved:false};
  },{signal});
  canvas.addEventListener('pointermove',event=>{
    if(gesture?.id===event.pointerId&&Math.hypot(event.clientX-gesture.x,event.clientY-gesture.y)>6)gesture.moved=true;
    onFrame();
  },{signal});
  canvas.addEventListener('pointerup',event=>{
    if(gesture?.id===event.pointerId&&!gesture.moved)pointAt(event);
    gesture=undefined;
    onFrame();
  },{signal});
  canvas.addEventListener('wheel',onFrame,{signal,passive:true});
  resize=new ResizeObserver(onFrame);
  resize.observe(canvas);
}
async function showCoast(){
  const image=new Image();
  image.src=coastURL;
  await image.decode();
  signal.throwIfAborted();
  const target=document.createElement('canvas');
  target.width=image.naturalWidth;
  target.height=image.naturalHeight;
  const context=target.getContext('2d');
  context.drawImage(image,0,0);
  view.shoreline(context.getImageData(0,0,target.width,target.height).data);
  state.coastline='ready';
  onFrame();
}
async function compat(){
  const {install}=await import('@margoengine/webgl2-compat');
  return {install:()=>install({force:true,signal})};
}
async function start(){
  applyQualityTier();
  const known=forced||!navigator.gpu;
  if(known)await (await compat()).install();
  await autoEngine(canvas,async target=>{
    if(!target.gpu)throw Error('This globe needs WebGPU or WebGL2 compatibility.');
    engine=target;
    target.onError=fail;
    target.scene.background='#18313e';
    launchOrientation();
    geometry();
    controls=new GlobeControls(target,undefined,{radii:[1,polar,1],minAltitude:.18,maxAltitude:7,maxTilt:1.2,clipPlanes:false});
    controls.enableTilt=false;
    view=installGlobe(target);
    publishYear(last,await initial);
    await target.gpu.queue.onSubmittedWorkDone();
  },{signal,backend:known?'webgpu':undefined,loadCompat:compat,exactSize:true,antialias:false,
    startupTimeout:4900,camera:{near:.03,far:25,fov:53}});
  signal.throwIfAborted();
  state.renderer=engine.gpu.adapterInfo?.vendor==='margo-webgl2'?'webgl2':'webgpu';
  tools.disabled=false;
  status.hidden=true;
  connect();
  ready.ready();
  performance.mark('margo-first-usable-frame');
  coastTimer=setTimeout(()=>showCoast().catch(error=>{
    if(!signal.aborted){state.coastline='unavailable';id('data-status').textContent=error.message;}
  }),500);
}
function dispose(){
  lifetime.abort();
  clearTimeout(coastTimer);clearTimeout(yearTimer);
  cancelAnimationFrame(designFrame);
  resize?.disconnect();
  controls?.dispose();
  view?.dispose();
  engine?.dispose();
}
function fail(error){
  if(signal.aborted)return;
  ready.error(error);
  console.error(error);
  status.hidden=true;
  id('error').hidden=false;
  dispose();
}
addEventListener('pagehide',event=>{if(!event.persisted)dispose();});
start().catch(fail);
