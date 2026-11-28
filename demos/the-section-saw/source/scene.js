import { margoError } from '@margoengine/core/extension';
import { Material } from '@margoengine/materials';
import { SectionPlanes } from '@margoengine/machinery/section';
import { Line, Lines } from '@margoengine/lines';
import { featureEdges } from '@margoengine/lines/edges';
import { HiddenLine } from '@margoengine/lines/hidden';
import { applyQualityTier } from '@margoengine/quality';
import { autoEngine } from '@margoengine/webgl2-compat/auto';
import { demoStatus } from 'margo-demo-status';
import { buildCartridge } from './cartridge.js';

let canvas=document.querySelector('#view');
const loading=document.querySelector('#status'), detail=document.querySelector('#detail');
const scrub=document.querySelector('#cut'), number=document.querySelector('#position'), sections=document.querySelector('#sections');
const through=document.querySelector('#through'), along=document.querySelector('#along'), hidden=document.querySelector('#hidden');
const caption=document.querySelector('#cut-label');
let status=demoStatus(canvas,loading,detail);
const controls=[through,along,scrub,hidden];
const controller=new AbortController(), {signal}=controller;
const force=new URLSearchParams(location.search).get('backend')==='webgl2';
const plane=[0,0,-1,0];
const cuttingMaterial=new Material({clippingPlanes:[plane]});
const cameraPresets={
  along: {position:[.276,.158,.286],target:[0,-.006,-.008],count:82,axis:2,label:'Along the shaft'},
  through:{position:[.306,.166,.258],target:[0,0,0],count:166,axis:0,label:'Across the shaft'},
};
let engine, parts, edges, behind, guide, section, frame, observer, busy=false;
let mode='along', dirty=true, pendingInput=false;

applyQualityTier();

function fail(error){
  if(status.failed||signal.aborted)return;
  status.error(error);
  loading.hidden=false;
  loading.querySelector('strong').textContent=error?.code==='unsupported'?'This exhibit needs WebGPU graphics.':'The cartridge could not be opened.';
  document.querySelector('#help').hidden=false;
  for(const control of controls)control.disabled=true;
}
function size(){
  const ratio=Math.max(1,Math.min(1.5,devicePixelRatio));
  const width=Math.max(1,Math.round(canvas.clientWidth*ratio)), height=Math.max(1,Math.round(canvas.clientHeight*ratio));
  if(canvas.width!==width)canvas.width=width;
  if(canvas.height!==height)canvas.height=height;
  engine.camera.fov=2*Math.atan(Math.max(.30,.36*height/width))*180/Math.PI;
}

function guides(at,axis){
  return axis===2
    ?[-.163,-.081,at,.163,-.081,at,.163,.081,at,-.163,.081,at]
    :[at,-.085,-.086,at,.085,-.086,at,.085,.086,at,-.085,.086];
}

