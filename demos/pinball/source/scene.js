import {buildCabinet} from './art.js';
import {fixedDelta,start} from './layout.js';

const el=id=>document.getElementById(id);
const playLabels={ready:'Awaiting ball',live:'Ball in play',ended:'Game over'};
export async function connect(engine,canvas,machine,signal,fail){
  const data=document.body.dataset,art=buildCabinet(engine);
  const launcher=el('launch'),status=el('status'),soundButton=el('sound');
  const flippers=[el('left'),el('right')],timeouts=[0,0],pressAt=[0,0];
  let builder,game,resize,queued=false,receipt=false,frame=0,last=0,carry=0,dwell=0;
  let context,sound,soundBusy=false,soundEnabled=false,sounds=0,lastScore=-1,lastPhase='';
  engine.scene.background='#3f4255';
  engine.lighting.direction.set([-3.3,6.9,4.7,2.75]);
  engine.lighting.radiance.set([.97,.93,1,.97]);
  engine.lighting.ambient.set([.70,.88,.99]);
  engine.camera.project=(m,aspect,gpu)=>{
    const span=aspect<1.33?1.19:1.17,{near,far}=engine.camera,d=far-near;
    m[0]=2/(span*aspect);m[5]=2/span;
    m[10]=gpu?1/d:-2/d;m[14]=gpu?far/d:-(far+near)/d;m[15]=1;
  };
  const onCue=(kind,slot)=>{
    if(!soundEnabled||!sound)return;
    try{sound.play(kind,slot);data.sounds=String(++sounds);}
    catch(error){soundEnabled=false;soundButton.textContent='Sound off';soundButton.setAttribute('aria-pressed','false');status.textContent=error.message;}
  };
  function paint(){
    signal.throwIfAborted();
    const ratio=Math.min(devicePixelRatio,2);
    const w=Math.round(canvas.clientWidth*ratio),h=Math.round(canvas.clientHeight*ratio);
    if(canvas.width!==w)canvas.width=w;
    if(canvas.height!==h)canvas.height=h;
    if(game){
      const state=game.state();
      art.sync(state);
      data.phase=state.phase;data.score=String(state.score);data.balls=String(state.balls);
      data.launches=String(state.launches);data.impacts=String(state.impacts);
      data.ball=state.ball.map(x=>x.toFixed(5)).join(',');
      data.flippers=state.flippers.map(q=>(2*Math.atan2(q[1],q[3])*180/Math.PI).toFixed(3)).join(',');
      data.steps=String(state.steps);
      if(state.score!==lastScore){lastScore=state.score;el('score').value=String(state.score).padStart(6,'0');}
      if(state.phase!==lastPhase){
        lastPhase=state.phase;
        el('play-state').textContent=playLabels[state.phase];
        el('balls').value=String(state.balls);
        launcher.disabled=state.phase!=='ready';
        if(state.phase==='ready'&&state.launches)status.textContent='Ball drained. Launch the next ball.';
        if(state.phase==='ended')status.textContent='Game over. Start a new game to play again.';
      }
    }
    engine.render({delta:0});
  }
  async function fence(){
    if(engine.gpu)await engine.gpu.queue.onSubmittedWorkDone();
    else canvas.getContext('webgl2').finish();
  }
  function schedule(){
    if(!frame&&!document.hidden&&!signal.aborted)frame=requestAnimationFrame(tick);
  }
  function tick(now){
    frame=0;
    if(signal.aborted)return;
    try{
      const delta=last?Math.min(.051,(now-last)/1000):1/60;
      last=now;carry+=delta;dwell-=delta;
      while(carry>=fixedDelta){game.step();carry-=fixedDelta;}
      paint();
      const state=game.state();
      if(receipt&&state.phase==='live'&&Math.abs(state.ball[2]-start[2])>.018){
        receipt=false;
        void fence().then(()=>{
          if(!signal.aborted&&!performance.getEntriesByName('margo-first-input-rendered').length)
            performance.mark('margo-first-input-rendered');
        }).catch(fail);
      }
      if(state.phase==='live'||dwell>0)schedule();
      else last=0;
    }catch(error){fail(error);}
  }
  function launch(trusted){
    if(!game){
      queued=trusted;launcher.disabled=true;
      el('loading').textContent='Launch queued. Loading the pinball solver…';
      return;
    }
    if(!game.launch())return;
    receipt||=trusted;
    status.textContent='Ball in play. Hold either flipper to lift it.';
    dwell=1.4;schedule();
  }
  function hold(index,down){
    if(!game)return;
    clearTimeout(timeouts[index]);
    if(down){
      pressAt[index]=performance.now();
      game.hold(index,true);
      flippers[index].setAttribute('aria-pressed','true');
      dwell=1.2;schedule();
      return;
    }
    const lower=()=>{
      if(signal.aborted)return;
      game.hold(index,false);
      flippers[index].setAttribute('aria-pressed','false');
      dwell=1.2;schedule();
    };
    const remaining=78-(performance.now()-pressAt[index]);
    if(remaining>0)timeouts[index]=setTimeout(lower,remaining);
    else lower();
  }
  const bind={signal};
  launcher.addEventListener('click',event=>launch(event.isTrusted),bind);
  for(const [index,button] of flippers.entries()){
    button.addEventListener('pointerdown',event=>{
      if(event.button!==0)return;
      event.preventDefault();button.setPointerCapture(event.pointerId);hold(index,true);
    },bind);
    for(const event of ['pointerup','pointercancel','lostpointercapture'])button.addEventListener(event,()=>{
      if(button.getAttribute('aria-pressed')==='true')hold(index,false);
    },bind);
    for(const type of ['keydown','keyup'])button.addEventListener(type,event=>{
      if(!['Enter',' '].includes(event.key))return;
      event.preventDefault();
      if(!event.repeat)hold(index,type==='keydown');
    },bind);
  }
  function hotkeys(event,pressed){
    if(event.target instanceof HTMLElement&&event.target.closest('button,input,select,a'))return;
    if(event.key==='ArrowLeft'||event.key==='ArrowRight'){
      event.preventDefault();
      if(!event.repeat)hold(Number(event.key==='ArrowRight'),pressed);
    }else if(event.code==='Space'&&pressed&&!event.repeat){
      event.preventDefault();
      launch(event.isTrusted);
    }
  }
  addEventListener('keydown',event=>hotkeys(event,true),bind);
  addEventListener('keyup',event=>hotkeys(event,false),bind);
  addEventListener('blur',()=>{for(const i of [0,1])hold(i,false);},bind);
  soundButton.addEventListener('click',async()=>{
    if(soundBusy)return;
    if(soundEnabled){
      soundEnabled=false;soundButton.textContent='Sound off';soundButton.setAttribute('aria-pressed','false');
      return;
    }
    soundBusy=true;soundButton.disabled=true;
    try{
      context??=new AudioContext();
      const resumed=context.resume();
      if(!sound){
        const {pinballSound}=await import('./sound.js');
        signal.throwIfAborted();
        sound=pinballSound(engine,context);
      }
      await resumed;
      signal.throwIfAborted();
      soundEnabled=true;soundButton.textContent='Sound on';soundButton.setAttribute('aria-pressed','true');
      onCue('launch',0);
    }catch(error){if(!signal.aborted)status.textContent='Sound could not start. '+error.message;}
    finally{soundBusy=false;soundButton.disabled=false;}
  },bind);
  el('reset').addEventListener('click',()=>{
    cancelAnimationFrame(frame);frame=0;last=0;carry=0;dwell=0;receipt=false;
    timeouts.forEach(clearTimeout);
    game.dispose();game=builder.makeGame(onCue);
    for(const button of flippers)button.setAttribute('aria-pressed','false');
    status.textContent='Use the flipper buttons or the arrow keys. Space launches a ball.';
    paint();
  },bind);
  document.addEventListener('visibilitychange',()=>{
    if(document.hidden){cancelAnimationFrame(frame);frame=0;last=0;}
    else if(game?.state().phase==='live')schedule();
  },bind);

  paint();data.renderer=engine.backend;data.launchReady='true';launcher.disabled=false;
  builder=await machine;
  signal.throwIfAborted();
  game=builder.makeGame(onCue);
  if(queued)launch(true);
  paint();await fence();signal.throwIfAborted();
  data.ready='true';performance.mark('margo-first-usable-frame');
  el('details').inert=false;el('loading').hidden=true;
  resize=new ResizeObserver(()=>{if(!frame&&!signal.aborted)paint();});
  resize.observe(canvas);
  return {dispose(){
    cancelAnimationFrame(frame);timeouts.forEach(clearTimeout);
    resize.disconnect();game.dispose();sound?.dispose();
    if(context&&context.state!=='closed')void context.close();
  }};
}
