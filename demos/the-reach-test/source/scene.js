import { Geometry, PbrMaterial, box } from '@margoengine/core';
import { autoEngine } from '@margoengine/webgl2-compat/auto';
import { applyQualityTier } from '@margoengine/quality';
import { demoStatus } from 'margo-demo-status';
import { between, gauges, jointRadii, minClearance, presets, radii, report, startPose, stepReach } from './solver.mjs';

const byId=id=>document.getElementById(id);
const canvas=byId('scene'), panel=byId('targets'), range=byId('depth'), reset=byId('reset');
const buttons=[...panel.querySelectorAll('button')];
const loading=byId('status'), error=byId('error');
const reticle=byId('target-crosshair');
const status=demoStatus(document.body,loading,error);
const controller=new AbortController();
const {signal}=controller;
const forced=new URLSearchParams(location.search).get('backend')==='webgl2';
const colors={
  dark:['#243139',.75,.28], bench:['#426064',.79,.15], rail:['#648188',.53,.42],
  body:['#768d90',.48,.45], cap:['#c5d5cb',.37,.61], brass:['#c38d4e',.50,.47],
  post:['#be7341',.64,.23], floor:['#23363e',.89,.08], guide:['#ddcd88',.75,.05],
  target:['#fee481',.40,.10],
};
const eye=[2.65,2.01,4.1], focus=[-.03,.93,0];
const subtract=(a,b)=>a.map((n,i)=>n-b[i]);
const scale=(a,s)=>a.map(n=>n*s);
const sum=(a,b)=>a.map((n,i)=>n+b[i]);
const norm=v=>scale(v,1/Math.hypot(...v));
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const forward=norm(subtract(focus,eye));
const right=norm(cross(forward,[0,1,0]));
const up=cross(right,forward);
const fixed=1/60;
const cameraScale=Math.tan(35*Math.PI/360);
const dot=(a,b)=>a.reduce((sum,value,i)=>sum+value*b[i],0);
let engine,materials,linkNodes,wristNodes,target,frame,last;
let pose=startPose, earlier=startPose, desired=[...pose.at(-1)];
let state=report(pose,desired,'Ready to reach'), accumulator=0, pointer;
let pendingStart=false,lastTip='',lastValues='';

function spun(profile,quality=28) {
  const position=[], normals=[], indices=[];
  for(const [row,[y,radius]] of profile.entries()) {
    const first=profile[Math.max(0,row-1)],next=profile[Math.min(profile.length-1,row+1)];
    const tangent=next[0]-first[0], radial=next[1]-first[1];
    const n=Math.hypot(tangent,radial)||1;
    for(let i=0;i<quality;i++){
      const phase=i*2*Math.PI/quality;
      const x=Math.cos(phase),z=Math.sin(phase);
      position.push(x*radius,y,z*radius);
      normals.push(x*tangent/n,-radial/n,z*tangent/n);
      if(!row)continue;
      const a=(row-1)*quality+i,b=(row-1)*quality+(i+1)%quality,c=row*quality+i,d=row*quality+(i+1)%quality;
      indices.push(a,c,b,b,c,d);
    }
  }
  return new Geometry(position,normals,indices);
}

function barrel(h,bottom,top=bottom,lip=.015) {
  return spun([[-h/2,0],[-h/2,Math.max(0,bottom-lip)],[-h/2+lip,bottom],[h/2-lip,top],[h/2,Math.max(0,top-lip)],[h/2,0]]);
}

function sphere(radius) {
  return spun(Array.from({length:17},(_,i)=>{
    const t=Math.PI*i/16-Math.PI/2;
    return [Math.sin(t)*radius,Math.cos(t)*radius];
  }),32);
}

function mount(geometry,look,at=[0,0,0],parent=null) {
  return engine.createMesh(parent).setGeometry(geometry).setMaterial(materials[look]).setPosition(at);
}

