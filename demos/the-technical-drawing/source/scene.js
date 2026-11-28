import { Geometry, PbrMaterial } from '@margoengine/core';
import { margoError } from '@margoengine/core/extension';
import { Lines, Line } from '@margoengine/lines';
import { featureEdges } from '@margoengine/lines/edges';
import { HiddenLine } from '@margoengine/lines/hidden';
import { Toon } from '@margoengine/toon';
import { applyQualityTier } from '@margoengine/quality';
import { autoEngine } from '@margoengine/webgl2-compat/auto';
import { demoStatus } from 'margo-demo-status';
import { annotations, buildRefractor, datumLines, tickLines } from './model.mjs';

const initialAngle=28;
let canvas=document.querySelector('#view');
const overlay=document.querySelector('#status'),reason=document.querySelector('#reason');
const slider=document.querySelector('#angle'),degrees=document.querySelector('#degrees');
const hiddenButton=document.querySelector('#hidden'),reset=document.querySelector('#reset');
const controls=[slider,hiddenButton,reset];
const labels=Object.keys(annotations).map(key=>({key,tag:document.querySelector('#'+key+'-label')}));
let status=demoStatus(canvas,overlay,reason);
const controller=new AbortController(),{signal}=controller;
const force=new URLSearchParams(location.search).get('backend')==='webgl2';
const surfaces={
  ivory:new PbrMaterial({color:'#bfc7b6',roughness:.74}),
  cool:new PbrMaterial({color:'#8ca4a1',roughness:.69}),
  warm:new PbrMaterial({color:'#beab86',roughness:.64}),
  dark:new PbrMaterial({color:'#667c7b',roughness:.68}),
  glass:new PbrMaterial({color:'#658587',roughness:.33,emissive:[.024,.034,.044]}),
};
let engine,lines,hiddenInk,leaders,observer,frame,dirty,pending;
let angle=initialAngle,hidden=true,action='',revision=0,reported=0,features=0,internal=0;
applyQualityTier();

function fail(error){
  if(signal.aborted||status.failed)return;
  status.error(error);
  overlay.querySelector('strong').textContent=error?.code==='unsupported'?'This exhibit needs WebGPU graphics.':'The drawing could not be opened.';
  document.querySelector('#help').hidden=error?.code!=='unsupported';
  overlay.hidden=false;
  for(const control of controls)control.disabled=true;
}

function size(){
  const scale=Math.max(1,Math.min(devicePixelRatio,1.65));
  const width=Math.max(1,Math.round(canvas.clientWidth*scale));
  const height=Math.max(1,Math.round(canvas.clientHeight*scale));
  if(canvas.width!==width)canvas.width=width;
  if(canvas.height!==height)canvas.height=height;
}

const dot=(a,b)=>a.reduce((sum,value,i)=>sum+value*b[i],0);

