import { PbrMaterial } from '@margoengine/core';
import { margoError } from '@margoengine/core/extension';
import { applyQualityTier } from '@margoengine/quality';
import { autoEngine } from '@margoengine/webgl2-compat/auto';
import { demoStatus } from 'margo-demo-status';
import { edit, meshStats, renderPayload, tools } from './workpiece.mjs';
import { buildFixture, edgeGeometry, filledGeometry } from './fixture.js';

let canvas=document.querySelector('#view');
const overlay=document.querySelector('#status');
const reason=document.querySelector('#reason');
const title=document.querySelector('#active');
const description=document.querySelector('#operation');
const undo=document.querySelector('#undo');
const buttons=Array.from(document.querySelectorAll('[data-tool]'));
const controls=[...buttons,undo];
const counters=Object.fromEntries([['vertices','vertices'],['edges','edges'],['faces','faces'],['boundaries','boundary']]
  .map(([key,id])=>[key,document.querySelector('#'+id)]));
let status=demoStatus(canvas,overlay,reason);
const abort=new AbortController();
const {signal}=abort;
const force=new URLSearchParams(location.search).get('backend')==='webgl2';
const quietWire=new PbrMaterial({color:'#2d5152',emissive:[.005,.009,.01],roughness:.72});
const activeWire=new PbrMaterial({color:'#e2b974',emissive:[.17,.061,.014],roughness:.57});
const items=new Map(), history=[];
let engine, observer, frame, dirty, drawing, selected, lastEntry='', revision=0, completed=0;

applyQualityTier();

function fail(error){
  if(signal.aborted||status.failed)return;
  status.error(error);
  overlay.hidden=false;
  overlay.querySelector('strong').textContent=error?.code==='unsupported'?'This exhibit needs WebGPU graphics.':'The workshop could not be opened.';
  document.querySelector('#help').hidden=error?.code!=='unsupported';
  for(const control of controls)control.disabled=true;
}

function size(){
  const ratio=Math.max(1,Math.min(devicePixelRatio,1.7));
  const width=Math.max(1,Math.round(canvas.clientWidth*ratio)),height=Math.max(1,Math.round(canvas.clientHeight*ratio));
  if(canvas.width!==width)canvas.width=width;
  if(canvas.height!==height)canvas.height=height;
}

function aim(){
  const item=items.get(selected);
  const [x,y,z]=item?.tool.focus??[-.10,.62,0];
  const blend=item?.tool.id==='bridge'?.22:.14;
  engine.camera.target=[-.095+blend*x,.54+blend*(y-.61),blend*z];
  engine.camera.position=[2.03+blend*x,2.53+blend*(y-.61),4.78+blend*z];
  engine.camera.fov=2*Math.atan(Math.max(.205,.303*canvas.height/canvas.width))*180/Math.PI;
}

function redraw(){
  dirty=true;
  if(frame===undefined&&!drawing&&!signal.aborted&&!status.failed)frame=requestAnimationFrame(draw);
}

async function draw(){
  frame=undefined;
  if(signal.aborted||status.failed||!dirty)return;
  dirty=false;
  drawing=true;
  try{
    const submission=revision, entry=lastEntry;
    size();
    aim();
    engine.render({delta:0});
    await engine.gpu.queue.onSubmittedWorkDone();
    if(signal.aborted)return;
    canvas.dataset.revision=String(submission);
    canvas.dataset.operation=entry;
    if(submission>completed&&!performance.getEntriesByName('workshop-first-edit').length)
      performance.mark('workshop-first-edit');
    completed=submission;
  }catch(error){fail(error);}
  finally{
    drawing=false;
    if(dirty)redraw();
  }
}

function place(item,mesh,changed){
  const render=renderPayload(mesh);
  const geometry=filledGeometry(render);
  const wire=edgeGeometry(render.segments,item.tool.id==='subdivide'&&changed?.0036:.0065);
  item.solid.setGeometry(geometry).setMaterial(changed?item.edited:item.original);
  item.wire.setGeometry(wire);
  item.mesh=mesh;
  item.modified=changed;
}