function tables() {
  mount(box(37,.10,37),'floor',[0,-.27,0]);
  mount(box(3.04,.17,2.52),'dark',[0,-.135,.11]);
  mount(box(2.91,.06,2.29),'bench',[0,-.054,.11]);
  const rails=box(2.72,.008,.012);
  for(let i=0;i<=10;i++)mount(rails,'rail',[0,-.020,-.91+i*.194]);
  const course=box(.033,.009,.17);
  for(let i=0;i<14;i++)mount(course,'guide',[-1.26+i*.194,-.02,1.08]);
  mount(barrel(.13,.37,.33,.018),'dark',[0,.041,0]);
  mount(barrel(.08,.296,.273,.024),'brass',[0,.14,0]);
  mount(barrel(.39,.18,.12,.025),'body',[0,.361,0]);
  mount(barrel(.09,.153,.13,.023),'cap',[0,.573,0]);
  const {a,b,radius}=gauges.post;
  const mid=scale(sum(a,b),.5),span=b[1]-a[1];
  mount(barrel(span,radius,radius,.002),'post',mid);
  mount(sphere(radius),'post',a);
  mount(sphere(radius),'post',b);
  mount(barrel(.10,.234,.20,.016),'brass',[a[0],.044,a[2]]);
  mount(barrel(.16,.102,.114,.016),'dark',[a[0],.13,a[2]]);
  const block=gauges.block;
  mount(box(...block.size),'rail',block.center);
  mount(box(block.size[0]*.8,.22,block.size[2]*.74),'dark',[block.center[0],.12,block.center[2]]);
  for(const x of [-.13,-.065,0,.065,.13]) {
    mount(box(.027,.004,.14),'guide',[block.center[0]+x,block.center[1]+block.size[1]/2+.002,block.center[2]]);
  }
}

function buildArm() {
  linkNodes=radii.map((r,i)=>{
    const n=engine.createMesh();
    const span=Math.hypot(...subtract(startPose[i+1],startPose[i]));
    mount(barrel(span*.88,r*.76,r*.50,.018),'body',[0,0,0],n);
    mount(barrel(span*.22,r*.81,r*.77,.011),'dark',[0,-span*.27,0],n);
    mount(barrel(span*.14,r*.59,r*.54,.010),'brass',[0,span*.23,0],n);
    mount(barrel(span*.16,r*.52,r*.45,.011),'cap',[0,span*.38,0],n);
    return n;
  });
  wristNodes=jointRadii.map((r,i)=>mount(sphere(r*.94),i%2?'cap':'dark'));
  target=engine.createMesh();
  mount(sphere(.026),'target',[0,0,0],target);
  mount(box(.14,.008,.008),'target',[0,0,0],target);
  mount(box(.008,.14,.008),'target',[0,0,0],target);
  mount(box(.008,.008,.14),'target',[0,0,0],target);
}

function updateArm(joints) {
  for(const [i,n] of linkNodes.entries()){
    const u=norm(subtract(joints[i+1],joints[i]));
    const axis=[u[2],0,-u[0],1+u[1]];
    const q=Math.hypot(...axis);
    n.setPosition(scale(sum(joints[i],joints[i+1]),.5));
    n.setQuaternion(q>1e-7?axis.map(v=>v/q):[1,0,0,0]);
  }
  wristNodes.forEach((node,index)=>node.setPosition(joints[index]));
  target.setPosition(desired);
}

function updateHud(mm,remaining,near,description) {
  const g=Math.floor(mm*1000),m=Math.round(remaining*1000),key=[g,m,near,description].join('/');
  if(lastValues===key)return;
  lastValues=key;
  byId('gap').value=g+' mm';
  byId('nearest').value=near;
  byId('miss').value=m+' mm';
  byId('motion').textContent=description;
  document.body.dataset.clearance=mm.toFixed(6);
  document.body.dataset.distance=remaining.toFixed(5);
  document.body.dataset.mode=description;
}

function chooseTarget(p,index=-1){
  desired=[...p];
  range.value=String(Math.round(p[2]*100));
  byId('depth-reading').value=range.value+' cm';
  for(const [i,button] of buttons.entries())button.setAttribute('aria-pressed',String(i===index));
  pendingStart=true;
}

function resize(){
  const pixel=Math.min(1.65,devicePixelRatio||1);
  const width=Math.max(1,Math.round(canvas.clientWidth*pixel));
  const height=Math.max(1,Math.round(canvas.clientHeight*pixel));
  if(canvas.width!==width)canvas.width=width;
  if(canvas.height!==height)canvas.height=height;
}
function moveTarget(x,y) {
  const r=canvas.getBoundingClientRect();
  const f=cameraScale;
  const nx=(2*(x-r.left)/r.width-1)*f*r.width/r.height;
  const ny=(1-2*(y-r.top)/r.height)*f;
  const ray=sum(forward,sum(scale(right,nx),scale(up,ny)));
  const depth=Number(range.value)/100;
  const t=(depth-eye[2])/ray[2];
  if(!(t>0))return;
  const point=sum(eye,scale(ray,t));
  chooseTarget([Math.max(-1.1,Math.min(1.1,point[0])),Math.max(.33,Math.min(1.76,point[1])),depth]);
}

