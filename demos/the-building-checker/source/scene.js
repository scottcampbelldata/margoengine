import { Geometry, PbrMaterial, box } from '@margoengine/core';
import { margoError } from '@margoengine/core/extension';
import { Highlight } from '@margoengine/selection/highlight';
import { readBCF, viewFromBCF } from '@margoengine/ifc/bcf';
import { applyQualityTier } from '@margoengine/quality';
import { autoEngine } from '@margoengine/webgl2-compat/auto';
import { demoStatus } from 'margo-demo-status';
import { decodeArchive } from './asset.mjs';

let canvas=document.querySelector('#view');
const overlay=document.querySelector('#status');
const statusDetail=document.querySelector('#detail');
const overviewButton=document.querySelector('#overview');
const run=document.querySelector('#run');
const issues=Array.from(document.querySelectorAll('button.issue'));
const controls=[...issues,overviewButton,run];
const summary=document.querySelector('#summary');
const finding=document.querySelector('#finding');
const audit=document.querySelector('#audit');
const viewName=document.querySelector('#view-name');
let status=demoStatus(canvas,overlay,statusDetail);
const lifetime=new AbortController();
const {signal}=lifetime;
const force=new URLSearchParams(location.search).get('backend')==='webgl2';
const doorBase='#507973', attention='#c9592c';
const finishes={
  plinth:'#74847b',stone:'#d1c5a7',lime:'#ded9c7',brick:'#995949',mortar:'#a28770',
  oak:'#a77c4c',linen:'#cab894',blackened:'#526060',lamp:'#e1c591',door:doorBase,
};
const materials=Object.fromEntries(Object.entries(finishes).map(([key,color])=>[key,new PbrMaterial({
  color,roughness:key==='blackened'?.47:.76,metalness:0,
  ...(key==='lamp'?{emissive:[.26,.14,.045]}:{}),
})]));
const failMaterial=new PbrMaterial({color:attention,roughness:.62,emissive:[.11,.022,.005]});
const doorMeshes=new Map(), shells=new Map();
let engine, highlight, observer, resizeFrame, busy=false, dirty=false, currentView, selectedIssue=-1;
let currentData, overview, archive, viewpoints, report;
let worker, task, ticket=0, taskTimer;

applyQualityTier();

function fail(error){
  if(signal.aborted||status.failed)return;
  status.error(error);
  overlay.hidden=false;
  overlay.querySelector('strong').textContent=error?.code==='unsupported'?'This exhibit needs WebGPU graphics.':'The archive could not be opened.';
  document.querySelector('#help').hidden=error?.code!=='unsupported';
  for(const control of controls)control.disabled=true;
}

function size(){
  const ratio=Math.max(1,Math.min(devicePixelRatio,1.5));
  const width=Math.max(1,Math.round(canvas.clientWidth*ratio)),height=Math.max(1,Math.round(canvas.clientHeight*ratio));
  if(canvas.width!==width)canvas.width=width;
  if(canvas.height!==height)canvas.height=height;
}

function orient({camera}){
  const active=engine.camera;
  active.position=camera.position;
  active.target=camera.target;
  active.up=camera.up;
  if(camera.type==='orthogonal'){
    active.project=(out,aspect,webgpu)=>{
      const height=Math.max(camera.height,16.5/aspect), distance=active.far-active.near;
      out[0]=2/(height*aspect);
      out[5]=2/height;
      out[10]=webgpu?1/distance:-2/distance;
      out[14]=webgpu?active.far/distance:-(active.far+active.near)/distance;
      out[15]=1;
    };
  }else{
    active.project=undefined;
    const tang=Math.tan(camera.fov*Math.PI/360);
    active.fov=2*Math.atan(Math.max(tang,tang*.84*canvas.height/canvas.width))*180/Math.PI;
  }
}

function redraw(){
  dirty=true;
  if(resizeFrame===undefined&&!busy)resizeFrame=requestAnimationFrame(draw);
}

async function draw(){
  resizeFrame=undefined;
  if(signal.aborted||status.failed||!dirty)return;
  dirty=false;
  busy=true;
  try{
    size();
    const issue=selectedIssue;
    const view=currentView;
    orient(view);
    engine.render({delta:0});
    await engine.gpu.queue.onSubmittedWorkDone();
    canvas.dataset.view=issue<0?'overview':viewpoints[issue].guid;
    canvas.dataset.selected=view.selected.join(',');
    canvas.dataset.camera=engine.camera.position.join(',');
    if(issue>=0&&!performance.getEntriesByName('archive-first-issue-frame').length)
      performance.mark('archive-first-issue-frame');
  }catch(error){fail(error);}
  finally{
    busy=false;
    if(dirty&&!signal.aborted&&!status.failed)redraw();
  }
}

