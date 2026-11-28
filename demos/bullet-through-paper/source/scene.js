import {buildStation} from './station.js';
import {divider,openingPose,sampleLimit} from './experiment.js';

const afterFrame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
const pace=330;
const opening=[openingPose()];
const describe=(side,index)=>{
  if(index===0)return 'Start pose';
  if(side.position[0]>divider[0])return 'Crossed divider';
  if(index===sampleLimit)return 'Kept on approach side';
  return side.contacts>0?'At divider':'Approaching';
};

export async function show({bench,physics,canvas,notice,status,signal,fail,onResize}){
  const qs=id=>document.querySelector('#'+id);
  const run=qs('run'),replay=qs('replay'),steps=qs('samples');
  const state=canvas.dataset;
  const engine=bench.engine,compat=bench.renderer==='compatibility';
  const stage=buildStation(engine,mesh=>bench.add(mesh));
  qs('route').textContent=compat?'Margo WebGL2':'Margo WebGPU';
  const draw=async()=>{
    await bench.render(0);
    if(engine.gpu)await engine.gpu.queue.onSubmittedWorkDone();
  };
  let trace={discrete:opening,continuous:opening},busy=false,first=true;
  let timer,requestId=0,runCount=0;

  // The bench frames the rig along the opening view direction at any aspect; the box leaves out the 140 m floor.
  const fit=()=>bench.fit({fill:.9,bounds:{min:[-3.6,-.45,-1.85],max:[3.6,.85,1.85]}});
  function stopReplay(){
    clearTimeout(timer);
    const playing=replay.getAttribute('aria-pressed')==='true';
    replay.setAttribute('aria-pressed','false');
    replay.textContent='Replay samples';
    return playing;
  }
  function record(i){
    const a=trace.discrete[i],b=trace.continuous[i];
    steps.value=String(i);
    qs('sample-number').value=i+' / '+sampleLimit;
    qs('outcome-a').textContent=describe(a,i);
    qs('outcome-b').textContent=describe(b,i);
    qs('detail').textContent=!runCount?'Run both blocks from the same initial pose.':
      i===sampleLimit&&a.position[0]>divider[0]&&b.position[0]<=0?
      'The unswept block crossed while the swept block stayed on the approach side.':
      i===0?'The two lanes share the same starting pose.':
      'The dots show the previous sampled poses.';
    state.index=String(i);
    state.discreteX=a.position[0].toFixed(7);
    state.continuousX=b.position[0].toFixed(7);
    state.swept=String(b.sweep);
    state.discreteContact=String(a.contacts);
    state.continuousContact=String(b.contacts);
    state.runs=String(runCount);
  }
  async function present(i,mark){
    const id=++requestId;
    stage.set(trace,i);
    await draw();
    await afterFrame();
    if(id!==requestId||signal.aborted)return;
    record(i);
    if(mark){
      performance.mark('divider-input-rendered');
      if(first){first=false;performance.mark('divider-first-input');}
    }
  }

  await fit();
  await draw();
  signal.throwIfAborted();
  record(0);
  status.ready(engine);
  notice.hidden=true;
  run.disabled=false;
  state.ready='true';
  performance.mark('divider-ready');


  run.addEventListener('click',async event=>{
    if(busy)return;
    stopReplay();
    busy=true;run.disabled=true;replay.disabled=true;steps.disabled=true;
    run.textContent='Comparing…';
    const trusted=event.isTrusted;
    if(trusted)performance.mark('divider-requested');
    try{
      const result=await physics.run();
      signal.throwIfAborted();
      trace=result;
      runCount++;
      await present(sampleLimit,trusted);

      if(signal.aborted)return;
      run.textContent='Run comparison';
      run.disabled=false;replay.disabled=false;steps.disabled=false;
    }catch(error){if(!signal.aborted)fail(error);}
    finally{busy=false;}
  },{signal});

  replay.addEventListener('click',event=>{
    if(stopReplay())return;
    replay.setAttribute('aria-pressed','true');
    replay.textContent='Pause';
    const trusted=event.isTrusted;
    async function play(i){
      if(signal.aborted||replay.getAttribute('aria-pressed')!=='true')return;
      try{
        await present(i,i===0&&trusted);
        if(signal.aborted||replay.getAttribute('aria-pressed')!=='true')return;
        if(i===sampleLimit)stopReplay();
        else timer=setTimeout(()=>play(i+1),pace);
      }catch(error){if(!signal.aborted)fail(error);}
    }
    play(0);
  },{signal});
  steps.addEventListener('input',event=>{
    stopReplay();
    present(Number(steps.value),event.isTrusted).catch(fail);
  },{signal});
  onResize(()=>{if(!signal.aborted)fit().then(()=>bench.request(),fail);});
  signal.addEventListener('abort',()=>clearTimeout(timer),{once:true});
}
