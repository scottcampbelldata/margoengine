import {apply,holds,initial,plan,target} from './domain.js';
import {lookout,stations} from './lookout.js';
import {readWorker,worker} from './worker.js';

const nextFrame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
const speed=1.57, gaitStride=1.23;
function walkPath(start,end){
  if(Math.hypot(start[0]-end[0],start[1]-end[1])<.025)return [start];
  if(Math.abs(start[0]-end[0])<.42)return [start,end];
  const crossing=.60;
  return [start,[start[0],crossing],[end[0],crossing],end];
}
function angle(a,b){return Math.atan2(b[0]-a[0],b[1]-a[1]);}
function mix(a,b,w){return [a[0]+(b[0]-a[0])*w,a[1]+(b[1]-a[1])*w];}
function turn(a,b,w){return a+Math.atan2(Math.sin(b-a),Math.cos(b-a))*w;}

export async function mount({engine,actor,canvas,notice,signal,size,fail}){
  const get=id=>document.getElementById(id),data=canvas.dataset;
  data.renderer=engine.backend==='webgl2'?'compatibility':'webgpu';
  get('renderer').textContent=data.renderer==='webgpu'?'Margo WebGPU':'Margo WebGL2';
  const set=lookout(engine);
  const player=worker(engine,set.w,readWorker(actor));
  performance.mark('planner-stage');
  const rain=get('weather'),method=get('method'),run=get('run'),reset=get('reset'),list=get('plan');
  let state=initial(),mode='cheap',selected,completed=[],current,
    at=stations.door.at,yaw=stations.door.yaw,running=false,
    last=0,poseChange=true,dirty=true,frame=0,serial=0,queued=0,applied=0;
  let pose={at,yaw};

  function announce(message){
    if(get('activity').textContent!==message){
      get('activity').textContent=message;
      get('announce').textContent=message;
    }
  }
  function stateUI(){
    rain.textContent=state.rain?'Clear rain':'Start rain';
    rain.setAttribute('aria-pressed',String(state.rain));
    get('fuel').textContent=state.fuel?state.fuelSource==='shelf'?'Kindling':'Split wood':state.fire?'In stove':'None';
    get('stove').textContent=state.fire?'Lit':'Cold';
    get('meal').textContent=state.meal?'Ready':'Pending';
    get('rest').textContent=state.rested?'Done':'Pending';
    run.textContent=running?'Pause':holds(state,target)?'Plan complete':'Run plan';
    run.disabled=holds(state,target);
    data.rain=String(state.rain);
    data.fuel=String(state.fuel);
    data.fire=String(state.fire);
    data.meal=String(state.meal);
    data.rested=String(state.rested);
    data.fuelSource=state.fuelSource;
    data.running=String(running);
    data.planner=mode==='cheap'?'goap':'htn';
    data.completed=completed.map(action=>action.name).join(',');
  }
  function planUI(){
    const items=[...completed,...selected.concrete].map((action,index)=>{
      const item=document.createElement('li');
      item.textContent=action.label;
      if(index<completed.length)item.dataset.completed='true';
      else if(action===current?.action&&index===completed.length)item.setAttribute('aria-current','step');
      return item;
    });
    list.replaceChildren(...items);
    data.plan=selected.concrete.map(action=>action.name).join(',');
    data.effort=selected.cost.toFixed(1);
    get('strategy').textContent=mode==='cheap'?'GOAP · effort '+data.effort:'HTN · house routine';
    const vertices=[at];
    for(const action of selected.concrete)vertices.push(...walkPath(vertices.at(-1),stations[action.station].at).slice(1));
    set.markRoute(vertices);
    stateUI();
    dirty=true;
  }
  function choose(){
    selected=plan(state,mode);
    if(!selected.concrete.length){
      running=false;current=null;
      if(state.rested)announce('Supper ready · Nessa is resting');
    }
    planUI();
  }
  function begin(){
    if(!running||current||!selected.concrete.length)return;
    const action=selected.concrete[0],spot=stations[action.station];
    current={action,spot,path:walkPath(at,spot.at),leg:0,distance:0,total:0,actionTime:0};
    data.phase=current.path.length>1?'walking':action.name;
    announce(current.path.length>1?'Walking · '+action.label:action.label);
    planUI();
  }
  function finishAction(action){
    if(!apply(state,action))throw new Error('The completed camp action lost its preconditions.');
    completed.push(action);
    if(action.name==='rest')pose={at,yaw,activity:'rest',phase:1,stopped:true};
    else pose={at,yaw};
    data.phase=action.name==='rest'?'rested':'idle';
    current=null;poseChange=true;
    choose();
    begin();
  }
  function advance(delta){
    begin();
    if(!current)return;
    const task=current,points=task.path;
    if(task.leg+1<points.length){
      const a=points[task.leg],b=points[task.leg+1],distance=Math.hypot(b[0]-a[0],b[1]-a[1]);
      if(distance>.001){
        task.distance+=delta*speed;
        task.total+=delta*speed;
        at=mix(a,b,Math.min(1,task.distance/distance));
        yaw=turn(yaw,angle(a,b),Math.min(1,delta*9));
        const remaining=task.leg+2===points.length?Math.max(0,distance-task.distance):1;
        const gaitWeight=Math.min(1,task.total/.24,remaining/.31);
        pose={at,yaw,walking:true,phase:(task.total/gaitStride)%1,gaitWeight};
      }
      if(distance<.001||task.distance>=distance){
        task.leg++;task.distance=0;
        if(task.leg===points.length-1){
          at=task.spot.at;
          data.phase=task.action.name;
          announce(task.action.label);
        }
      }
    }else{
      task.actionTime+=delta;
      const progress=Math.min(1,task.actionTime/task.action.seconds);
      yaw=turn(yaw,task.spot.yaw,Math.min(1,delta*7));
      pose={at,yaw,activity:task.action.name,phase:progress};
      if(progress>=1)finishAction(task.action);
    }
    poseChange=true;
  }
  function interrupt(){
    current=null;
    if(!state.rested)pose={at,yaw};
    poseChange=true;
    data.phase=state.rested?'rested':'idle';
    choose();
    begin();
  }
  function mark(event){
    if(event.isTrusted)queued++;
    dirty=true;
  }
  rain.addEventListener('click',event=>{
    state.rain=!state.rain;
    if(!state.rested)announce(state.rain?'Rain on the porch · the fuel plan has been checked':'Clear evening · the fuel plan has been checked');
    interrupt();mark(event);
  },{signal});
  method.addEventListener('change',event=>{
    mode=method.value;
    interrupt();mark(event);
  },{signal});
  run.addEventListener('click',event=>{
    running=!running;
    if(running)begin();
    else announce('Paused · '+(current?.action.label??'review the plan'));
    stateUI();mark(event);
  },{signal});
  reset.addEventListener('click',event=>{
    state=initial();completed=[];current=null;running=false;
    at=stations.door.at;yaw=stations.door.yaw;pose={at,yaw};
    data.phase='idle';poseChange=true;
    announce('Clear evening');choose();mark(event);
  },{signal});

  function draw(now){
    if(poseChange){
      const actor=player.draw(pose);
      data.at=actor.pivot.map(n=>n.toFixed(3)).join(',');
      data.hand=actor.hand.map(n=>n.toFixed(3)).join(',');
      poseChange=false;
    }
    set.update(state,now/1000);
    engine.render(0);
    data.frame=String(++serial);
  }
  function animate(now){
    if(signal.aborted)return;
    frame=requestAnimationFrame(animate);
    if(!dirty&&(!(running||state.rain||state.fire)||now-last<32))return;
    try{
      const elapsed=Math.min(.081,Math.max(.004,(now-last)/1000));
      last=now;dirty=false;
      if(running)advance(elapsed);
      draw(now);
      if(queued>applied){
        const revision=queued;applied=revision;
        Promise.resolve(engine.gpu?.queue.onSubmittedWorkDone()).then(nextFrame).then(()=>{
          if(signal.aborted)return;
          performance.mark('planner-input-rendered');
          if(revision===1)performance.mark('planner-first-input');
        }).catch(fail);
      }
    }catch(error){fail(error);}
  }
  const resize=new ResizeObserver(()=>{if(!signal.aborted&&size())dirty=true;});
  signal.addEventListener('abort',()=>{cancelAnimationFrame(frame);resize.disconnect();},{once:true});
  data.phase='idle';
  choose();
  last=performance.now();draw(last);
  if(engine.gpu)await engine.gpu.queue.onSubmittedWorkDone();
  await nextFrame();
  signal.throwIfAborted();
  for(const control of [rain,run,reset,method])control.disabled=false;
  notice.hidden=true;data.ready='true';
  performance.mark('planner-ready');
  resize.observe(canvas);
  frame=requestAnimationFrame(animate);
}
