import {build,move,routeLength,tileState} from './navigation.js';
import {start,goal,radius} from './layout.js';
import {fixture} from './fixture.js';

const nextFrame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
const lerp=(a,b,t)=>a+(b-a)*t;
const ease=t=>t*t*(3-2*t);
const slideSamples=5;
const velocity=.69;
const signature=points=>points.map(p=>p.map(v=>v.toFixed(3)).join(',')).join('|');

export async function mount({engine,canvas,notice,signal,size,fail}){
  const get=id=>document.getElementById(id),data=canvas.dataset;
  data.renderer=engine.backend==='webgl2'?'compatibility':'webgpu';
  get('renderer').textContent=data.renderer==='webgpu'?'Margo WebGPU':'Margo WebGL2';
  const {world,moving,constructed}=build();
  const art=fixture(engine,world);
  performance.mark('changing-maze-stage');
  const gateButtons=moving.map(({gate})=>get(gate.name)),dispatch=get('dispatch'),home=get('home'),mesh=get('mesh');
  const controls=[...gateButtons,dispatch,home,mesh];
  let point=start.slice(),yaw=0,arrived=false,running=false,route,waypoint=1,
    slide=null,changedKeys=new Set(),refreshed=0,meshVisible=false,
    last=0,frame=0,serial=0,queued=0,applied=0,dirty=true;

  function say(message){
    if(get('activity').textContent===message)return;
    get('activity').textContent=message;
    get('announcement').textContent=message;
  }
  function readout(){
    const length=route?routeLength(route.points):null;
    get('distance').textContent=length===null?'—':length.toFixed(2)+' m';
    get('tiles').textContent=changedKeys.size+' / '+art.visibleTiles;
    get('polygons').textContent=String(world.polygonCount);
    dispatch.textContent=running?'Pause':'Dispatch';
    dispatch.setAttribute('aria-label',running?'Pause shuttle':'Dispatch shuttle');
    data.route=route?signature(route.points):'';
    data.distance=length===null?'':length.toFixed(4);
    data.rebuilt=String(changedKeys.size);
    data.updateCount=String(refreshed);
    data.activeTiles=String(art.visibleTiles);
    data.allTiles=String(constructed);
    data.pending=String(world.pendingTiles);
    data.version=String(world.version);
    data.polygons=String(world.polygonCount);
    data.gates=moving.map(item=>item.index).join(',');
    data.mesh=String(meshVisible);
    data.running=String(running);
    data.arrived=String(arrived);
  }
  function calculate(){
    route=world.route(point,goal);
    waypoint=1;
    art.trace(route?.points??[]);
    if(!route)running=false;
    readout();
  }
  function affect(event){
    if(event.isTrusted)queued++;
    dirty=true;
  }
  function rebuilt(){
    const n=world.update(3);
    if(!n)return;
    refreshed+=n;
    const current=tileState(world);
    for(const [key,value] of current)if(value.mesh!==slide.before.get(key)?.mesh&&value.mesh)changedKeys.add(key);
    art.highlight(changedKeys);
    if(meshVisible)art.meshEdges(true);
    readout();
  }
  function admitGate(index,event){
    if(slide)return;
    const item=moving[index],next=1-item.index,to=item.gate.stops[next],
      margin=radius+.014,range=item.gate.depth*.5;
    if(Math.abs(point[0]-item.gate.x)<=item.gate.width*.5+margin&&
        point[2]>=Math.min(item.z,to)-range-margin&&point[2]<=Math.max(item.z,to)+range+margin){
      say('The shuttle is on that track. Dock it to move the wall.');
      return;
    }
    slide={index,item,next,from:item.z,to,start:performance.now(),step:0,before:tileState(world),trusted:event.isTrusted,
      resume:running};
    running=false;
    changedKeys=new Set();
    refreshed=0;
    route=null;
    art.trace([]);
    art.highlight(changedKeys);
    for(const control of [...gateButtons,dispatch,home])control.disabled=true;
    say(item.gate.name==='jade'?'Sliding jade wall · rebuilding':'Sliding copper wall · rebuilding');
    data.phase='sliding';
    readout();dirty=true;
  }
  function advanceGate(now){
    const state=slide,progress=Math.max(0,Math.min(1,(now-state.start)/440));
    const step=Math.floor(progress*slideSamples);
    art.moveGate(state.index,lerp(state.from,state.to,ease(progress)),state.next);
    if(step>state.step){
      state.step=step;
      move(world,state.item,lerp(state.from,state.to,ease(step/slideSamples)));
    }
    if(world.pendingTiles)rebuilt();
    if(progress<1||world.pendingTiles)return;
    state.item.index=state.next;
    slide=null;
    running=state.resume&&!arrived;
    for(const control of [...gateButtons,dispatch,home])control.disabled=false;
    calculate();
    data.phase='routed';
    say(!route?'No route from the shuttle. Dock it to start again.':
      running?'Route refreshed · shuttle resumed':'Route refreshed · '+changedKeys.size+' tiles rebuilt');
    if(state.trusted)queued++;
  }
  function follow(seconds){
    if(!route||waypoint>=route.points.length)return;
    let available=seconds*velocity;
    while(available>0&&waypoint<route.points.length){
      const end=route.points[waypoint],dx=end[0]-point[0],dz=end[2]-point[2],d=Math.hypot(dx,dz);
      if(d>.0001)yaw=Math.atan2(dx,dz);
      if(d<=available){
        point=[...end];available-=d;waypoint++;
      }else{
        point=[point[0]+dx*available/d,0,point[2]+dz*available/d];available=0;
      }
    }
    if(waypoint>=route.points.length){
      arrived=true;running=false;
      data.phase='arrived';
      say('Shuttle arrived at the far dock');
      readout();
    }
  }
  for(const [i,button] of gateButtons.entries())button.addEventListener('click',event=>admitGate(i,event),{signal});
  dispatch.addEventListener('click',event=>{
    if(slide)return;
    if(running){
      running=false;data.phase='paused';say('Shuttle paused');
    }else{
      if(arrived){point=start.slice();arrived=false;}
      calculate();
      if(route&&route.points.length>1){running=true;data.phase='travel';say('Shuttle following the route');}
    }
    readout();affect(event);
  },{signal});
  home.addEventListener('click',event=>{
    if(slide)return;
    running=false;arrived=false;point=start.slice();yaw=0;
    calculate();say('Shuttle docked');data.phase='routed';affect(event);
  },{signal});
  mesh.addEventListener('change',event=>{
    meshVisible=mesh.checked;art.meshEdges(meshVisible);readout();affect(event);
  },{signal});

  function draw(){
    art.shuttle(point,yaw,arrived);
    engine.render(0);
    data.position=point.map(n=>n.toFixed(4)).join(',');
    data.frame=String(++serial);
  }
  function animate(now){
    if(signal.aborted)return;
    frame=requestAnimationFrame(animate);
    if(!dirty&&!slide&&!running)return;
    try{
      const elapsed=Math.min(.064,Math.max(.002,(now-last)/1000));
      last=now;dirty=false;
      if(slide)advanceGate(now);
      if(running&&!slide)follow(elapsed);
      draw();
      if(queued>applied){
        const revision=queued;applied=revision;
        Promise.resolve(engine.gpu?.queue.onSubmittedWorkDone()).then(nextFrame).then(()=>{
          if(signal.aborted)return;
          performance.mark('changing-maze-input-rendered');
          if(revision===1)performance.mark('changing-maze-first-input');
        }).catch(fail);
      }
    }catch(reason){fail(reason);}
  }
  const resize=new ResizeObserver(()=>{if(!signal.aborted&&size())dirty=true;});
  signal.addEventListener('abort',()=>{cancelAnimationFrame(frame);resize.disconnect();world.dispose();},{once:true});
  calculate();data.phase='routed';draw();
  if(engine.gpu)await engine.gpu.queue.onSubmittedWorkDone();
  await nextFrame();
  signal.throwIfAborted();
  for(const control of controls)control.disabled=false;
  notice.hidden=true;data.ready='true';
  performance.mark('changing-maze-ready');
  resize.observe(canvas);
  frame=requestAnimationFrame(animate);
}
