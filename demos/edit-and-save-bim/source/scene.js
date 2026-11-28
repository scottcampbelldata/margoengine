import { Geometry, PbrMaterial, box } from '@margoengine/core';
import { margoError } from '@margoengine/core/extension';
import { applyQualityTier } from '@margoengine/quality';
import { autoEngine } from '@margoengine/webgl2-compat/auto';
import { demoStatus } from 'margo-demo-status';
import { acousticLabel } from './door-values.mjs';

let canvas=document.querySelector('#view');
const statusPanel=document.querySelector('#status');
const detail=document.querySelector('#detail');
const viewLabel=document.querySelector('#view-label');
const doorSelect=document.querySelector('#door');
const overviewButton=document.querySelector('#overview');
const doorName=document.querySelector('#name');
const tag=document.querySelector('#tag');
const rating=document.querySelector('#rating');
const displayRating=document.querySelector('#rating-value');
const closing=document.querySelector('#closing');
const summary=document.querySelector('#changes');
const restore=document.querySelector('#restore');
const prepare=document.querySelector('#prepare');
const download=document.querySelector('#download');
const exportStatus=document.querySelector('#export-status');
const controls=[doorSelect,overviewButton,rating,closing,restore,prepare];
let status=demoStatus(canvas,statusPanel,detail);
const controller=new AbortController();
const {signal}=controller;
const forced=new URLSearchParams(location.search).get('backend')==='webgl2';
const marker=new PbrMaterial({color:'#638d87',emissive:[.057,.14,.124],roughness:.7});
const changedMarker=new PbrMaterial({color:'#c48739',emissive:[.29,.091,.013],roughness:.66});
const originals=new Map(), edited=new Map(), markers=new Map();
let engine, observer, raf, dirty, rendering, doors, selection=0, focused=false;
let revision=0, viewedRevision=0, worker, deadline, pending, downloadUrl;

applyQualityTier();

function fail(error){
  if(signal.aborted||status.failed)return;
  status.error(error);
  statusPanel.hidden=false;
  statusPanel.querySelector('strong').textContent=error?.code==='unsupported'?'This exhibit needs WebGPU graphics.':'The pavilion could not be opened.';
  document.querySelector('#help').hidden=error?.code!=='unsupported';
  for(const control of controls)control.disabled=true;
}

function size(){
  const ratio=Math.max(1,Math.min(devicePixelRatio,1.8));
  const width=Math.max(1,Math.round(canvas.clientWidth*ratio));
  const height=Math.max(1,Math.round(canvas.clientHeight*ratio));
  if(canvas.width!==width)canvas.width=width;
  if(canvas.height!==height)canvas.height=height;
}

function applyView(){
  const door=doors[selection];
  if(focused){
    engine.camera.position=[door.x+.67,2.74,door.z+4.57];
    engine.camera.target=[door.x,1.35,door.z];
  }else{
    engine.camera.position=[8.59,5.08,17.62];
    engine.camera.target=[0,1.19,.53];
  }
  const aspect=canvas.width/canvas.height;
  const tangent=focused?Math.max(.36,.40/aspect):Math.max(.244,.293/aspect);
  engine.camera.fov=2*Math.atan(tangent)*180/Math.PI;
  for(const [guid,pieces] of markers){
    const material=edited.has(guid)?changedMarker:marker;
    for(const node of pieces){
      node.setMaterial(material);
      node.visible=door.guid===guid||edited.has(guid);
    }
  }
}

function redraw(){
  dirty=true;
  if(raf===undefined&&!rendering&&!signal.aborted&&!status.failed)raf=requestAnimationFrame(draw);
}

async function draw(){
  raf=undefined;
  if(signal.aborted||status.failed||!dirty)return;
  dirty=false;
  rendering=true;
  try{
    const drawing=revision;
    const door=doors[selection];
    size();
    applyView();
    engine.render({delta:0});
    await engine.gpu.queue.onSubmittedWorkDone();
    if(signal.aborted)return;
    canvas.dataset.door=door.tag;
    canvas.dataset.position=engine.camera.position.join(',');
    canvas.dataset.revision=String(drawing);
    if(drawing>viewedRevision&&!performance.getEntriesByName('pavilion-first-edit').length)
      performance.mark('pavilion-first-edit');
    viewedRevision=drawing;
  }catch(error){fail(error);}
  finally{
    rendering=false;
    if(dirty)redraw();
  }
}

