import {makeLandscape} from './art.js';
import {delta,checkpoints,roadElevation,startX} from './terrain.js';
const el=id=>document.getElementById(id);
const labels={
  'park':'Buggy parked.',drive:'Driving toward the next trail flag.',
  'brake':'Braking through both tire contacts.',reverse:'Reversing on the trail.',
  recover:'The buggy rolled. Restart the run to return to the start.'
};
export async function connect(engine,canvas,signal,solver,fail){
  const data=document.body.dataset,art=makeLandscape(engine);
  const main=el('drive'),brake=el('brake'),reverse=el('reverse'),note=el('status');
  let rig,factory,frame=0,last=0,carry=0,queued=false,receipt=null,resize,coast=0;
  let cx=startX+2.12,cy=-roadElevation(startX)+2.57,stage=-1,mode='park';
  engine.scene.background='#70849c';
  engine.lighting.direction.set([.12,.19,1,2.34]);
  engine.lighting.ambient.set([.81,.86,.99]);
  engine.lighting.radiance.set([1,.94,.91,.93]);
  engine.camera.project=(m,aspect,gpu)=>{
    const span=aspect<1.42?8.74:8.53,{far,near}=engine.camera,d=far-near;
    m[0]=2/(span*aspect);m[5]=2/span;m[10]=gpu?1/d:-2/d;m[14]=gpu?far/d:-(far+near)/d;m[15]=1;
  };
  function updateReadings(state){
    data.position=state.p.map(x=>x.toFixed(5)).join(',');
    data.speed=state.speed.toFixed(4);data.mode=state.mode;
    data.checkpoints=String(state.stage);data.angle=state.angle.toFixed(5);data.tick=String(state.tick);
    data.suspension=state.wheels.map(wheel=>wheel.travel.toFixed(5)).join(',');
    data.contact=state.wheels.map(wheel=>Number(wheel.contact)).join(',');
    data.wheels=state.wheels.map(wheel=>wheel.spin.toFixed(5)).join(',');
    el('speed').value=(Math.abs(state.speed)*3.6).toFixed(1)+' km/h';
    el('distance').value=Math.max(0,state.p[0]-(Number(data.initial)||startX)).toFixed(1)+' m';
    el('wheel-rear').value=state.wheels[0].travel;
    el('wheel-front').value=state.wheels[1].travel;
    if(stage!==state.stage){
      stage=state.stage;
      el('checkpoint').textContent=stage+' / '+checkpoints.length+' checkpoints';
    }
    if(mode!==state.mode){
      mode=state.mode;
      main.firstChild.textContent=mode==='drive'?'Coast to a stop ':'Drive forward ';
      brake.setAttribute('aria-pressed',String(mode==='brake'));
      reverse.setAttribute('aria-pressed',String(mode==='reverse'));
      main.disabled=brake.disabled=reverse.disabled=mode==='recover';
      note.textContent=stage===checkpoints.length&&mode==='park'?'Salt Ridge completed.':labels[mode];
    }
  }
  function paint(dt=0,state=rig?.state()){
    signal.throwIfAborted();
    const dpr=Math.min(devicePixelRatio,2);
    const w=Math.round(canvas.clientWidth*dpr),h=Math.round(canvas.clientHeight*dpr);
    if(canvas.width!==w)canvas.width=w;
    if(canvas.height!==h)canvas.height=h;
    if(state){
      const a=dt>0?1-Math.exp(-dt*6.4):1;
      cx+=(state.p[0]+2.12+state.speed*.09-cx)*a;
      cy+=(-state.p[1]+1.9-cy)*a;
      art.draw(state,cx,cy);
      updateReadings(state);
    }else art.stage(cx,cy);
    engine.camera.position=[cx,cy,27];
    engine.camera.target=[cx,cy,0];
    engine.render({delta:0});
  }
  async function fence(){
    if(engine.gpu)await engine.gpu.queue.onSubmittedWorkDone();
    else canvas.getContext('webgl2').finish();
  }
  function schedule(){
    if(!frame&&!signal.aborted&&!document.hidden)frame=requestAnimationFrame(tick);
  }
  function tick(now){
    frame=0;
    if(signal.aborted)return;
    try{
      const dt=last?Math.min(.055,(now-last)/1000):1/60;
      last=now;carry+=dt;coast-=dt;
      while(carry>=delta){rig.step();carry-=delta;}
      const state=rig.state();
      paint(dt,state);
      if(receipt!==null&&state.p[0]-receipt>.061&&state.speed>.32){
        receipt=null;
        void fence().then(()=>{
          if(!signal.aborted&&!performance.getEntriesByName('margo-first-input-rendered').length)
            performance.mark('margo-first-input-rendered');
        }).catch(fail);
      }
      if(state.mode!=='recover'&&(state.mode==='drive'||state.mode==='reverse'||coast>0||Math.abs(state.speed)>.12))schedule();
      else last=0;
    }catch(error){fail(error);}
  }
  function choose(next,trusted=false){
    if(!rig){
      if(next==='drive'){
        queued=trusted;main.disabled=true;
        el('loading').textContent='Drive queued. Setting the buggy on its springs…';
      }
      return;
    }
    if(rig.state().mode==='recover')return;
    if(next==='drive'&&trusted&&!performance.getEntriesByName('margo-first-input-rendered').length)
      receipt=rig.state().p[0];
    rig.control(next);coast=2;
    schedule();
  }
  const events={signal};
  main.addEventListener('click',event=>choose(mode==='drive'?'park':'drive',event.isTrusted),events);
  brake.addEventListener('click',()=>choose(mode==='brake'?'park':'brake'),events);
  reverse.addEventListener('click',()=>choose(mode==='reverse'?'park':'reverse'),events);
  el('reset').addEventListener('click',()=>{
    cancelAnimationFrame(frame);frame=0;carry=0;last=0;receipt=null;
    stage=-1;mode='';
    rig.dispose();rig=factory.makeBuggy();
    paint();
  },events);
  const keys={ArrowRight:'drive',ArrowLeft:'reverse',Space:'brake'};
  for(const type of ['keydown','keyup'])addEventListener(type,event=>{
    if(event.target instanceof HTMLElement&&event.target.closest('button,input,select,a'))return;
    const command=keys[event.code];
    if(!command||event.repeat)return;
    event.preventDefault();choose(type==='keydown'?command:'park',event.isTrusted);
  },events);
  document.addEventListener('visibilitychange',()=>{
    if(document.hidden){cancelAnimationFrame(frame);frame=0;last=0;}
    else if(rig&&['drive','reverse','brake'].includes(rig.state().mode))schedule();
  },events);

  paint();
  data.renderer=engine.backend;data.driveReady='true';main.disabled=false;
  factory=await solver;
  signal.throwIfAborted();
  rig=factory.makeBuggy();
  data.initial=rig.state().p[0].toFixed(5);
  if(queued)choose('drive',true);
  paint();await fence();signal.throwIfAborted();
  data.ready='true';performance.mark('margo-first-usable-frame');
  main.disabled=false;el('extra').inert=false;el('loading').hidden=true;
  resize=new ResizeObserver(()=>{if(!signal.aborted&&!frame)paint();});resize.observe(canvas);
  return {dispose(){cancelAnimationFrame(frame);resize.disconnect();rig.dispose();}};
}
