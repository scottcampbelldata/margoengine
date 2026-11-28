import {Engine} from '@margoengine/core';
import {applyQualityTier} from '@margoengine/quality';
import {demoStatus} from 'margo-demo-status';
import {openingView} from './opening.js';
import {adjacency,islands,ports,routes} from './network.mjs';
import {resizeCanvas} from './presentation.mjs';

const by=id=>document.getElementById(id);
const base=by('chart'),controls=by('controls'),overlay=by('status');
const marker=by('marker'),select=by('port'),relax=by('relax');
const status=demoStatus(document.body,overlay,by('error'));
const lifetime=new AbortController(),{signal}=lifetime,events={signal};
const force=new URLSearchParams(location.search).get('backend')==='webgl2';
const stage=document.body.dataset;
let view,observer,walk,upgrade,stream,active=-1,revision=0,busy=false,liveUnavailable=false;

function fail(reason) {
  if(signal.aborted||status.failed)return;
  status.error(reason);
  overlay.hidden=false;
  overlay.querySelector('strong').textContent='The route chart could not open.';
  by('requirements').hidden=!['unsupported','no-adapter'].includes(reason?.code);
  controls.disabled=true;
}

function syncMarker(){
  if(active<0){marker.hidden=true;return;}
  const [x,y]=view.position(active),place=view.area();
  marker.hidden=x<place.x||y<place.y||x>place.x+place.width||y>place.y+place.height;
  marker.dataset.name=ports[active].name;
  marker.classList.toggle('mark-left',x>view.canvas.clientWidth*.61);
  marker.style.left=x+'px';
  marker.style.top=y+'px';
}

function inspector(id){
  const from=by('from'),degree=by('degree'),message=by('message'),list=by('connections');
  select.value=id<0?'':String(id);
  list.replaceChildren();
  by('indirect').hidden=true;
  message.hidden=id>=0;
  if(id<0){
    from.textContent='Trace a connection';
    degree.textContent='';
    return;
  }
  from.textContent=ports[id].name;
  degree.textContent=adjacency[id].length+' direct';
  for(const to of adjacency[id]){
    const li=document.createElement('li'),button=document.createElement('button');
    const dot=document.createElement('i'),{name,group}=ports[to];
    dot.style.background=islands[group].color;
    button.type='button';
    button.dataset.port=to;
    button.append(dot,name);
    li.append(button);
    list.append(li);
  }
}

function showPasses() {
  const {iterations,dispatches}=view.work();
  by('iterations').textContent=iterations+' layout passes';
  stage.iterations=String(iterations);
  stage.dispatches=String(dispatches);
}

function painted(){
  return new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
}

async function countTransfers(id,version){
  await painted();
  if(signal.aborted||version!==revision||!view.full)return;
  walk?.abort();
  const task=new AbortController(),target=view;
  walk=task;
  const combined=AbortSignal.any([signal,task.signal,AbortSignal.timeout(8000)]);
  const indirect=by('indirect');
  try{
    const count=await target.transfers(id,combined);
    if(version!==revision||target!==view)return;
    indirect.textContent=count+' ports two ferries away';
    indirect.hidden=false;
    stage.indirect=String(count);
  }catch(reason){
    if(!task.signal.aborted&&!signal.aborted&&version===revision){
      indirect.textContent='Two-ferry analysis is unavailable.';
      indirect.hidden=false;
    }
  }finally{
    if(walk===task)walk=undefined;
  }
}

async function choose(id,kind){
  const changed=++revision,receiver=view;
  walk?.abort();
  active=id;
  delete stage.indirect;
  inspector(id);
  await receiver.update(id);
  if(changed!==revision||signal.aborted)return;
  syncMarker();
  stage.inspected=String(id);
  stage.pick=kind;
  if(!performance.getEntriesByName('first-port-frame').length)performance.mark('first-port-frame');
  if(view.full&&id>=0)void countTransfers(id,changed);
  if(!view.full&&!liveUnavailable)void streamLive();
}

function bindCanvas(canvas){
  canvas.addEventListener('click',async event=>{
    if((busy&&view.full)||view.canvas!==canvas)return;
    try{
      const rect=canvas.getBoundingClientRect(),receiver=view;
      const hit=await receiver.pick(event.clientX-rect.left,event.clientY-rect.top);
      if(hit>=0)await choose(hit,receiver.pickMode);
    }catch(reason){fail(reason);}
  },events);
}

