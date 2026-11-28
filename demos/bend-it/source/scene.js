import {PbrMaterial,box} from '@margoengine/core';
import {pipeGeometry} from '@margoengine/geometry/parts';
import {toGeometry} from '@margoengine/geometry/utils';
import {autoEngine} from '@margoengine/webgl2-compat/auto';
import {applyQualityTier} from '@margoengine/quality';
import {demoStatus} from 'margo-demo-status';
import {construct,guide,specimen} from './specimen.js';

const id=name=>document.getElementById(name);
const canvas=id('view'),plan=id('plan'),bend=id('bend'),rise=id('rise'),edit=id('edit');
const point=id('point'),offset=id('offset'),guides=id('guide');
const status=id('status'),statusController=demoStatus(document.body,status,id('error'));
const state=document.body.dataset, controller=new AbortController(),{signal}=controller;
const forced=new URLSearchParams(location.search).get('backend')==='webgl2';
const deck=[], handles=[], offsets=[0,0,0,0,0];
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
let engine,centerLine,model,knots,resize,raf,pending='',drag,planDrag,revision=0;
let yaw=.54,pitch=.64;
const mat=(color,roughness=.68,metalness=.08)=>new PbrMaterial({color,roughness,metalness});

function stage(target){
  const dark=mat('#3b4441',.47,.49), ivory=mat('#e0d2b1',.81), sage=mat('#879687',.78);
  const sand=mat('#a79c7e',.82), bronze=mat('#a87b47',.54,.62), black=mat('#303a35',.62,.18);
  const teal=mat('#416966',.33,.23), smooth=mat('#608782',.42,.19);
  const place=(geometry,material,position)=>target.createMesh().setGeometry(geometry).setMaterial(material).setPosition(position);
  place(box(75,.08,60),sage,[0,-.64,0]);
  place(box(13.2,.25,6.75),dark,[0,-.445,0]);
  place(box(13.30,.034,6.84),bronze,[0,-.329,0]);
  place(box(13.12,.085,6.64),sand,[0,-.271,0]);
  place(box(12.94,.036,6.47),ivory,[0,-.211,0]);
  place(box(2.35,.05,6.45),teal,[.26,-.184,0]);
  for(const side of [-1,1]){
    const x=.26+side*1.20;
    place(box(.058,.037,6.43),black,[x,-.169,0]);
    place(box(.032,.044,6.43),bronze,[x+side*.058,-.161,0]);
    place(box(1.35,.07,2.04),sand,[side*4.8,-.144,0]);
    place(box(1.32,.035,2),sage,[side*4.8,-.097,0]);
    place(box(1.41,.018,2.03),dark,[side*4.8,-.076,0]);
    for(let i=0;i<7;i++){
      const z=-2.73+i*.91;
      place(box(.165,.006,.010),black,[side*5.82,-.189,z]);
    }
  }
  for(let i=0;i<23;i++){
    const z=-3.15+i*.285;
    const x=.23+.43*Math.sin(i*1.91), w=.22+.55*(.5+.5*Math.sin(i*4.37));
    const grain=place(box(w,.003,.013+(i%2)*.013),i%3?smooth:teal,[x,-.154,z]);
    const rotation=.025*Math.sin(i*2.32);
    grain.setQuaternion([0,Math.sin(rotation),0,Math.cos(rotation)]);
  }
  for(let i=0;i<6;i++){
    const x=-5.62+i*.29;
    place(box(.094,.010,.035),bronze,[x,-.188,2.91]);
  }
  for(const part of specimen){
    deck.push(target.createMesh().setMaterial(mat(part.color,part.rough,part.metal)));
  }
  centerLine=target.createMesh().setMaterial(mat('#e5a252',.54,.15));
  const node=box(.09,.084,.09), mark=mat('#f9c680',.57,.12);
  for(let i=0;i<5;i++)handles.push(target.createMesh().setGeometry(node).setMaterial(mark).setQuaternion([0,.38268,0,.92388]));
}
function setCamera(){
  const dpi=Math.min(1.65,devicePixelRatio||1);
  const width=Math.max(1,Math.round(canvas.clientWidth*dpi)),height=Math.max(1,Math.round(canvas.clientHeight*dpi));
  if(canvas.width!==width)canvas.width=width;
  if(canvas.height!==height)canvas.height=height;
  const aspect=width/height;
  const distance=aspect<1.65?12.30:11.14;
  const floorDistance=distance*Math.cos(pitch);
  engine.camera.position=[Math.sin(yaw)*floorDistance,.48+Math.sin(pitch)*distance,Math.cos(yaw)*floorDistance];
  engine.camera.target=[0,.24,0];
  state.orbit=yaw.toFixed(3)+','+pitch.toFixed(3);
}
// The centre line: a thin rod 0.159 above the bent curve, on the flow's own frames.
function line(flow){
  const frames=Array.from({length:81},(_,i)=>flow.getFrame(i*flow.length/80));
  const path=frames.map(({position,up})=>position.map((v,k)=>v+.159*up[k]));
  return toGeometry(pipeGeometry(path,.013,{sides:4,up:frames[0].up}));
}
function planMap(){
  const scale=Math.min(2,devicePixelRatio||1);
  const w=Math.max(1,Math.round(plan.clientWidth*scale)), h=Math.max(1,Math.round(plan.clientHeight*scale));
  if(plan.width!==w)plan.width=w;
  if(plan.height!==h)plan.height=h;
  return {w,h,x:x=>w*(.08+(x+5.1)/10.2*.84),y:z=>h*(.5+.136*z),z:y=>(y/h-.5)/.136};
}
function paintPlan(){
  const {w,h,x,y}=planMap(), g=plan.getContext('2d');
  g.fillStyle='#283937';
  g.fillRect(0,0,w,h);
  g.strokeStyle='#4a5c55';
  g.lineWidth=1;
  g.beginPath();
  for(let value=-5;value<=5;value++){
    g.moveTo(x(value),0);g.lineTo(x(value),h);
  }
  for(let value=-3;value<=3;value++){
    g.moveTo(0,y(value));g.lineTo(w,y(value));
  }
  g.stroke();
  g.strokeStyle='#9eab96';
  g.setLineDash([3,4]);
  g.beginPath();g.moveTo(x(-5.1),y(0));g.lineTo(x(5.1),y(0));g.stroke();
  g.setLineDash([]);
  g.strokeStyle='#edbf83';
  g.lineWidth=Math.max(1.5,w/230);
  g.beginPath();
  for(let i=0;i<=90;i++){
    const p=model.spline.at(i/90);
    if(i===0)g.moveTo(x(p[0]),y(p[2]));else g.lineTo(x(p[0]),y(p[2]));
  }
  g.stroke();
  knots.forEach((p,i)=>{
    const inner=i>0&&i<4, center=+point.value===i;
    g.beginPath();g.arc(x(p[0]),y(p[2]),w*(center?.018:.013),0,2*Math.PI);
    g.fillStyle=inner?(center?'#f8d9a7':'#eab879'):'#b5c5aa';
    g.fill();
    if(center){
      g.lineWidth=1.6;g.strokeStyle='#402e21';g.stroke();
    }
  });
}
function markModel(action){
  state.action=action;
  state.bend=bend.value;
  state.rise=rise.value;
  state.control=offsets.map(n=>n.toFixed(3)).join(',');
  state.length=model.length.toFixed(5);
  const m=model.flow.getFrame(model.length/2);
  state.center=m.position.map(n=>(Math.abs(n)<.000005?0:n).toFixed(5)).join(',');
  let signature=0;
  const vertices=model.meshes[0].positions;
  for(let i=0;i<vertices.length;i+=47)signature+=vertices[i]*(i%211+1);
  state.pose=signature.toFixed(5);
  id('length').value=model.length.toFixed(2)+' m';
  id('bendValue').value=bend.value+'%';
  id('riseValue').value=(+rise.value/100).toFixed(2)+' m';
}
function apply(action){
  if(action!=='camera'&&action!=='guides'){
    knots=guide(+bend.value/100,+rise.value/100,offsets);
    model=construct(knots);
    model.meshes.forEach((g,i)=>deck[i].setGeometry(toGeometry(g)));
    const visible=guides.checked;
    if(visible)centerLine.setGeometry(line(model.flow));
    centerLine.visible=visible;
    handles.forEach((mesh,i)=>{
      mesh.visible=visible;
      mesh.setPosition([knots[i][0],knots[i][1]+.190,knots[i][2]]);
    });
    paintPlan();
    markModel(action);
  }else if(action==='guides'){
    if(guides.checked)centerLine.setGeometry(line(model.flow));
    centerLine.visible=guides.checked;
    for(const m of handles)m.visible=guides.checked;
  }
  state.guides=String(guides.checked);
  setCamera();
  engine.render({delta:0});
  const ticket=++revision;
  engine.gpu.queue.onSubmittedWorkDone().then(()=>{
    if(signal.aborted)return;
    if(ticket>Number(state.revision??0))state.revision=String(ticket);
    if(['bend','rise','point','straight','reset'].includes(action)&&!performance.getEntriesByName('bend-applied').length)
      performance.mark('bend-applied');
  }).catch(fail);
}
function schedule(action){
  const needsGeometry=action!=='camera'&&action!=='guides';
  if(needsGeometry||!pending||pending==='camera')pending=action;
  if(raf)return;
  raf=requestAnimationFrame(()=>{
    raf=undefined;
    const key=pending;
    pending='';
    try{apply(key);}catch(error){fail(error);}
  });
}
function setDefault(flat){
  bend.value=flat?'0':'62';rise.value=flat?'0':'72';
  offsets.fill(0);offset.value='0';
  point.value='2';
  schedule(flat?'straight':'reset');
}
function connect(){
  bend.addEventListener('input',()=>schedule('bend'),{signal});
  rise.addEventListener('input',()=>schedule('rise'),{signal});
  id('straight').addEventListener('click',()=>setDefault(true),{signal});
  id('reset').addEventListener('click',()=>setDefault(false),{signal});
  guides.addEventListener('input',()=>schedule('guides'),{signal});
  point.addEventListener('input',()=>{offset.value=String(Math.round(offsets[+point.value]*100));paintPlan();},{signal});
  offset.addEventListener('input',()=>{offsets[+point.value]=+offset.value/100;schedule('point');},{signal});
  function relative(event){
    const r=plan.getBoundingClientRect();
    return [(event.clientX-r.x)*plan.width/r.width,(event.clientY-r.y)*plan.height/r.height];
  }
  plan.addEventListener('pointerdown',event=>{
    if(planDrag)return;
    const map=planMap(), at=relative(event);
    const slot=[1,2,3].find(i=>Math.hypot(map.x(knots[i][0])-at[0],map.y(knots[i][2])-at[1])<map.w*.095);
    if(slot===undefined)return;
    planDrag={id:event.pointerId,slot};
    point.value=String(slot);
    offset.value=String(Math.round(offsets[slot]*100));
    paintPlan();
    plan.setPointerCapture(event.pointerId);
  },{signal});
  plan.addEventListener('pointermove',event=>{
    if(planDrag?.id!==event.pointerId)return;
    const map=planMap(), base=guide(+bend.value/100,+rise.value/100);
    const next=clamp(map.z(relative(event)[1])-base[planDrag.slot][2],-.7,.7);
    offsets[planDrag.slot]=next;
    offset.value=String(Math.round(next*100));
    schedule('point');
  },{signal});
  plan.addEventListener('lostpointercapture',()=>{planDrag=undefined;},{signal});
  canvas.addEventListener('pointerdown',event=>{
    if(drag)return;
    drag={id:event.pointerId,x:event.clientX,y:event.clientY,yaw,pitch};
    canvas.setPointerCapture(event.pointerId);
  },{signal});
  canvas.addEventListener('pointermove',event=>{
    if(drag?.id!==event.pointerId)return;
    yaw=drag.yaw-(event.clientX-drag.x)*.008;
    pitch=clamp(drag.pitch+(event.clientY-drag.y)*.008,.22,1.05);
    schedule('camera');
  },{signal});
  canvas.addEventListener('lostpointercapture',()=>{drag=undefined;},{signal});
  resize=new ResizeObserver(()=>{paintPlan();schedule('camera');});
  resize.observe(canvas);
  resize.observe(plan);
}
async function compat(){
  const {install}=await import('@margoengine/webgl2-compat');
  return {install:()=>install({force:true,signal})};
}
async function start(){
  applyQualityTier();
  const fallback=forced||!navigator.gpu;
  if(fallback)await (await compat()).install();
  await autoEngine(canvas,async target=>{
    if(!target.gpu)throw new Error('The footbridge needs WebGPU or the WebGL2 compatibility renderer.');
    engine=target;
    engine.scene.background='#9ca397';
    engine.lighting.direction.set([-.58,.78,.42,2.3]);
    engine.lighting.radiance.set([1,.93,.80,.78]);
    engine.lighting.ambient.set([.77,.84,.84]);
    stage(target);
    apply('opening');
    await target.gpu.queue.onSubmittedWorkDone();
  },{backend:fallback?'webgpu':undefined,signal,loadCompat:compat,exactSize:true,antialias:true,
    camera:{near:.07,far:110,fov:43},startupTimeout:5000});
  signal.throwIfAborted();
  engine.onError=fail;
  state.renderer=engine.gpu.adapterInfo?.vendor==='margo-webgl2'?'webgl2':'webgpu';
  state.guides=String(guides.checked);
  status.hidden=true;
  edit.disabled=point.disabled=offset.disabled=guides.disabled=false;
  connect();
  statusController.ready();
  performance.mark('margo-first-usable-frame');
}
function dispose(){
  controller.abort();
  if(raf)cancelAnimationFrame(raf);
  resize?.disconnect();
  engine?.dispose();
}
function fail(error){
  if(signal.aborted)return;
  statusController.error(error);
  status.hidden=true;
  id('error').hidden=false;
  console.error(error);
  dispose();
}
addEventListener('pagehide',event=>{if(!event.persisted)dispose();});
start().catch(fail);
