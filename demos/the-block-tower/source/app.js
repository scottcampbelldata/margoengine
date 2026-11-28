import { demoStatus } from 'margo-demo-status';

const el=id=>document.getElementById(id);
const exhibit=el('exhibit'),status=demoStatus(exhibit,el('status'));
const controller=new AbortController(),{signal}=controller;
const pull=el('pull'),reset=el('reset'),course=el('course'),beam=el('beam');
const slots=['A','Center','B'];
const forced=new URLSearchParams(location.search).get('backend')==='webgl2';
const physicsReady=import('./physics.js').then(async module=>{
  await module.loadPhysics(signal);
  performance.mark('tower-physics');
  return module;
}).catch(error=>({error}));
let scene,roster='',lastSelection='',lastCollapse=false;

function fail(error){
  if(signal.aborted||status.failed)return;
  for(const control of [pull,reset,course,beam])control.disabled=true;
  scene?.close();
  status.error(error);
}
function slotOf(id){return Number(id.at(-1))-1;}
function update(state){
  const {selected,course:level,held,collapsed,removed,sleeping,steps,millimeters,crown,beams,moving}=state;
  Object.assign(exhibit.dataset,{selected,held,collapsed,removed,sleeping,steps,millimeters,crown,moving});
  const list=beams.join(',');
  if(roster!==list||lastSelection!==selected||lastCollapse!==collapsed){
    roster=list;
    lastSelection=selected;
    lastCollapse=collapsed;
    const levels=[...new Set(beams.map(id=>id[0]))];
    course.replaceChildren(...levels.map(id=>new Option(id,id)));
    course.value=String(level+1);
    const parts=beams.filter(id=>id.startsWith((level+1)+'-'));
    beam.replaceChildren(...parts.map(id=>new Option(slots[slotOf(id)],id)));
    beam.value=selected;
    el('selection').textContent=selected?'Course '+(level+1)+' · '+slots[slotOf(selected)]:'Tower fell';
    el('stand').textContent=collapsed?'Tower fell. Rebuild to try another pull.':'';
  }
  if(held||collapsed||!selected)pull.disabled=true;
  else pull.disabled=false;
  course.disabled=beam.disabled=held||collapsed;
  const count=removed+' / 24',rest=sleeping+' / 32';
  if(el('removed').textContent!==count)el('removed').textContent=count;
  if(el('sleeping').textContent!==rest)el('sleeping').textContent=rest;
}
pull.addEventListener('click',()=>scene?.pull(),{signal});
reset.addEventListener('click',()=>scene?.reset(),{signal});
beam.addEventListener('change',()=>scene?.select(beam.value),{signal});
course.addEventListener('change',()=>{
  const eligible=roster.split(',').filter(id=>id.startsWith(course.value+'-'));
  scene?.select(eligible.find(id=>slotOf(id)===1)??eligible[0]);
},{signal});
window.addEventListener('pagehide',event=>{if(!event.persisted)controller.abort();},{signal});
import('./scene.js').then(async module=>{
  scene=await module.openScene(el('canvas'),forced,signal,physicsReady,update,
    ()=>performance.mark('margo-first-input-rendered'),fail);
  signal.throwIfAborted();
  exhibit.dataset.renderer=scene.backend;
  scene.show();
  reset.disabled=false;
  performance.mark('margo-first-usable-frame');
  status.ready('');
}).catch(fail);
