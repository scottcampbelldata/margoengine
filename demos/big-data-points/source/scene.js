import { PointsPlugin, PointsMaterial } from '@margoengine/points';
import { OctreeCloud } from '@margoengine/points/octree';
import { Colormap } from '@margoengine/sciviz/colormaps';
import { autoEngine } from '@margoengine/webgl2-compat/auto';
import { demoStatus } from 'margo-demo-status';
import manifest from './tools/runtime.json';

const $=id=>document.getElementById(id);
const panel=$('status'), slider=$('angle'), note=$('load-note');
const controls=[...document.querySelectorAll('[data-budget]')];
const formatter=new Intl.NumberFormat('en-US');
const controller=new AbortController(), {signal}=controller;
let canvas=$('view'), status=demoStatus(canvas,panel,$('reason'));
let engine, cloud, points, frame, resizing, ready=false, busy=false, dirty=false;
let angle=24, budget=65500, revision=0, lastAction='', lastMarked=0;
let seed, failure, loadedFiles=0, planned;

const assets=import.meta.glob('./tools/cloud/*.bin',{query:'?url&no-inline',import:'default',eager:true});
const records=new Map(manifest.nodes.map(record=>[record.id,record]));
const nodes=new Map();
const [widthM,depthM]=manifest.extent, [heightBase]=manifest.height;
const [zLo,zHi]=manifest.elevation;
const rise=(zHi+zLo)/2-heightBase;
const palette=[
  [.00,[.29,.32,.58]], [.17,[.43,.35,.58]], [.39,[.62,.39,.48]], [.59,[.81,.51,.37]],
  [.77,[.88,.66,.42]], [1,[.95,.83,.65]],
];
const cmap=new Colormap('Lidar elevation','sequential',t=>{
  const k=palette.findIndex(([value])=>value>=t);
  if(k<1)return palette[0][1];
  const [a,left]=palette[k-1],[b,right]=palette[k];
  const f=(t-a)/(b-a);
  return left.map((c,i)=>c+(right[i]-c)*f);
}).table(256);

for(const record of manifest.nodes){
  const {id,count,bounds}=record;
  const level=id.length-1, parent=level?nodes.get(id.slice(0,-1)):null;
  const node={id, level, count, bounds:Float64Array.from(bounds),
    spacing:(bounds[3]-bounds[0])/Math.sqrt(count),parent,children:new Array(8).fill(null)};
  if(parent)parent.children[Number(id.at(-1))]=node;
  nodes.set(id,node);
}
const root=nodes.get('r');
const children=new Map([...nodes.values()].map(node=>[node,[...node.children]]));

async function bricked(record, cancel) {
  const local=AbortSignal.any([signal,cancel,AbortSignal.timeout(40000)]);
  const response=await fetch(assets['./tools/cloud/'+record.file],{signal:local});
  if(!response.ok||!response.body)throw new Error('Lidar tile could not load: '+record.id);
  const stream=response.body.pipeThrough(new DecompressionStream('gzip'));
  const raw=await new Response(stream).arrayBuffer();
  local.throwIfAborted();
  const n=record.count;
  if(raw.byteLength!==n*7)throw new Error('Lidar tile length is incorrect: '+record.id);
  const source=new Uint16Array(raw,0,n*3), shade=new Uint8Array(raw,n*6,n);
  const positions=new Float32Array(3*n), colors=new Uint8Array(3*n);
  let east=0,north=0,vertical=0;
  for(let i=0;i<n;i++){
    east=(east+source[i])&65535;
    north=(north+source[n+i])&65535;
    vertical=(vertical+source[2*n+i])&65535;
    const x=manifest.step*east, y=manifest.step*vertical, z=manifest.step*north,index=i*3;
    positions[index]=x-widthM/2;
    positions[index+1]=y;
    positions[index+2]=depthM/2-z;
    const normalized=Math.max(0,Math.min(1,(y+heightBase-zLo)/(zHi-zLo)));
    const idx=4*Math.round(normalized*255), light=.31+.70*shade[i]/255;
    for(let c=0;c<3;c++)colors[index+c]=Math.round(cmap[idx+c]*light*255);
  }
  loadedFiles++;
  return {positions,colors,colorComponents:3};
}

