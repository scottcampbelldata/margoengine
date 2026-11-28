import { Geometry, PbrMaterial, box } from '@margoengine/core';
import { applyQualityTier } from '@margoengine/quality';
import { autoEngine } from '@margoengine/webgl2-compat/auto';
import { OrbitControls } from '@margoengine/controls/orbit';
import { WalkControls } from '@margoengine/controls/walk';
import { LabelRenderer } from '@margoengine/labels';
import { Callouts } from '@margoengine/labels/callouts';
import { HitDetails } from '@margoengine/selection/hit-details';
import { demoStatus } from 'margo-demo-status';

const byId=id=>document.getElementById(id);
const canvas=byId('house');
const figure=canvas.parentElement;
byId('download').href=new URL('./assets/rain-courtyard.ifc',import.meta.url).href;
const levels=byId('levels');
const floorButtons=[...levels.querySelectorAll('[data-floor]')];
const walkButton=byId('walk');
const wallList=byId('pick-wall');
const loading=byId('status');
const error=byId('error');
const status=demoStatus(document.body,loading,error);
const abort=new AbortController();
const {signal}=abort;
const forced=new URLSearchParams(location.search).get('backend')==='webgl2';
const source=new URL('./assets/house.bin',import.meta.url);
const data=fetch(source,{signal}).then(response=>{
  if(!response.ok)throw Error('The IFC geometry could not be downloaded.');
  return new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).json();
});
data.catch(()=>{});

const appearance={
  'Cedar':['#866344',.69,.11],
  'Sandstone':['#d2bd91',.85,.01],
  'Board-marked concrete':['#a9a79b',.81,.03],
  'Bronze':['#6e6042',.50,.36],
  'Blue glass':['#536c71',.19,.49],
  'Zinc':['#64766e',.52,.43],
  'Travertine':['#c1ac7f',.78,.08],
  'Wool':['#947156',.91,.01],
  'Sedum':['#657451',.91,.03],
  'Oak':['#b38657',.63,.15],
};
const selectedMaterial=new PbrMaterial({color:'#dcc47a',roughness:.67,metalness:.08});
const brown=new PbrMaterial({color:'#627452',roughness:.96});
const lawn=new PbrMaterial({color:'#8d9774',roughness:.91});
const forest=new PbrMaterial({color:'#405444',roughness:.98});
const walls=new Map(), wallPick=new Map();
const readings=[['material','material',''],['length','Length',' m'],['thickness','Width',' m'],
  ['surface','NetSideArea',' m²'],['volume','NetVolume',' m³']];
const number=new Intl.NumberFormat(undefined,{maximumFractionDigits:3});
let engine, orbit, walker, picking, labels, model;
let viewFloor=-1, selected, tag, frame, last, pending='', pointer, inspecting=false;

function mount(geometry,material,position) {
  const mesh=engine.createMesh().setGeometry(geometry).setMaterial(material);
  if(position)mesh.setPosition(position);
  return mesh;
}

function site() {
  mount(box(252,.24,252),forest,[0,-.58,0]);
  mount(box(18,.20,13),brown,[0,-.40,0]);
  mount(box(10,.11,.21),lawn,[0,-.25,4.88]);
  mount(box(5.8,.11,.22),lawn,[-5.0,-.25,-4.28]);
}

function showProperties(item, point) {
  tag?.remove();
  tag=undefined;
  if(selected)selected.mesh.setMaterial(selected.material);
  selected=item;
  if(item)item.mesh.setMaterial(selectedMaterial);
  wallList.value=item?String(item.id):'';
  byId('wall-name').textContent=item?.name??'Select a wall';
  for(const [id,key,unit] of readings) {
    const value=key==='material'?item?.materialName:item?.quantities[key];
    byId(id).textContent=value===undefined?'—':typeof value==='number'?number.format(value)+unit:value;
  }
  if(item){
    const label=document.createElement('span');
    label.className='wall-tag';
    label.textContent=item.name;
    tag=labels.add(label,{position:point??item.pin,screenOffset:[18,-31]});
    document.body.dataset.wall=String(item.id);
    pending='wall';
  } else delete document.body.dataset.wall;
}

