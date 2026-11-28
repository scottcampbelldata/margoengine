import {Engine} from '@margoengine/core';
import {makeVillage,choices,stations} from './brain.js';
import {makeBoard} from './village.js';

const $=id=>document.getElementById(id);
const canvas=$('village'),data=canvas.dataset,notice=$('notice');
const models=[...document.querySelectorAll('[data-resident]')],needs=['thirst','hunger','fatigue'];
const displays=choices.map(choice=>{
  const row=document.querySelector('[data-score="'+choice.id+'"]');
  return {id:choice.id,row,meter:row.querySelector('meter'),number:row.querySelector('output')};
});
const places=new Map(stations.map(s=>[s.id,s]));
const lifetime=new AbortController(),{signal}=lifetime;
const nextFrame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
let engine,village=makeVillage(),board,selected=0,paused=false,dirty=true,previous,logged=false,inputCount=0;
function fail(error){
  if(signal.aborted)return;
  data.error=String(error?.message??error);
  notice.textContent='The orchard could not open.';
  notice.hidden=false;
  console.error(error);
  document.querySelectorAll('button,input').forEach(element=>element.disabled=true);
  close();
}
function close(){
  if(signal.aborted)return;
  lifetime.abort();engine?.dispose();
}
async function connect(){
  const forced=new URLSearchParams(location.search).get('backend')==='webgl2';
  const options={backend:'webgpu',exactSize:true,antialias:true,capacity:100,signal,startupTimeout:2200};
  if(!forced&&navigator.gpu){
    try{return await Engine.create(canvas,options);}
    catch(error){if(error.code!=='unsupported'&&error.code!=='timeout')throw error;}
  }
  const {webglRenderer}=await import('./compatibility.js');
  return Engine.create(canvas,{...options,backend:'webgl2',fallback:webglRenderer});
}
function flag(event){
  if(event?.isTrusted)inputCount++;
  dirty=true;
}
$('heat').addEventListener('click',event=>{
  village.changeHeat(!village.heat);flag(event);
},{signal});
$('heat').disabled=false;
$('pause').addEventListener('click',event=>{paused=!paused;flag(event);},{signal});
$('reset').addEventListener('click',event=>{village=makeVillage();paused=false;flag(event);},{signal});
for(const [index,button] of models.entries())button.addEventListener('click',event=>{selected=index;flag(event);},{signal});
for(const id of needs)$(id).addEventListener('input',event=>{
  village.setNeed(village.people[selected],id,Number(event.currentTarget.value)/100);flag(event);
},{signal});
window.addEventListener('pagehide',event=>{if(!event.persisted)close();},{signal});

function controls(person){
  for(const [index,button] of models.entries())button.setAttribute('aria-pressed',String(index===selected));
  $('heat').setAttribute('aria-pressed',String(village.heat));
  $('heat').textContent=village.heat?'Return to mild weather':'Start a hot afternoon';
  $('pause').setAttribute('aria-pressed',String(paused));
  $('pause').textContent=paused?'Resume':'Pause';
  $('weather').textContent=village.heat?'Hot afternoon':'Mild afternoon';
  $('destination').textContent=person.destination
    ? person.phase+' · '+places.get(person.destination)?.name
    : 'Waiting for an open place';
  for(const {id,row,meter,number} of displays){
    const score=person.scores[id]??0;
    row.dataset.chosen=String(person.action===id);
    meter.value=score;
    number.value=Math.round(score*100);
  }
  for(const need of needs){
    const value=Math.round(person.needs[need]*100);
    if(document.activeElement!==$(need))$(need).value=String(value);
    $(need+'-value').value=value+'%';
  }
  const [used,capacity]=village.slots('spring'),[other]=village.slots('cistern');
  $('occupancy').textContent='Water places reserved · Spring '+used+'/'+capacity+' · Cistern '+other+'/1';
  data.person=person.name;
  data.destination=person.destination;
  data.action=person.action;
  data.mode=person.phase;
  data.score=JSON.stringify(person.scores);
  data.thirst=person.needs.thirst.toFixed(3);
  data.done=String(person.done);
  data.all=JSON.stringify(village.people.map(p=>({name:p.name,action:p.action,to:p.destination,phase:p.phase,done:p.done})));
  data.occupancy=String(used)+','+String(other);
  data.time=village.time.toFixed(3);
  data.position=person.position.map(v=>v.toFixed(3)).join(',');
  data.heat=String(village.heat);
  data.paused=String(paused);
  data.input=String(inputCount);
}
function labelPlace(person){
  const place=places.get(person.destination),label=$('place-label');
  if(!place){label.hidden=true;return;}
  const {x,z}=place, y=place.use==='food'||place.use==='rest'?1.70:place.use==='orchard'?1.05:.59;
  const m=engine.camera.matrix;
  const w=m[3]*x+m[7]*y+m[11]*z+m[15];
  const col=(m[0]*x+m[4]*y+m[8]*z+m[12])/w;
  const row=(m[1]*x+m[5]*y+m[9]*z+m[13])/w;
  label.style.left=((col+1)*50).toFixed(2)+'%';
  label.style.top=((1-row)*50).toFixed(2)+'%';
  label.textContent=place.name;
  label.hidden=false;
}
function layout(){
  const ratio=Math.min(1.72,devicePixelRatio),w=Math.max(1,Math.round(canvas.clientWidth*ratio)),h=Math.max(1,Math.round(canvas.clientHeight*ratio));
  if(canvas.width===w&&canvas.height===h)return false;
  canvas.width=w;canvas.height=h;return true;
}
async function step(now){
  if(signal.aborted)return;
  try{
    const dt=previous?Math.min(.038,(now-previous)/1000):0;
    previous=now;
    const resized=layout();
    if(!paused)village.advance(dt);
    if(!paused||dirty||resized){
      const person=village.people[selected];
      engine.camera.position=[7.5,14.5,11.4];
      engine.camera.target=[.17,-.72,1.22];
      engine.camera.near=.6;
      engine.camera.far=48;
      engine.camera.fov=41.4*Math.max(1,(1.42/(canvas.width/canvas.height))**.54);
      engine.lighting.direction.set([-.55,.83,.28,village.heat?3.8:3.05]);
      engine.lighting.radiance.set(village.heat?[1,.77,.55,.21]:[1,.90,.73,.30]);
      engine.lighting.ambient.set(village.heat?[.47,.52,.67]:[.59,.65,.72]);
      engine.scene.background=village.heat?'#b5b1a0':'#b4b9a2';
      const revision=inputCount;
      board.draw(village,person);
      engine.render({delta:dt});
      labelPlace(person);
      controls(person);
      dirty=false;
      if(data.ready!=='true'||(!logged&&revision>0)){
        if(engine.backend==='webgpu')await engine.gpu.queue.onSubmittedWorkDone();
        await nextFrame();
        if(signal.aborted)return;
        if(data.ready!=='true'){
          notice.hidden=true;data.ready='true';
          performance.mark('margo-first-usable-frame');
        }
        if(!logged&&revision>0){
          logged=true;performance.mark('margo-first-input-rendered');
        }
      }
    }
    requestAnimationFrame(step);
  }catch(error){fail(error);}
}
layout();
connect().then(device=>{
  if(signal.aborted){device.dispose();return;}
  engine=device;engine.onError=fail;
  data.renderer=engine.backend;
  board=makeBoard(engine,village.people);
  for(const element of document.querySelectorAll('button,input'))element.disabled=false;
  requestAnimationFrame(step);
}).catch(fail);