const source={
  root,
  async load(node,cancel){
    try{
      return await (node===root?seed:bricked(records.get(node.id),cancel));
    }finally{
      if(ready)schedule();
    }
  },
};

function fail(error){
  if(status.failed||signal.aborted)return;
  status.error(error);
  const unsupported=error?.code==='unsupported';
  panel.querySelector('strong').textContent=unsupported?
    'Survey points need WebGPU or full WebGL2.':'The lidar survey could not open.';
  $('help').hidden=!unsupported;
  panel.hidden=false;
  for(const control of [slider,...controls])control.disabled=true;
}

function fit(viewAngle){
  const cssW=canvas.clientWidth,cssH=canvas.clientHeight;
  const scale=Math.min(1.65,Math.max(1,devicePixelRatio));
  const w=Math.round(cssW*scale),h=Math.round(cssH*scale);
  if(canvas.width!==w)canvas.width=w;
  if(canvas.height!==h)canvas.height=h;
  const t=viewAngle*Math.PI/180, camera=engine.camera;
  camera.target=[0,rise-40,0];
  camera.position=[6100*Math.sin(t),rise+5300,6100*Math.cos(t)];
  const span=Math.max(4050,5950*cssH/cssW), depth=camera.far-camera.near;
  camera.project=(out,aspect,webgpu)=>{
    out[0]=2/(span*aspect);
    out[5]=2/span;
    out[10]=webgpu?1/depth:-2/depth;
    out[14]=webgpu?camera.far/depth:-(camera.far+camera.near)/depth;
    out[15]=1;
  };
  $('scale').style.width=1000*cssH/span+'px';
}

function renderRaw(viewAngle,limit){
  fit(viewAngle);
  if(planned!==limit){
    const depth=limit===root.count?0:limit===manifest.count?3:1;
    for(const [node,all] of children)for(let i=0;i<all.length;i++)
      node.children[i]=node.level<depth?all[i]:null;
    planned=limit;
  }
  cloud.pointBudget=limit;
  points.pointBudget=limit;
  cloud.select({position:engine.camera.position,screenHeight:canvas.height,fov:42});
  engine.render({delta:0});
}

function readout(viewAngle,limit,version,action){
  const {loaded,loading,failed}=cloud.stats, drawn=points.stats.pointsDrawn;
  $('drawn').textContent=formatter.format(drawn);
  $('loaded').textContent=formatter.format(loaded);
  const message=failure?
    'A detail tile is unavailable. The loaded detail stays visible.':
    loading?'Loading survey tiles…':drawn===manifest.count?'Full crop rendered.':'';
  if(message!==note.textContent)note.textContent=message;
  Object.assign(canvas.dataset,{angle:viewAngle,budget:limit,loaded,drawn,loading,failed,tiles:loadedFiles,
    activeNodes:cloud.visible.length,revision:version,action});
}

function schedule(){
  dirty=true;
  if(frame===undefined&&!busy&&!signal.aborted&&!status.failed)frame=requestAnimationFrame(draw);
}

async function draw(){
  frame=undefined;
  if(!dirty||signal.aborted||status.failed)return;
  dirty=false;
  busy=true;
  const viewAngle=angle, limit=budget, version=revision, action=lastAction;
  try{
    renderRaw(viewAngle,limit);
    await engine.gpu.queue.onSubmittedWorkDone();
    signal.throwIfAborted();
    readout(viewAngle,limit,version,action);
    if(version>lastMarked&&action==='angle'&&!performance.getEntriesByName('points-first-turn').length)
      performance.mark('points-first-turn');
    lastMarked=version;
  }catch(error){fail(error);}
  finally{
    busy=false;
    if(dirty)schedule();
  }
}