function report(){
  const total={vertices:0,edges:0,faces:0,boundaries:0};
  for(const item of items.values()){
    const stats=meshStats(item.mesh);
    for(const key of Object.keys(total))total[key]+=stats[key];
    item.wire.setMaterial(item.tool.id===selected?activeWire:quietWire);
  }
  for(const [key,value] of Object.entries(total))counters[key].textContent=String(value);
  canvas.dataset.vertices=String(total.vertices);
  canvas.dataset.edges=String(total.edges);
  canvas.dataset.faces=String(total.faces);
  canvas.dataset.boundaries=String(total.boundaries);
  canvas.dataset.history=String(history.length);
  for(const button of buttons){
    const current=items.get(button.dataset.tool);
    button.disabled=current.modified;
    button.setAttribute('aria-pressed',String(current.modified));
  }
  undo.disabled=history.length===0;
  title.textContent=items.get(selected)?.tool.subject??'Full assembly';
}

function apply(id){
  const item=items.get(id);
  if(item.modified)return;
  try{
    const {before,after,result}=edit(item.tool,item.mesh);
    const change={id,previous:item.mesh};
    place(item,result.mesh,true);
    history.push(change);
    selected=id;
    lastEntry=id;
    revision++;
    description.textContent=item.tool.detail+' '+before.faces+' → '+after.faces+' faces.';
    report();
    redraw();
  }catch(error){fail(error);}
}

function revert(){
  if(!history.length)return;
  try{
    const {id,previous}=history.at(-1);
    const item=items.get(id);
    place(item,previous,false);
    history.pop();
    selected=id;
    lastEntry='undo-'+id;
    revision++;
    description.textContent='Undid '+item.tool.label.toLowerCase()+'. The previous '+item.tool.subject.toLowerCase()+' topology is restored.';
    report();
    redraw();
  }catch(error){fail(error);}
}

function connect(){
  for(const button of buttons)button.addEventListener('click',()=>apply(button.dataset.tool),{signal});
  undo.addEventListener('click',revert,{signal});
  observer=new ResizeObserver(redraw);
  observer.observe(canvas);
}

async function open(){
  const known=force||!navigator.gpu;
  const early=known?import('@margoengine/webgl2-compat').then(module=>({module}),error=>({error})):undefined;
  const loadCompat=async()=>{
    const prepared=await early;
    if(prepared?.error)throw prepared.error;
    const compat=prepared?.module??await import('@margoengine/webgl2-compat');
    return {install:()=>compat.install({force,signal})};
  };
  if(known)await (await loadCompat()).install();
  engine=await autoEngine(canvas,async target=>{
    if(!target.gpu)throw margoError('unsupported','The mesh workshop needs the full Margo graphics layer','webgpu');
    engine=target;
    canvas=target.canvas;
    status=demoStatus(canvas,overlay,reason);
    size();
    target.scene.background='#526564';
    target.lighting.direction.set([.52,.8,.37,2.45]);
    target.lighting.radiance.set([1,.94,.82,.56]);
    target.lighting.ambient.set([.64,.73,.78]);
    buildFixture(target);
    items.clear();
    for(const tool of tools){
      const item={tool,solid:target.createMesh(),wire:target.createMesh(),
        original:new PbrMaterial({color:tool.color,roughness:.61}),edited:new PbrMaterial({color:tool.editedColor,roughness:.58})};
      place(item,tool.mesh,false);
      items.set(tool.id,item);
    }
    aim();
    report();
    target.render({delta:0});
    await target.gpu.queue.onSubmittedWorkDone();
  },{
    loadCompat,backend:known?'webgpu':undefined,signal,exactSize:true,antialias:false,capacity:64,
    startupTimeout:8500,camera:{near:.06,far:40,fov:44},
  });
  signal.throwIfAborted();
  engine.onError=fail;
  canvas.dataset.renderer=engine.gpu.adapterInfo?.vendor==='margo-webgl2'?'webgl2':'webgpu';
  canvas.dataset.revision='0';
  connect();
  overlay.hidden=true;
  status.ready();
  performance.mark('margo-first-usable-frame');
}

window.addEventListener('pagehide',event=>{
  if(event.persisted)return;
  abort.abort();
  if(frame!==undefined)cancelAnimationFrame(frame);
  observer?.disconnect();
  engine?.dispose();
});
open().catch(fail);