function show(index){
  selectedIssue=index;
  const condition=report.specifications[index];
  const failedIds=new Set(report.specifications.flatMap(entry=>entry.failures.map(item=>item.id)));
  const view=index===-1?overview:viewFromBCF(viewpoints[index],currentData);
  currentView=view;
  const hidden=new Set(view.hidden);
  for(const [id,node] of shells)node.visible=!hidden.has(id);
  for(const [id,node] of doorMeshes){
    node.visible=!hidden.has(id);
    node.setMaterial(failedIds.has(id)?failMaterial:materials.door);
  }
  highlight.set((index===-1?[...failedIds]:view.selected).map(id=>doorMeshes.get(id)).filter(Boolean));
  overviewButton.setAttribute('aria-pressed',String(index===-1));
  for(const [i,issue] of issues.entries())issue.setAttribute('aria-pressed',String(index===i));
  viewName.textContent=index===-1?'Building overview':condition.failures[0].name;
  finding.textContent=index===-1?'Choose an issue to open its saved viewpoint.':describe(condition.failures[0]);
  if(engine.canvas.dataset.ready==='true')redraw();
}

function describe(result){
  const name=report.specifications.find(spec=>spec.failures.includes(result))?.specification.name;
  const [,actual,expected]=result.reason.match(/ is (.+), expected (.+)$/)??[];
  return actual&&expected?name+' recorded as '+actual+' · required '+expected+'.':result.reason;
}

function readout(){
  const spec=report.specifications;
  const results=spec.flatMap(item=>item.failures);
  summary.textContent=results.length+' of '+spec.reduce((n,item)=>n+item.applicable.length,0)+' checks flagged';
  for(const [i,issue] of issues.entries()){
    const entry=spec[i];
    const failure=entry?.failures[0];
    issue.hidden=!failure;
    issue.querySelector('b').textContent=failure?.name??'';
    issue.querySelector('span').textContent=entry?.specification.name??'';
  }
}