function clearFile(){
  if(downloadUrl)URL.revokeObjectURL(downloadUrl);
  downloadUrl=undefined;
  download.hidden=true;
  download.removeAttribute('href');
  delete canvas.dataset.bytes;
  delete canvas.dataset.export;
}

function fields(){
  const door=doors[selection];
  const values=edited.get(door.guid)??door;
  const nominal=acousticLabel(values.rating);
  doorName.textContent=door.name;
  tag.textContent=door.tag;
  rating.value=String(values.rating);
  rating.setAttribute('aria-valuetext',nominal);
  closing.checked=values.selfClosing;
  displayRating.textContent=nominal;
  viewLabel.textContent=focused?door.name:'Pavilion overview';
  summary.textContent=edited.size?'Edits queued for '+edited.size+(edited.size===1?' door.':' doors.'):'Values from the original file.';
  restore.disabled=!edited.has(door.guid);
  prepare.disabled=!!pending||edited.size===0;
  overviewButton.disabled=!focused;
}

function commit(values){
  const guid=doors[selection].guid;
  const base=originals.get(guid);
  if(base.rating===values.rating&&base.selfClosing===values.selfClosing)edited.delete(guid);
  else edited.set(guid,{guid,...values});
  revision++;
  clearFile();
  if(!pending)exportStatus.textContent='';
  fields();
  redraw();
}

function eventValues(){
  commit({rating:Number(rating.value),selfClosing:closing.checked});
}

function finishReply(reply){
  if(!pending||reply.ticket!==pending.ticket||signal.aborted)return;
  clearTimeout(deadline);
  const ticket=pending.ticket;
  pending=undefined;
  fields();
  if(reply.error){
    exportStatus.textContent=reply.error;
    canvas.dataset.export='error';
    worker?.terminate();
    worker=undefined;
    return;
  }
  if(ticket!==revision){
    exportStatus.textContent='Newer edits are ready to prepare.';
    canvas.dataset.export='stale';
    return;
  }
  downloadUrl=URL.createObjectURL(new Blob([reply.bytes],{type:'application/octet-stream'}));
  download.href=downloadUrl;
  download.hidden=false;
  exportStatus.textContent='Saved file reopened successfully. '+reply.checked.length+' door records checked.';
  canvas.dataset.export='verified';
  canvas.dataset.bytes=String(reply.bytes.length);
  performance.mark('pavilion-export-verified');
}

function beginExport(){
  if(!edited.size||pending)return;
  clearFile();
  const ticket=revision;
  pending={ticket};
  fields();
  canvas.dataset.export='pending';
  exportStatus.textContent='Loading the IFC editor and checking the saved file…';
  performance.mark('pavilion-export-start');
  try{
    if(!worker){
      worker=new Worker(new URL('./editor-worker.js',import.meta.url),{type:'module'});
      worker.onmessage=event=>finishReply(event.data);
      worker.onerror=event=>{
        event.preventDefault();
        if(pending)finishReply({ticket:pending.ticket,error:event.message||'The IFC editor could not start.'});
      };
    }
    deadline=setTimeout(()=>finishReply({ticket,error:'The IFC export timed out.'}),30000);
    worker.postMessage({ticket,ifcUrl:new URL('./tern-pavilion.ifc',import.meta.url).href,edits:[...edited.values()]});
  }catch(error){
    finishReply({ticket,error:error.message});
  }
}

