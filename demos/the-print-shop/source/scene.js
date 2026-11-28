import { Geometry, PbrMaterial, box } from '@margoengine/core';
import { autoEngine } from '@margoengine/webgl2-compat/auto';
import { applyQualityTier } from '@margoengine/quality';
import { demoStatus } from 'margo-demo-status';

const id=name=>document.getElementById(name);
const canvas=id('scene'), slider=id('layer'), sizes=id('sizes'), travels=id('travel'), play=id('play');
const state=demoStatus(document.body,id('status'),id('error'));
const controller=new AbortController();
const {signal}=controller;
const forced=new URLSearchParams(location.search).get('backend')==='webgl2';
const archive=new URL('./assets/paths.bin',import.meta.url);
const displayData=fetch(archive,{signal}).then(response=>{
  if(!response.ok)throw Error('The part and layer data could not load.');
  return new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).json();
});
displayData.catch(()=>{});
const modelFiles=[
  new URL('./assets/kite-8.3mf',import.meta.url), new URL('./assets/kite-11.3mf',import.meta.url), new URL('./assets/kite-14.3mf',import.meta.url),
];
const programs=[
  new URL('./assets/kite-8.gcode',import.meta.url), new URL('./assets/kite-11.gcode',import.meta.url), new URL('./assets/kite-14.gcode',import.meta.url),
];
const appearance={
  stage:['#433c35',.94,.06], platform:['#575a54',.83,.13], graphite:['#343e3f',.69,.30],
  dark:['#252c2b',.76,.1], rail:['#9da5a0',.49,.43], amber:['#dfa94c',.62,.08],
  orange:['#ab6b38',.64,.22], oxide:['#934d2e',.55,.24], faded:['#9b693e',.7,.18], travel:['#548c9d',.63,.05],
};
const gain=17.5, midpoint=.76, solidX=-.74, printedY=.085, layerRate=.29;
let engine, shapes, materials, outline, previous, lastLayer, travelLayer, nozzle, frame, last, since=0;
let part=0, layer=0, playing=false, dirty=true, changed=false;

function mount(geometry,style,at=[0,0,0],parent=null) {
  return engine.createMesh(parent).setGeometry(geometry).setMaterial(materials[style]).setPosition(at);
}
function buildBench() {
  mount(box(35,.055,35),'stage',[0,-.165,0]);
  mount(box(3.15,.11,1.73),'graphite',[0,-.072,.014]);
  mount(box(1.24,.095,1.25),'platform',[solidX,.003,0]);
  mount(box(1.37,.07,1.28),'dark',[midpoint,.025,0]);
  mount(box(1.21,.022,1.10),'graphite',[midpoint,.073,0]);
  mount(box(1.24,.006,1.12),'rail',[midpoint,.054,0]);
  const scoring=box(.007,.004,1.09);
  for(let i=-5;i<=5;i++)mount(scoring,'platform',[midpoint+.102*i,.084,0]);
  for(const side of [-1,1]){
    const x=midpoint+side*.70;
    mount(box(.077,.94,.081),'graphite',[x,.47,-.45]);
    mount(box(.09,.11,.15),'rail',[x,.084,.44]);
    mount(box(.09,.10,.89),'graphite',[x,.13,0]);
  }
  mount(box(1.46,.071,.085),'graphite',[midpoint,.91,-.45]);
  mount(box(1.42,.018,.055),'rail',[midpoint,.86,-.45]);
  mount(box(1.39,.036,.058),'rail',[midpoint,.80,-.35]);
  mount(box(.225,.041,.118),'dark',[midpoint,.078,.655]);
  mount(box(.123,.013,.072),'amber',[midpoint,.104,.66]);
  nozzle=engine.createMesh();
  mount(box(.104,.12,.088),'oxide',[0,.071,0],nozzle);
  mount(box(.060,.028,.060),'rail',[0,-.006,0],nozzle);
  mount(box(.017,.025,.018),'amber',[0,-.029,0],nozzle);
}

