import { Camera } from '@margoengine/core';
import { margoError } from '@margoengine/core/extension';
import { applyQualityTier } from '@margoengine/quality';
import { autoEngine } from '@margoengine/webgl2-compat/auto';
import { demoStatus } from 'margo-demo-status';
import { buildProfile, buildSolid, cleanOutline, collar, defaults, draftExtent, fillGeometry, interiors, resetOutline } from './profile.mjs';
import { draftTable, edges, geometry, materials, pins, segments, stroke, studioFixture } from './draw.js';

let canvas=document.querySelector('#view');
const overlay=document.querySelector('#status');
const reason=document.querySelector('#reason');
const reset=document.querySelector('#reset');
const joined=document.querySelector('#joined');
const smooth=document.querySelector('#smooth');
const instruction=document.querySelector('#instruction');
const dimensions=document.querySelector('#dimensions');
const readout=document.querySelector('#readout');
const sliders=Object.fromEntries(['offset','thickness','bevel'].map(name=>[name,{
  input:document.querySelector('#'+name),output:document.querySelector('#'+name+'-value'),
}]));
const controls=[...Object.values(sliders).map(slider=>slider.input),joined,smooth,reset];
const controller=new AbortController();
const {signal}=controller;
const force=new URLSearchParams(location.search).get('backend')==='webgl2';
const compact=matchMedia('(max-width:760px)');
const drawingCamera=new Camera({position:[0,0,.82],target:[0,0,0],near:.015,far:3});
const studioCamera=new Camera({position:[.40,.196,.69],target:[.019,-.003,0],near:.015,far:4,fov:38});
let status=demoStatus(canvas,overlay,reason);
let engine, draft, models, observer, frame, pending, dirty, needsModel=true, outline=resetOutline();
let views, planRect, planWidth, planHeight, pen, revision=0, drawn=0, action='', currentProfile, currentSolid;
const settings={...defaults};
applyQualityTier();

function fail(error){
  if(signal.aborted||status.failed)return;
  status.error(error);
  overlay.querySelector('strong').textContent=error?.code==='unsupported'?'This exhibit needs WebGPU graphics.':'The drafting table could not be opened.';
  document.querySelector('#help').hidden=error?.code!=='unsupported';
  overlay.hidden=false;
  for(const control of controls)control.disabled=true;
}

function fit(){
  const scale=Math.max(1,Math.min(devicePixelRatio,1.7));
  const width=Math.max(1,Math.round(canvas.clientWidth*scale)),height=Math.max(1,Math.round(canvas.clientHeight*scale));
  if(canvas.width!==width)canvas.width=width;
  if(canvas.height!==height)canvas.height=height;
  planRect=compact.matches?[0,0,1,.5]:[0,0,.5,1];
  const resultRect=compact.matches?[0,.5,1,.5]:[.5,0,.5,1];
  const aspect=width*planRect[2]/(height*planRect[3]);
  planWidth=2*Math.max(.244,.175*aspect);
  planHeight=planWidth/aspect;
  const distance=drawingCamera.far-drawingCamera.near;
  drawingCamera.project=(out,_,gpu)=>{
    out[0]=2/planWidth;
    out[5]=2/planHeight;
    out[10]=gpu?1/distance:-2/distance;
    out[14]=gpu?drawingCamera.far/distance:-(drawingCamera.far+drawingCamera.near)/distance;
    out[15]=1;
  };
  studioCamera.fov=2*Math.atan(Math.max(.285,.335/aspect))*180/Math.PI;
  views=[
    {viewport:planRect,camera:drawingCamera,scene:draft,clear:{color:'#233e3c'},id:'outline'},
    {viewport:resultRect,camera:studioCamera,clear:{color:'#817f6c'},id:'solid'},
  ];
}

function node(scene,material,z=0){
  return scene.createMesh().setMaterial(material).setPosition([0,0,z]);
}

function changeGeometry(mesh,data){
  mesh.visible=!!data?.indices.length;
  if(mesh.visible)mesh.setGeometry(data);
}

