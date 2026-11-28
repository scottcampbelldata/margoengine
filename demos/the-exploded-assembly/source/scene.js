import { box, Geometry, PbrMaterial } from '@margoengine/core';
import { margoError } from '@margoengine/core/extension';
import { ExplodedView } from '@margoengine/machinery/exploded';
import { Picking } from '@margoengine/selection';
import { Tween, easeInOutCubic } from '@margoengine/tween';
import { applyQualityTier } from '@margoengine/quality';
import { autoEngine } from '@margoengine/webgl2-compat/auto';
import { demoStatus } from 'margo-demo-status';
import { fullSpread, parts, profiles, styles } from './iris.mjs';
import { decodeIris } from './mesh-data.mjs';

let canvas=document.querySelector('#view');
const overlay=document.querySelector('#status'), detail=document.querySelector('#detail');
const slider=document.querySelector('#spread'), distance=document.querySelector('#distance');
const explode=document.querySelector('#explode'), assemble=document.querySelector('#assemble');
const picker=document.querySelector('#part'), name=document.querySelector('#name');
const controls=[slider,explode,assemble,picker];
let status=demoStatus(canvas,overlay,detail);
const controller=new AbortController(),{signal}=controller;
const force=new URLSearchParams(location.search).get('backend')==='webgl2';
const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
const motion={spread:Number(slider.value)/100},timeline=new Tween();
const highlight=new PbrMaterial({color:'#dec085',roughness:.48,metalness:0});
let engine, stage, observer, frame, busy=false, dirty=true, last, rendered=-1, active, selected;
let request, pickingBusy=false, pickVersion=0, beganInput=false;
const choices=[],pickOwners=new Map();

applyQualityTier();

function fail(error){
  if(signal.aborted||status.failed)return;
  status.error(error);
  overlay.hidden=false;
  overlay.querySelector('strong').textContent=error?.code==='unsupported'?'This exhibit needs WebGPU graphics.':'The iris could not be opened.';
  document.querySelector('#help').hidden=false;
  for(const control of controls)control.disabled=true;
}

function size(){
  const ratio=Math.max(1,Math.min(devicePixelRatio,1.5));
  const width=Math.max(1,Math.round(canvas.clientWidth*ratio)),height=Math.max(1,Math.round(canvas.clientHeight*ratio));
  if(canvas.width!==width)canvas.width=width;
  if(canvas.height!==height)canvas.height=height;

}

function select(index){
  if(selected && selected===choices[index])return;
  if(selected)selected.node.setMaterial(selected.material);
  selected=choices[index];
  if(selected)selected.node.setMaterial(highlight);
  name.textContent=selected?.label??'Move over a part';
  canvas.dataset.part=selected?.label??'';
  picker.value=selected?String(index):'';
  redraw();
}

async function readPick(){
  if(busy||pickingBusy||!request||signal.aborted||status.failed)return;
  pickingBusy=true;
  const at=request;
  request=undefined;
  try{
    const node=await engine.pick(at.x,at.y);
    if(!signal.aborted&&at.version===pickVersion)select(pickOwners.get(node?.id)??-1);
  }catch(error){fail(error);}
  finally{pickingBusy=false;if(request)void readPick();}
}

function requestPick(event){
  const rect=canvas.getBoundingClientRect();
  request={x:event.clientX-rect.left,y:event.clientY-rect.top,version:++pickVersion};
  void readPick();
}

function update(){
  const spread=motion.spread;
  stage.amount=spread;
  engine.camera.fov=2*Math.atan(Math.max(.241+.069*spread,.31*canvas.height/canvas.width))*180/Math.PI;
  engine.camera.position=[.155+.109*spread,.316-.079*spread,.194+.085*spread];
  engine.camera.target=[0,-.005+.057*spread,0];
  slider.value=String(spread*100);
  distance.textContent=(fullSpread*spread*1000).toFixed(1)+' mm';
  slider.setAttribute('aria-valuetext',distance.textContent+' additional axial spread');
  canvas.dataset.spread=spread.toFixed(4);
  canvas.dataset.distance=(fullSpread*spread*1000).toFixed(3);
}

function redraw(){
  dirty=true;
  if(frame===undefined&&!busy&&!status.failed)frame=requestAnimationFrame(draw);
}

async function draw(now){
  frame=undefined;
  if(signal.aborted||status.failed||!dirty)return;
  dirty=false;
  busy=true;
  try{
    if(active){
      timeline.update(Math.min(.065,Math.max(0,last===undefined?1/60:(now-last)/1000)));
      last=now;
    }
    update();
    const submitted=motion.spread;
    const change=beganInput&&submitted!==rendered;
    engine.render({delta:0});
    await engine.gpu.queue.onSubmittedWorkDone();
    rendered=submitted;
    if(signal.aborted)return;
    if(change&&!performance.getEntriesByName('iris-first-spread-frame').length)
      performance.mark('iris-first-spread-frame');
  }catch(error){fail(error);}
  finally{
    busy=false;
    if(request)void readPick();
    if((active||dirty)&&!signal.aborted&&!status.failed)redraw();
  }
}

