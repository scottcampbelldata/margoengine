import { Engine,Geometry,PbrMaterial } from '@margoengine/core';
import { meshLines,routeLines } from '@margoengine/navmesh/debug';
import { Shadows } from '@margoengine/shadows';
import { arcHeight,makeWorld } from './navigation.js';
import { buildArt } from './art.js';
import { boardView } from './view.js';

const color=(hex)=>new PbrMaterial({color:hex,roughness:.85,doubleSided:true});
const ink={
  route:color('#f5d8a0'),jump:color('#f1aa58'),grid:color('#7fcbc8'),arc:color('#ba7658'),
};
const routeColors={route:[1,0,0],link:[0,1,0]};
const terrainColors={inner:[1,0,0],outline:[1,0,0],link:[0,1,0]};

function ribbons(lines,kind,width){
  const {positions,colors}=lines;
  const points=[],normals=[],indices=[];
  for(let i=0,k=0;i<positions.length;i+=6,k+=8){
    if(colors[k+kind]<.5)continue;
    const [x,y,z,a,b,c]=positions.subarray(i,i+6);
    const dx=a-x,dz=c-z,d=Math.hypot(dx,dz);
    if(d<1e-8)continue;
    const ox=-dz/d*width,oz=dx/d*width,p=points.length/3;
    points.push(x+ox,y,z+oz,x-ox,y,z-oz,a+ox,b,c+oz,a-ox,b,c-oz);
    normals.push(0,1,0,0,1,0,0,1,0,0,1,0);
    indices.push(p,p+2,p+1,p+1,p+2,p+3);
  }
  return points.length?new Geometry(points,normals,indices):null;
}

const fixed=1/60;

