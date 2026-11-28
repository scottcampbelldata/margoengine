import { applyQualityTier } from '@margoengine/quality';
import { autoEngine } from '@margoengine/webgl2-compat/auto';
import { MultiGoalIKSolver } from '@margoengine/kinematics-constraints/multi-goal';
import { demoStatus } from 'margo-demo-status';
import { contacts,fixture,startOffset,weights } from './fixture.mjs';
import { makeCell } from './cell.js';

const get=id=>document.getElementById(id);
const canvas=document.querySelector('canvas');
const loading=get('loading');
const error=get('error');
const status=demoStatus(document.body,loading,error);
const priorities=get('priority');
const buttons=[...priorities.querySelectorAll('button')];
const spread=get('spread');
const labels=[...document.querySelectorAll('.target-labels span')];
const reducedMotion=matchMedia('(prefers-reduced-motion: reduce)');
const lifetime=new AbortController();
const {signal}=lifetime,events={signal}, info=document.body.dataset;
const rig=fixture(MultiGoalIKSolver);
const force=new URLSearchParams(location.search).get('backend')==='webgl2';
let engine,cell,observer,raf,animation,result,current,targetPositions;
let choice=0,offset=startOffset,busy=false,dirty=false,inputPending=false;

function fail(reason) {
  if (signal.aborted || status.failed) return;
  status.error(reason);
  loading.hidden=true;
  error.hidden=false;
  priorities.disabled=spread.disabled=true;
}

function fit() {
  const ratio=Math.max(1,Math.min(devicePixelRatio||1,1.4));
  const width=Math.max(1,Math.round(canvas.clientWidth*ratio));
  const height=Math.max(1,Math.round(canvas.clientHeight*ratio));
  if (canvas.width!==width) canvas.width=width;
  if (canvas.height!==height) canvas.height=height;
  const view=width/height;
  engine.camera.position=[.40,2.05,4.86];
  engine.camera.target=[-.27,1.17,0];
  engine.camera.fov=view<1.27?36:26;
}

function pinLabels(matrix) {
  for(const [i,[x,y,z]] of targetPositions.entries()){
    const worldX=x+.101, worldY=y+.148;
    const clipW=matrix[3]*worldX+matrix[7]*worldY+matrix[11]*z+matrix[15];
    const clipX=matrix[0]*worldX+matrix[4]*worldY+matrix[8]*z+matrix[12];
    const clipY=matrix[1]*worldX+matrix[5]*worldY+matrix[9]*z+matrix[13];
    const style=labels[i].style;
    style.left=(50+50*clipX/clipW)+'%';
    style.top=(50-50*clipY/clipW)+'%';
    style.display='block';
  }
}

function metrics(poses) {
  const distances=contacts.map(({frame},i)=>{
    const actual=poses[frame].position,target=targetPositions[i];
    return Math.hypot(...actual.map((component,axis)=>component-target[axis]));
  });
  for(const [i,distance] of distances.entries()) {
    get('gap-'+i).value=Math.round(distance*1000)+' mm';
    get('weight-'+i).value=weights[choice][i]+'×';
  }
  get('percent').value=Math.round(offset*100)+'%';
  const settled=!animation;
  get('motion-status').textContent=settled?(result.resolved?'All three contacts aligned.':'Weighted compromise.'):'Moving to the weighted pose…';
  info.priority=String(choice);
  info.spread=String(Math.round(offset*100));
  info.gaps=distances.map(distance=>(distance*1000).toFixed(3)).join(',');
  info.solverStatus=result.status;
  info.settled=String(settled);
  info.resolved=String(result.resolved && settled);
}

async function draw(now) {
  const drawn=result;
  if(animation) {
    const portion=Math.max(0,Math.min(1,(now-animation.start)/360));
    const t=portion*portion*(3-2*portion);
    current=animation.from.map((value,i)=>value+(result.values[i]-value)*t);
    if(portion===1) animation=undefined;
  } else current=result.values;
  const computed=rig.evaluate(current);
  fit();
  cell.update(computed,targetPositions,choice);
  engine.render();
  pinLabels(engine.camera.matrix);
  await engine.gpu?.queue.onSubmittedWorkDone();
  const latest=result===drawn && !signal.aborted;
  if (latest) metrics(computed);
  return latest;
}

function queue() {
  dirty=true;
  if (raf!==undefined || busy || signal.aborted || status.failed) return;
  raf=requestAnimationFrame(async now=>{
    raf=undefined;
    busy=true;
    dirty=false;
    try {
      const latest=await draw(now);
      const applied=!animation || now-animation.start>=26;
      if(latest && inputPending && applied && !signal.aborted &&
       !performance.getEntriesByName('margo-first-input-rendered').length) {
        performance.mark('margo-first-input-rendered');
      }
    } catch(reason){fail(reason);}
    finally {busy=false;if(animation || dirty) queue();}
  });
}

function solve(next,amount) {
  if (next===choice && amount===offset) return;
  choice=next;
  offset=amount;
  result=rig.solve(choice,offset);
  targetPositions=result.targets;
  animation=reducedMotion.matches?undefined:{from:current,start:performance.now()};
  inputPending=true;
  for(const [i,button] of buttons.entries())button.setAttribute('aria-pressed',String(i===choice));
  queue();
}

async function start() {
  applyQualityTier();
  engine=await autoEngine(canvas,()=>{},{
    backend:force?'webgl2':undefined,signal,exactSize:true,antialias:true,camera:{near:.17,far:30,fov:37},
  });
  engine.onError=fail;
  cell=makeCell(engine);
  result=rig.solve(choice,offset);
  targetPositions=result.targets;
  current=result.values;
  await draw(performance.now());
  if(signal.aborted || status.failed) return;
  for(const [i,button] of buttons.entries())button.addEventListener('click',()=>solve(i,offset),events);
  spread.addEventListener('input',()=>solve(choice,spread.valueAsNumber/100),events);
  observer=new ResizeObserver(queue);
  observer.observe(canvas);
  info.renderer=engine.backend;
  priorities.disabled=spread.disabled=false;
  status.ready();
  loading.hidden=true;
  performance.mark('margo-first-usable-frame');
}

function dispose(){
  lifetime.abort();
  observer?.disconnect();
  if(raf!==undefined) cancelAnimationFrame(raf);
  engine?.dispose();
}
addEventListener('pagehide',event=>{if(!event.persisted) dispose();},events);
if(import.meta.hot) import.meta.hot.dispose(dispose);
void start().catch(fail);