function present(next){
  observer?.disconnect();
  view=next;
  stage.renderer=next.renderer;
  stage.presentation=next.full?'full':'opening';
  bindCanvas(next.canvas);
  next.onDraw?.(syncMarker);
  observer=new ResizeObserver(()=>{next.resize();syncMarker();});
  observer.observe(next.canvas);
  syncMarker();
  showPasses();
}

async function installedCanvas(canvas){
  const {installCompatibility}=await import('./compatibility.js');
  await installCompatibility(signal);
  const options={backend:'webgpu',signal,exactSize:true,antialias:false,capacity:32};
  resizeCanvas(canvas);
  const engine=await Engine.create(canvas,options);
  performance.mark('engine-ready');
  return engine;
}

async function upgradeOpening(){
  clearTimeout(stream);
  let hidden,next,engine;
  try{
    hidden=document.createElement('canvas');
    hidden.className='streamed-chart';
    hidden.setAttribute('aria-hidden','true');
    base.after(hidden);
    const opened=installedCanvas(hidden);
    const functions=import('./scene.js');
    const result=await Promise.allSettled([opened,functions]);
    if(result[0].status==='fulfilled')engine=result[0].value;
    for(const entry of result)if(entry.status==='rejected')throw entry.reason;
    next=await result[1].value.completeView(engine,hidden,'webgl2',signal);
    let selected;
    do {
      selected=active;
      next.resize();
      await next.update(selected);
      signal.throwIfAborted();
    }while(selected!==active);
    const former=view;
    hidden.id='chart';
    hidden.classList.add('shown');
    hidden.removeAttribute('aria-hidden');
    hidden.setAttribute('aria-label',base.getAttribute('aria-label'));
    base.id='opening-completed';
    engine.onError=fail;
    present(next);
    former.dispose();
    base.remove();
    performance.mark('live-chart-frame');
    if(active>=0)void countTransfers(active,revision);
    return next;
  }catch(reason){
    if(next)next.dispose();
    else engine?.dispose();
    hidden?.remove();
    if(!signal.aborted){
      liveUnavailable=true;
      stage.liveError=reason?.message??String(reason);
      by('live-requirements').hidden=false;
      relax.disabled=true;
    }
    return null;
  }
}

function streamLive(){
  return upgrade??=(upgradeOpening());
}

async function advance(){
  if(busy||liveUnavailable)return;
  busy=true;
  relax.textContent='Computing…';
  relax.disabled=true;
  try{
    await painted();
    const current=view.full?view:await streamLive();
    if(!current||signal.aborted)return;
    await current.advance();
    if(signal.aborted)return;
    syncMarker();
    showPasses();
    performance.mark('layout-frame');
  }finally{
    busy=false;
    relax.textContent='Run layout';
    relax.disabled=liveUnavailable;
  }
}

function enableInspector(){
  const groups=islands.map(island=>{
    const group=document.createElement('optgroup');
    group.label=island.name;
    return group;
  });
  ports.forEach(({name,group},id)=>groups[group].append(new Option(name,String(id))));
  select.append(...groups);
  by('inventory').textContent=ports.length+' ports · '+routes.length+' routes';
  relax.addEventListener('click',()=>void advance().catch(fail),events);
  select.addEventListener('change',()=>void choose(select.value===''?-1:Number(select.value),'selector').catch(fail),events);
  by('connections').addEventListener('click',event=>{
    const port=event.target.closest('button[data-port]');
    if(port)void choose(Number(port.dataset.port),'connection').catch(fail);
  },events);
  stage.ports=String(ports.length);
  stage.routes=String(routes.length);
  controls.disabled=false;
  if(status.ready())overlay.hidden=true;
  performance.mark('chart-ready');
}

async function open(){
  applyQualityTier();
  resizeCanvas(base);
  if(!force&&navigator.gpu){
    const loadView=import('./scene.js');
    let engine;
    try{
      engine=await Engine.create(base,{backend:'webgpu',signal,exactSize:true,antialias:false,capacity:32});
    }catch(reason){
      if(!['unsupported','no-adapter'].includes(reason?.code))throw reason;
    }
    if(engine){
      engine.onError=fail;
      performance.mark('engine-ready');
      const {completeView}=await loadView;
      present(await completeView(engine,base,'webgpu',signal));
      enableInspector();
      return;
    }
  }
  present(await openingView(base,signal,fail));
  enableInspector();
  stream=setTimeout(()=>void streamLive(),1800);
}

addEventListener('pagehide',event=>{
  if(event.persisted)return;
  lifetime.abort();
  clearTimeout(stream);
  observer?.disconnect();
  view?.dispose();
});

open().catch(fail);