function connect(){
  panel.addEventListener('click',event=>{
    const button=event.target.closest('[data-position]');
    if(button){const i=Number(button.dataset.position);chooseTarget(presets[i],i);}
  },{signal});
  range.addEventListener('input',()=>chooseTarget([desired[0],desired[1],Number(range.value)/100]),{signal});
  reset.addEventListener('click',()=>{
    earlier=pose=startPose;
    chooseTarget(startPose.at(-1));
    state=report(pose,desired,'Ready to reach');
  },{signal});
  canvas.addEventListener('pointerdown',event=>{
    if(pointer!==undefined)return;
    pointer=event.pointerId;
    canvas.setPointerCapture(pointer);
    moveTarget(event.clientX,event.clientY);
  },{signal});
  canvas.addEventListener('pointermove',event=>{if(pointer===event.pointerId)moveTarget(event.clientX,event.clientY);},{signal});
  canvas.addEventListener('lostpointercapture',()=>{pointer=undefined;},{signal});
}

function projectTarget() {
  const {clientWidth:width,clientHeight:height}=canvas;
  const offset=subtract(desired,eye);
  const length=dot(offset,forward);
  const x=width*.5+dot(offset,right)*height/(2*length*cameraScale);
  const y=height*.5-dot(offset,up)*height/(2*length*cameraScale);
  reticle.hidden=!(length>0&&x>12&&y>12&&x<width-12&&y<height-12);
  if(!reticle.hidden)reticle.style.transform='translate('+x.toFixed(1)+'px,'+y.toFixed(1)+'px)';
}

function render(now) {
  const delta=last===undefined?0:Math.min(.065,Math.max(0,(now-last)/1000));
  last=now;
  accumulator+=delta;
  while(accumulator>=fixed){
    earlier=pose;
    state=stepReach(pose,desired,fixed);
    pose=state.pose;
    accumulator-=fixed;
  }
  const shown=between(earlier,pose,accumulator/fixed);
  updateArm(shown);
  const live=report(shown,desired,state.status);
  updateHud(live.gap,live.miss,live.near,state.status);
  resize();
  projectTarget();
  engine.render({delta});
  const tip=shown.at(-1).map(x=>x.toFixed(4)).join(',');
  if(pendingStart&&tip!==lastTip){
    pendingStart=false;
    performance.mark('reach-target-applied');
  }
  lastTip=tip;
  document.body.dataset.tip=tip;
}
function tick(now){
  if(signal.aborted)return;
  try{render(now);frame=requestAnimationFrame(tick);}catch(ex){fail(ex);}
}
async function compatibility(){
  const {install}=await import('@margoengine/webgl2-compat');
  return {install:()=>install({force:true,signal})};
}
function setup(active){
  if(!active.gpu)throw Error('The reach bench needs WebGPU or WebGL2.');
  engine=active;
  engine.onError=fail;
  engine.scene.background='#142b33';
  engine.lighting.direction.set([-.67,.85,.44,3]);
  engine.lighting.radiance.set([1,.88,.70,.58]);
  engine.lighting.ambient.set([.81,.96,1.14]);
  engine.camera.position=eye;
  engine.camera.target=focus;
  materials=Object.fromEntries(Object.entries(colors).map(([name,[color,roughness,metalness]])=>[name,new PbrMaterial({color,roughness,metalness})]));
  tables();
  buildArm();
}
async function run(){
  applyQualityTier();
  const options={signal,exactSize:true,antialias:true,startupTimeout:4200,camera:{near:.045,far:42,fov:35}};
  if(forced||!navigator.gpu) {
    await (await compatibility()).install();
    await autoEngine(canvas,setup,{...options,backend:'webgpu'});
  } else await autoEngine(canvas,setup,{...options,loadCompat:compatibility});
  render(performance.now());
  await engine.gpu.queue.onSubmittedWorkDone();
  signal.throwIfAborted();
  connect();
  panel.disabled=range.disabled=reset.disabled=false;
  loading.hidden=true;
  status.ready();
  document.body.dataset.minimum=minClearance;
  document.body.dataset.renderer=engine.gpu.adapterInfo?.vendor==='margo-webgl2'?'webgl2':'webgpu';
  performance.mark('margo-first-usable-frame');
  frame=requestAnimationFrame(tick);
}
function dispose(){
  controller.abort();
  cancelAnimationFrame(frame);
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
run().catch(fail);