function setSection(){
  const view=cameraPresets[mode], value=Number(scrub.value), at=value*.001;
  const extent=view.axis===2?.077:.158;
  const enabled=at<extent-1e-6;
  plane.fill(0);
  plane[view.axis]=-1;
  plane[3]=at;
  section.enabled=enabled;
  cuttingMaterial.clippingPlanes=[plane];
  const clip=cuttingMaterial.clippingPlanes;
  section.options.planes=clip;
  edges.material.clippingPlanes=enabled?clip:[];
  behind.material.clippingPlanes=enabled?clip:[];
  behind.visible=hidden.checked;
  guide.visible=enabled&&at>-extent+1e-6;
  guide.setPositions(guides(at,view.axis));
  engine.camera.position=view.position;
  engine.camera.target=view.target;
  const partsCut=parts.filter(({bounds})=>at>bounds[view.axis][0]+1e-6&&at<bounds[view.axis][1]-1e-6);
  number.textContent=value.toFixed(1)+' mm';
  sections.textContent=String(partsCut.length);
  caption.textContent=view.label;
  scrub.setAttribute('aria-valuetext',number.textContent);
  Object.assign(canvas.dataset,{axis:mode,plane:value.toFixed(1),parts:partsCut.length,hidden:!hidden.checked?'off':'on'});
}
function draw(){
  dirty=true;
  if(!busy&&frame===undefined&&!status.failed)frame=requestAnimationFrame(tick);
}
async function tick(){
  frame=undefined;
  if(status.failed||signal.aborted||!dirty)return;
  busy=true;
  dirty=false;
  const mark=pendingInput;
  pendingInput=false;
  try{
    setSection();
    engine.render({delta:0});
    await engine.gpu.queue.onSubmittedWorkDone();
    if(!signal.aborted&&mark&&!performance.getEntriesByName('section-first-scrub-frame').length)
      performance.mark('section-first-scrub-frame');
  }catch(error){fail(error);}
  finally{
    busy=false;
    if(dirty&&!signal.aborted&&!status.failed)draw();
  }
}
function connect(){
  scrub.addEventListener('input',()=>{
    pendingInput=true;
    draw();
  },{signal});
  hidden.addEventListener('change',draw,{signal});
  for(const [control,name] of [[along,'along'],[through,'through']]){
    control.addEventListener('click',()=>{
      if(mode===name)return;
      mode=name;
      const view=cameraPresets[mode];
      scrub.min=String(-view.count);
      scrub.max=String(view.count);
      scrub.value='0';
      along.setAttribute('aria-pressed',String(mode==='along'));
      through.setAttribute('aria-pressed',String(mode==='through'));
      draw();
    },{signal});
  }
  observer=new ResizeObserver(()=>{size();draw();});
  observer.observe(canvas);
}
async function open(){
  const knownCompatibility=force||!navigator.gpu;
  const early=knownCompatibility?import('@margoengine/webgl2-compat').then(module=>({module}),error=>({error})):undefined;
  const loadCompat=async()=>{
    const setup=await early;
    if(setup?.error)throw setup.error;
    const compat=setup?.module??await import('@margoengine/webgl2-compat');
    return {install:()=>compat.install({force,signal})};
  };
  if(knownCompatibility)await (await loadCompat()).install();
  engine=await autoEngine(canvas,async target=>{
    if(!target.gpu)throw margoError('unsupported','Section caps use the Margo WebGPU frame graph','webgpu');
    canvas=target.canvas;
    status=demoStatus(canvas,loading,detail);
    engine=target;
    size();
    target.scene.background='#30434c';
    target.lighting.direction.set([.58,.68,.68,2.8]);
    target.lighting.radiance.set([.98,.97,.84,.23]);
    target.lighting.ambient.set([.48,.65,.68]);
    parts=buildCartridge(target);
    section=SectionPlanes.attach(target,{planes:[plane],cap:true,color:'#c68d53',hatch:156});
    const lines=Lines.attach(target);
    const edgeCache=new Map();
    const contour=parts.flatMap(({geom,origin})=>{
      let source=edgeCache.get(geom);
      if(!source){
        source=featureEdges(geom,{angle:33,tolerance:.000012});
        edgeCache.set(geom,source);
      }
      return Array.from(source,(value,i)=>value+origin[i%3]);
    });
    edges=lines.add(new Line({positions:contour,mode:'segments',width:1.0,color:'#b6d2ca',
      opacity:.83,clippingPlanes:[plane],depthBias:.0005}));
    behind=lines.add(new HiddenLine(edges,{dashSize:.0041,gapSize:.0027,opacity:.27,color:'#89b8c1',depthBias:.0006}));
    guide=lines.add(new Line({positions:guides(0,2),mode:'loop',width:1.15,color:'#7fc5c6',opacity:.6,dashSize:.007,gapSize:.004}));
    setSection();
    target.render({delta:0});
    await target.gpu.queue.onSubmittedWorkDone();
  },{
    loadCompat,backend:knownCompatibility?'webgpu':undefined,signal,exactSize:true,antialias:false,
    startupTimeout:8500,camera:{position:cameraPresets.along.position,target:cameraPresets.along.target,near:.015,far:1.8,fov:42},
  });
  signal.throwIfAborted();
  engine.onError=fail;
  canvas.dataset.renderer=engine.gpu.adapterInfo?.vendor==='margo-webgl2'?'webgl2':'webgpu';
  for(const control of controls)control.disabled=false;
  loading.hidden=true;
  connect();
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
