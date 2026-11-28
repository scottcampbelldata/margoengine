import {makeBench} from './art.js';
import {fixedDelta,stopAngle} from './layout.js';

const id=name=>document.getElementById(name);
export async function connect(engine,canvas,source,signal,fail){
  const data=document.body.dataset,art=makeBench(engine);
  const labels=[id('left'),id('right')],limits=stopAngle*180/Math.PI;
  const target=[false,false];
  let rig,format,offset=0,timer=0,frame=0,before=0,carry=0,debug=null,resize,showDebug=false,segments=0;
  let receipt=null,working=false,queuedDrive=false;
  engine.scene.background='#35444c';
  engine.lighting.direction.set([-.445,.73,.49,2.78]);
  engine.lighting.radiance.set([1,.90,.76,.96]);
  engine.lighting.ambient.set([.74,.85,.96]);
  engine.camera.project=(m,aspect,webgpu)=>{
    const span=Math.max(2.99,5.28/aspect),{near,far}=engine.camera,d=far-near;
    m[0]=2/(span*aspect);m[5]=2/span;
    m[10]=webgpu?1/d:-2/d;
    m[14]=webgpu?far/d:-(far+near)/d;m[15]=1;
  };
  function fit(){
    const ratio=Math.min(devicePixelRatio,2);
    const width=Math.max(1,Math.round(canvas.clientWidth*ratio));
    const height=Math.max(1,Math.round(canvas.clientHeight*ratio));
    if(canvas.width!==width)canvas.width=width;
    if(canvas.height!==height)canvas.height=height;
  }
  function metrics(){
    const angles=rig.angles(),mm=Math.round(rig.chainOffset()*1000);
    id('angle-left').value=angles[0].toFixed(1)+'°';
    id('angle-right').value=angles[1].toFixed(1)+'°';
    id('swing').value=mm+' mm';
    data.angles=angles.map(angle=>angle.toFixed(3)).join(',');
    data.offset=String(mm);
    data.debug=String(showDebug);
    data.lines=String(segments);
    data.motion=working?'moving':'rest';
    return {angles,mm};
  }
  function paint(){
    signal.throwIfAborted();
    fit();
    if(rig)art.sync(rig);
    if(debug)segments=debug.draw(showDebug);
    engine.render({delta:0});
    if(rig)return metrics();
  }
  async function fence(){
    if(engine.gpu)await engine.gpu.queue.onSubmittedWorkDone();
    else canvas.getContext('webgl2').finish();
  }
  function wake(seconds){
    timer=Math.max(timer,seconds);
    if(frame)return;
    working=true;before=0;carry=0;
    frame=requestAnimationFrame(tick);
  }
  function tick(now){
    frame=0;
    if(signal.aborted)return;
    try{
      const delta=before?Math.min(.056,(now-before)/1000):1/60;
      before=now;timer-=delta;carry+=delta;
      while(carry>=fixedDelta){rig.step();carry-=fixedDelta;}
      working=timer>0;
      const {angles,mm}=paint();
      if(receipt&&receipt({angles,mm})){
        receipt=null;
        void fence().then(()=>{
          if(!signal.aborted&&!performance.getEntriesByName('margo-first-input-rendered').length)
            performance.mark('margo-first-input-rendered');
        }).catch(fail);
      }
      if(working)frame=requestAnimationFrame(tick);
    }catch(error){fail(error);}
  }
  function renames(){
    const both=target.some(Boolean);
    for(const [i,button] of labels.entries())button.textContent=(target[i]?'Close ':'Open ')+(i===0?'left':'right');
    id('drive').firstChild.textContent=both?'Close both doors ':'Open both doors ';
    data.command=target.map(open=>Number(open)).join(',');
  }
  function door(index,trusted){
    const open=index===null?!target.some(Boolean):!target[index];
    const starting=rig.angles();
    if(index===null)target.fill(open);
    else target[index]=open;
    rig.drive(index,open);
    if(trusted)receipt??=({angles})=>angles.some((angle,i)=>Math.abs(angle-starting[i])>=.45);
    id('status').textContent=open?'Motors drive past '+limits.toFixed(1)+'°. The hinge stops set the final angle.':'Motors return the doors to the closed stops.';
    renames();
    wake(2.4);
  }
  const listening={signal};
  id('drive').addEventListener('click',event=>{
    if(rig){door(null,event.isTrusted);return;}
    queuedDrive=event.isTrusted;
    id('drive').disabled=true;
    id('loading').textContent='Doors queued. Loading the joint solver…';
  },listening);
  for(const [index,button] of labels.entries())button.addEventListener('click',event=>door(index,event.isTrusted),listening);
  id('tap').addEventListener('click',event=>{
    const start=rig.chainOffset()*1000;
    rig.tap();
    if(event.isTrusted)receipt??=({mm})=>Math.abs(mm-start)>=5;
    id('status').textContent='Impulse applied to the pendulum. Five ball joints limit its motion.';
    wake(7);
  },listening);
  id('debug').addEventListener('change',async event=>{
    const field=event.currentTarget;
    showDebug=field.checked;
    if(showDebug&&!debug){
      field.disabled=true;
      try{
        const {jointOverlay}=await import('./debug.js');
        signal.throwIfAborted();
        debug=jointOverlay(engine);
        debug.use(rig.world);
      }catch(error){if(!signal.aborted)fail(error);}
      finally{field.disabled=false;}
    }
    if(!signal.aborted)paint();
  },listening);
  id('reset').addEventListener('click',()=>{
    cancelAnimationFrame(frame);
    frame=0;working=false;timer=0;receipt=null;
    rig.dispose();
    rig=format.createWorkshop();
    debug?.use(rig.world);
    target.fill(false);
    renames();
    id('status').textContent='The hinge stops are at '+limits.toFixed(1)+'°.';
    paint();
  },listening);
  paint();
  data.renderer=engine.backend;
  data.driveReady='true';
  id('drive').disabled=false;
  format=await source;
  signal.throwIfAborted();
  rig=format.createWorkshop();
  if(queuedDrive)door(null,true);
  paint();
  await fence();
  signal.throwIfAborted();
  data.renderer=engine.backend;
  data.ready='true';
  byReady();
  function byReady(){
    renames();
    performance.mark('margo-first-usable-frame');
    id('loading').hidden=true;
    id('drive').disabled=false;
    id('secondary').inert=false;
  }
  resize=new ResizeObserver(()=>{if(!working&&!signal.aborted)paint();});
  resize.observe(canvas);
  return {dispose(){
    cancelAnimationFrame(frame);
    resize.disconnect();
    debug?.dispose();
    rig.dispose();
  }};
}