function rebuild(){
  currentProfile=buildProfile(outline,settings);
  currentSolid=buildSolid(currentProfile,settings);
  const {base,result,metrics}=currentProfile;
  const selected=metrics.result, flat=settings.thickness===0;
  changeGeometry(models.draftFill,result.length?geometry(fillGeometry(result)):null);
  changeGeometry(models.baseline,base.length?stroke(edges(base),.00085):null);
  changeGeometry(models.outcome,result.length?stroke(edges(result),.00225):null);
  changeGeometry(models.handles,pins(outline,.00152));
  changeGeometry(models.ring,stroke(edges([collar]),settings.joined?.0007:.0017));
  models.ring.visible=!!result.length||!settings.joined;
  const solid=currentSolid.mesh;
  const cap=flat?(result.length?fillGeometry(result):null):solid&&interiors(solid,0);
  const wall=flat?null:solid&&interiors(solid,1);
  changeGeometry(models.cap,cap&&geometry(cap));
  changeGeometry(models.wall,wall&&geometry(wall));
  models.cap.setPosition([0,0,flat?-.009:-currentSolid.depth/2]);
  models.wall.setPosition([0,0,-currentSolid.depth/2]);
  canvas.dataset.area=String(selected.area);
  canvas.dataset.baseArea=String(metrics.base.area);
  canvas.dataset.offsetArea=String(metrics.offset.area);
  canvas.dataset.pieces=String(selected.pieces);
  canvas.dataset.holes=String(selected.holes);
  canvas.dataset.thickness=String(settings.thickness);
  canvas.dataset.bevel=String(currentSolid.bevel);
  canvas.dataset.joined=String(settings.joined);
  canvas.dataset.anchors=String(outline.length);
  const describe=(n,one,many)=>n+' '+(n===1?one:many);
  dimensions.textContent=selected.pieces?(flat?'Profile only':settings.thickness+' mm thick'):'Empty';
  readout.textContent=selected.pieces?
    (selected.area*10_000).toFixed(1)+' cm² · '+describe(selected.pieces,'region','regions')+' · '+describe(selected.holes,'opening','openings')
    :'The offset leaves no filled outline.';
  if(settings.bevel&&currentSolid.bevel!==settings.bevel&&!flat&&selected.pieces)
    readout.textContent+=' · Bevel applied '+currentSolid.bevel.toFixed(1)+' mm';
  needsModel=false;
}

function numberLabel(name,value){
  return (name==='offset'&&value>0?'+':'')+value+' mm';
}
function readControls(){
  for(const [name,slider] of Object.entries(sliders)){
    slider.input.value=String(settings[name]);
    const value=numberLabel(name,settings[name]);
    slider.output.textContent=value;
    slider.input.setAttribute('aria-valuetext',value);
  }
  joined.setAttribute('aria-pressed',String(settings.joined));
  smooth.setAttribute('aria-pressed',String(settings.smooth));
}

function schedule(){
  dirty=true;
  if(frame===undefined&&!pending&&!signal.aborted&&!status.failed)frame=requestAnimationFrame(draw);
}

async function draw(){
  frame=undefined;
  if(signal.aborted||status.failed||!dirty)return;
  dirty=false;
  pending=true;
  try{
    const submission=revision, entry=action;
    fit();
    if(needsModel)rebuild();
    changeGeometry(models.preview,pen?.points.length>1?stroke(segments(pen.points),.0031):null);
    engine.render({delta:0,views});
    await engine.gpu.queue.onSubmittedWorkDone();
    if(signal.aborted)return;
    canvas.dataset.revision=String(submission);
    canvas.dataset.action=entry;
    if(submission>drawn&&!performance.getEntriesByName('shapes-first-operation').length)
      performance.mark('shapes-first-operation');
    drawn=submission;
  }catch(error){fail(error);}
  finally{
    pending=false;
    if(dirty)schedule();
  }
}

function update(name){
  action=name;
  revision++;
  needsModel=true;
  readControls();
  schedule();
}

function eventPoint(event){
  const bounds=canvas.getBoundingClientRect();
  const [left,top,wide,high]=planRect;
  const u=((event.clientX-bounds.left)/bounds.width-left)/wide;
  const v=((event.clientY-bounds.top)/bounds.height-top)/high;
  return [(u-.5)*planWidth,(.5-v)*planHeight];
}
function clampPoint(point){
  return point.map((value,i)=>Math.max(-draftExtent[i],Math.min(draftExtent[i],value)));
}
function addPen(event){
  const point=clampPoint(eventPoint(event));
  const previous=pen.points.at(-1);
  if(Math.hypot(point[0]-previous[0],point[1]-previous[1])<.003)return;
  pen.points.push(point);
  if(pen.points.length>72)pen.points=pen.points.filter((_,i)=>i%2===0);
}
function startPen(event){
  if(!event.isPrimary||event.button!==0||pen)return;
  const point=eventPoint(event);
  if(point.some((value,i)=>Math.abs(value)>draftExtent[i]))return;
  canvas.setPointerCapture(event.pointerId);
  pen={id:event.pointerId,points:[point]};
  instruction.textContent='Release to close the outline';
  schedule();
}
function finishPen(event){
  if(pen?.id!==event.pointerId)return;
  if(event.type==='pointerup')addPen(event);
  const {points}=pen;
  if(points.length>4&&Math.hypot(points[0][0]-points.at(-1)[0],points[0][1]-points.at(-1)[1])<.004)points.pop();
  pen=undefined;
  if(canvas.hasPointerCapture(event.pointerId))canvas.releasePointerCapture(event.pointerId);
  if(event.type!=='pointerup'){instruction.textContent='Drag to draw a closed shape';schedule();return;}
  const closed=cleanOutline(points,settings.smooth);
  if(points.length<4||!closed.length){
    instruction.textContent='Draw a wider loop on the grid';
    schedule();
    return;
  }
  outline=points;
  instruction.textContent='Drag to draw another shape';
  update('draw');
}