function exteriorPose() {
  const compact=canvas.clientWidth/canvas.clientHeight<1.6;
  const zoom=compact?1.25:1;
  if(viewFloor<0){
    engine.camera.position=[12.7*zoom,12.4*zoom,15.8*zoom];
    engine.camera.target=[0,4,0];
  } else {
    const {elevation}=model.floors[viewFloor];
    engine.camera.position=[11.65*zoom,elevation+10.65*zoom,12.75*zoom];
    engine.camera.target=[0,elevation+.75,0];
  }
}

function updateVisible(interior=Boolean(walker)) {
  for(const [index,floor] of model.floors.entries())for(const item of floor.elements) {
    const roofLayer=item.name==='Studio roof'||item.name==='Green roof'||item.name==='Roof coping';
    const ceiling=interior && (index===viewFloor+1 && item.type==='IfcSlab' ||
      viewFloor===model.floors.length-1 && item.name==='Studio roof');
    item.mesh.visible=viewFloor<0||(!roofLayer && index<=viewFloor)||ceiling;
  }
}

function walk(active) {
  if(walker){
    walker.dispose();
    walker=undefined;
  }
  updateVisible(active);
  if(active){
    const floor=model.floors[Math.max(0,viewFloor)];
    const {elevation}=floor;
    engine.camera.position=[-.34,elevation+1.65,.87];
    engine.camera.target=[.35,elevation+1.58,-2.0];
    engine.camera.fov=66;
    const colliders=model.floors.flatMap(level=>level.elements.filter(part=>part.mesh.visible).map(part=>part.mesh));
    walker=WalkControls.attach(engine,{element:canvas,colliders,carry:false});
    walker.pointerLock=false;
    walker.speed=1.85;
    walker.radius=.21;
    orbit.enabled=false;
    walkButton.textContent='Return to model';
    byId('help').textContent='Touch left to move and right to look. On a keyboard use WASD or arrows.';
  } else {
    orbit.enabled=true;
    engine.camera.fov=39;
    exteriorPose();
    walkButton.textContent='Walk on this floor';
    byId('help').textContent='Turn the model with a drag. Tap a wall to inspect it.';
  }
  document.body.dataset.walking=String(Boolean(walker));
  pending='floor';
}

function openFloor(index,keepWalking=false) {
  viewFloor=index;
  showProperties(undefined);
  updateVisible();
  for(const button of floorButtons)button.setAttribute('aria-pressed',String(Number(button.dataset.floor)===index));
  const floor=model.floors[index];
  byId('view-floor').value=floor?.name??'Whole house';
  const first=new Option('Choose a wall','');
  const options=floor?floor.elements.filter(item=>item.type==='IfcWall'):[...walls.values()];
  wallList.replaceChildren(first,...options.map(item=>new Option((floor?'':model.floors[item.floor].name+' · ')+item.name,String(item.id))));
  walk(keepWalking&&index>=0);
}

async function pickWall(x,y){
  if(inspecting)return;
  inspecting=true;
  try {
    const hit=await picking.pick(x,y);
    if(signal.aborted)return;
    const wall=wallPick.get(hit?.mesh);
    if(wall)showProperties(wall,hit.position);
  } catch(ex) {
    if(!signal.aborted)fail(ex);
  } finally {
    inspecting=false;
  }
}

function connect() {
  levels.addEventListener('click',event=>{
    const button=event.target.closest('[data-floor]');
    if(button)openFloor(Number(button.dataset.floor),Boolean(walker));
  },{signal});
  walkButton.addEventListener('click',()=>{
    if(viewFloor<0)openFloor(0);
    walk(!walker);
  },{signal});
  wallList.addEventListener('change',()=>showProperties(walls.get(Number(wallList.value))),{signal});
  canvas.addEventListener('pointerdown',e=>{pointer={id:e.pointerId,x:e.clientX,y:e.clientY};},{signal});
  canvas.addEventListener('pointerup',e=>{
    const small=pointer?.id===e.pointerId&&Math.hypot(e.clientX-pointer.x,e.clientY-pointer.y)<6;
    pointer=undefined;
    if(!small)return;
    const {x,y}=canvas.getBoundingClientRect();
    void pickWall(e.clientX-x,e.clientY-y);
  },{signal});
  canvas.addEventListener('pointercancel',()=>{pointer=undefined;},{signal});
}

