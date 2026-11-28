import {Shadows} from '@margoengine/shadows';
import {createReef} from './reef.js';
import {lightSheet} from './light.js';

const stages=[{name:'Young',age:.37},{name:'Forking',age:.62},{name:'Branching',age:.88},{name:'Mature',age:1.19}];
export async function install(engine,canvas,signal,opening,build,fail){
  const shadows=Shadows.attach(engine,{resolution:1024,cascades:1,distance:26,filter:'pcf'});
  const scene=createReef(engine,opening,shadows),lights=lightSheet(engine);
  engine.scene.background='#275d67';
  engine.lighting.direction.set([-.36,.80,.43,1.92]);
  engine.lighting.radiance.set([1,.94,.81,.72]);
  engine.lighting.ambient.set([.58,.89,1]);
  const controls=document.querySelector('#controls'),state=document.body.dataset;
  const advance=document.querySelector('#advance'),flow=document.querySelector('#flow'),orbit=document.querySelector('#orbit');
  const motion=document.querySelector('#animate'),phase=document.querySelector('#progress'),count=document.querySelector('#stems');
  const flowLabel=document.querySelector('#flow-value'),orbitLabel=document.querySelector('#orbit-value'),status=document.querySelector('#status');
  let epoch=0,settled=0,inFlight=false,period=0,current=0,visibleStage=0,visibleFlow=0,display=opening.evolving;
  let revision=0,time=0,frame=0,previous=0,flowTimer=0,observer;
  motion.checked=!matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fence=()=>engine.gpu.queue.onSubmittedWorkDone();
  function draw(){
    const factor=Math.min(devicePixelRatio,2),width=Math.round(canvas.clientWidth*factor),height=Math.round(canvas.clientHeight*factor);
    if(canvas.width!==width)canvas.width=width;
    if(canvas.height!==height)canvas.height=height;
    const yaw=Number(orbit.value)*Math.PI/180;
    const radius=Math.max(8.1,9.8*height/width),aim=[-.09,.62,-1.16];
    engine.camera.position=[aim[0]+Math.sin(yaw)*radius,2.96,aim[2]+Math.cos(yaw)*radius];
    engine.camera.target=aim;
    lights.set(time,visibleFlow);
    scene.frame(time,visibleFlow);
    engine.render({delta:0});
  }
  function report(){
    const stage=stages[visibleStage];
    phase.textContent=stage.name;count.textContent=display.stems;
    advance.textContent=period===stages.length-1?'Start over':'Advance growth';
    state.stage=String(visibleStage);state.flow=String(visibleFlow);state.stems=String(display.stems);
    state.height=display.height.toFixed(4);state.triangles=String(display.indices.length/3);
    state.revision=String(revision);state.motion=motion.checked?'running':'paused';state.angle=orbit.value;
  }
  function animate(now){
    frame=0;
    if(!motion.checked||document.hidden||signal.aborted){previous=0;return;}
    time+=previous?Math.min(.045,(now-previous)/1000):0;
    previous=now;
    try{draw();}catch(error){fail(error);return;}
    frame=requestAnimationFrame(animate);
  }
  function run(){if(motion.checked&&!frame&&!document.hidden&&!signal.aborted)frame=requestAnimationFrame(animate);}
  async function refresh(){
    if(inFlight||signal.aborted)return;
    inFlight=true;const target=epoch,stage=period,water=current;
    status.textContent='Growing the current colony…';
    try{
      const result=await build({age:stages[stage].age,current:water});
      if(target!==epoch||signal.aborted)return;
      display=result.evolving;visibleStage=stage;visibleFlow=water;
      scene.replace(display);draw();await fence();
      if(signal.aborted)return;
      revision++;report();
      status.textContent=stage===3?'The mature colony supports a full set of branch tips.':'Each stage grows new tips from attached branches.';
      if(!performance.getEntriesByName('coral-control-applied').length)performance.mark('coral-control-applied');
    }catch(error){fail(error);}
    finally{
      inFlight=false;settled=target;
      if(epoch!==settled)void refresh();
    }
  }
  function change(){epoch++;void refresh();}
  await shadows.ready;
  draw();
  await fence();
  return {
    connect(){
      state.renderer=engine.gpu.adapterInfo?.vendor==='margo-webgl2'?'webgl2':'webgpu';
      report();
      const options={signal};
      advance.addEventListener('click',()=>{period=(period+1)%stages.length;change();},options);
      flow.addEventListener('input',()=>{
        const value=Number(flow.value);
        flowLabel.value=value===0?'Calm':Math.abs(value)+'% '+(value>0?'east':'west');
        clearTimeout(flowTimer);flowTimer=setTimeout(()=>{current=value/100;change();},76);
      },options);
      orbit.addEventListener('input',()=>{
        orbitLabel.value=orbit.value+'°';report();draw();
      },options);
      motion.addEventListener('input',()=>{report();run();},options);
      document.addEventListener('visibilitychange',run,options);
      observer=new ResizeObserver(()=>{
        const factor=Math.min(devicePixelRatio,2);
        if(canvas.width!==Math.round(canvas.clientWidth*factor)||canvas.height!==Math.round(canvas.clientHeight*factor)){
          try{draw();}catch(error){fail(error);}
        }
      });
      observer.observe(canvas);
      document.querySelector('#loading').hidden=true;controls.disabled=false;state.ready='true';
      performance.mark('margo-first-usable-frame');
      setTimeout(run,320);
    },
    dispose(){clearTimeout(flowTimer);cancelAnimationFrame(frame);observer?.disconnect();lights.dispose();shadows.dispose();scene.dispose();}
  };
}