function pathGeometry(layers,kind,thickness) {
  const points=[], surface=[], faces=[];
  for(const layer of layers){
    const path=layer[kind],y=printedY+layer.z*.001*gain;
    for(let i=0;i<path.length;i+=4){
      const ax=midpoint+path[i]*.000001*gain,bx=midpoint+path[i+2]*.000001*gain;
      const az=-path[i+1]*.000001*gain,bz=-path[i+3]*.000001*gain;
      const distance=Math.hypot(bx-ax,bz-az);
      if(distance<.0000001)continue;
      const x=(bz-az)*thickness/distance,z=(ax-bx)*thickness/distance;
      const offset=points.length/3;
      points.push(ax-x,y,az-z,ax+x,y,az+z,bx-x,y,bz-z,bx+x,y,bz+z);
      surface.push(0,1,0,0,1,0,0,1,0,0,1,0);
      faces.push(offset,offset+2,offset+1,offset+1,offset+2,offset+3);
    }
  }
  return new Geometry(points,surface,faces);
}

function renderPaths(){
  const shape=shapes[part];
  const active=shape.layers[layer];
  if(outline!==shape.mesh){
    if(outline)outline.visible=false;
    shape.mesh.visible=true;
    outline=shape.mesh;
  }
  previous.setGeometry(pathGeometry(shape.layers.slice(0,layer),'paths',.0035));
  lastLayer.setGeometry(pathGeometry([active],'paths',.0041));
  if(travels.checked)travelLayer.setGeometry(pathGeometry([active],'travel',.0011));
  travelLayer.visible=travels.checked;
  const final=active.paths.slice(-2);
  nozzle.position.set(midpoint+final[0]*.000001*gain,printedY+active.z*.001*gain+.105,-final[1]*.000001*gain);
  slider.value=String(layer+1);
  id('layer-readout').value=(layer+1)+' / '+shape.layers.length;
  id('height').value=active.z.toFixed(2)+' mm';
  id('moves').value=String(active.paths.length/4);
  id('filament').value=(shape.filament/1000).toFixed(2)+' m';
  id('download-model').href=modelFiles[part].href;
  id('download-model').download='Kite-jig-'+shape.diameter+'mm.3mf';
  id('download-gcode').href=programs[part].href;
  id('download-gcode').download='Kite-jig-'+shape.diameter+'mm.gcode';
  const buttons=sizes.querySelectorAll('button');
  for(const [i,button] of buttons.entries())button.setAttribute('aria-pressed',String(i===part));
  document.body.dataset.bore=String(shape.diameter);
  document.body.dataset.layer=String(layer+1);
  document.body.dataset.moves=String(active.paths.length/4);
  document.body.dataset.travel=String(travels.checked);
  dirty=false;
}

function camera(){
  const dpr=Math.min(1.65,devicePixelRatio||1);
  const width=Math.max(1,Math.round(canvas.clientWidth*dpr)),height=Math.max(1,Math.round(canvas.clientHeight*dpr));
  if(canvas.width!==width)canvas.width=width;
  if(canvas.height!==height)canvas.height=height;
  const compact=Math.min(1.72,canvas.clientWidth/canvas.clientHeight)/1.72;
  const ratio=1/Math.min(1,compact);
  engine.camera.position=[.52*ratio,2.43*ratio,3.95*ratio];
  engine.camera.target=[.0,.23,-.12];
}

function switchPlay(active){
  playing=active;
  play.textContent=playing?'Pause layers':'Play layers';
  play.setAttribute('aria-pressed',String(playing));
  since=0;
}

function schedule(){
  if(!frame&&!signal.aborted)frame=requestAnimationFrame(draw);
}

function scrub(index,manual=true){
  layer=index;
  dirty=true;
  changed||=manual;
  schedule();
}