function goTo(spread){
  beganInput=true;
  active?.();
  active=undefined;
  if(reduced){
    motion.spread=spread;
  }else{
    last=undefined;
    active=timeline.to(motion,'spread',spread,{duration:.83,easing:easeInOutCubic,onComplete:()=>{active=undefined;}});
  }
  redraw();
}

function connect(){
  slider.addEventListener('input',()=>{
    beganInput=true;
    active?.();
    active=undefined;
    motion.spread=Number(slider.value)/100;
    redraw();
  },{signal});
  explode.addEventListener('click',()=>goTo(1),{signal});
  assemble.addEventListener('click',()=>goTo(0),{signal});
  picker.addEventListener('change',()=>select(picker.value===''?-1:Number(picker.value)),{signal});
  canvas.addEventListener('pointermove',event=>{if(event.pointerType==='mouse')requestPick(event);},{signal});
  canvas.addEventListener('pointerup',requestPick,{signal});
  canvas.addEventListener('pointerleave',event=>{
    if(event.pointerType!=='mouse')return;
    request=undefined;
    pickVersion++;
    select(-1);
  },{signal});
  observer=new ResizeObserver(()=>{size();redraw();});
  observer.observe(canvas);
}

async function loadGeometry(){
  const response=await fetch(new URL('./iris.mesh',import.meta.url),{signal});
  if(!response.ok)throw new Error('The aperture geometry could not be loaded.');
  const buffer=await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  return decodeIris(buffer,profiles.length+2);
}

async function open(){
  const packed=loadGeometry().then(value=>({value}),error=>({error}));
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
    if(!target.gpu)throw margoError('unsupported','The iris part pick uses the Margo WebGPU frame graph','selection');
    engine=target;
    canvas=target.canvas;
    status=demoStatus(canvas,overlay,detail);
    size();
    target.scene.background='#354c56';
    target.lighting.direction.set([.64,.69,.47,2.65]);
    target.lighting.radiance.set([1,.93,.81,.55]);
    target.lighting.ambient.set([.63,.79,.82]);
    const pedestal=new PbrMaterial({color:'#263b46',roughness:.74});
    const lip=new PbrMaterial({color:'#364c55',roughness:.62});
    target.createMesh().setGeometry(box(.223,.011,.189)).setMaterial(pedestal).setPosition([0,-.065,0]);
    target.createMesh().setGeometry(box(.228,.003,.194)).setMaterial(lip).setPosition([0,-.058,0]);
    const asset=await packed;
    if(asset.error)throw asset.error;
    const geometric=asset.value.map(({positions,normals,indices})=>new Geometry(positions,normals,indices));
    const ids=[...profiles.map(({id})=>id),'leaf','drive-pin'];
    const materials=Object.fromEntries(Object.entries(styles).map(([key,spec])=>[key,new PbrMaterial(spec)]));
    for(const [index,part] of parts.entries()){
      const material=materials[part.style];
      const node=target.createMesh().setGeometry(geometric[ids.indexOf(part.id)]).setMaterial(material)
        .setPosition(part.origin).setRotation([0,-(part.angle??0),0]);
      choices.push({...part,node,material});
      pickOwners.set(node.id,index);
      if(part.id==='bezel'){
        const fine=box(.00044,.00008,.00215), master=box(.00072,.00008,.00325);
        const enamel=new PbrMaterial({color:'#b5ad8f',roughness:.58});
        for(let tick=0;tick<30;tick++){
          const angle=tick*Math.PI/15;
          const engraving=target.createMesh().setGeometry(tick%5===0?master:fine).setMaterial(enamel)
            .setParent(node).setPosition([.0534*Math.sin(angle),.004245,.0534*Math.cos(angle)])
            .setRotation([0,angle,0]);
          pickOwners.set(engraving.id,index);
        }
      }
      const option=document.createElement('option');
      option.textContent=part.label;
      option.value=String(index);
      picker.append(option);
    }
    stage=ExplodedView.attach(target,choices.map(({node,offset})=>({node,offset})));
    Picking.attach(target,{capture:false});
    update();
    target.render({delta:0});
    await target.gpu.queue.onSubmittedWorkDone();
    rendered=motion.spread;
  },{
    loadCompat,backend:known?'webgpu':undefined,signal,exactSize:true,antialias:false,capacity:120,
    startupTimeout:8500,camera:{near:.02,far:2.4,fov:43},
  });
  signal.throwIfAborted();
  engine.onError=fail;
  canvas.dataset.renderer=engine.gpu.adapterInfo?.vendor==='margo-webgl2'?'webgl2':'webgpu';
  canvas.dataset.parts=String(choices.length);
  for(const control of controls)control.disabled=false;
  connect();
  overlay.hidden=true;
  status.ready();
  performance.mark('margo-first-usable-frame');
}
window.addEventListener('pagehide',event=>{
  if(event.persisted)return;
  controller.abort();
  observer?.disconnect();
  active?.();
  if(frame!==undefined)cancelAnimationFrame(frame);
  engine?.dispose();
});
open().catch(fail);
