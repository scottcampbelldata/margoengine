import {startEngine} from '@margoengine/webgl2-compat/auto';
import {applyQualityTier} from '@margoengine/quality';
import {Figure} from '@margoengine/sciviz';
import {flowInk} from '@margoengine/sciviz/flow-ink';
import {lic} from '@margoengine/sciviz/lic';
import {demoStatus} from 'margo-demo-status';
import {bounds,defaultSeed,dims,duration,maxSpeed,snapshot,stops} from './flow-field.js';

const id=name=>document.getElementById(name);
const canvas=id('view'),overlay=id('overlay'),tools=id('tools'),play=id('play'),timeline=id('time');
const texture=id('texture'),streak=id('streak'),path=id('path'),status=id('status');
const report=demoStatus(document.body,status,id('error')), state=document.body.dataset;
const lifetime=new AbortController(),{signal}=lifetime;
const forced=new URLSearchParams(location.search).get('backend')==='webgl2';
const runner=new Worker(new URL('./flow-worker.js',import.meta.url),{type:'module'});
const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
let engine,figure,layer,pathInk,streakInk,resize,raf,clockAt=0,clockBase=0;
let running=false,observation=0,nextId=0,busy=false,started=false;
let seed=defaultSeed.slice(),samples=[],pathPoints=[],pathHead=null;

