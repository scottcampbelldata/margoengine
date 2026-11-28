import {buildWorks} from './works.js';
import {cadence,interval,startPoses,ticks} from './course.js';

const frame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
const start=startPoses();
export async function show({engine,simulation,canvas,notice,status,signal,size,fail}){
  const qs=id=>document.querySelector('#'+id);
  const run=qs('run'),slider=qs('timeline'),state=canvas.dataset;
  const compat=engine.backend==='webgl2';
  const yard=buildWorks(engine);
  engine.scene.background='#172125';
  engine.lighting.direction.set([-3.7,8.3,4.15,3.72]);
  engine.lighting.radiance.set([1,.88,.74,.56]);
  engine.lighting.ambient.set([.81,.93,1.0]);
  qs('route').textContent=compat?'Margo WebGL2':'Margo WebGPU';
  state.renderer=compat?'compatibility':'webgpu';
  state.bodies=String(start.length);
  qs('bodies').textContent=String(start.length);
  let current,tracking=false,first=true,pendingSeek=null,seeking=false,recordings=0;

  function fit(){
    const aspect=canvas.width/canvas.height,zoom=Math.max(1,1.62/aspect);
    engine.camera.fov=2*Math.atan(Math.tan(16.4*Math.PI/180)*zoom)*180/Math.PI;
  }
  function describe(data,statusLine){
    current=data;
    if(pendingSeek===null)slider.value=String(data.current);
    qs('time').value=(data.current*interval).toFixed(2)+' s';
    qs('checkpoints').textContent=String(data.checkpoints);
    qs('hint').textContent=statusLine;
    state.tick=String(data.current);
    state.recorded=String(data.recorded);
    state.checkpoints=String(data.checkpoints);
    state.checkpoint=String(data.source??0);
    state.restores=String(data.restores);
    state.hash=String(data.hash);
    state.storage=String(data.storage);
    state.runs=String(recordings);
    state.rollerX=data.states[0].p[0].toFixed(6);
    state.moved=String(data.states.filter(({p},i)=>Math.hypot(...p.map((v,k)=>v-start[i].p[k]))>.20).length);
  }
  async function present(data,active,stage){
    yard.set(data.states);
    engine.render(0);
    if(engine.gpu)await engine.gpu.queue.onSubmittedWorkDone();
    await frame();
    if(signal.aborted)return;
    describe(data,stage);
    if(active){
      performance.mark('rewind-input-rendered');
      if(first){first=false;performance.mark('rewind-first-input');}
    }
  }

  fit();
  engine.render(0);
  if(engine.gpu)await engine.gpu.queue.onSubmittedWorkDone();
  signal.throwIfAborted();
  describe({states:start,current:0,recorded:0,checkpoints:0,source:0,restores:0,hash:0,storage:0},'Start the roller to record the pile-up.');
  status.ready(engine);
  notice.hidden=true;
  run.disabled=false;
  state.ready='true';
  performance.mark('rewind-ready');

  run.addEventListener('click',async event=>{
    if(tracking||seeking)return;
    tracking=true;
    run.disabled=true;slider.disabled=true;
    run.textContent='Recording…';
    state.phase='recording';
    const trusted=event.isTrusted;
    if(trusted)performance.mark('rewind-requested');
    try{
      const sim=await simulation;
      signal.throwIfAborted();
      sim.begin();
      recordings++;
      sim.advance(3);
      await present(sim.sample(),trusted,'Recording physics checkpoints…');
      const launchedAt=performance.now();
      while(current.recorded<ticks&&!signal.aborted){
        const goal=Math.min(ticks,3+Math.max(3,Math.ceil((performance.now()-launchedAt)/(interval*1000))));
        if(goal<=current.recorded){await frame();continue;}
        const batch=Math.min(cadence,goal-current.recorded);
        sim.advance(batch);
        await present(sim.sample(),false,'Recording physics checkpoints…');
      }
      if(signal.aborted)return;
      run.textContent='Run again';
      run.disabled=false;slider.disabled=false;
      state.phase='recorded';
      qs('hint').textContent='Scrub to restore a checkpoint and replay the intervening solver steps.';
      performance.mark('rewind-captured');
    }catch(error){if(!signal.aborted)fail(error);}
    finally{tracking=false;}
  },{signal});

  async function scrub(){
    if(seeking)return;
    seeking=true;
    try{
      const sim=await simulation;
      while(pendingSeek&&!signal.aborted){
        const {tick,trusted}=pendingSeek;
        pendingSeek=null;
        sim.seek(tick);
        const data=sim.sample();
        const delta=data.current-data.source;
        await present(data,trusted,delta
          ?'Restored checkpoint at '+(data.source*interval).toFixed(2)+' s and replayed '+delta+' '+(delta===1?'step.':'steps.')
          :'Restored the checkpoint at '+(data.source*interval).toFixed(2)+' s.');
      }
    }catch(error){if(!signal.aborted)fail(error);}
    finally{seeking=false;}
  }
  slider.addEventListener('input',event=>{
    pendingSeek={tick:Number(slider.value),trusted:event.isTrusted};
    scrub();
  },{signal});
  const observer=new ResizeObserver(()=>{
    if(signal.aborted||!size())return;
    fit();engine.render(0);
  });
  observer.observe(canvas);
  signal.addEventListener('abort',()=>observer.disconnect(),{once:true});
}
