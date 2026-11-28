import {screenToWorld,worldToScreen} from '@margoengine/math';
import {pixelToCell} from '@margoengine/tilemap/hex';
import {buildArt} from './art.js';
import {cells,extentX,extentZ,grid,reveal,route,sites,start,tileAt} from './model.js';

const frame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
const same=(a,b)=>a[0]===b[0]&&a[1]===b[1];
const coastHint='Choose a landmark or tap a land tile to chart a route.';
const turning=.224;
function location(coord){
  const tile=tileAt(coord);
  const monument=same(coord,sites.beacon.cell)||same(coord,sites.summit.cell);
  const offset=monument?[.27,.23]:[0,0];
  return [tile.x+offset[0],tile.elevation,tile.z+offset[1]];
}
function configure(camera){
  camera.project=(out,aspect,webgpu)=>{
    const height=Math.max(8.77,13.57/aspect),depth=camera.far-camera.near;
    out[0]=2/(height*aspect);
    out[5]=2/height;
    out[10]=webgpu?1/depth:-2/depth;
    out[14]=webgpu?camera.far/depth:-(camera.near+camera.far)/depth;
    out[15]=1;
  };
}
export async function mount({engine,canvas,notice,signal,size,fail}){
  const get=id=>document.getElementById(id),data=canvas.dataset;
  const compat=engine.backend==='webgl2';
  const reduced=matchMedia('(prefers-reduced-motion:reduce)');
  data.renderer=compat?'compatibility':'webgpu';
  get('route').textContent=compat?'Margo WebGL2':'Margo WebGPU';
  engine.scene.background='#263d44';
  engine.lighting.direction.set([-.48,.77,.32,2.72]);
  engine.lighting.radiance.set([1,.90,.75,.25]);
  engine.lighting.ambient.set([.58,.68,.78]);
  configure(engine.camera);
  const art=buildArt(engine);
  const render=()=>engine.render(0);
  let current=start,history=new Set(),visible,plan,step=0,started=0,tick=0,applied=0,moves=0;
  let point=location(current);
  const summaries=['beacon','summit','reset'].map(get);
  const coordinate=()=>current.join(',');
  const message=text=>{get('note').textContent=text;get('announcement').textContent=text;};
  function state(){
    visible=reveal(current,history);
    art.fog(visible,history);
    data.cell=coordinate();
    data.visible=String(visible.size);
    data.surveyed=String(history.size);
    data.memory=String(history.size-visible.size);
    get('visible').textContent=visible.size;
    get('surveyed').textContent=history.size;
  }
  function mark(trusted,changed){
    if(!trusted||!changed)return;
    Promise.resolve(engine.gpu?.queue.onSubmittedWorkDone()).then(frame).then(()=>{
      if(signal.aborted)return;
      performance.mark('hex-input-rendered');
      if(!applied++)performance.mark('hex-first-input');
    }).catch(fail);
  }
  function advance(time){
    tick=0;
    if(!plan||signal.aborted)return;
    try{
      if(!started)started=time-18;
      const target=plan.cells[step+1];
      if(!target)return;
      const to=location(target),duration=reduced.matches?.035:turning;
      const fraction=Math.min(1,(time-started)/(duration*1000));
      const u=fraction*fraction*(3-2*fraction);
      const currentPoint=point.map((value,i)=>value+(to[i]-value)*u);
      art.token(...currentPoint);
      data.rover=currentPoint.map(v=>v.toFixed(4)).join(',');
      if(fraction>=1){
        current=target;point=to;step++;started=time;state();
      }
      const track=plan;
      if(step>=plan.cells.length-1){
        plan=undefined;
        data.moving='false';
        message(track.destination+' reached. Surveyed tiles remain on the chart.');
      }else tick=requestAnimationFrame(advance);
      render();
      if(track.pending&&u>0){mark(track.pending,true);track.pending=false;}
    }catch(error){fail(error);}
  }
  function select(goal,label,event){
    if(signal.aborted)return;
    const target=tileAt(goal);
    if(!target)return;
    if(!Number.isFinite(target.cost)){
      message(target.kind==='w'?'The survey team cannot cross water.':'The ridge blocks travel and line of sight.');
      return;
    }
    const way=route(current,goal);
    if(!way){message('There is no passable route to this tile.');return;}
    if(way.cells.length<2){
      message('The survey team is already at '+label+'.');
      return;
    }
    if(tick)cancelAnimationFrame(tick);
    step=0;started=0;point=location(current);
    plan={...way,destination:label,pending:event.isTrusted};
    art.path(way.cells);
    data.goal=goal.join(',');
    data.path=way.cells.map(cell=>cell.join(',')).join(';');
    data.distance=String(way.cells.length-1);
    data.routeCost=String(way.cost);
    data.moving='true';
    data.moves=String(++moves);
    get('cost').textContent=way.cost;
    message('Charted '+(way.cells.length-1)+' hexes to '+label+'.');
    tick=requestAnimationFrame(advance);
  }
  function reset(event){
    const changed=!!plan||!same(current,start)||history.size>(visible?.size??0);
    cancelAnimationFrame(tick);tick=0;step=0;plan=undefined;started=0;current=start;
    history=new Set();point=location(current);
    art.path([]);art.token(...point);
    data.moving='false';
    data.rover=point.map(v=>v.toFixed(4)).join(',');
    for(const key of ['goal','path','routeCost','distance'])delete data[key];
    get('cost').textContent='—';
    state();message(coastHint);render();
    mark(event?.isTrusted,changed);
  }
  function atPointer(event){
    const box=canvas.getBoundingClientRect(),x=event.clientX-box.left,y=event.clientY-box.top;
    const a={x:0,y:0,z:0},b={x:0,y:0,z:0};
    if(!screenToWorld(x,y,compat?-1:1,engine.camera,box.width,box.height,a)||
       !screenToWorld(x,y,compat?1:0,engine.camera,box.width,box.height,b))return;
    if(Math.abs(b.y-a.y)<1e-9)return;
    let nearest;
    let depth=Infinity;
    for(const tile of cells){
      const t=(tile.elevation-a.y)/(b.y-a.y);
      if(t>=depth)continue;
      const px=a.x+(b.x-a.x)*t+extentX/2,pz=a.z+(b.z-a.z)*t+extentZ/2;
      if(!same(pixelToCell(grid,px,pz),tile.coord))continue;
      nearest=tile;depth=t;
    }
    if(!nearest)return;
    const named=Object.values(sites).find(site=>same(site.cell,nearest.coord));
    select(nearest.coord,named?.name??('hex '+nearest.coord.map(n=>n+1).join(' / ')),event);
  }
  function probes(){
    const world=location([6,6]),box=canvas.getBoundingClientRect(),point={x:0,y:0,z:0};
    worldToScreen({x:world[0],y:world[1],z:world[2]},engine.camera,box.width,box.height,point);
    data.trailPoint=[point.x/box.width,point.y/box.height].map(n=>n.toFixed(5)).join(',');
  }
  const resize=new ResizeObserver(()=>{
    if(signal.aborted)return;
    try{if(size()){render();probes();}}catch(error){fail(error);}
  });
  signal.addEventListener('abort',()=>{resize.disconnect();cancelAnimationFrame(tick);},{once:true});
  for(const name of ['beacon','summit']){
    const site=sites[name];
    get(name).addEventListener('click',event=>select(site.cell,site.name,event),{signal});
  }
  get('reset').addEventListener('click',reset,{signal});
  canvas.addEventListener('click',atPointer,{signal});
  reset();
  probes();
  if(engine.gpu)await engine.gpu.queue.onSubmittedWorkDone();
  await frame();
  signal.throwIfAborted();
  data.ready='true';
  notice.hidden=true;
  for(const action of summaries)action.disabled=false;
  resize.observe(canvas);
  performance.mark('hex-ready');
}