export async function connect(canvas,{compatibility,signal,report,fail,inputRendered}){
  let engine,art,view,world,resize,shadows,arcs,mesh,currentRoute,worldGraphics,closed=false;
  let links=true,grid=false,paused=matchMedia('(prefers-reduced-motion: reduce)').matches;
  let previous=0,frame=0,carry=0,receipt=false,inputPending=false,first=false;
  function close(){
    if(closed)return;
    closed=true;
    cancelAnimationFrame(frame);
    resize?.disconnect();
    world?.dispose();
    shadows?.dispose();
    engine?.dispose();
  }
  signal.addEventListener('abort',close,{once:true});
  function fit(){
    const dpr=Math.min(devicePixelRatio,2,1512/Math.max(1,canvas.clientWidth));
    const w=Math.max(1,Math.round(canvas.clientWidth*dpr));
    const h=Math.max(1,Math.round(canvas.clientHeight*dpr));
    if(canvas.width!==w)canvas.width=w;
    if(canvas.height!==h)canvas.height=h;
  }
  function roads(){
    const lines=meshLines(world.nav,{lift:.034,colors:terrainColors});
    mesh.setGeometry(ribbons(lines,0,.009));
    arcs.setGeometry(ribbons(lines,1,.016));
    mesh.visible=grid;
    currentRoute=undefined;
  }
  function showRoute(route){
    if(currentRoute===route)return;
    currentRoute=route;
    if(!route){for(const part of worldGraphics)part.setGeometry(null);return;}
    const lines=routeLines(route,{lift:.045,colors:routeColors});
    worldGraphics[0].setGeometry(ribbons(lines,0,.042));
    worldGraphics[1].setGeometry(ribbons(lines,1,.040));
  }
  function make(resetGoal){
    const goal=resetGoal?null:world?.observation().goal;
    world?.dispose();
    world=makeWorld(links);
    if(goal)world.setGoal(goal);
    carry=previous=0;
    if(arcs)roads();
  }
  function paint(dt){
    signal.throwIfAborted();
    const state=world.observation();
    for(const [i,cart] of world.carts.entries()){
      const {agent}=cart;
      const [x,y,z]=agent.position,airborne=agent.state==='offmesh';
      const height=airborne?arcHeight(agent.position):0;
      const speed=Math.hypot(agent.velocity[0],agent.velocity[2]);
      if(speed>.08){
        const next=Math.atan2(agent.velocity[0],agent.velocity[2]);
        const difference=Math.atan2(Math.sin(next-cart.heading),Math.cos(next-cart.heading));
        cart.heading+=difference*(dt?1-Math.exp(-dt*13):1);
      }
      const pitch=airborne?Math.max(-.18,Math.min(.18,x*-.17*Math.sign(agent.velocity[0]))):0;
      art.carts[i].setPosition([x,y+height,z]).setRotation([pitch,cart.heading,0]);
    }
    showRoute(state.route);
    art.beacon.setPosition(state.goal);
    engine.render({delta:dt});
    report({...state,compatibility,links,paused,grid,goalScreen:view.screen(state.goal)});
    if(receipt&&state.route&&state.revision>0&&state.routeRevision===state.revision&&!inputPending&&!first){
      inputPending=true;
      performance.mark('pathfinder-route-submitted');
      void engine.gpu.queue.onSubmittedWorkDone().then(()=>{
        if(closed)return;
        first=true;
        inputRendered();
      }).catch(fail);
    }
  }
  function schedule(){
    if(!frame&&!signal.aborted&&!document.hidden)frame=requestAnimationFrame(tick);
  }
  function tick(timestamp){
    frame=0;
    if(signal.aborted||document.hidden)return;
    try{
      const elapsed=previous?Math.max(0,Math.min(.22,(timestamp-previous)/1000)):fixed;
      previous=timestamp;
      if(!paused){
        carry+=elapsed;
        while(carry>=fixed){world.update(fixed);carry-=fixed;}
      }
      paint(paused?0:Math.min(.065,elapsed));
      if(!paused)schedule();else previous=0;
    }catch(error){fail(error);}
  }
  function action(changes){
    try{changes();schedule();}catch(error){fail(error);}
  }
  function moveGoal(point,trusted){
    action(()=>{
      if(world.setGoal(point))receipt=receipt||trusted&&!first;
    });
  }
  function drag(u,v,trusted){moveGoal(view.point(u,v),trusted);}
  function nudge(x,z,trusted){
    const [a,,b]=world.observation().goal;
    moveGoal([a+x,0,b+z],trusted);
  }
  function pause(){
    action(()=>{paused=!paused;previous=carry=0;});
  }
  function toggleGrid(){
    action(()=>{grid=!grid;mesh.visible=grid;});
  }
  function toggleLinks(){
    action(()=>{links=!links;make(false);});
  }
  function reset(){
    action(()=>make(true));
  }
  function visibility(){
    if(document.hidden){cancelAnimationFrame(frame);frame=previous=carry=0;}
    else schedule();
  }
  try{
    fit();
    engine=await Engine.create(canvas,{backend:'webgpu',signal,exactSize:true,antialias:true,capacity:180,
      startupTimeout:9000,camera:{near:.25,far:65}});
    engine.onError=fail;
    performance.mark('pathfinder-device');
    view=boardView(engine.camera);
    make(true);
    art=buildArt(engine,world.carts);
    mesh=engine.createMesh().setMaterial(ink.grid);
    arcs=engine.createMesh().setMaterial(ink.arc);
    worldGraphics=[engine.createMesh().setMaterial(ink.route),engine.createMesh().setMaterial(ink.jump)];
    roads();
    shadows=Shadows.attach(engine,{resolution:1024,filter:'pcf',
      bounds:{min:[-6,-1,-4],max:[6,1.1,4]}});
    shadows.add(art.beds,{static:true});
    for(const cart of art.carts)shadows.add(cart);
    shadows.add(art.beacon);
    paint(0);
    performance.mark('pathfinder-first-submitted');
    signal.throwIfAborted();
  }catch(error){close();throw error;}
  resize=new ResizeObserver(()=>action(fit));
  resize.observe(canvas);
  document.addEventListener('visibilitychange',visibility,{signal});
  schedule();
  return {drag,nudge,pause,toggleGrid,toggleLinks,reset};
}