function render(now) {
  const pxRatio=Math.min(1.65,devicePixelRatio||1);
  const width=Math.max(1,Math.round(canvas.clientWidth*pxRatio));
  const height=Math.max(1,Math.round(canvas.clientHeight*pxRatio));
  if(canvas.width!==width)canvas.width=width;
  if(canvas.height!==height)canvas.height=height;
  const delta=last===undefined?0:Math.min(.065,Math.max(0,(now-last)/1000));
  last=now;
  engine.render({delta});
  if(pending==='floor'){
    document.body.dataset.floor=String(viewFloor);
    performance.mark('bim-floor-rendered');
  }
  if(pending==='wall')performance.mark('bim-wall-rendered');
  pending='';
  if(walker&&document.body.dataset.ready){
    const [x,y,z]=engine.camera.position;
    document.body.dataset.walkX=x.toFixed(3);
    document.body.dataset.walkY=y.toFixed(3);
    document.body.dataset.walkZ=z.toFixed(3);
  }
}
function tick(now) {
  if(signal.aborted)return;
  try {
    render(now);
    frame=requestAnimationFrame(tick);
  } catch(ex) {
    fail(ex);
  }
}

async function setup(target) {
  if(!target.gpu)throw Error('This exhibit needs the WebGPU or WebGL2 renderer.');
  engine=target;
  engine.onError=fail;
  engine.scene.background='#879e97';
  engine.lighting.direction.set([-.42,.7,.55,2.75]);
  engine.lighting.radiance.set([1,.915,.783,.70]);
  engine.lighting.ambient.set([.79,.93,1.035]);
  model=await data;
  signal.throwIfAborted();
  const styles=new Map(Object.entries(appearance).map(([name,[color,roughness,metalness]])=>[name,new PbrMaterial({color,roughness,metalness})]));
  for(const [index,floor] of model.floors.entries())for(const item of floor.elements){
    item.materialName=item.material;
    item.floor=index;
    const style=styles.get(item.material);
    if(!style)throw Error('An IFC product has an unknown exhibit material: '+item.material);
    const geometry=new Geometry(item.position,item.normal,item.index);
    item.mesh=mount(geometry,style);
    item.mesh.name=item.name;
    item.pin=[geometry.bounds[0],geometry.bounds[1],geometry.bounds[2]];
    item.material=style;
    if(item.type==='IfcWall'){walls.set(item.id,item);wallPick.set(item.mesh,item);}
  }
  site();
  labels=LabelRenderer.attach(engine,{parent:figure,zIndex:1,layout:new Callouts({color:'#f0d488',width:1.1,dot:3})});
  picking=HitDetails.attach(engine);
  orbit=OrbitControls.attach(engine);
  orbit.minDistance=5;
  orbit.maxDistance=60;
  orbit.maxPolarAngle=1.52;
  orbit.enableDamping=true;
  orbit.dampingFactor=.14;
  openFloor(-1);
}
async function compatibility() {
  const {install}=await import('@margoengine/webgl2-compat');
  return {install:()=>install({force:true,signal})};
}
async function start() {
  applyQualityTier();
  const options={signal,exactSize:true,antialias:true,camera:{near:.05,far:180,fov:39},startupTimeout:4600};
  if(forced||!navigator.gpu){
    await (await compatibility()).install();
    await autoEngine(canvas,setup,{...options,backend:'webgpu'});
  } else await autoEngine(canvas,setup,{...options,loadCompat:compatibility});
  render(performance.now());
  await engine.gpu.queue.onSubmittedWorkDone();
  signal.throwIfAborted();
  connect();
  levels.disabled=walkButton.disabled=wallList.disabled=false;
  loading.hidden=true;
  status.ready();
  document.body.dataset.renderer=engine.gpu.adapterInfo?.vendor==='margo-webgl2'?'webgl2':'webgpu';
  performance.clearMarks('bim-floor-rendered');
  performance.mark('margo-first-usable-frame');
  frame=requestAnimationFrame(tick);
}
function dispose(){
  abort.abort();
  cancelAnimationFrame(frame);
  walker?.dispose();
  orbit?.dispose();
  engine?.dispose();
}
function fail(reason) {
  if(signal.aborted)return;
  status.error(reason);
  loading.hidden=true;
  error.hidden=false;
  console.error(reason);
  dispose();
}
addEventListener('pagehide',event=>{if(!event.persisted)dispose();});
start().catch(fail);