function activate(button,perform){
  let tap;
  button.addEventListener('pointerdown',event=>{
    if(event.isPrimary&&event.pointerType==='touch')
      tap={id:event.pointerId,x:event.clientX,y:event.clientY};
  },{signal});
  button.addEventListener('pointercancel',()=>{tap=undefined;},{signal});
  button.addEventListener('pointerup',event=>{
    if(tap?.id!==event.pointerId)return;
    const contact=tap;
    tap=undefined;
    // The browser can suppress a click after a drawing gesture. A distinct stationary tap is an explicit activation.
    if(Math.hypot(event.clientX-contact.x,event.clientY-contact.y)<=10)perform();
  },{signal});
  button.addEventListener('click',event=>{
    if(event.pointerType!=='touch'&&!event.sourceCapabilities?.firesTouchEvents)perform();
  },{signal});
}

function connect(){
  for(const [name,{input}] of Object.entries(sliders))input.addEventListener('input',()=>{
    settings[name]=Number(input.value);
    update(name);
  },{signal});
  for(const [name,button] of [['joined',joined],['smooth',smooth]])activate(button,()=>{
    settings[name]=!settings[name];
    update(name);
  });
  activate(reset,()=>{
    pen=undefined;
    outline=resetOutline();
    Object.assign(settings,defaults);
    instruction.textContent='Drag to draw a closed shape';
    update('reset');
  });
  canvas.addEventListener('pointerdown',startPen,{signal});
  canvas.addEventListener('pointermove',event=>{
    if(pen?.id!==event.pointerId)return;
    const samples=event.getCoalescedEvents?.();
    for(const sample of samples?.length?samples:[event])addPen(sample);
    schedule();
  },{signal});
  canvas.addEventListener('pointerup',finishPen,{signal});
  canvas.addEventListener('lostpointercapture',finishPen,{signal});
  canvas.addEventListener('pointercancel',finishPen,{signal});
  observer=new ResizeObserver(schedule);
  observer.observe(canvas);
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
    if(!target.gpu)throw margoError('unsupported','The drafting table needs the full Margo graphics layer','webgpu');
    engine=target;
    canvas=target.canvas;
    status=demoStatus(canvas,overlay,reason);
    draft=target.createScene('shape-draft');
    draft.lighting.direction.set([0,0,1,.48]);
    draft.lighting.radiance.set([.85,1,.90,.47]);
    target.lighting.direction.set([-.39,.61,.70,4.8]);
    target.lighting.radiance.set([1,.94,.82,.65]);
    target.lighting.ambient.set([.79,.83,.80]);
    draftTable(draft);
    studioFixture(target.scene);
    models={
      draftFill:node(draft,materials.fill,.002),
      baseline:node(draft,materials.source,.003),
      outcome:node(draft,materials.contour,.004),
      ring:node(draft,materials.ring,.0045),
      handles:node(draft,materials.pin,.005),
      preview:node(draft,materials.pen,.006),
      cap:node(target.scene,materials.cap),
      wall:node(target.scene,materials.wall),
    };
    fit();
    rebuild();
    target.render({delta:0,views});
    await target.gpu.queue.onSubmittedWorkDone();
  },{
    loadCompat,backend:known?'webgpu':undefined,signal,exactSize:true,antialias:false,
    capacity:60,startupTimeout:8500,
  });
  signal.throwIfAborted();
  engine.onError=fail;
  canvas.dataset.renderer=engine.gpu.adapterInfo?.vendor==='margo-webgl2'?'webgl2':'webgpu';
  canvas.dataset.revision='0';
  for(const control of controls)control.disabled=false;
  readControls();
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