function connect(){
  doorSelect.addEventListener('change',()=>{
    selection=doorSelect.selectedIndex;
    focused=true;
    fields();
    redraw();
  },{signal});
  overviewButton.addEventListener('click',()=>{
    focused=false;
    fields();
    redraw();
  },{signal});
  rating.addEventListener('input',eventValues,{signal});
  closing.addEventListener('change',eventValues,{signal});
  restore.addEventListener('click',()=>commit(originals.get(doors[selection].guid)),{signal});
  prepare.addEventListener('click',beginExport,{signal});
  observer=new ResizeObserver(redraw);
  observer.observe(canvas);
}

async function loadGeometry(){
  const response=await fetch(new URL('./tern-pavilion.mesh',import.meta.url),{signal});
  if(!response.ok)throw new Error('The pavilion model could not be loaded.');
  return new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).json();
}

function addMarker(target,door){
  const thickness=.028,gap=.08,z=door.z+.168,edge=door.width*.5+.056;
  const vertical=box(thickness,door.height+gap,.024);
  const cross=box(door.width+2*gap,thickness,.024);
  const top=target.createMesh().setGeometry(cross).setMaterial(marker)
    .setPosition([door.x,door.height+gap,z]);
  const rails=[door.x-edge,door.x+edge].map(x=>target.createMesh().setGeometry(vertical).setMaterial(marker)
    .setPosition([x,(door.height+gap)*.5,z]));
  markers.set(door.guid,[top,...rails]);
}

async function open(){
  const model=loadGeometry().then(asset=>({asset}),error=>({error}));
  const known=forced||!navigator.gpu;
  const early=known?import('@margoengine/webgl2-compat').then(module=>({module}),error=>({error})):undefined;
  const loadCompat=async()=>{
    const prepared=await early;
    if(prepared?.error)throw prepared.error;
    const module=prepared?.module??await import('@margoengine/webgl2-compat');
    return {install:()=>module.install({force:forced,signal})};
  };
  if(known)await (await loadCompat()).install();
  engine=await autoEngine(canvas,async target=>{
    if(!target.gpu)throw margoError('unsupported','The pavilion needs the full Margo graphics layer','webgpu');
    engine=target;
    canvas=target.canvas;
    status=demoStatus(canvas,statusPanel,detail);
    size();
    target.scene.background='#b4c2b3';
    target.lighting.direction.set([.66,.69,.37,2.4]);
    target.lighting.radiance.set([1,.95,.83,.57]);
    target.lighting.ambient.set([.64,.73,.81]);
    const asset=await model;
    if(asset.error)throw asset.error;
    doors=asset.asset.doors;
    markers.clear();
    originals.clear();
    doorSelect.replaceChildren(...doors.map(door=>{
      const option=document.createElement('option');
      option.value=door.guid;
      option.textContent=door.name;
      originals.set(door.guid,door);
      return option;
    }));
    for(const mesh of asset.asset.meshes){
      const positions=Float32Array.from(mesh.positions,value=>value/10000);
      const normals=Float32Array.from(mesh.normals,value=>value/127);
      target.createMesh().setGeometry(new Geometry(positions,normals,Uint32Array.from(mesh.indices)))
        .setMaterial(new PbrMaterial({color:mesh.color,roughness:.72}));
    }
    for(const door of doors)addMarker(target,door);
    applyView();
    target.render({delta:0});
    if(target.gpu)await target.gpu.queue.onSubmittedWorkDone();
  },{
    loadCompat,backend:known?'webgpu':undefined,signal,exactSize:true,antialias:false,capacity:64,
    startupTimeout:8500,camera:{near:.06,far:90,fov:42},
  });
  signal.throwIfAborted();
  engine.onError=fail;
  canvas.dataset.renderer=engine.gpu?.adapterInfo?.vendor==='margo-webgl2'?'webgl2':engine.backend;
  for(const control of controls)control.disabled=false;
  fields();
  connect();
  statusPanel.hidden=true;
  status.ready();
  performance.mark('margo-first-usable-frame');
}

window.addEventListener('pagehide',event=>{
  if(event.persisted)return;
  controller.abort();
  observer?.disconnect();
  if(raf!==undefined)cancelAnimationFrame(raf);
  clearTimeout(deadline);
  worker?.terminate();
  clearFile();
  engine?.dispose();
});
open().catch(fail);
