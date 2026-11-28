import {createAisle} from './art.js';
import {fixedDelta,approvedLimit} from './layout.js';

const el=id=>document.getElementById(id);
export async function connect(bench,source,signal,fail,onResize){
  const {engine,canvas}=bench,renderer=bench.renderer==='compatibility'?'webgl2':'webgpu',data=document.body.dataset;
  engine.camera.project=(m,aspect,webgpu)=>{
    const span=Math.max(4.22,7.8/aspect),{near,far}=engine.camera,r=far-near;
    m[0]=2/(span*aspect);m[5]=2/span;
    m[10]=webgpu?1/r:-2/r;
    m[14]=webgpu?far/r:-(far+near)/r;m[15]=1;
  };
  const art=createAisle(engine,(mesh,options)=>bench.add(mesh,options));
  const motor=el('motor'),gear=el('speed'),feed=el('feed'),status=el('status');
  const reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;
  let rig,format,phase=0,frame=0,last=0,carry=0,pausedFor=0,receipt=null;
  let reported='',pieceCount=0,queuedStart=false;
  function report(){
    if(!rig)return;
    const state=rig.state(),list=state.counters.join(',');
    if(list!==reported){
      reported=list;
      for(const [index,count] of state.counters.entries())el('count-'+index).value=String(count);
    }
    const [x,y]=state.parcels[2].body.position;
    data.motor=String(state.active);
    data.bins=list;
    data.speed=state.drive.toFixed(2);
    data.parcels=String(state.parcels.length);
    data.waiting=String(state.waiting);
    data.lead=x.toFixed(5);
    data.leadHeight=y.toFixed(5);
    data.steps=String(state.steps);
    if(state.parcels.length!==pieceCount){
      pieceCount=state.parcels.length;
      feed.disabled=pieceCount>=approvedLimit;
    }
  }
  function paint(){
    signal.throwIfAborted();
    if(rig)art.sync(rig.parcels,phase);
    engine.render({delta:0});
    report();
  }
  async function fence(){
    if(engine.gpu)await engine.gpu.queue.onSubmittedWorkDone();
    else canvas.getContext('webgl2').finish();
  }
  function announce(){
    const active=rig.state().active;
    motor.firstChild.textContent=active?'Pause belts ':'Start belts ';
    motor.lastElementChild.textContent=active?'Ⅱ':'▶';
    motor.setAttribute('aria-pressed',String(active));
    el('floor-state').textContent=active?'Belts running':'Belts stopped';
  }
  function schedule(){
    if(!frame&&!signal.aborted&&!document.hidden)frame=requestAnimationFrame(tick);
  }
  function tick(now){
    frame=0;
    if(signal.aborted)return;
    try{
      const delta=last?Math.min(.055,(now-last)/1000):1/60;
      last=now;
      carry+=delta;
      const state=rig.state();
      let advanced=0;
      while(carry>=fixedDelta){rig.step();carry-=fixedDelta;advanced+=fixedDelta;}
      if(!reduce)phase=(phase+state.drive*advanced)%92;
      if(!state.active)pausedFor+=delta;
      paint();
      if(receipt&&Math.abs(+data.lead-receipt.x)>=.012){
        receipt=null;
        void fence().then(()=>{
          if(!signal.aborted&&!performance.getEntriesByName('margo-first-input-rendered').length)
            performance.mark('margo-first-input-rendered');
        }).catch(fail);
      }
      if(state.active||pausedFor<3)schedule();
      else last=0;
    }catch(error){fail(error);}
  }
  const bound={signal};
  function changeMotor(trusted){
    const active=!rig.state().active;
    if(active&&trusted&&!performance.getEntriesByName('margo-first-input-rendered').length)
      receipt={x:rig.parcels[2].body.position[0]};
    rig.motor(active,Number(gear.value));
    pausedFor=0;
    status.textContent=active?'The belts carry parcels by contact friction.':'Belts stopped. Parcels already in the chutes can still fall.';
    data.initialLead??=rig.parcels[2].body.position[0].toFixed(5);
    announce();schedule();
  }
  motor.addEventListener('click',event=>{
    if(rig){changeMotor(event.isTrusted);return;}
    queuedStart=event.isTrusted;
    motor.disabled=true;
    el('loading').textContent='Belts queued. Starting the factory simulator…';
  },bound);
  gear.addEventListener('change',()=>{
    rig.motor(rig.state().active,Number(gear.value));
    status.textContent='Belt target set to '+gear.selectedOptions[0].textContent+'.';
    if(frame)report();
    else paint();
  },bound);
  feed.addEventListener('click',()=>{
    const parcel=rig.add();
    status.textContent=parcel?'Parcel released onto bay '+['A','B','C'][parcel.lane]+'.':'The feed positions are occupied.';
    if(parcel){pausedFor=0;schedule();}
  },bound);
  el('reset').addEventListener('click',()=>{
    cancelAnimationFrame(frame);frame=0;last=0;carry=0;phase=0;pausedFor=0;receipt=null;
    art.reset();rig.dispose();rig=format.createFactory();
    gear.value='1';
    status.textContent='Nine parcels are on the belts.';
    announce();paint();
  },bound);
  document.addEventListener('visibilitychange',()=>{
    if(document.hidden){cancelAnimationFrame(frame);frame=0;last=0;}
    else if(rig?.state().active)schedule();
  },bound);
  paint();
  data.renderer=renderer;
  data.motorReady='true';
  motor.disabled=false;
  format=await source;
  signal.throwIfAborted();
  rig=format.createFactory();
  if(queuedStart)changeMotor(true);
  paint();
  await fence();
  signal.throwIfAborted();
  data.renderer=renderer;data.ready='true';
  performance.mark('margo-first-usable-frame');
  el('loading').hidden=true;motor.disabled=false;el('secondary').inert=false;
  onResize(()=>{if(!frame&&!signal.aborted)paint();});
  return {dispose(){cancelAnimationFrame(frame);rig.dispose();}};
}
