import {autoEngine} from '@margoengine/webgl2-compat/auto';
import {applyQualityTier} from '@margoengine/quality';
import {demoStatus} from 'margo-demo-status';
import record from './assets/record.json';
import specs from './assets/intervals.json';
import {extent,horizontal,at,position,installTerrain} from './terrain.js';

const paths=import.meta.glob('./assets/*.{dat,paths}',{query:'?url',import:'default',eager:true});
const id=name=>document.getElementById(name);
const canvas=id('view'),overlay=id('labels'),tools=id('tools'),status=id('status');
const lines=id('show-lines'),labels=id('show-labels');
const buttons=[...tools.querySelectorAll('[data-interval]')];
const state=document.body.dataset,message=demoStatus(document.body,status,id('error'));
const lifetime=new AbortController(),{signal}=lifetime;
const forced=new URLSearchParams(location.search).get('backend')==='webgl2',n=record.resolution;
const packets=new Map();
const compressed=async filename=>{
  const response=await fetch(paths['./assets/'+filename],{signal});
  if(!response.ok)throw Error('The elevation file could not be opened.');
  return new DataView(await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
};
const opening=compressed('dem-helens.dat').then(raw=>{
  if(raw.byteLength!==n*n*2)throw Error('The elevation grid has an unexpected size.');
  return Float32Array.from({length:n*n},(_,i)=>raw.getUint16(i*2,true)/4);
});
opening.catch(()=>{});
function contours(interval){
  let entry=packets.get(interval);
  if(!entry){
    entry=compressed(specs[interval].key).then(buffer=>{
      const count=buffer.getUint16(0,true), source=[];
      if(count!==specs[interval].lines)throw Error('The elevation contours are incomplete.');
      let offset=2;
      for(let i=0;i<count;i++){
        const level=buffer.getUint16(offset,true), size=buffer.getUint16(offset+2,true);
        const closed=buffer.getUint8(offset+4)>0;
        offset+=5;
        const points=[];
        for(let j=0;j<size;j++,offset+=4)points.push([buffer.getUint16(offset,true)/4,buffer.getUint16(offset+2,true)/4]);
        source.push({level,points,closed});
      }
      if(offset!==buffer.byteLength)throw Error('The contour packet is invalid.');
      return source;
    });
    packets.set(interval,entry);
    entry.catch(()=>{if(packets.get(interval)===entry)packets.delete(interval);});
  }
  return entry;
}
const initial=contours(200);
initial.then(()=>{contours(100).catch(()=>{});contours(400).catch(()=>{});},()=>{});
let engine,terrain,values,pathsForView,resize,frame,drag,probe,version=0,interval=200,mode='map';
let azimuth=.62,pitch=.69;
const grouped=new Intl.NumberFormat(undefined,{maximumFractionDigits:0});

function size(){
  const density=Math.min(1.65,devicePixelRatio||1);
  const w=Math.max(1,Math.round(canvas.clientWidth*density)),h=Math.max(1,Math.round(canvas.clientHeight*density));
  if(canvas.width!==w)canvas.width=w;
  if(canvas.height!==h)canvas.height=h;
  if(overlay.width!==w)overlay.width=w;
  if(overlay.height!==h)overlay.height=h;
  return {w,h,density};
}
function setupCamera(w,h){
  const camera=engine.camera;
  if(mode==='map'){
    camera.position=[0,10,0];
    camera.target=[0,0,0];
    camera.up=[0,0,-1];
    const scale=1.84/Math.max(horizontal,.001), aspect=w/h;
    camera.project=(mat,_aspect,webgpu)=>{
      const end=1/(camera.far-camera.near);
      mat.fill(0);
      mat[0]=scale/Math.max(1,aspect);
      mat[5]=scale*Math.min(1,aspect);
      mat[10]=webgpu?end:-2*end;
      mat[14]=webgpu?camera.far*end:-(camera.far+camera.near)*end;
      mat[15]=1;
    };
  }else{
    const reach=w/h<1.12?8.88:8.42;
    const ground=reach*Math.cos(pitch);
    camera.position=[Math.sin(azimuth)*ground,.42+Math.sin(pitch)*reach,Math.cos(azimuth)*ground];
    camera.target=[0,.09,0];
    camera.up=[0,1,0];
    camera.project=undefined;
  }
  state.camera=camera.position.map(n=>n.toFixed(4)).join(',');
}
function coords(x,y,height,w,h){
  const p=position(x,y,height),m=engine.camera.matrix;
  const c=Array.from({length:4},(_,i)=>m[i]*p[0]+m[4+i]*p[1]+m[8+i]*p[2]+m[12+i]);
  return [(1+c[0]/c[3])*w/2,(1-c[1]/c[3])*h/2];
}
function modelLabels(viewSize){
  const {w,h,density:d}=viewSize;
  const ctx=overlay.getContext('2d');
  ctx.clearRect(0,0,w,h);
  const px=(x,y,z)=>coords(x,y,z,w,h);
  const font=Math.max(11*d,Math.min(w,h)/45);
  ctx.font='660 '+font+'px ui-monospace, monospace';
  ctx.textAlign='center';
  ctx.textBaseline='middle';
  function textLabel(x,y,label){
    ctx.lineWidth=3.8*d;
    ctx.strokeStyle='#2b443a';
    ctx.strokeText(label,x,y);
    ctx.fillStyle='#f3e7bc';
    ctx.fillText(label,x,y);
  }
  if(mode==='map'){
    if(lines.checked){
      ctx.strokeStyle='rgba(28,55,45,.53)';ctx.lineWidth=.72*d;ctx.lineJoin='round';
      ctx.beginPath();
      for(const line of pathsForView){
        if(line.points.length<3)continue;
        line.points.forEach(([x,y],i)=>{
          const [a,b]=px(x,y,line.level);
          if(i===0)ctx.moveTo(a,b);else ctx.lineTo(a,b);
        });
      }
      ctx.stroke();
    }
    ctx.strokeStyle='#ebddb4';ctx.fillStyle='#ebddb4';ctx.lineWidth=1.2*d;
    const nx=w-24*d,ny=32*d;
    textLabel(nx,ny-12*d,'N');
    ctx.strokeStyle='#ebddb4';ctx.lineWidth=1.2*d;
    ctx.beginPath();ctx.moveTo(nx,ny);ctx.lineTo(nx,ny+20*d);ctx.moveTo(nx-4*d,ny+6*d);ctx.lineTo(nx,ny);ctx.lineTo(nx+4*d,ny+6*d);ctx.stroke();
    const left=px(0,0,500)[0],scale=px(2000,0,500)[0]-left,x=left+12*d,y=h-20*d;
    ctx.beginPath();ctx.moveTo(x,y-4*d);ctx.lineTo(x,y);ctx.lineTo(x+scale,y);ctx.lineTo(x+scale,y-4*d);ctx.stroke();
    textLabel(x+scale/2,y-10*d,'2 km');
  }
  if(labels.checked){
    const used=[];
    const labels=pathsForView.filter(l=>l.points.length>61).sort((a,b)=>b.points.length-a.points.length);
    for(const line of labels){
      if(used.length>=8||used.some(entry=>entry.level===line.level))continue;
      for(const s of [.28,.48,.68,.83]){
        const [x,y]=line.points[Math.floor((line.points.length-1)*s)];
        const [a,b]=px(x,y,line.level+.6);
        if(a<30*d||a>w-30*d||b<20*d||b>h-27*d||
          used.some(p=>Math.hypot(p.x-a,p.y-b)<49*d))continue;
        used.push({x:a,y:b,level:line.level});
        textLabel(a,b,grouped.format(line.level));
        break;
      }
    }
  }
  if(probe){
    const [x,y]=px(probe.x,probe.y,probe.value);
    ctx.lineWidth=1.2*d;ctx.strokeStyle='#fff0c7';
    ctx.beginPath();ctx.moveTo(x-8*d,y);ctx.lineTo(x+8*d,y);ctx.moveTo(x,y-8*d);ctx.lineTo(x,y+8*d);
    ctx.moveTo(x+5*d,y);ctx.arc(x,y,5*d,0,Math.PI*2);ctx.stroke();
  }
}
function paint(){
  const measure=size();
  setupCamera(measure.w,measure.h);
  terrain.style(interval,mode==='relief'&&lines.checked);
  engine.render({delta:0});
  modelLabels(measure);
}
function schedule(){
  if(frame||signal.aborted)return;
  frame=requestAnimationFrame(()=>{
    frame=undefined;
    try{paint();}catch(error){fail(error);}
  });
}
function currentView(){
  const meta=specs[interval];
  id('path-count').value=String(meta.lines);
  id('band-count').value=String(meta.bands);
  state.interval=String(interval);
  state.contours=String(meta.lines);
  state.bands=String(meta.bands);
  state.mode=mode;
  state.labels=String(labels.checked);
  state.lines=String(lines.checked);
  canvas.dataset.view=mode;
  id('mode-label').textContent=mode==='map'?'Topographic map':'Oblique relief';
  for(const button of buttons)button.setAttribute('aria-pressed',String(Number(button.dataset.interval)===interval));
  for(const button of [id('map'),id('relief')])button.setAttribute('aria-pressed',String(button.id===mode));
}
async function change(target){
  const request=++version;
  if(target===interval){id('message').textContent='';return;}
  id('message').textContent='Loading '+target+' m contours…';
  try{
    const next=await contours(target);
    if(request!==version||signal.aborted)return;
    interval=target;
    pathsForView=next;
    id('message').textContent='';
    currentView();
    paint();
    await engine.gpu.queue.onSubmittedWorkDone();
    if(signal.aborted||request!==version)return;
    state.revision=String(request);
    if(!performance.getEntriesByName('contour-interval-applied').length)performance.mark('contour-interval-applied');
  }catch(error){
    if(!signal.aborted&&request===version)id('message').textContent=error.message;
  }
}
function locate(event){
  const rect=canvas.getBoundingClientRect(),aspect=rect.width/rect.height;
  const x=(event.clientX-rect.x)/rect.width*2-1, y=(event.clientY-rect.y)/rect.height*2-1;
  const u=.5+x*Math.max(1,aspect)/1.84, v=.5+y/Math.min(1,aspect)/1.84;
  if(Math.min(u,v)<0||Math.max(u,v)>1)return;
  const value=at(values,n,u*extent,v*extent);
  probe={x:u*extent,y:v*extent,value};
  id('probe').value=grouped.format(value)+' m';
  state.probe=value.toFixed(3);
  state.probeX=probe.x.toFixed(3);
  state.probeY=probe.y.toFixed(3);
  schedule();
}
function connect(){
  for(const button of buttons)button.addEventListener('click',()=>change(+button.dataset.interval),{signal});
  for(const option of ['map','relief'])id(option).addEventListener('click',()=>{
    mode=option;
    currentView();
    schedule();
  },{signal});
  for(const option of [labels,lines])option.addEventListener('input',()=>{currentView();schedule();},{signal});
  canvas.addEventListener('pointerdown',event=>{
    if(mode==='map')return;
    if(!drag)drag={id:event.pointerId,x:event.clientX,y:event.clientY,azimuth,pitch};
    canvas.setPointerCapture(event.pointerId);
  },{signal});
  canvas.addEventListener('pointermove',event=>{
    if(drag?.id!==event.pointerId)return;
    azimuth=drag.azimuth-(event.clientX-drag.x)*.008;
    pitch=Math.max(.44,Math.min(1.44,drag.pitch+(event.clientY-drag.y)*.008));
    schedule();
  },{signal});
  canvas.addEventListener('click',event=>{if(mode==='map')locate(event);},{signal});
  for(const type of ['pointerup','pointercancel','lostpointercapture'])canvas.addEventListener(type,event=>{
    if(drag?.id===event.pointerId)drag=undefined;
  },{signal});
  resize=new ResizeObserver(schedule);resize.observe(canvas);
}
async function compatibility(){
  const {install}=await import('@margoengine/webgl2-compat');
  return {install:()=>install({force:true,signal})};
}
async function start(){
  applyQualityTier();
  const known=forced||!navigator.gpu;
  if(known)await (await compatibility()).install();
  await autoEngine(canvas,async target=>{
    if(!target.gpu)throw Error('The contour exhibit needs WebGPU or WebGL2.');
    engine=target;
    engine.onError=fail;
    engine.scene.background='#2c443a';
    [values,pathsForView]=await Promise.all([opening,initial]);
    terrain=installTerrain(engine,values,n);
    currentView();
    paint();
    await engine.gpu.queue.onSubmittedWorkDone();
  },{signal,backend:known?'webgpu':undefined,loadCompat:compatibility,exactSize:true,antialias:false,
    startupTimeout:4900,camera:{near:.05,far:40,fov:44}});
  signal.throwIfAborted();
  tools.disabled=false;
  state.renderer=engine.gpu.adapterInfo?.vendor==='margo-webgl2'?'webgl2':'webgpu';
  status.hidden=true;
  connect();
  message.ready();
  performance.mark('margo-first-usable-frame');
}
function dispose(){
  lifetime.abort();cancelAnimationFrame(frame);resize?.disconnect();
  terrain?.dispose();engine?.dispose();
}
function fail(error){
  if(signal.aborted)return;
  message.error(error);console.error(error);
  status.hidden=true;id('error').hidden=false;dispose();
}
addEventListener('pagehide',event=>{if(!event.persisted)dispose();});
start().catch(fail);