function aim(){
  const camera=engine.camera,t=angle*Math.PI/180;
  const span=Math.max(1.59,1.23*canvas.height/canvas.width),depth=camera.far-camera.near;
  const target=[-.015,.593,-.012],rise=1.00,radius=3.3;
  const right=[Math.cos(t),0,-Math.sin(t)];
  const length=Math.hypot(rise,radius);
  const up=[-Math.sin(t)*rise/length,radius/length,-Math.cos(t)*rise/length];
  camera.target=target;
  camera.position=[target[0]+radius*Math.sin(t),target[1]+rise,target[2]+radius*Math.cos(t)];
  camera.project=(out,aspect,webgpu)=>{
    out[0]=2/(span*aspect);
    out[5]=2/span;
    out[10]=webgpu?1/depth:-2/depth;
    out[14]=webgpu?camera.far/depth:-(camera.far+camera.near)/depth;
    out[15]=1;
  };
  const w=canvas.clientWidth,h=canvas.clientHeight;
  const pxPerMeter=h/span;
  const guide=[];
  for(const {key,tag} of labels){
    const world=annotations[key], relative=world.map((value,i)=>value-target[i]);
    const x=w*.5+pxPerMeter*dot(right,relative), y=h*.5-pxPerMeter*dot(up,relative);
    const spread=key==='aperture'?34:29, side=key==='polar'?-1:1;
    const vertical=key==='aperture'?-21:key==='polar'?-19:33;
    const endY=Math.min(h-37,Math.max(22,y+vertical));
    if(tag.hidden)tag.hidden=false;
    const labelWidth=tag.offsetWidth;
    const desiredX=x+(spread+2)*side-(side<0?labelWidth:0);
    const labelX=Math.min(w-labelWidth-9,Math.max(9,desiredX));
    const endX=side>0?labelX-2:labelX+labelWidth+2;
    const cornerX=x+(endX-x)*.48;
    const at=(a,b)=>world.map((value,i)=>value+((a-x)*right[i]-(b-y)*up[i])/pxPerMeter);
    tag.style.left=labelX+'px';
    tag.style.top=endY+'px';
    const elbow=at(cornerX,endY), end=at(endX,endY);
    guide.push(...world,...elbow,...elbow,...end);
  }
  leaders.setPositions(guide);
}

function schedule(){
  dirty=true;
  if(frame===undefined&&!pending&&!signal.aborted&&!status.failed)frame=requestAnimationFrame(draw);
}

function readout(){
  slider.value=String(angle);
  degrees.textContent=angle+'°';
  slider.setAttribute('aria-valuetext',angle+' degrees');
  hiddenButton.setAttribute('aria-pressed',String(hidden));
}
function setControl(name){
  action=name;
  revision++;
  readout();
  schedule();
}
function recordPose(){
  canvas.dataset.angle=String(angle);
  canvas.dataset.hiddenEdges=String(hidden);
  canvas.dataset.featureEdges=String(features);
  canvas.dataset.insideEdges=String(internal);
  canvas.dataset.lines=String(lines.stats.lines);
}
async function draw(){
  frame=undefined;
  if(signal.aborted||status.failed||!dirty)return;
  dirty=false;
  pending=true;
  try{
    const drawing=revision,entry=action;
    size();
    aim();
    hiddenInk.visible=hidden;
    engine.render({delta:0});
    recordPose();
    await engine.gpu.queue.onSubmittedWorkDone();
    if(signal.aborted)return;
    canvas.dataset.revision=String(drawing);
    canvas.dataset.action=entry;
    if(drawing>reported&&!performance.getEntriesByName('drawing-first-view').length)
      performance.mark('drawing-first-view');
    reported=drawing;
  }catch(error){fail(error);}
  finally{
    pending=false;
    if(dirty)schedule();
  }
}

function connect(){
  slider.addEventListener('input',()=>{
    angle=Number(slider.value);
    setControl('angle');
  },{signal});
  hiddenButton.addEventListener('click',()=>{
    hidden=!hidden;
    setControl('hidden');
  },{signal});
  reset.addEventListener('click',()=>{
    angle=initialAngle;
    hidden=true;
    setControl('reset');
  },{signal});
  observer=new ResizeObserver(schedule);
  observer.observe(canvas);
}

function makeGeometry(group){
  return new Geometry(Float32Array.from(group.points),Float32Array.from(group.normals),Uint32Array.from(group.indices));
}

