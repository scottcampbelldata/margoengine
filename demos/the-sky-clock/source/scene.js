import {Sky} from '@margoengine/sky/base';
import {preetham} from '@margoengine/sky/preetham';
import {night} from '@margoengine/sky/night';
import {AstroSky,planetNames} from '@margoengine/sky/astro';
import {degrees} from '@margoengine/sky/sun';
import {autoEngine} from '@margoengine/webgl2-compat/auto';
import archive from './assets/yale-v50.bin?url';
import {makeHorizon} from './horizon.js';

const id=name=>document.getElementById(name);
const canvas=id('view'),day=id('date'),clock=id('time'),minute=id('minute'),site=id('site');
const coordinates=id('coordinate-controls'),lat=id('latitude'),lon=id('longitude');
const state=document.body.dataset,position=id('location'),painting=id('labels');
const abort=new AbortController(),{signal}=abort;
const force=new URLSearchParams(location.search).get('backend')==='webgl2';
const rad=Math.PI/180,origin=[0,.5,0];
const sites={
  'mauna-kea':['Mauna Kea',19.820,-155.470],
  greenwich:['Greenwich',51.477,0],
  vancouver:['Vancouver',49.282,-123.121],
  atacama:['Atacama',-24.627,-70.404],
  sydney:['Sydney',-33.869,151.209],
};
const cardinals=[['N',0],['NE',45],['E',90],['SE',135],['S',180],['SW',225],['W',270],['NW',315]];
const orbitables=['sun','moon',...planetNames];
const title=name=>name[0].toUpperCase()+name.slice(1);
const turn=angle=>(angle%360+360)%360;
const compass=point=>turn(180-point.azimuth.degrees);
const two=value=>String(value).padStart(2,'0');
const timeLabel=value=>two(Math.floor(value/60))+':'+two(value%60);
const dot=(az,el)=>[Math.sin(az*rad)*Math.cos(el*rad),Math.sin(el*rad),-Math.cos(az*rad)*Math.cos(el*rad)];
const trim=(v,lo,hi)=>Math.min(hi,Math.max(lo,v));
const signed=value=>(value<0?'−':'')+Math.abs(value).toFixed(1)+'°';
const phases=['New Moon','Waxing crescent','First quarter','Waxing gibbous','Full Moon','Waning gibbous','Last quarter','Waning crescent'];
const layerLabels=new Map();
const size=2717;
let engine,sky,astro,drag,draw,resize,revision=0,placed=sites['mauna-kea'];
let yaw=290,pitch=17.6, stamp=new Date('2026-05-20T05:48:00Z'), bodies={};
let observationChanged=true,timeChanged=false;

