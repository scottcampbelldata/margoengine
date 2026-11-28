import {Clustered} from '@margoengine/clustered';
import {WalkControls} from '@margoengine/controls/walk';
import {Geometry,PbrMaterial} from '@margoengine/core';
import {entrance,sanctuary,floorAt,floorId,fingerprint,plot,tile} from './grid.js';

function mount(engine,art){
  const [room,ceiling]=art.layers.map(layer=>layer.map(a=>{
    const geometry=new Geometry(a.positions,a.normals,a.indices);
    return engine.createMesh().setGeometry(geometry).setMaterial(new PbrMaterial(a.material));
  }));
  return {room,ceiling,lamps:art.lamps,dispose(){for(const item of [...room,...ceiling])item.dispose();}};
}

export async function install(engine,canvas,signal,initial,generate,fail){
  engine.scene.background='#211d27';
  engine.lighting.direction.set([-.43,.81,.39,.51]);
  engine.lighting.radiance.set([.89,.91,1,.34]);
  engine.lighting.ambient.set([.73,.78,1]);
  const bulbs=Clustered.attach(engine,{grid:[8,6,12],maxLights:180});
  const state=document.body.dataset,controls=document.querySelector('#controls'),next=document.querySelector('#next');
  const walkBtn=document.querySelector('#walk'),moves=document.querySelector('#walk-controls'),location=document.querySelector('#location');
  const seedLabel=document.querySelector('#seed'),countLabel=document.querySelector('#rooms'),status=document.querySelector('#status');
  let shown=initial,rooms,walker,observer,frame=0,last=0,walk=false,busy=false,revision=0,held=null,pulse=null;
  const spawn=plot(...entrance),final=plot(...sanctuary);
  function configureCamera(){
    const ratio=canvas.clientWidth/canvas.clientHeight;
    if(walk){
      engine.camera.position=[spawn[0],1.65,spawn[1]-.66];
      engine.camera.target=[spawn[0],1.52,spawn[1]+4.5];
      engine.camera.up=[0,1,0];engine.camera.fov=67;
    }else{
      engine.camera.position=ratio<1.36?[43,58,59]:[31,49,58];
      engine.camera.target=[0,0,0];
      engine.camera.up=[0,1,0];engine.camera.fov=37;
    }
  }
  function fit(){
    const scale=Math.min(devicePixelRatio,2),width=Math.round(canvas.clientWidth*scale),height=Math.round(canvas.clientHeight*scale);
    if(canvas.width!==width)canvas.width=width;
    if(canvas.height!==height)canvas.height=height;
  }
  function onVisit(){
    const [x,y,z]=engine.camera.position;
    state.position=x.toFixed(3)+','+y.toFixed(3)+','+z.toFixed(3);
    const dist=Math.hypot(final[0]-x,final[1]-z);
    const arrival=dist<tile*.69;
    const tag=arrival?'Vault reached':'Walkthrough';
    if(location.textContent!==tag)location.textContent=tag;
  }
  function capture(delta=0){
    fit();engine.render({delta});
    if(walk)onVisit();
  }
  function tick(now){
    frame=0;
    if(!walk||signal.aborted||document.hidden){last=0;return;}
    const active=held??(pulse&&pulse.end>now?pulse.name:null);
    walker.axes.y=active==='forward'?-1:active==='back'?1:0;
    walker.axes.lookX=active==='turn-left'?-1:active==='turn-right'?1:0;
    try{capture(last?Math.min(.045,(now-last)/1000):1/60);}
    catch(error){fail(error);return;}
    last=now;frame=requestAnimationFrame(tick);
  }
  function start(){if(!frame&&walk&&!document.hidden)frame=requestAnimationFrame(tick);}
  function resetWalker(){
    walker?.dispose();walker=undefined;configureCamera();
    if(walk){
      walker=new WalkControls(engine,{element:canvas,colliders:[...rooms.room,...rooms.ceiling],carry:false});
      walker.pointerLock=false;walker.gamepad=false;walker.speed=2.85;walker.radius=.24;walker.stepHeight=.15;
      walker.connect(canvas);
    }
  }
  function show(layout){
    const fresh=mount(engine,layout.art);
    for(const item of fresh.ceiling)item.visible=walk;
    bulbs.setLights(fresh.lamps);
    walker?.dispose();walker=undefined;rooms?.dispose();
    rooms=fresh;shown=layout;
    resetWalker();capture();
  }
  function report(){
    const count=shown.solved.reduce((n,cell)=>n+Number(floorId(cell)),0);
    seedLabel.textContent=String(shown.seed);
    countLabel.textContent=String(count);
    state.seed=String(shown.seed);state.signature=fingerprint(shown.solved);state.tiles=String(count);
    state.decisions=String(shown.decisions);state.pins=String(shown.pins);state.revision=String(revision);
  }
  async function changeLayout(){
    if(busy)return;
    busy=true;next.disabled=true;
    status.textContent='Resolving adjoining tiles and passages…';
    try{
      const target=(Math.imul(shown.seed,1664525)+1013904223)>>>0;
      const natural=await generate(target);
      if(signal.aborted)return;
      show(natural);await engine.gpu.queue.onSubmittedWorkDone();
      if(signal.aborted)return;
      revision++;report();
      status.textContent=walk?'Move with the arrows or drag the right half of the view to look.':'Generate another plan or walk from the amber entrance.';
      if(!performance.getEntriesByName('dungeon-control-applied').length)performance.mark('dungeon-control-applied');
    }catch(error){fail(error);}
    finally{busy=false;if(!signal.aborted)next.disabled=false;}
  }
  function walkMode(enabled){
    walk=enabled;held=pulse=null;
    state.view=walk?'walk':'plan';moves.hidden=!walk;
    walkBtn.setAttribute('aria-pressed',String(walk));walkBtn.textContent=walk?'View layout':'Walk through';
    for(const item of rooms.ceiling)item.visible=walk;
    resetWalker();capture();
    if(walk){status.textContent='Use the arrows to move. Drag the right half of the view to look.';start();}
    else{location.textContent='Stone archive';status.textContent='Generate another plan or walk from the amber entrance.';}
  }
  show(initial);
  await engine.gpu.queue.onSubmittedWorkDone();
  return {
    connect(){
      state.renderer=engine.gpu.adapterInfo?.vendor==='margo-webgl2'?'webgl2':'webgpu';
      state.view='plan';report();
      const options={signal};
      next.addEventListener('click',()=>void changeLayout(),options);
      walkBtn.addEventListener('click',()=>{try{walkMode(!walk);}catch(error){fail(error);}},options);
      for(const button of moves.querySelectorAll('button')){
        button.addEventListener('pointerdown',event=>{
          button.setPointerCapture(event.pointerId);held=button.id;pulse={name:button.id,end:performance.now()+177};
        },options);
        for(const type of ['pointerup','pointercancel','lostpointercapture'])button.addEventListener(type,()=>{held=null;},options);
        button.addEventListener('click',event=>{if(event.detail===0)pulse={name:button.id,end:performance.now()+220};},options);
      }
      document.addEventListener('visibilitychange',start,options);
      observer=new ResizeObserver(()=>{
        if(walk)return;
        try{configureCamera();capture();}catch(error){fail(error);}
      });
      observer.observe(canvas);
      document.querySelector('#loading').hidden=true;controls.disabled=false;
      state.ready='true';performance.mark('margo-first-usable-frame');
    },
    dispose(){observer?.disconnect();cancelAnimationFrame(frame);walker?.dispose();rooms?.dispose();bulbs.dispose();}
  };
}