function assembly(target){
  const parts=buildRefractor();
  const byMaterial=new Map(),exterior=[],inside=[];
  for(const part of parts){
    if(!byMaterial.has(part.finish))byMaterial.set(part.finish,{points:[],normals:[],indices:[]});
    const {body,finish,hidden}=part;
    const feature=featureEdges({vertices:body.points,indices:body.indices},{stride:3,tolerance:.00001,angle:part.crease});
    if(!part.guide){
      for(const value of feature)(hidden?inside:exterior).push(value);
    }else{
      const {origin,axis,station,radius}=part.guide;
      const onRing=(at)=>{
        const along=origin.map((value,i)=>feature[at+i]-value);
        const projection=dot(along,axis);
        return Math.abs(projection-station)<1e-5&&Math.abs(Math.hypot(...along.map((value,i)=>value-axis[i]*projection))-radius)<1e-5;
      };
      for(let index=0;index<feature.length;index+=6)
        if(onRing(index)&&onRing(index+3))inside.push(...feature.subarray(index,index+6));
    }
    const dest=byMaterial.get(finish),base=dest.points.length/3;
    for(const value of body.points)dest.points.push(value);
    for(const value of body.normals)dest.normals.push(value);
    for(const value of body.indices)dest.indices.push(value+base);
  }
  for(const [key,body] of byMaterial)target.createMesh().setGeometry(makeGeometry(body)).setMaterial(surfaces[key]);
  features=(exterior.length+inside.length)/6;
  internal=inside.length/6;
  return {exterior,inside};
}

async function open(){
  const known=force||!navigator.gpu;
  const early=known?import('@margoengine/webgl2-compat').then(module=>({module}),error=>({error})):undefined;
  const loadCompat=async()=>{
    const setup=await early;
    if(setup?.error)throw setup.error;
    const module=setup?.module??await import('@margoengine/webgl2-compat');
    return {install:()=>module.install({force,signal})};
  };
  if(known)await (await loadCompat()).install();
  engine=await autoEngine(canvas,async target=>{
    if(!target.gpu)throw margoError('unsupported','Feature and hidden lines need the full Margo graphics layer','lines');
    engine=target;
    canvas=target.canvas;
    status=demoStatus(canvas,overlay,reason);
    size();
    target.scene.background='#edebdf';
    target.lighting.direction.set([-.48,.66,.58,2.46]);
    target.lighting.radiance.set([1,.965,.87,.66]);
    target.lighting.ambient.set([.67,.78,.805]);
    const {exterior,inside}=assembly(target);
    Toon.attach(target,{bands:4,rim:.04,outline:.0021,color:[.022,.043,.050]});
    lines=Lines.attach(target);
    lines.add(new Line({positions:exterior,mode:'segments',color:'#2d4749',width:1.46,cap:'butt',depthBias:.0010}));
    const probe=lines.add(new Line({positions:inside,mode:'segments',color:'#324c4d',width:1.17,cap:'butt',depthBias:.00075}));
    hiddenInk=lines.add(new HiddenLine(probe,{color:'#a85b3b',dashed:true,dashCap:'round',
      dashSize:.0115,gapSize:.009,width:1.33,opacity:.87,depthBias:.0011}));
    lines.add(new Line({positions:tickLines(),mode:'segments',color:'#4a5352',width:1.16,cap:'butt',depthBias:.0012}));
    lines.add(new Line({positions:datumLines(),mode:'segments',color:'#aeb6a0',width:.93,cap:'butt',depthBias:.00024}));
    leaders=lines.add(new Line({positions:[],mode:'segments',color:'#739484',width:.92,cap:'butt',depthBias:.003}));
    aim();
    target.render({delta:0});
    await target.gpu.queue.onSubmittedWorkDone();
    recordPose();
  },{
    loadCompat,backend:known?'webgpu':undefined,signal,exactSize:true,antialias:false,capacity:48,
    startupTimeout:8500,camera:{near:.05,far:12,fov:41},
  });
  signal.throwIfAborted();
  engine.onError=fail;
  canvas.dataset.renderer=engine.gpu.adapterInfo?.vendor==='margo-webgl2'?'webgl2':'webgpu';
  canvas.dataset.revision='0';
  for(const control of controls)control.disabled=false;
  readout();
  connect();
  overlay.hidden=true;
  status.ready();
  performance.mark('margo-first-usable-frame');
}

window.addEventListener('pagehide',event=>{
  if(event.persisted)return;
  controller.abort();
  observer?.disconnect();
  if(frame!==undefined)cancelAnimationFrame(frame);
  engine?.dispose();
});
open().catch(fail);