function layout(){
  const scale=Math.min(1.65,devicePixelRatio||1);
  const w=Math.max(1,Math.round(canvas.clientWidth*scale)),h=Math.max(1,Math.round(canvas.clientHeight*scale));
  if(canvas.width!==w)canvas.width=w;
  if(canvas.height!==h)canvas.height=h;
  if(overlay.width!==w)overlay.width=w;
  if(overlay.height!==h)overlay.height=h;
  return {w,h,scale};
}
function markers(){
  const {w,h,scale}=layout(), ctx=overlay.getContext('2d');
  const from=([x,y])=>[(x-bounds[0])/(bounds[1]-bounds[0])*w,(bounds[3]-y)/(bounds[3]-bounds[2])*h];
  const [sx,sy]=from(seed);
  ctx.clearRect(0,0,w,h);
  ctx.globalAlpha=.37;
  ctx.strokeStyle='#d1ded4';
  ctx.lineWidth=scale;
  ctx.beginPath();
  for(let i=1;i<12;i++){
    const x=w*i/12;
    ctx.moveTo(x,0);ctx.lineTo(x,5*scale);ctx.moveTo(x,h);ctx.lineTo(x,h-5*scale);
  }
  for(let i=1;i<8;i++){
    const y=h*i/8;
    ctx.moveTo(0,y);ctx.lineTo(5*scale,y);ctx.moveTo(w,y);ctx.lineTo(w-5*scale,y);
  }
  ctx.stroke();
  if(streak.checked){
    for(let i=0;i<samples.length;i+=2){
      const [x,y]=from(samples[i]);
      ctx.globalAlpha=.38+.55*(i+1)/samples.length;
      ctx.fillStyle='#fff0c7';
      ctx.beginPath();ctx.arc(x,y,scale*(1.1+.83*(i+1)/samples.length),0,Math.PI*2);ctx.fill();
    }
  }
  if(path.checked&&pathHead){
    const [x,y]=from(pathHead);
    ctx.globalAlpha=1;ctx.fillStyle='#b5fff0';
    ctx.beginPath();ctx.arc(x,y,2.7*scale,0,Math.PI*2);ctx.fill();
  }
  ctx.globalAlpha=1;
  ctx.fillStyle='#fcce96';ctx.strokeStyle='#fcce96';ctx.lineWidth=1.4*scale;
  ctx.beginPath();
  ctx.moveTo(sx-11*scale,sy);ctx.lineTo(sx+11*scale,sy);
  ctx.moveTo(sx,sy-11*scale);ctx.lineTo(sx,sy+11*scale);
  ctx.stroke();
  ctx.beginPath();ctx.arc(sx,sy,5.6*scale,0,2*Math.PI);ctx.stroke();
}
function render(){
  layer.visible=texture.checked;
  streakInk.set(streak.checked&&samples.length>1?[{positions:samples.flatMap(([x,y])=>[x,y,0])}]:[]);
  pathInk.set(path.checked&&pathPoints.length>1?[{positions:pathPoints.flatMap(([x,y])=>[x,y,0])}]:[]);
  markers();
  figure.render();
}
function setRun(value){
  running=value;
  play.textContent=value?'Pause':observation>0&&observation<duration?'Resume dye':observation>=duration?'Replay dye':'Release dye';
  play.setAttribute('aria-pressed',String(value));
  state.playing=String(value);
  if(!value){
    cancelAnimationFrame(raf);
    raf=undefined;
  }
}
function showTime(value){
  observation=value;
  id('clock').value=value.toFixed(1)+' s';
  timeline.value=String(Math.round(value*10));
  state.time=value.toFixed(3);
  id('source').value=seed.slice(0,2).map(n=>n.toFixed(2)).join(', ')+' m';
  state.source=seed.slice(0,2).map(n=>n.toFixed(3)).join(',');
  state.parcels=String(samples.length);
  id('parcels').value=String(samples.length);
}
function submit(time){
  if(time<=0){
    nextId++;
    busy=false;
    runner.postMessage({kind:'cancel'});
    samples=[];
    pathPoints=[];
    pathHead=null;
    showTime(0);
    render();
    return;
  }
  busy=true;
  runner.postMessage({id:++nextId,seed,time});
}
function playingAt(from){
  clockAt=performance.now();
  clockBase=from;
  setRun(true);
  submit(from);
  schedule();
}
function schedule(){
  if(!raf&&running)raf=requestAnimationFrame(tick);
}
function tick(now){
  raf=undefined;
  if(!running||signal.aborted)return;
  const desired=Math.min(duration,clockBase+(now-clockAt)/1000);
  if(!busy&&desired>=observation+.075)submit(desired);
  else if(!busy&&desired===duration&&observation<duration)submit(duration);
  schedule();
}
function parseStreak(values){
  const points=[];
  for(let i=values.length-4;i>=0;i-=4){
    const x=values[i],y=values[i+1];
    if(!Number.isFinite(x+y))break;
    points.push([x,y]);
  }
  return points.reverse();
}
function parsePath(values,time){
  const points=[];
  for(let i=0;i<values.length;i+=4){
    if(values[i+3]<=time)points.push([values[i],values[i+1]]);
    else {
      const a=values[i-1],b=values[i+3],s=(time-a)/(b-a);
      points.push([values[i-4]+(values[i]-values[i-4])*s,values[i-3]+(values[i+1]-values[i-3])*s]);
      break;
    }
  }
  return points;
}
async function actual(event){
  const data=event.data;
  if(data.id!==nextId||signal.aborted)return;
  if(data.error)throw new Error(data.error);
  const dye=parseStreak(data.streak);
  const first=parsePath(data.path,data.time);
  samples=dye;
  pathPoints=first;
  pathHead=first.length>1?first.at(-1):null;
  showTime(data.time);
  state.pathPoints=String(first.length);
  state.traceSignature=dye.slice(0,8).map(p=>p.map(n=>n.toFixed(4)).join(',')).join('|');
  render();
  await figure.ready();
  if(data.id!==nextId||signal.aborted)return;
  state.revision=String(data.id);
  if(started&&dye.length>=2&&!performance.getEntriesByName('flow-dye-applied').length)performance.mark('flow-dye-applied');
  busy=false;
  if(data.time>=duration)setRun(false);
}
function connect(){
  runner.addEventListener('message',event=>actual(event).catch(fail),{signal});
  runner.addEventListener('error',event=>fail(new Error(event.message)),{signal});
  play.addEventListener('click',()=>{
    if(running){setRun(false);return;}
    started=true;
    playingAt(observation>0&&observation<duration?observation:.68);
  },{signal});
  id('reset').addEventListener('click',()=>{
    setRun(false);
    seed=defaultSeed.slice();
    submit(0);
    setRun(false);
  },{signal});
  timeline.addEventListener('input',()=>{
    setRun(false);
    submit(+timeline.value/10);
  },{signal});
  for(const check of [texture,streak,path])check.addEventListener('input',()=>{
    state.layers=[texture,streak,path].map(box=>box.checked?'1':'0').join('');
    render();
  },{signal});
  canvas.addEventListener('click',event=>{
    const r=canvas.getBoundingClientRect();
    const x=clamp((event.clientX-r.x)/r.width,.045,.955),y=clamp((event.clientY-r.y)/r.height,.045,.955);
    seed=[bounds[0]+x*(bounds[1]-bounds[0]),bounds[3]-y*(bounds[3]-bounds[2]),0];
    started=true;
    playingAt(.68);
  },{signal});
  resize=new ResizeObserver(()=>render());
  resize.observe(canvas);
}
async function setup(){
  engine.onError=fail;
  layout();
  engine.camera.position=[0,3,0];
  engine.camera.target=[0,0,0];
  engine.camera.up=[0,0,-1];
  engine.camera.project=(matrix,_aspect,webgpu)=>{
    const {near,far}=engine.camera;
    const r=1/(far-near);
    matrix.fill(0);
    matrix[0]=matrix[5]=matrix[15]=1;
    matrix[10]=webgpu?r:-2*r;
    matrix[14]=webgpu?far*r:-(far+near)*r;
  };
  figure=new Figure(engine,{limits:bounds,axes:false,tooltips:false,legend:false,
    theme:{background:'#193344',axis:'#92b1ba',grid:'#305460',text:'#e0e8da'}});
  const field=snapshot(0);
  layer=await lic(figure,{bounds,dims,u:field.u,v:field.v},{
    resolution:[360,216],steps:21,step:.61,seed:1445,contrast:4.45,
    colormap:stops,range:[0,maxSpeed],signal,
  });
  pathInk=await flowInk(figure,{color:'#a6f5e3',width:1.65,onTop:true,signal});
  streakInk=await flowInk(figure,{color:'#f5b870',width:2.5,onTop:true,signal});
  state.layers='111';
  state.textureDetail='full';
  showTime(0);
  render();
  await figure.ready();
}
async function start(){
  applyQualityTier();
  ({engine}=await startEngine(canvas,{loadCompat:()=>import('@margoengine/webgl2-compat'),forceCompat:forced,
    signal,exactSize:true,antialias:false,startupTimeout:6500}).then(started=>{
    state.renderer=started.renderer==='compatibility'?'webgl2':'webgpu';
    return started;
  }));
  signal.throwIfAborted();
  await setup();
  signal.throwIfAborted();
  tools.disabled=false;
  status.hidden=true;
  setRun(false);
  connect();
  report.ready();
  performance.mark('margo-first-usable-frame');
}
function dispose(){
  lifetime.abort();
  cancelAnimationFrame(raf);
  resize?.disconnect();
  runner.terminate();
  pathInk?.dispose();
  streakInk?.dispose();
  figure?.dispose();
  engine?.dispose();
}
function fail(error){
  if(signal.aborted)return;
  report.error(error);
  console.error(error);
  status.hidden=true;
  id('error').hidden=false;
  dispose();
}
addEventListener('pagehide',event=>{if(!event.persisted)dispose();});
start().catch(fail);