function draw(time) {
  frame=0;
  if(signal.aborted)return;
  try {
    const elapsed=last===undefined?0:Math.min(.065,Math.max(0,(time-last)/1000));
    last=time;
    if(playing){
      since+=elapsed;
      if(since>=layerRate){
        since-=layerRate;
        if(layer+1===shapes[part].layers.length)switchPlay(false);
        else layer++;
        dirty=true;
      }
    }
    if(dirty)renderPaths();
    camera();
    engine.render({delta:elapsed});
    if(changed){
      changed=false;
      performance.mark('print-layer-applied');
    }
    if(playing)schedule();
  } catch(error) {
    fail(error);
  }
}

async function setup(target) {
  if(!target.gpu)throw Error('The print bench needs WebGPU or WebGL2.');
  engine=target;
  engine.onError=fail;
  engine.scene.background='#433b33';
  engine.lighting.direction.set([-.36,.81,.51,2.65]);
  engine.lighting.radiance.set([1,.89,.74,.58]);
  engine.lighting.ambient.set([.86,.90,.97]);
  materials=Object.fromEntries(Object.entries(appearance).map(([name,[color,roughness,metalness]])=>[name,new PbrMaterial({color,roughness,metalness})]));
  shapes=await displayData;
  signal.throwIfAborted();
  for(const shape of shapes){
    const geometry=new Geometry(shape.position.map(x=>x*gain),shape.normal,shape.index);
    shape.mesh=mount(geometry,'orange',[solidX,.051,0]);
    shape.mesh.visible=false;
  }
  buildBench();
  previous=engine.createMesh().setMaterial(materials.faded);
  lastLayer=engine.createMesh().setMaterial(materials.amber);
  travelLayer=engine.createMesh().setMaterial(materials.travel).setPosition([0,.0015,0]);
}

function connect(){
  sizes.addEventListener('click',event=>{
    const button=event.target.closest('[data-part]');
    if(!button)return;
    part=Number(button.dataset.part);
    scrub(layer);
  },{signal});
  slider.addEventListener('input',()=>{
    switchPlay(false);
    scrub(Number(slider.value)-1);
  },{signal});
  travels.addEventListener('change',()=>scrub(layer),{signal});
  play.addEventListener('click',()=>{
    if(!playing&&layer+1===shapes[part].layers.length)scrub(0,false);
    switchPlay(!playing);
    last=undefined;
    schedule();
  },{signal});
  const observer=new ResizeObserver(schedule);
  observer.observe(canvas);
  signal.addEventListener('abort',()=>observer.disconnect(),{once:true});
}

async function compatibility(){
  const {install}=await import('@margoengine/webgl2-compat');
  return {install:()=>install({force:true,signal})};
}
async function start(){
  applyQualityTier();
  const options={signal,exactSize:true,antialias:true,camera:{near:.047,far:40,fov:37},startupTimeout:4300};
  if(forced||!navigator.gpu){
    await (await compatibility()).install();
    await autoEngine(canvas,setup,{...options,backend:'webgpu'});
  }else await autoEngine(canvas,setup,{...options,loadCompat:compatibility});
  draw(performance.now());
  await engine.gpu.queue.onSubmittedWorkDone();
  signal.throwIfAborted();
  connect();
  document.body.dataset.renderer=engine.gpu.adapterInfo?.vendor==='margo-webgl2'?'webgl2':'webgpu';
  state.ready();
  id('status').hidden=true;
  sizes.disabled=slider.disabled=play.disabled=travels.disabled=false;
  performance.mark('margo-first-usable-frame');
}
function dispose(){
  controller.abort();
  cancelAnimationFrame(frame);
  engine?.dispose();
}
function fail(reason){
  if(signal.aborted)return;
  state.error(reason);
  id('status').hidden=true;
  id('error').hidden=false;
  console.error(reason);
  dispose();
}
addEventListener('pagehide',event=>{if(!event.persisted)dispose();});
start().catch(fail);
