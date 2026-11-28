import {Lines,Line} from '@margoengine/lines';
import {describeSeries,sonificationPlan} from '@margoengine/sciviz/a11y';
import {autoEngine} from '@margoengine/webgl2-compat/auto';
import tide from './tide.json';

const id=name=>document.getElementById(name);
const plate=document.querySelector('.plate'), axes=id('axes'),cursor=id('cursor');
const hour=id('hour'),day=id('day'),play=id('play'),volume=id('volume'),audioStatus=id('audio-status');
const state=document.body.dataset,inputMeasure=id('reading'),spoken=id('spoken');
const colors={water:'#88dfcc',zero:'#696c53',grid:'#34545d',background:'#14262d'};
const yRange=[-.75,2.50],pitch=[162,715],duration=5.28;
const abort=new AbortController(),{signal}=abort;
const date=new Intl.DateTimeFormat('en-US',{month:'long',day:'numeric',timeZone:'UTC'});
const decimal=new Intl.NumberFormat('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
const guideX=[0,4,8,12,16,20,23],guideY=[-.5,0,.5,1,1.5,2,2.5];
const fullHour=index=>String(index).padStart(2,'0')+':00 UTC';
const meters=value=>decimal.format(value)+' m';
const expandMeters=value=>decimal.format(value)+' meters';
const firstDate=tide.first;
let engine,waterLine,gridLine,zeroLine,viewport,resize,drawFrame;
let selected=12,data=[],audio,level,playing,sequence=0;
const notice = id('summary');

function addLabel(type,count){
  return Array.from({length:count},()=>{
    const element=document.createElement('span');
    element.className=type;axes.append(element);return element;
  });
}
const horizontal=addLabel('x',guideX.length),vertical=addLabel('y',guideY.length);
function showHour(index,announce){
  selected=Math.max(0,Math.min(23,index));
  const v=data[selected], text=fullHour(selected);
  if(hour.valueAsNumber!==selected)hour.value=String(selected);
  hour.setAttribute('aria-valuetext',text+', '+expandMeters(v));
  inputMeasure.value=text.slice(0,5)+' · '+meters(v);
  if(announce)spoken.textContent=text+'. '+expandMeters(v)+' relative to mean lower low water.';
  state.hour=String(selected);
  state.value=String(v);
  if(viewport){
    cursor.style.left=viewport.x(selected)+'px';
    cursor.style.setProperty('--marker',viewport.y(v)+'px');
  }
}
function setDay(){
  const index=Number(day.value);
  const start=index*24;
  const label=date.format(firstDate+index*86400000);
  data=tide.mm.slice(start,start+24).map(mm=>mm/1000);
  const summary=describeSeries({name:'Water level',kind:'series',count:data.length,
    datum:position=>({x:position,value:data[position]})});
  id('low').textContent=meters(summary.minimum);
  id('high').textContent=meters(summary.maximum);
  id('range').textContent=meters(summary.maximum-summary.minimum);
  notice.textContent=label+' at San Francisco, Golden Gate. '+summary.finite+' hourly observations. Lowest reading '+expandMeters(summary.minimum)+' at '+fullHour(summary.minimumIndex)+'. Highest reading '+expandMeters(summary.maximum)+' at '+fullHour(summary.maximumIndex)+'.';
  id('table-caption').textContent=label+', 2025 · San Francisco, Golden Gate';
  const rows=data.map((value,position)=>{
    const tr=document.createElement('tr'), timestamp=document.createElement('th'), reading=document.createElement('td');
    timestamp.scope='row';timestamp.textContent=fullHour(position).slice(0,5);
    reading.textContent=value.toFixed(3);
    tr.append(timestamp,reading);
    return tr;
  });
  id('table').replaceChildren(...rows);
  state.day=String(index+1);
  showHour(selected,true);
}
function plot(){
  if(!engine||signal.aborted)return;
  const canvas=engine.canvas,w=canvas.clientWidth,h=canvas.clientHeight,dpr=Math.min(1.8,Math.max(1,devicePixelRatio||1));
  const x0=46,x1=w-22,y0=15,y1=h-25;
  if(canvas.width!==Math.round(w*dpr))canvas.width=Math.round(w*dpr);
  if(canvas.height!==Math.round(h*dpr))canvas.height=Math.round(h*dpr);
  const x=index=>x0+(x1-x0)*index/23,
    y=value=>y1-(y1-y0)*(value-yRange[0])/(yRange[1]-yRange[0]);
  viewport={x,y,x0,x1};
  const camera=engine.camera,z=camera.far-camera.near;
  camera.project=(out,_aspect,webgpu)=>{
    out.fill(0);out[0]=2/w;out[5]=2/h;out[10]=webgpu?1/z:-2/z;
    out[14]=webgpu?camera.far/z:-(camera.far+camera.near)/z;out[15]=1;
  };
  const work=[];
  const segment=(from,to)=>work.push(from,to);
  for(const [index,tick] of guideX.entries()){
    const at=x(tick);
    segment([at,y0],[at,y1]);
    const axis=horizontal[index];
    axis.style.left=at+'px';axis.style.top=y1+5+'px';
    axis.textContent=String(tick).padStart(2,'0')+'h';
  }
  for(const [index,tick] of guideY.entries()){
    const at=y(tick);
    if(tick!==0)segment([x0,at],[x1,at]);
    const axis=vertical[index];
    axis.style.left=x0-7+'px';axis.style.top=at+'px';axis.textContent=tick.toFixed(1);
  }
  const world=(list,z)=>list.flatMap(([x,y])=>[x-w/2,h/2-y,z]);
  gridLine.setPositions(world(work,0));
  zeroLine.setPositions(world([[x0,y(0)],[x1,y(0)]],.001));
  waterLine.setPositions(world(data.map((value,index)=>[x(index),y(value)]),.004));
  showHour(selected,false);
  engine.render({delta:0});
  drawFrame=undefined;
}
function queueDraw(){
  if(!drawFrame&&engine)drawFrame=requestAnimationFrame(plot);
}
function stop(announce){
  sequence++;
  if(playing){
    const current=playing;playing=undefined;
    cancelAnimationFrame(current.frame);
    const now=audio.currentTime;
    current.envelope.gain.cancelScheduledValues(now);
    current.envelope.gain.setTargetAtTime(0,now,.008);
    current.oscillator.stop(now+.045);
  }
  play.textContent='Listen';
  play.setAttribute('aria-label','Listen to the selected day');
  state.playing='false';
  audioStatus.textContent=announce?'Playback stopped.':'24 hourly readings · 5.3 seconds';
}
function gainValue(){return .16*(volume.valueAsNumber/100)**1.7;}
async function listen(){
  if(playing){stop(true);return;}
  const token=++sequence;
  if(!globalThis.AudioContext){
    audioStatus.textContent='Audio playback is unavailable in this browser. The readings and keyboard controls remain available.';
    return;
  }
  try{
    if(!audio){
      audio=new AudioContext({latencyHint:'interactive'});
      level=audio.createGain();
      level.gain.value=gainValue();
      level.connect(audio.destination);
    }
    await audio.resume();
    if(signal.aborted||token!==sequence)return;
    const plan=sonificationPlan(data,{duration,pitch,range:yRange,signal});
    const oscillator=audio.createOscillator(), envelope=audio.createGain();
    oscillator.type='sine';
    oscillator.connect(envelope).connect(level);
    const start=audio.currentTime+.028,end=start+plan.duration;
    envelope.gain.setValueAtTime(0,start);
    envelope.gain.linearRampToValueAtTime(.81,start+.022);
    envelope.gain.setValueAtTime(.81,end-.052);
    envelope.gain.linearRampToValueAtTime(0,end);
    oscillator.frequency.setValueAtTime(plan.frequencies[0],start);
    for(let i=1;i<plan.times.length;i++){
      const at=start+plan.times[i];
      oscillator.frequency.setValueAtTime(plan.frequencies[i-1],at);
      oscillator.frequency.exponentialRampToValueAtTime(plan.frequencies[i],at+.034);
    }
    const current={oscillator,envelope,frame:undefined};
    playing=current;
    oscillator.addEventListener('ended',()=>{
      oscillator.disconnect();envelope.disconnect();
      if(playing!==current)return;
      cancelAnimationFrame(current.frame);playing=undefined;
      showHour(23,false);
      play.textContent='Listen';play.setAttribute('aria-label','Listen to the selected day');
      state.playing='false';audioStatus.textContent='Playback ended.';
    },{once:true});
    oscillator.start(start);
    oscillator.stop(end);
    audioStatus.textContent='Playing hourly readings for '+date.format(firstDate+(Number(day.value))*86400000)+'.';
    play.textContent='Stop audio';play.setAttribute('aria-label','Stop the selected day playback');
    state.playing='true';
    state.audioState=audio.state;
    state.notes=String(plan.frequencies.length);
    state.firstHz=plan.frequencies[0].toFixed(3);
    state.lastHz=plan.frequencies.at(-1).toFixed(3);
    let last=-1;
    function follow(){
      if(playing!==current||signal.aborted)return;
      const elapsed=audio.currentTime-start;
      if(elapsed>=0){
        const next=Math.min(23,Math.floor(elapsed*24/plan.duration));
        if(last!==next){showHour(next,false);last=next;}
        if(!performance.getEntriesByName('tide-first-audio').length)performance.mark('tide-first-audio');
      }
      current.frame=requestAnimationFrame(follow);
    }
    current.frame=requestAnimationFrame(follow);
  }catch(error){
    if(signal.aborted)return;
    audioStatus.textContent='Audio could not start. Select Listen to try again.';
    console.error(error);
  }
}
function connect(){
  day.addEventListener('change',()=>{stop(false);setDay();queueDraw();},{signal});
  hour.addEventListener('input',()=>{if(playing)stop(false);showHour(hour.valueAsNumber,true);},{signal});
  volume.addEventListener('input',()=>{if(audio)level.gain.setTargetAtTime(gainValue(),audio.currentTime,.02);},{signal});
  play.addEventListener('click',listen,{signal});
  plate.addEventListener('click',event=>{
    if(!viewport)return;
    const {x0,x1}=viewport, rect=plate.getBoundingClientRect();
    if(playing)stop(false);
    showHour(Math.round((event.clientX-rect.left-x0)*23/(x1-x0)),true);
  },{signal});
  document.querySelector('a[href="#observations"]').addEventListener('click',()=>{id('observations').open=true;},{signal});
}
async function compatibility(){
  const {install}=await import('@margoengine/webgl2-compat');
  return {install:()=>install({force:true,signal})};
}
async function start(){
  setDay();
  connect();
  play.disabled=false;
  const known=!navigator.gpu||new URLSearchParams(location.search).get('backend')==='webgl2';
  if(known)await (await compatibility()).install();
  await autoEngine(id('plot'),async target=>{
    if(!target.gpu)throw Error('The chart could not open on this device.');
    engine=target;
    target.scene.background=colors.background;
    target.camera.position=[0,0,3];
    const lines=Lines.attach(target);
    gridLine=lines.add(new Line({positions:[],color:colors.grid,mode:'segments',width:.9}));
    zeroLine=lines.add(new Line({positions:[],color:colors.zero,mode:'segments',width:1.5}));
    waterLine=lines.add(new Line({positions:[],color:colors.water,width:3.2,join:'round',cap:'round'}));
    plot();
    await target.gpu.queue.onSubmittedWorkDone();
  },{loadCompat:compatibility,signal,backend:known?'webgpu':undefined,exactSize:true,
    antialias:false,capacity:24,startupTimeout:5500,camera:{near:.05,far:10}});
  signal.throwIfAborted();
  state.renderer=engine.gpu.adapterInfo?.vendor==='margo-webgl2'?'webgl2':'webgpu';
  plate.dataset.ready='true';
  state.ready='true';
  performance.mark('margo-first-usable-frame');
  resize=new ResizeObserver(queueDraw);resize.observe(plate);
}
addEventListener('pagehide',event=>{
  stop(false);
  if(event.persisted)return;
  abort.abort();resize?.disconnect();cancelAnimationFrame(drawFrame);
  engine?.dispose();audio?.close().catch(()=>{});
});
start().catch(error=>{
  if(signal.aborted)return;
  const note=document.createElement('p');
  note.textContent='The chart display could not start. The audio and data table are available.';
  note.className='plot-message';note.setAttribute('role','status');plate.append(note);
  console.error(error);
});
