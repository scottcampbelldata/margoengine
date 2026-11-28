import {Engine} from '@margoengine/core';
import {CutscenePlayer} from '@margoengine/cutscene';
import {mouthOf} from '@margoengine/cutscene/lipsync';
import {film,names,tracks,total,endTitle} from './cut.js';
import {take} from './voice.js';
import {prepareSounds} from './sound.js';
import {makeSet} from './set.js';
import {makeKeeper,readKeeper} from './keeper.js';
import actorURL from './keeper.packed?url';

const $=id=>document.getElementById(id);
const canvas=$('picture'),data=canvas.dataset;
const cutInputs=[$('first'),$('second')],shotButtons=[$('lens'),$('keeper'),$('channel')];
const lifecycle=new AbortController(),{signal}=lifecycle;
const nextFrame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
const audio=prepareSounds(signal);
let engine,stage,keeper,player,sequence,saved=0,dirty=true,last=0,number=0;
let muted=false,showCaptions=true,queued=false,gesture=0,marked=false,exporting;
function fail(error){
  data.error=String(error?.message??error);
  $('loading').hidden=false;$('loading').textContent='The lantern room could not open.';
  for(const control of document.querySelectorAll('button,input'))control.disabled=true;
  console.error(error);
  close();
}
function close(){
  if(signal.aborted)return;
  audio.stop();lifecycle.abort();engine?.dispose();
}
addEventListener('pagehide',event=>{if(!event.persisted)close();},{signal});
function queue(event){
  if(event?.isTrusted)gesture++;
  dirty=true;
}
function timeString(t){
  const wide=Math.floor(t),hundredths=Math.floor((t%1)*100);
  return '00:'+String(wide).padStart(2,'0')+'.'+String(hundredths).padStart(2,'0');
}
const cuts=()=>cutInputs.map(input=>Number(input.value));
function timeline(){
  const [first,second]=cuts();
  cutInputs.forEach(input=>{$(input.id+'-value').value=Number(input.value).toFixed(2)+' s';});
  $('shots').style.gridTemplateColumns=[first,second-first,total-second].map(value=>value+'fr').join(' ');
  const captions=$('captions-track');
  captions.replaceChildren();
  if(showCaptions)for(const cue of sequence.doc.tracks.find(track=>track.type==='subtitle').clips){
    const item=document.createElement('span');
    item.textContent=cue.text;
    item.style.left=(cue.start/total*100)+'%';
    item.style.width=(cue.duration/total*100)+'%';
    captions.append(item);
  }
}
function rebuild(time=saved){
  const wasPlaying=player?.playing;
  player?.pause();
  audio.stop();
  sequence=film(cuts(),take,showCaptions);
  player=new CutscenePlayer(sequence.cut,{tracks});
  player.seek(time);
  saved=time;
  if(wasPlaying)play();
  timeline();
}
rebuild();
function play(){
  if(player.state.time>=total-.012)player.seek(0);
  void player.play();
  if(!muted&&engine)audio.play(sequence.doc,player.state.time);
}
function pause(){
  player.pause();audio.stop();
}
$('play').addEventListener('click',event=>{
  queue(event);
  if(!muted)void audio.unlock();
  if(!engine){queued=!queued;return;}
  if(player.playing)pause();else play();
},{signal});
$('play').disabled=false;
$('captions').addEventListener('click',event=>{
  if(!muted)void audio.unlock();
  queue(event);showCaptions=!showCaptions;rebuild(player.state.time);
},{signal});
$('audio').addEventListener('click',event=>{
  queue(event);muted=!muted;
  if(muted)audio.stop();
  else void audio.unlock().then(()=>{if(player.playing&&!muted)audio.play(sequence.doc,player.state.time);});
},{signal});
function seek(time,event){
  pause();player.seek(time);queue(event);
}
$('time').addEventListener('input',event=>seek(+event.target.value,event),{signal});
for(const [i,button] of shotButtons.entries())button.addEventListener('click',event=>seek([0,...cuts()][i],event),{signal});
for(const input of cutInputs)input.addEventListener('input',event=>{
  const time=player.state.time;
  rebuild(time);
  queue(event);
},{signal});

