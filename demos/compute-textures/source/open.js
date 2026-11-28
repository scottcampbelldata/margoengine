import {recipes,size} from './model.js';
const canvas=document.querySelector('#plate'),controls=document.querySelector('#controls');
const state=document.body.dataset,life=new AbortController(),{signal}=life;
const params=new URLSearchParams(location.search);
const selectNative=!!navigator.gpu&&params.get('backend')!=='webgl2';
const buttons=[...controls.querySelectorAll('[data-recipe]')];
const toggle=document.querySelector('#toggle'),step=document.querySelector('#step'),restart=document.querySelector('#restart');
const feed=document.querySelector('#feed'),kill=document.querySelector('#kill'),counter=document.querySelector('#steps');
let installed,selected='labyrinth',written='labyrinth',iterations=0,brush=[0,0,false],brushPulse=false;
let raf=0,active=false,requested=0,reseed=false,remaining=0,userControl=false;
let playing=!matchMedia('(prefers-reduced-motion: reduce)').matches;

function fit(){
  const scale=Math.min(2,devicePixelRatio),width=Math.round(canvas.clientWidth*scale),height=Math.round(canvas.clientHeight*scale);
  if(canvas.width!==width)canvas.width=width;
  if(canvas.height!==height)canvas.height=height;
}
function labels(){
  state.recipe=written;state.iterations=String(iterations);state.playing=String(playing);
  feed.textContent=recipes[written].feed.toFixed(3);kill.textContent=recipes[written].kill.toFixed(3);
  counter.textContent=iterations.toLocaleString('en-US');
  toggle.textContent=playing?'Pause':'Play';toggle.setAttribute('aria-pressed',String(playing));
  for(const button of buttons)button.setAttribute('aria-pressed',String(button.dataset.recipe===written));
}
function fail(error){
  if(signal.aborted)return;
  delete state.ready;state.error=error.message;
  controls.disabled=true;
  document.querySelector('#loading').hidden=true;
  const notice=document.querySelector('#error');
  notice.hidden=false;notice.textContent=error.message;
  console.error(error);
}
function schedule(){
  if(active||raf||signal.aborted||state.error||document.hidden)return;
  raf=requestAnimationFrame(draw);
}
async function draw(){
  raf=0;active=true;
  try{
    fit();
    if(reseed){
      written=selected;installed.install(written);iterations=0;reseed=false;
    }
    const input=userControl;userControl=false;
    const ticks=Math.min(128,requested+remaining+(playing&&!requested&&!remaining?3:0));
    requested=0;remaining=Math.max(0,remaining-ticks);
    installed.brush(...brush);
    if(brushPulse){brushPulse=false;brush[2]=false;}
    await installed.draw(ticks);
    if(signal.aborted)return;
    iterations+=ticks;labels();
    if(input&&!performance.getEntriesByName('reaction-control-applied').length)
      performance.mark('reaction-control-applied');
  }catch(error){fail(error);}
  finally{active=false;}
  if(reseed||requested||remaining||playing||brush[2]||userControl)schedule();
}
function recipe(name){
  selected=name;reseed=true;remaining=128;requested=0;userControl=true;schedule();
}
function seed(x,y,pulse){
  brush=[x,y,true];brushPulse=pulse;
  requested=Math.max(requested,3);schedule();
}
function coords(event){
  const bounds=canvas.getBoundingClientRect(),ratio=bounds.width/bounds.height;
  const x=(2*(event.clientX-bounds.x)/bounds.width-1)*Math.max(ratio,1);
  const y=(1-2*(event.clientY-bounds.y)/bounds.height)*Math.max(1/ratio,1);
  const px=x/(.965+.045*y),py=y*1.090;
  if(Math.max(Math.abs(px),Math.abs(py))>.835)return;
  seed(px/1.67+.5,-py/1.67+.5,event.type==='pointerdown');
}
async function open(){
  const initial=selectNative?await import('./native.js'):await import('./direct.js');
  if(selectNative){
    try{installed=await initial.attachNative(canvas,signal);}
    catch(error){
      if(error.code!=='unsupported')throw error;
      installed=await (await import('./direct.js')).attachDirect(canvas,signal);
    }
  }else installed=await initial.attachDirect(canvas,signal);
  performance.mark('reaction-device');
  fit();installed.install(selected);
  await installed.draw(180);
  iterations=180;
  state.renderer=installed.backend;state.grid=String(size);
  labels();
  const options={signal};
  for(const button of buttons)button.addEventListener('click',()=>recipe(button.dataset.recipe),options);
  restart.addEventListener('click',()=>recipe(selected),options);
  toggle.addEventListener('click',()=>{playing=!playing;labels();schedule();},options);
  step.addEventListener('click',()=>{playing=false;requested+=1;schedule();},options);
  canvas.addEventListener('pointerdown',event=>{canvas.setPointerCapture(event.pointerId);coords(event);},options);
  canvas.addEventListener('pointermove',event=>{if(canvas.hasPointerCapture(event.pointerId))coords(event);},options);
  for(const name of ['pointerup','pointercancel','lostpointercapture'])canvas.addEventListener(name,()=>{
    if(!brushPulse)brush[2]=false;
  },options);
  canvas.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();seed(.5,.5,true);}},options);
  const observer=new ResizeObserver(()=>{
    if(canvas.width!==Math.round(canvas.clientWidth*Math.min(2,devicePixelRatio))||
       canvas.height!==Math.round(canvas.clientHeight*Math.min(2,devicePixelRatio)))schedule();
  });
  observer.observe(canvas);
  signal.addEventListener('abort',()=>observer.disconnect(),{once:true});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)schedule();},options);
  controls.disabled=false;document.querySelector('#loading').hidden=true;
  state.ready='true';performance.mark('margo-first-usable-frame');
  if(playing)setTimeout(schedule,300);
}
open().catch(fail);
addEventListener('pagehide',event=>{
  if(event.persisted)return;
  life.abort();cancelAnimationFrame(raf);installed?.dispose();
});
