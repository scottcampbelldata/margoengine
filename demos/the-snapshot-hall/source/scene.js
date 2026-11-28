import {makeHall} from './archive.js';
import {hallView} from './view.js';

const afterFrame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
const about={
  snapshot:'Replay one recorded GPU bundle. The hall’s parts keep their original draw commands.',
  direct:'Encode a separate draw for every part, using the same meshes and camera.',
  batch:'Draw each shape group as one indexed instanced batch.',
};
export async function show({engine,canvas,notice,status,signal,size,fail}){
  const query=id=>document.querySelector('#'+id);
  const choices=[...document.querySelectorAll('[name=mode]')];
  const slider=query('position'),state=canvas.dataset;
  const compat=engine.gpu.adapterInfo?.vendor==='margo-webgl2';
  const hall=makeHall();
  const renderer=hallView(hall);
  engine.use(renderer);
  performance.mark('snapshot-geometry');
  const format=new Intl.NumberFormat('en-US');
  state.renderer=compat?'compatibility':'webgpu';
  state.parts=String(hall.parts);
  state.triangles=String(hall.triangles);
  state.batches=String(hall.ranges.length);
  query('parts').textContent=format.format(hall.parts);
  query('route').textContent=compat?'Margo WebGL2':'Margo WebGPU';
  query('runtime').textContent=compat?'Compatibility replays this list as WebGL2 draws.':'The GPU pass executes the recorded list.';
  let mode='snapshot',first=true,running=false,queued=null;

  function publish(frameMode,position){
    const frame=renderer.stats();
    state.mode=frameMode;
    state.position=String(position);
    state.calls=String(frame.calls);
    state.recording=String(frame.recordCount);
    state.recordedDraws=String(frame.draws);
    state.encodeTime=String(frame.milliseconds);
    query('commands').textContent=format.format(frame.calls);
    query('encoding').textContent=frame.milliseconds===0?'Under timer':frame.milliseconds.toFixed(2)+' ms';
    query('description').textContent=about[frameMode];
    query('movement').value=(position*.129).toFixed(1)+' m';
    query('runtime').hidden=frameMode!=='snapshot';
  }
  async function draw(){
    if(running)return;
    running=true;
    try{
      while(queued&&!signal.aborted){
        const {frameMode,position,trusted}=queued;
        queued=null;
        renderer.configure(frameMode,position);
        engine.render(0);
        await engine.gpu.queue.onSubmittedWorkDone();
        await afterFrame();
        if(signal.aborted)return;
        publish(frameMode,position);
        if(trusted){
          performance.mark('snapshot-input-rendered');
          if(first){first=false;performance.mark('snapshot-first-input');}
        }
      }
    }catch(error){if(!signal.aborted)fail(error);}
    finally{running=false;}
  }
  function request(event){
    queued={frameMode:mode,position:Number(slider.value),trusted:event?.isTrusted??false};
    draw();
  }
  engine.render(0);
  await engine.gpu.queue.onSubmittedWorkDone();
  signal.throwIfAborted();
  publish(mode,0);
  status.ready(engine);
  notice.hidden=true;
  slider.disabled=false;
  choices.forEach(control=>control.disabled=false);
  state.ready='true';
  performance.mark('snapshot-ready');

  slider.addEventListener('input',request,{signal});
  for(const input of choices)input.addEventListener('change',event=>{
    if(!input.checked)return;
    mode=input.value;
    request(event);
  },{signal});
  const observer=new ResizeObserver(()=>{if(!signal.aborted&&size())request();});
  observer.observe(canvas);
  signal.addEventListener('abort',()=>observer.disconnect(),{once:true});
}
