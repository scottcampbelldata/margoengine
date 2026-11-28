import {modelView} from './view.js';
import {openingWidth,resolution} from './operands.js';

const description={
  difference:'Remove the copper tool from the ivory casting to open a stepped lightwell.',
  union:'Fuse the ivory casting with the copper tool. The exposed tool surfaces show what was added.',
  intersection:'Keep the region shared by the casting and tool. It is the volume removed by Carve.',
};
const names={difference:'Carve',union:'Add',intersection:'Overlap'};
const frame=()=>new Promise(resolve=>requestAnimationFrame(resolve));

export async function show({engine,model,generate,canvas,notice,status,signal,size,fail}){
  const view=modelView();
  engine.use(view);
  const qs=id=>document.querySelector('#'+id);
  const radios=[...document.querySelectorAll('[name=operation]')];
  const slider=qs('width'),orbit=qs('orbit'),wire=qs('wire');
  const controls=[slider,orbit,wire,...radios];
  const state=canvas.dataset;
  const compat=engine.gpu.adapterInfo?.vendor==='margo-webgl2';
  qs('route').textContent=compat?'Margo WebGL2':'Margo WebGPU';
  state.renderer=compat?'compatibility':'webgpu';

  let nextMode='difference',current={mode:'difference',width:openingWidth,data:model};
  let pending=null,running=false,first=true;
  function record(){
    const {mode,width,data}=current;
    const degree=Number(orbit.value);
    state.mode=mode;
    state.width=String(width);
    state.orbit=String(degree);
    state.wire=String(wire.checked);
    state.triangles=String(data.triangles);
    state.volume=String(data.volume);
    state.edgeSolves=String(data.edgeSolves);
    state.edgeUses=String(data.cellEdgeUses);
    state.residual=String(data.residual);
    qs('width-value').value=width+' mm';
    qs('orbit-value').value=degree+'°';
    qs('operation').textContent=names[mode];
    qs('description').textContent=description[mode];
    qs('stats').textContent=data.triangles.toLocaleString('en-US')+' triangles · '+resolution+'³ sampling grid';
    canvas.setAttribute('aria-label',names[mode]+' composition of an ivory architectural lightwell cast from a signed distance field');
  }

  async function draw(){
    if(running)return;
    running=true;
    try{
      while(pending&&!signal.aborted){
        const job=pending;
        pending=null;
        if(job.mode!==current.mode||job.width!==current.width){
          const data=await generate(job.mode,job.width);
          signal.throwIfAborted();
          if(pending&&(pending.mode!==job.mode||pending.width!==job.width))continue;
          view.upload(data.vertices);
          current={...job,data};
        }
        view.camera(Number(orbit.value),wire.checked);
        engine.render(0);
        await engine.gpu.queue.onSubmittedWorkDone();
        await frame();
        if(signal.aborted)return;
        record();
        if(job.trusted){
          performance.mark('sharp-input-rendered');
          if(first){first=false;performance.mark('sharp-first-input');}
        }
      }
    }catch(reason){if(!signal.aborted)fail(reason);}
    finally{running=false;}
  }
  function request(event){
    pending={mode:nextMode,width:Number(slider.value),trusted:event.isTrusted};
    draw();
  }

  view.upload(model.vertices);
  engine.render(0);
  await engine.gpu.queue.onSubmittedWorkDone();
  signal.throwIfAborted();
  record();
  status.ready(engine);
  notice.hidden=true;
  controls.forEach(element=>element.disabled=false);
  state.ready='true';
  performance.mark('sharp-ready');

  slider.addEventListener('input',request,{signal});
  orbit.addEventListener('input',request,{signal});
  wire.addEventListener('change',request,{signal});
  for(const radio of radios)radio.addEventListener('change',event=>{
    if(!radio.checked)return;
    nextMode=radio.value;
    request(event);
  },{signal});
  const observer=new ResizeObserver(()=>{
    if(signal.aborted||!size())return;
    if(!pending)pending={mode:nextMode,width:Number(slider.value),trusted:false};
    draw();
  });
  observer.observe(canvas);
  signal.addEventListener('abort',()=>observer.disconnect(),{once:true});
}