function register(){
  slider.addEventListener('input',()=>{
    angle=Number(slider.value);
    $('degrees').textContent=angle+'°';
    slider.setAttribute('aria-valuetext',angle+' degrees');
    revision++;
    lastAction='angle';
    schedule();
  },{signal});
  for(const button of controls)button.addEventListener('click',()=>{
    budget=Number(button.dataset.budget);
    for(const other of controls)other.setAttribute('aria-pressed',String(other===button));
    $('budget-note').textContent='Up to '+formatter.format(budget)+' points drawn per frame.';
    revision++;
    lastAction='budget';
    schedule();
  },{signal});
  let size=canvas.clientWidth+'x'+canvas.clientHeight;
  resizing=new ResizeObserver(()=>{
    const next=canvas.clientWidth+'x'+canvas.clientHeight;
    if(next===size)return;
    size=next;
    schedule();
  });
  resizing.observe(canvas);
}

async function open(){
  const force=new URLSearchParams(location.search).get('backend')==='webgl2';
  const known=force||!navigator.gpu;
  const loadCompat=async()=>{
    const setup=await import('@margoengine/webgl2-compat');
    return {install:()=>setup.install({force,signal})};
  };
  seed=bricked(records.get('r'),signal);
  void seed.catch(()=>{});
  if(known)await (await loadCompat()).install();
  engine=await autoEngine(canvas,async target=>{
    engine=target;
    canvas=engine.canvas;
    status=demoStatus(canvas,panel,$('reason'));
    engine.scene.background='#171925';
    planned=undefined;
    const spec=new PointsMaterial({size:.85,minPixelSize:.65,maxPixelSize:9,shape:'round',vertexColors:true});
    points=PointsPlugin.attach(engine,{pointBudget:root.count});
    cloud=new OctreeCloud(points,source,{pointBudget:root.count,minNodePixels:.45,maxLoadedPoints:manifest.count,
      maxConcurrentLoads:5,material:spec,adaptiveSize:{scale:1.31},cloud:{blockSize:8192,seed:611}});
    cloud.onError((node,error)=>{
      if(node===root)fail(error);
      else{
        failure=error;
        schedule();
      }
    });
    await seed;
    fit(angle);
    cloud.select({position:engine.camera.position,screenHeight:canvas.height,fov:42});
    for(let tick=0;!cloud.stats.loaded&&tick<12&&!status.failed;tick++)
      await new Promise(resolve=>requestAnimationFrame(resolve));
    if(!cloud.stats.loaded)throw new Error('The coarse lidar tile could not be rendered.');
    renderRaw(angle,root.count);
    await engine.gpu.queue.onSubmittedWorkDone();
    readout(angle,root.count,0,'');
  },{
    loadCompat,backend:known?'webgpu':undefined,signal,exactSize:true,antialias:false,
    startupTimeout:8500,capacity:32,camera:{near:10,far:35000,fov:42},
  });
  signal.throwIfAborted();
  if(status.failed)return;
  engine.onError=fail;
  canvas.dataset.renderer=engine.gpu.adapterInfo?.vendor==='margo-webgl2'?'webgl2':'webgpu';
  $('low').textContent=formatter.format(Math.round(zLo))+' m';
  $('high').textContent=formatter.format(Math.round(zHi))+' m';
  for(const control of [slider,...controls])control.disabled=false;
  register();
  ready=true;
  panel.hidden=true;
  performance.mark('margo-first-usable-frame');
  status.ready();
  schedule();
}

window.addEventListener('pagehide',event=>{
  if(event.persisted)return;
  controller.abort();
  resizing?.disconnect();
  if(frame!==undefined)cancelAnimationFrame(frame);
  cloud?.dispose();
  engine?.dispose();
});
open().catch(fail);