async function renderer(){
  const forced=new URLSearchParams(location.search).get('backend')==='webgl2';
  const options={backend:'webgpu',exactSize:true,antialias:true,capacity:420,signal,startupTimeout:2400};
  if(!forced&&navigator.gpu){
    try{return await Engine.create(canvas,options);}
    catch(error){if(error.code!=='unsupported'&&error.code!=='timeout')throw error;}
  }
  const {webglRenderer}=await import('./compatibility.js');
  return Engine.create(canvas,{...options,backend:'webgl2',fallback:webglRenderer});
}
async function portrait(){
  const response=await fetch(actorURL,{signal});
  if(!response.ok||!response.body)throw new Error('The keeper’s portrait could not load.');
  return readKeeper(await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
}
function size(){
  const factor=Math.min(1.72,devicePixelRatio);
  const w=Math.max(1,Math.round(canvas.clientWidth*factor)),h=Math.max(1,Math.round(canvas.clientHeight*factor));
  if(canvas.width===w&&canvas.height===h)return false;
  canvas.width=w;canvas.height=h;
  return true;
}
function draw(state){
  const time=state.time,shot=time<cuts()[0]?0:time<cuts()[1]?1:2;
  const {position,target,fov,up}=state.camera;
  engine.camera.position=position;engine.camera.target=target;engine.camera.up=up;
  engine.camera.fov=fov;engine.camera.near=.12;engine.camera.far=160;
  const params=state.properties.beacon;
  stage.draw({outside:shot===2,sweep:params.heading,power:params.power,wind:.65});
  const mouth=keeper.pose(shot===1,mouthOf(state,'keeper'),time);
  engine.render({delta:0});
  return {shot,mouth};
}
function hud(state,{shot,mouth}){
  const t=state.time;
  $('play').textContent=player.playing?'Pause cut':t>=total-.012?'Replay cut':'Play cut';
  $('captions').setAttribute('aria-pressed',String(showCaptions));$('audio').setAttribute('aria-pressed',String(!muted));
  $('shot').textContent=names[shot];
  $('clock').value=timeString(t);$('time').value=t;
  for(const [i,button] of shotButtons.entries())button.setAttribute('aria-pressed',String(i===shot));
  $('caption').textContent=state.subtitles.map(cue=>cue.text).join(' ');
  $('caption').hidden=!state.subtitles.length||t>=endTitle;
  $('titles').hidden=t<endTitle;
  data.time=t.toFixed(4);data.shot=String(shot);
  data.mouth=mouth.toFixed(4);
  data.caption=$('caption').hidden?'':$('caption').textContent;
  data.playing=String(player.playing);data.frame=String(++number);
  data.cuts=cuts().join(',');
}
async function frame(stamp){
  if(signal.aborted)return;
  if(exporting){requestAnimationFrame(frame);return;}
  try{
    const delta=last?Math.min(.066,(stamp-last)/1000):0;
    last=stamp;
    const moved=player.playing;
    if(moved){
      player.update(delta);
      if(!player.playing)audio.stop();
    }
    const resized=size();
    if(dirty||moved||resized){
      const revision=gesture,state=player.state;
      const display=draw(state);
      hud(state,display);
      dirty=false;
      if(data.ready!=='true'||(!marked&&revision>0&&state.time>.008)){
        if(engine.backend==='webgpu')await engine.gpu.queue.onSubmittedWorkDone();
        await nextFrame();
        if(signal.aborted)return;
        if(data.ready!=='true'){
          $('loading').hidden=true;data.ready='true';performance.mark('margo-first-usable-frame');
        }
        if(!marked&&revision>0&&state.time>.008){
          marked=true;performance.mark('margo-first-input-rendered');
        }
      }
    }
    requestAnimationFrame(frame);
  }catch(error){fail(error);}
}
$('export').addEventListener('click',async ()=>{
  if(exporting){exporting.abort(new DOMException('Render canceled','AbortError'));return;}
  const control=new AbortController();
  exporting=control;
  signal.addEventListener('abort',()=>control.abort(),{once:true,signal:control.signal});
  const button=$('export'),status=$('status');
  pause();
  for(const item of document.querySelectorAll('button,input'))if(item!==button)item.disabled=true;
  button.textContent='Cancel render';status.textContent='Preparing 960 × 540 video…';
  await nextFrame();
  canvas.width=960;canvas.height=540;
  try{
    const {renderVideo}=await import('./export.js');
    const result=await renderVideo(canvas,async state=>{
      draw(state);
      if(engine.backend==='webgpu')await engine.gpu.queue.onSubmittedWorkDone();
    },sequence.cut,muted?null:audio.inventory,{
      signal:control.signal,
      report(done,frames){status.textContent='Rendering frame '+done+' of '+frames;},
    });
    const url=URL.createObjectURL(new Blob([result.bytes],{type:result.mimeType}));
    const link=document.createElement('a');
    link.href=url;link.download='bring-the-light-around.webm';document.body.append(link);link.click();link.remove();
    setTimeout(()=>URL.revokeObjectURL(url),20_000);
    status.textContent='Downloaded '+result.frames+' frames at 24 fps.';
    data.export=String(result.frames);data.exportBytes=String(result.bytes.length);
  }catch(error){
    status.textContent=control.signal.aborted?'Render canceled.':String(error?.message??error);
    data.exportError=status.textContent;
  }finally{
    exporting=undefined;
    control.abort();
    button.textContent='Render video';
    for(const item of document.querySelectorAll('button,input'))item.disabled=false;
    last=0;size();dirty=true;
  }
},{signal});
size();
Promise.all([renderer(),portrait(),audio.ready]).then(([device,actor])=>{
  if(signal.aborted){device.dispose();return;}
  engine=device;engine.onError=fail;data.renderer=engine.backend;
  stage=makeSet(engine);keeper=makeKeeper(engine,actor);
  for(const item of document.querySelectorAll('button,input'))item.disabled=false;
  if(queued)play();
  requestAnimationFrame(frame);
}).catch(fail);
