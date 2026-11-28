import {paintLandscape,rig} from './art.js';
import {deck,height,opening,planks,width} from './layout.js';

const clamp=(v,min,max)=>Math.min(max,Math.max(min,v));
const nextFrame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
const stepTime=1/60;
function openingItems(){
  const item=(id,kind,paint,x,y,rotation=0,length)=>({id,kind,paint,length,body:{position:[x,y],rotation}});
  return [
    ...planks().map(({x,y,rotation,length},i)=>item('plank-'+i,'plank',i%2,x,y,rotation,length)),
    ...opening.map(({x,y,theme},i)=>item('crate-'+i,'crate',theme,x,y)),
  ];
}
export async function show({engine,prepared,canvas,notice,status,signal,size,fail}){
  const qs=id=>document.querySelector('#'+id);
  const data=canvas.dataset,control=['crate','bridge','knock','reset'].map(qs);
  const compat=engine.backend==='webgl2';
  data.renderer=compat?'compatibility':'webgpu';
  qs('route').textContent=compat?'Margo WebGL2':'Margo WebGPU';
  engine.scene.background='#232e43';
  engine.lighting.direction.set([0,0,1,0]);
  engine.lighting.radiance.set([1,1,1,1]);
  engine.lighting.ambient.set([1,1,1]);
  paintLandscape(engine);
  const rigs=new Map();
  let model,create,tasks=[],loop=0,last=0,lag=0,frames=0,first=true,stepping=false;
  let message='Tap open air to add a crate. Release the right pin to collapse the span.';
  let latest=null;

  function sync(items){
    const live=new Set();
    for(const item of items){
      live.add(item.id);
      let view=rigs.get(item.id);
      if(!view){view=rig(engine,item);rigs.set(item.id,view);}
      view.draw(item);
    }
    for(const [id,view] of rigs)if(!live.has(id)){view.dispose();rigs.delete(id);}
  }
  function report(meta){
    data.crates=String(meta.crates);data.joints=String(meta.joints);data.planks=String(meta.planks);
    data.weights=String(meta.weights);data.bridgeEnd=meta.bridgeEnd.toFixed(5);
    data.contacts=String(meta.events);
    data.frame=String(frames);
    const crates=meta.crates;
    qs('crates').textContent=String(crates);
    qs('joints').textContent=String(meta.joints);
    qs('hint').textContent=message;
    qs('knock').disabled=meta.joints<deck.planks+1;
    qs('crate').disabled=crates>=64;
    if(latest){
      const [x,y]=latest.body.position;
      data.latestX=x.toFixed(5);data.latestY=y.toFixed(5);
    }else{
      delete data.latestX;delete data.latestY;
    }
  }
  function paint(){
    const items=model.items();
    if(latest&&!items.includes(latest))latest=null;
    sync(items);
    engine.render(0);
    report(model.report());
  }
  function configure(){
    const camera=engine.camera;
    camera.position=[width*.005,-height*.005,18];
    camera.target=[width*.005,-height*.005,0];
    camera.near=.15;camera.far=30;
    camera.project=(out,aspect,webgpu)=>{
      const viewHeight=Math.max(height,width/aspect)*.01;
      const range=camera.far-camera.near;
      out[0]=2/(viewHeight*aspect);
      out[5]=2/viewHeight;
      out[10]=webgpu?1/range:-2/range;
      out[14]=webgpu?camera.far/range:-(camera.near+camera.far)/range;
      out[15]=1;
    };
  }
  async function cycle(time){
    if(signal.aborted)return;
    loop=requestAnimationFrame(cycle);
    if(stepping)return;
    stepping=true;
    try{
      const queue=tasks;
      tasks=[];
      for(const {action} of queue)action();
      lag+=last?Math.min(.09,(time-last)/1000):stepTime;
      last=time;
      if(queue.length)lag=Math.max(stepTime,lag);
      let taken=0;
      while(lag>=stepTime&&taken<6){
        model.step();
        lag-=stepTime;
        frames++;
        taken++;
      }
      if(!taken)return;
      paint();
      if(queue.some(job=>job.trusted)){
        if(engine.gpu)await engine.gpu.queue.onSubmittedWorkDone();
        await nextFrame();
        if(signal.aborted)return;
        performance.mark('sandbox-input-rendered');
        if(first){first=false;performance.mark('sandbox-first-input');}
      }
    }catch(error){if(!signal.aborted)fail(error);}
    finally{stepping=false;}
  }
  function task(action,event){
    tasks.push({action,trusted:event.isTrusted});
  }
  function drop(x,y,event){
    task(()=>{
      if(model.report().crates>=64)return;
      latest=model.addCrate(x,y);
      message='Crate released. It settles against the terrain and other bodies.';
      data.dropped=String(Number(data.dropped??0)+1);
    },event);
  }
  qs('crate').addEventListener('click',event=>drop(151,167,event),{signal});
  qs('bridge').addEventListener('click',event=>task(()=>{
    model.build();
    message='A new span is pinned to both banks.';
    data.bridges=String(Number(data.bridges??0)+1);
  },event),{signal});
  qs('knock').addEventListener('click',event=>task(()=>{
    model.knock();
    message='The right pin is released. The weight and loose span fall under gravity.';
    data.collapses=String(Number(data.collapses??0)+1);
  },event),{signal});
  qs('reset').addEventListener('click',event=>task(()=>{
    model.dispose();
    model=create();
    latest=null;frames=0;lag=0;
    message='The original sandbox is ready.';
    data.resets=String(Number(data.resets??0)+1);
  },event),{signal});
  canvas.addEventListener('pointerdown',event=>{
    if(event.button!==0)return;
    const b=canvas.getBoundingClientRect();
    const scale=Math.min(b.width/width,b.height/height);
    const x=(event.clientX-b.left-(b.width-width*scale)/2)/scale;
    const y=(event.clientY-b.top-(b.height-height*scale)/2)/scale;
    if(x>=0&&x<=width&&y<317)drop(clamp(x,18,width-18),clamp(y,18,301),event);
  },{signal});

  configure();
  sync(openingItems());
  engine.render(0);
  if(engine.gpu)await engine.gpu.queue.onSubmittedWorkDone();
  signal.throwIfAborted();
  qs('crates').textContent=String(opening.length);
  qs('joints').textContent=String(deck.planks+1);
  data.crates=String(opening.length);data.joints=String(deck.planks+1);data.planks=String(deck.planks);data.frame='0';
  status.ready(engine);
  notice.hidden=true;
  control.forEach(input=>input.disabled=false);
  data.ready='true';
  performance.mark('sandbox-ready');

  create=await prepared;
  signal.throwIfAborted();
  model=create();
  const observer=new ResizeObserver(()=>{
    if(signal.aborted||!size())return;
    engine.render(0);
  });
  observer.observe(canvas);
  signal.addEventListener('abort',()=>{cancelAnimationFrame(loop);observer.disconnect();model?.dispose();},{once:true});
  loop=requestAnimationFrame(cycle);
}