async function catalog(){
  const response=await fetch(archive,{signal});
  if(!response.ok)throw Error('The star catalogue could not be opened.');
  const stream=response.body.pipeThrough(new DecompressionStream('gzip'));
  const data=new DataView(await new Response(stream).arrayBuffer());
  const count=data.getUint16(0,true);
  if(count!==size||data.byteLength!==count*18+2)throw Error('Unexpected star catalogue data.');
  const numbers=new Uint16Array(count),positions=new Float32Array(count*3),motions=new Float32Array(count*3);
  const magnitudes=new Float32Array(count),colors=new Float32Array(count),names=Array(count).fill('');
  for(let i=0;i<count;i++){
    const p=2+i*18;
    numbers[i]=data.getUint16(p,true);
    magnitudes[i]=data.getInt16(p+2,true)/100;
    const color=data.getInt16(p+4,true);
    colors[i]=color===-32768?NaN:color/100;
    for(let c=0;c<3;c++){
      positions[i*3+c]=data.getInt16(p+6+c*2,true)/32767;
      motions[i*3+c]=data.getInt16(p+12+c*2,true)*1e-8;
    }
  }
  return {count,numbers,positions,motions,magnitudes,colors,names};
}
function updateBodies(){
  bodies={sun:astro.sun,moon:astro.moon,...Object.fromEntries(astro.planets.map(p=>[p.name,p]))};
  const altitude=bodies.sun.elevation.degrees,moon=bodies.moon;
  const twilight=altitude>=0?'Daylight':altitude>=-6?'Civil twilight':altitude>=-12?'Nautical twilight':altitude>=-18?'Astronomical twilight':'Night';
  const progression=(180-moon.phaseAngle.degrees)/360;
  const cycle=moon.waxing?progression:1-progression;
  const phase=phases[Math.round(8*cycle)%8];
  id('sun').textContent=signed(altitude);
  id('illumination').textContent=(moon.illumination*100).toFixed(1)+'%';
  id('phase').textContent=phase;
  id('twilight').textContent=twilight;
  position.textContent=placed[0]+' · '+Math.abs(placed[1]).toFixed(2)+'° '+(placed[1]<0?'S':'N')+
    ', '+Math.abs(placed[2]).toFixed(2)+'° '+(placed[2]<0?'W':'E');
  const rows=[];
  for(const name of orbitables){
    const entry=bodies[name];
    if(entry.elevation.degrees<0)continue;
    const row=document.createElement('tr'), heading=document.createElement('th');
    heading.textContent=title(name);heading.scope='row';row.append(heading);
    for(const label of [compass(entry).toFixed(1)+'°',signed(entry.elevation.degrees)]){
      const td=document.createElement('td');td.textContent=label;row.append(td);
    }
    rows.push(row);
  }
  if(!rows.length){
    const row=document.createElement('tr'),description=document.createElement('td');
    description.colSpan=3;description.textContent='All listed objects are below the horizon.';row.append(description);rows.push(row);
  }
  id('bodies').replaceChildren(...rows);
  state.utc=stamp.toISOString();
  state.sun=altitude.toFixed(6);
  state.moon=moon.elevation.degrees.toFixed(6);
  state.illumination=moon.illumination.toFixed(7);
  state.moonBearing=compass(moon).toFixed(5);
  state.sunBearing=compass(bodies.sun).toFixed(5);
  state.twilight=twilight;
  state.location=placed.slice(1).join(',');
  state.bodies=Object.keys(bodies).length.toString();
}
function placeLabel(name,type,coords){
  let label=layerLabels.get(name);
  if(!label){
    label=document.createElement('span');label.className=type;label.textContent=name;
    painting.append(label);layerLabels.set(name,label);
  }
  label.hidden=!coords;
  if(!coords)return;
  label.style.left=coords[0]+'px';label.style.top=coords[1]+'px';
}
function project(direction,w,h){
  const v=origin.map((n,i)=>n+direction[i]*30),m=engine.camera.matrix;
  const coord=Array.from({length:4},(_,i)=>m[i]*v[0]+m[i+4]*v[1]+m[i+8]*v[2]+m[i+12]);
  if(coord[3]<=0)return null;
  const x=(1+coord[0]/coord[3])*w/2,y=(1-coord[1]/coord[3])*h/2;
  return x>12&&x<w-56&&y>13&&y<h-13?[x,y]:null;
}
function annotate(w,h){
  for(const [name,az] of cardinals)placeLabel(name,'bearing',project(dot(az,-1.5),w,h));
  const sunAlt=bodies.sun.elevation.degrees;
  const used=[];
  for(const name of orbitables){
    const body=bodies[name];
    const vis=body.elevation.degrees>0&&(name==='sun'||name==='moon'||(sunAlt<0&&body.magnitude<3));
    const mark=vis?project(body.direction,w,h):null;
    const show=mark&&!used.some(p=>Math.hypot(p[0]-mark[0],p[1]-mark[1])<26);
    placeLabel(title(name),'tag',show?mark:null);
    if(show)used.push(mark);
  }
}
function paint(){
  if(signal.aborted)return;
  const w=canvas.clientWidth,h=canvas.clientHeight,dpr=Math.min(1.7,Math.max(1,devicePixelRatio||1));
  if(canvas.width!==Math.round(w*dpr))canvas.width=Math.round(w*dpr);
  if(canvas.height!==Math.round(h*dpr))canvas.height=Math.round(h*dpr);
  const camera=engine.camera;
  camera.position=origin;
  camera.target=dot(yaw,pitch).map((n,i)=>n+origin[i]);
  engine.render({delta:0});
  if(observationChanged){observationChanged=false;updateBodies();}
  annotate(w,h);
  state.yaw=yaw.toFixed(3);
  state.pitch=pitch.toFixed(3);
}
function schedule(){
  if(draw||signal.aborted)return;
  draw=requestAnimationFrame(()=>{
    draw=undefined;
    try{
      paint();
      if(timeChanged){
        timeChanged=false;
        const target=revision;
        engine.gpu.queue.onSubmittedWorkDone().then(()=>{
          if(signal.aborted||target!==revision)return;
          state.revision=String(target);
          if(!performance.getEntriesByName('clock-first-time').length)performance.mark('clock-first-time');
        },fail);
      }
    }catch(error){fail(error);}
  });
}
function applyObservation(kind){
  if(!day.value||!day.validity.valid||!clock.value)return;
  const when=new Date(day.value+'T'+clock.value.slice(0,5)+':00Z');
  if(!Number.isFinite(+when))return;
  stamp=when;
  const [h,m]=clock.value.split(':').map(Number);
  minute.value=String(h*60+m);
  id('scrub-readout').value=timeLabel(h*60+m);
  minute.setAttribute('aria-valuetext',timeLabel(h*60+m)+' UTC');
  astro.options.latitude=degrees(placed[1]);
  astro.options.longitude=degrees(placed[2]);
  astro.options.date=stamp;
  observationChanged=true;
  if(kind==='time'){revision++;timeChanged=true;}
  schedule();
}
function move(az,el){
  yaw=turn(az);
  pitch=trim(el,-15,88.5);
  schedule();
}
function connect(){
  minute.addEventListener('input',()=>{
    clock.value=timeLabel(minute.valueAsNumber);applyObservation('time');
  },{signal});
  for(const control of [clock,day])control.addEventListener('change',()=>applyObservation('time'),{signal});
  site.addEventListener('change',()=>{
    const custom=site.value==='custom';
    coordinates.hidden=!custom;
    if(custom){lat.value=String(placed[1]);lon.value=String(placed[2]);return;}
    placed=sites[site.value];
    applyObservation('site');
  },{signal});
  id('place').addEventListener('click',()=>{
    if(!lat.value||!lon.value||!lat.reportValidity()||!lon.reportValidity())return;
    placed=['Custom site',lat.valueAsNumber,lon.valueAsNumber];
    applyObservation('site');
  },{signal});
  for(const point of document.querySelectorAll('[data-bearing]'))point.addEventListener('click',()=>move(Number(point.dataset.bearing),16),{signal});
  id('find-moon').addEventListener('click',()=>{
    const el=bodies.moon.elevation.degrees;
    move(compass(bodies.moon),el>0?Math.max(5,el):6);
  },{signal});
  const cancel=event=>{if(drag?.pointer===event.pointerId)drag=undefined;};
  canvas.addEventListener('pointerdown',event=>{
    if(drag)return;
    drag={pointer:event.pointerId,x:event.clientX,y:event.clientY,az:yaw,el:pitch};
    canvas.setPointerCapture(event.pointerId);
  },{signal});
  canvas.addEventListener('pointermove',event=>{
    if(drag?.pointer!==event.pointerId)return;
    move(drag.az-(event.clientX-drag.x)*.22,drag.el+(event.clientY-drag.y)*.22);
  },{signal});
  for(const kind of ['pointerup','pointercancel','lostpointercapture'])canvas.addEventListener(kind,cancel,{signal});
  canvas.addEventListener('keydown',event=>{
    const step={ArrowLeft:[-5,0],ArrowRight:[5,0],ArrowUp:[0,5],ArrowDown:[0,-5]}[event.key];
    if(!step)return;
    event.preventDefault();move(yaw+step[0],pitch+step[1]);
  },{signal});
  resize=new ResizeObserver(schedule);resize.observe(canvas);
}
async function loadCompat(){
  const {install}=await import('@margoengine/webgl2-compat');
  return {install:()=>install({force:true,signal})};
}
async function start(){
  const stars=catalog();
  stars.catch(()=>{});
  const known=force||!navigator.gpu;
  if(known)await (await loadCompat()).install();
  await autoEngine(canvas,async target=>{
    if(!target.gpu)throw Error('The sky needs WebGPU or WebGL2.');
    engine=target;target.onError=fail;performance.mark('clock-device');
    astro=AstroSky.attach(target,{latitude:degrees(placed[1]),longitude:degrees(placed[2]),date:stamp,
      timeScale:0,catalog:await stars,brightness:33,pointSize:.73,limitingMagnitude:5.45,extinction:.13});
    sky=Sky.attach(target,{timeScale:0,night:{starIntensity:0,starTwinkleIntensity:0,glowIntensity:.013,
      zenithColor:[.005,.010,.028],horizonColor:[.034,.048,.085]}},{preetham,night});
    astro.options.sky=sky;
    performance.mark('clock-astronomy');
    makeHorizon(target);
    paint();
    performance.mark('clock-submit');
    await target.gpu.queue.onSubmittedWorkDone();
  },{backend:known?'webgpu':undefined,loadCompat,signal,exactSize:true,antialias:false,startupTimeout:6000,
    camera:{near:.1,far:230,fov:63}});
  signal.throwIfAborted();
  state.renderer=engine.gpu.adapterInfo?.vendor==='margo-webgl2'?'webgl2':'webgpu';
  state.catalog=String(size);
  id('tools').disabled=id('view-tools').disabled=false;
  id('status').hidden=true;
  connect();
  state.ready='true';
  performance.mark('margo-first-usable-frame');
}
function dispose(){
  abort.abort();delete state.ready;cancelAnimationFrame(draw);resize?.disconnect();engine?.dispose();
}
function fail(error){
  if(signal.aborted)return;
  id('status').hidden=true;
  id('error').hidden=false;
  id('error').textContent=error.message;
  state.error=error.message;
  console.error(error);
}
addEventListener('pagehide',event=>{if(!event.persisted)dispose();});
start().catch(fail);
