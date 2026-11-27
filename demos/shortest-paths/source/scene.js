import {createCompute} from '@margoengine/compute';
import {graph,shortestPaths} from '@margoengine/compute/graph';
import {demoStatus} from 'margo-demo-status';
import {defaultDestination,defaultOrigin,graphData,junction,namesByNode,nearestWorld,roads,routeBetween} from './network.mjs';
import {linesFor} from './map-model.mjs';
import {openMap} from './renderer.js';

const by=id=>document.getElementById(id);
const canvas=by('streets'),overlay=by('status'),controls=by('controls');
const originSelect=by('origin'),destinationSelect=by('destination'),arrows=by('oneways');
const status=demoStatus(document.body,overlay,by('error'));
const lifetime=new AbortController(),{signal}=lifetime,events={signal};
const info=document.body.dataset;
const force=new URLSearchParams(location.search).get('backend')==='webgl2';
let map,gpu,matrix,observer,tree;
let origin=defaultOrigin,destination=defaultDestination,picking='start',viewKey='',pending=false,queueing=false;
let strokes=linesFor(null,null,false);

function fail(reason){
  if(signal.aborted||status.failed)return;
  status.error(reason);
  overlay.hidden=false;
  overlay.querySelector('strong').textContent='The street graph could not open.';
  by('requirements').hidden=!['unsupported','no-adapter'].includes(reason?.code);
  controls.disabled=true;
}

function markers(){
  const projection=map.getMap();
  for(const [node,element] of [[origin,by('origin-pin')],[destination,by('destination-pin')]]){
    const [x,y]=projection.screen(junction[node]);
    element.style.left=x+'px';
    element.style.top=y+'px';
    element.hidden=false;
  }
  document.querySelector('.scale i').style.width=projection.scale*500+'px';
}

function draw(){
  map.draw(strokes);
  markers();
}

function updateReport(route,distances,iterations){
  const total=distances.reduce((count,distance)=>count+Number(Number.isFinite(distance)),0);
  by('reachable').textContent=total+' of '+junction.length+' junctions reachable from A';
  by('distance').textContent=route?(route.distance/1000).toFixed(2)+' km':'No route';
  by('route-label').textContent=route?'Shortest distance':'Within the mapped area';
  const list=by('route-streets');
  list.replaceChildren();
  if(route){
    let street;
    for(const step of route.steps){
      if(street===step.road.name)continue;
      street=step.road.name;
      const row=document.createElement('li');
      row.textContent=street;
      list.append(row);
    }
  }
  info.origin=String(origin);
  info.destination=String(destination);
  info.distance=route?route.distance.toFixed(2):'unreachable';
  info.reachable=String(total);
  info.steps=String(route?.steps.length??0);
  info.route=route?.steps.map(step=>step.road.sourceId+(step.reversed?'r':'f')).join(',')??'';
  info.iterations=String(iterations);
}

async function solve(start){
  if(tree?.source===start)return tree;
  const deadline=AbortSignal.any([signal,AbortSignal.timeout(9000)]);
  const answer=await shortestPaths(matrix,start,{checkEvery:4,signal:deadline});
  try{
    if(answer.negativeCycle)throw new Error('The selected road graph contains an invalid distance cycle.');
    const [distances,predecessors]=await Promise.all([
      answer.distances.read({signal:deadline}),answer.predecessors.read({signal:deadline}),
    ]);
    tree={source:start,distances,predecessors,iterations:answer.iterations};
    return tree;
  }finally{
    answer.distances.dispose();
    answer.predecessors.dispose();
  }
}

async function show(interactive){
  if(queueing)return;
  queueing=true;
  try{
    do{
      pending=false;
      const start=origin,end=destination,oneWay=arrows.checked;
      const key=[start,end,oneWay].join('/');
      if(key===viewKey)continue;
      const {distances,predecessors,iterations}=await solve(start);
      if(signal.aborted)return;
      if(start!==origin||end!==destination||oneWay!==arrows.checked){pending=true;continue;}
      const route=routeBetween(start,end,distances,predecessors);
      strokes=linesFor(distances,route,oneWay);
      draw();
      await map.settle();
      if(signal.aborted)return;
      // Report the completed frame that still matches the selected endpoints.
      if(start!==origin||end!==destination||oneWay!==arrows.checked){pending=true;continue;}
      viewKey=key;
      updateReport(route,distances,iterations);
      info.arrows=String(oneWay);
      if(interactive){
        if(!performance.getEntriesByName('first-control-frame').length)performance.mark('first-control-frame');
        performance.mark('route-frame');
      }
    }while(pending);
  }finally{
    queueing=false;
  }
}

function refresh(){
  originSelect.value=String(origin);
  destinationSelect.value=String(destination);
  pending=true;
  void show(true).catch(fail);
}

function pickTarget(which){
  picking=which;
  by('pick-start').setAttribute('aria-pressed',String(which==='start'));
  by('pick-end').setAttribute('aria-pressed',String(which==='end'));
}

function input(){
  for(const [name,id] of namesByNode.map((name,id)=>[name,id]).sort((a,b)=>a[0].localeCompare(b[0]))){
    originSelect.append(new Option(name,id));
    destinationSelect.append(new Option(name,id));
  }
  originSelect.value=String(origin);
  destinationSelect.value=String(destination);
  by('pick-start').addEventListener('click',()=>pickTarget('start'),events);
  by('pick-end').addEventListener('click',()=>pickTarget('end'),events);
  by('swap').addEventListener('click',()=>{
    [origin,destination]=[destination,origin];
    refresh();
  },events);
  originSelect.addEventListener('change',()=>{origin=Number(originSelect.value);refresh();},events);
  destinationSelect.addEventListener('change',()=>{destination=Number(destinationSelect.value);refresh();},events);
  arrows.addEventListener('change',refresh,events);
  canvas.addEventListener('click',event=>{
    const rect=canvas.getBoundingClientRect(),projection=map.getMap();
    const [x,y]=projection.world(event.clientX-rect.left,event.clientY-rect.top);
    const hit=nearestWorld(x,y);
    if(hit.id<0||hit.distance*projection.scale>14)return;
    if(picking==='start')origin=hit.id;
    else destination=hit.id;
    refresh();
  },events);
}

async function open(){
  map=await openMap(canvas,force,signal);
  if(signal.aborted){map.dispose();return;}
  map.engine.onError=fail;
  draw();
  performance.mark('map-frame');
  const native=map.backend==='webgpu';
  gpu=await createCompute(native?{engine:map.engine,backend:'webgpu',signal}:{backend:'cpu',signal});
  if(signal.aborted){gpu.dispose();return;}
  matrix=graph(gpu,graphData);
  info.renderer=map.backend;
  info.search=gpu.backend;
  info.junctions=String(junction.length);
  info.roads=String(roads.length);
  by('backend').textContent=native?'WebGPU':'Margo CPU compatibility';
  await show(false);
  input();
  observer=new ResizeObserver(()=>draw());
  observer.observe(canvas);
  controls.disabled=false;
  if(status.ready())overlay.hidden=true;
  performance.mark('routes-ready');
}

addEventListener('pagehide',event=>{
  if(event.persisted)return;
  lifetime.abort();
  observer?.disconnect();
  matrix?.dispose();
  gpu?.dispose();
  map?.dispose();
});

open().catch(fail);