async function loadModel(){
  const mesh=new URL('./archive.mesh',import.meta.url);
  const bcf=new URL('./issues.bcf',import.meta.url);
  const [geometry,issuesFile]=await Promise.all([fetch(mesh,{signal}),fetch(bcf,{signal})]);
  if(!geometry.ok||!issuesFile.ok)throw new Error('Archive geometry or issue file is unavailable.');
  const [buffer,issues]=await Promise.all([
    new Response(geometry.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer(),
    issuesFile.arrayBuffer().then(bytes=>readBCF(bytes,{signal})),
  ]);
  return {model:decodeArchive(new Uint8Array(buffer)),issues};
}

function connect(){
  for(const [index,issue] of issues.entries())issue.addEventListener('click',()=>show(index),{signal});
  overviewButton.addEventListener('click',()=>show(-1),{signal});
  run.addEventListener('click',()=>void checkModel(),{signal});
  observer=new ResizeObserver(redraw);
  observer.observe(canvas);
}

function settleTask(reply){
  if(task===undefined)return;
  clearTimeout(taskTimer);
  const resolve=task;
  task=undefined;
  resolve(reply);
}

function clearWorker(){
  worker?.terminate();
  worker=undefined;
}

function checkInWorker(){
  return new Promise(resolve=>{
    try{
      if(!worker){
        worker=new Worker(new URL('./checks.js',import.meta.url),{type:'module'});
        worker.onmessage=({data})=>{if(data.id===ticket)settleTask(data);};
        worker.onerror=(event)=>{
          event.preventDefault();
          settleTask({error:event.message||'The IFC reader could not start.'});
          clearWorker();
        };
      }
      task=resolve;
      taskTimer=setTimeout(()=>{
        settleTask({error:'The IFC check timed out.'});
        clearWorker();
      },30000);
      worker.postMessage({
        id:++ticket,
        modelUrl:new URL('./archive.ifc',import.meta.url).href,
        rulesUrl:new URL('./requirements.ids',import.meta.url).href,
      });
    }catch(error){
      clearWorker();
      if(task){settleTask({error:error.message});return;}
      resolve({error:error.message});
    }
  });
}

async function checkModel(){
  run.disabled=true;
  audit.textContent='Running the rules on the IFC model…';
  canvas.dataset.audit='pending';
  const result=await checkInWorker();
  if(signal.aborted)return;
  run.disabled=false;
  if(result.error){
    audit.textContent=result.error;
    canvas.dataset.audit='error';
    return;
  }
  report=result.report;
  readout();
  show(report.specifications[selectedIssue]?.failures.length?selectedIssue:-1);
  const total=report.specifications.reduce((n,item)=>n+item.passed.length,0);
  audit.textContent='Live check complete · '+total+' passed.';
  canvas.dataset.audit='live';
  performance.mark('archive-live-check');
}

async function open(){
  const packed=loadModel().then(value=>({value}),error=>({error}));
  const known=force||!navigator.gpu;
  const early=known?import('@margoengine/webgl2-compat').then(module=>({module}),error=>({error})):undefined;
  const loadCompat=async()=>{
    const setup=await early;
    if(setup?.error)throw setup.error;
    const compat=setup?.module??await import('@margoengine/webgl2-compat');
    return {install:()=>compat.install({force,signal})};
  };
  if(known)await (await loadCompat()).install();
  engine=await autoEngine(canvas,async target=>{
    if(!target.gpu)throw margoError('unsupported','Highlight needs WebGPU','selection');
    engine=target;
    canvas=target.canvas;
    status=demoStatus(canvas,overlay,statusDetail);
    size();
    target.scene.background='#c6d2cd';
    target.lighting.direction.set([.41,.82,.39,2.3]);
    target.lighting.radiance.set([1,.91,.78,.46]);
    target.lighting.ambient.set([.71,.78,.80]);
    const table=target.createMesh().setGeometry(box(15.1,.17,10.8))
      .setMaterial(new PbrMaterial({color:'#61766e',roughness:.83})).setPosition([0,-.43,0]);
    table.visible=true;
    const asset=await packed;
    if(asset.error)throw asset.error;
    archive=asset.value.model;
    const {schema,elements,overview:vp,doorRecords,meshes}=archive;
    currentData={schema,elements:new Map(elements.map(e=>[e.id,e])),byGlobalId:new Map(elements.filter(e=>e.globalId).map(e=>[e.globalId,e.id]))};
    report=archive.report;
    const doorIds=new Set(doorRecords.map(door=>door.id));
    overview=viewFromBCF(vp,currentData);
    viewpoints=asset.value.issues.topics.map(topic=>topic.viewpoints[0]);
    if(viewpoints.length!==issues.length)throw new Error('The issue list and BCF viewpoints differ.');
    const hidden=new Set(overview.hidden);
    for(const mesh of meshes){
      const node=target.createMesh().setGeometry(new Geometry(mesh.positions,mesh.normals,mesh.indices)).setMaterial(materials[mesh.finish]);
      node.visible=!hidden.has(mesh.id);
      if(doorIds.has(mesh.id))doorMeshes.set(mesh.id,node);
      else if(mesh.id) shells.set(mesh.id,node);
    }
    highlight=Highlight.attach(target,{color:[1,.16,.047],fillOpacity:.20,glowOpacity:.78,radius:7});
    readout();
    show(-1);
    orient(overview);
    target.render({delta:0});
    await target.gpu.queue.onSubmittedWorkDone();
    canvas.dataset.view='overview';
    canvas.dataset.selected='';
    canvas.dataset.camera=target.camera.position.join(',');
  },{
    loadCompat,backend:known?'webgpu':undefined,signal,exactSize:true,antialias:false,capacity:80,
    startupTimeout:8500,camera:{near:.1,far:90,fov:44},
  });
  signal.throwIfAborted();
  engine.onError=fail;
  canvas.dataset.renderer=engine.gpu.adapterInfo?.vendor==='margo-webgl2'?'webgl2':'webgpu';
  for(const control of controls)control.disabled=false;
  connect();
  overlay.hidden=true;
  status.ready();
  performance.mark('margo-first-usable-frame');
}

window.addEventListener('pagehide',event=>{
  if(event.persisted)return;
  lifetime.abort();
  if(resizeFrame!==undefined)cancelAnimationFrame(resizeFrame);
  observer?.disconnect();
  settleTask({error:'The page was closed.'});
  clearWorker();
  engine?.dispose();
});
open().catch(fail);
