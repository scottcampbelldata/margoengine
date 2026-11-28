import {tileSample} from './field.js';
import {specimenView} from './view.js';

const labels={
  terrain:{head:'Height field',equation:'N(x, y)',detail:'Relief',range:[15,95],
    alt:'Procedural island on a bronze display plinth',
    caption:'Height from two coordinates. The bright contour lines follow equal elevation.'},
  cloud:{head:'Density volume',equation:'N(x, y, z)',detail:'Slice height',range:[0,100],
    alt:'Procedural cloud in a display chamber with a green horizontal density section',
    caption:'Density from three coordinates. Move the green plane to cut a horizontal section through the plume.'},
  tile:{head:'Periodic material',equation:'N(x, y, z, w)',detail:'Tile phase',range:[0,100],
    alt:'Two rows of three repeating four-dimensional noise tiles in a bronze frame',
    caption:'Two circular coordinate pairs make a seamless texture. All six copies move together when you change phase.'},
};
const nextFrame=()=>new Promise(resolve=>requestAnimationFrame(resolve));

export async function show({engine,canvas,notice,status,size,signal,fail}){
  const view=specimenView(signal);
  engine.use(view);
  const qs=selector=>document.querySelector(selector);
  const dataset=canvas.dataset;
  const route=qs('#route'),frequency=qs('#frequency'),detail=qs('#detail');
  const radios=[...document.querySelectorAll('[name=mode]')];
  const inputs=[frequency,detail,...radios];
  const compatibility=engine.gpu.adapterInfo?.vendor==='margo-webgl2';
  route.textContent=compatibility?'Margo WebGL2':'Margo WebGPU';
  dataset.renderer=compatibility?'compatibility':'webgpu';

  let selected='terrain',first=true,queued=null,running=false,deferredResize=false;
  const detailValues={terrain:65,cloud:46,tile:0};
  function note(mode,scale,amount,data){
    const info=labels[mode];
    canvas.setAttribute('aria-label',info.alt);
    qs('#specimen').textContent=info.head;
    qs('#coordinates').textContent=info.equation;
    qs('#description').textContent=info.caption;
    qs('#detail-label').textContent=info.detail;
    qs('#frequency-value').value=scale.toFixed(1)+'×';
    qs('#detail-value').value=Math.round(amount*100)+'%';
    dataset.mode=mode;
    dataset.frequency=scale.toFixed(1);
    dataset.detail=amount.toFixed(2);
    dataset.elevation=data.relief.toFixed(6);
    dataset.triangles=String(data.triangles);
    if(mode==='cloud')dataset.density=String(data.cloudSum);
    if(mode==='tile'){
      const points=[.135,.317,.502,.661,.812];
      const seams=Math.max(...points.flatMap(x=>[Math.abs(tileSample(0,x,scale,amount)-tileSample(1,x,scale,amount)),
        Math.abs(tileSample(x,0,scale,amount)-tileSample(x,1,scale,amount))]));
      dataset.seamDelta=String(seams);
      dataset.woodBake='128x128';
    }
  }
  async function redraw(){
    if(running)return;
    running=true;
    try{
      while(queued&&!signal.aborted){
        const job=queued;
        queued=null;
        const {mode,scale,amount,trusted}=job;
        const data=mode==='tile'?await view.prepare(mode,scale,amount):view.set(mode,scale,amount);
        signal.throwIfAborted();
        engine.render(0);
        await engine.gpu.queue.onSubmittedWorkDone();
        await nextFrame();
        if(signal.aborted)return;
        note(mode,scale,amount,data);
        if(trusted){
          performance.mark('noise-input-rendered');
          if(first){first=false;performance.mark('noise-first-input');}
        }
      }
      if(deferredResize&&!signal.aborted){deferredResize=false;engine.render(0);}
    }catch(reason){if(!signal.aborted)fail(reason);}
    finally{running=false;}
  }
  function request(event){
    queued={mode:selected,scale:Number(frequency.value),amount:detailValues[selected]/100,trusted:event.isTrusted};
    redraw();
  }

  const opening=view.set('terrain',2.4,.65);
  performance.mark('noise-data');
  engine.render(0);
  await engine.gpu.queue.onSubmittedWorkDone();
  signal.throwIfAborted();
  status.ready(engine);
  notice.hidden=true;
  note('terrain',2.4,.65,opening);
  inputs.forEach(input=>input.disabled=false);
  dataset.ready='true';
  performance.mark('noise-ready');

  frequency.addEventListener('input',request,{signal});
  detail.addEventListener('input',event=>{
    detailValues[selected]=Number(detail.value);
    request(event);
  },{signal});
  for(const radio of radios)radio.addEventListener('change',event=>{
    if(!radio.checked)return;
    selected=radio.value;
    const [lo,hi]=labels[selected].range;
    detail.min=String(lo);detail.max=String(hi);
    detail.value=String(detailValues[selected]);
    request(event);
  },{signal});
  const observer=new ResizeObserver(()=>{
    if(signal.aborted||!size())return;
    if(running){deferredResize=true;return;}
    engine.render(0);
  });
  observer.observe(canvas);
  signal.addEventListener('abort',()=>observer.disconnect(),{once:true});
}
