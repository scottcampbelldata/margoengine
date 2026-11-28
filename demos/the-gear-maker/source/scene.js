import {Shadows} from '@margoengine/shadows';
import {bench} from './machine.js';

const keys=['a','b','c','d'],stock={a:20,b:39,c:23,d:48},close={a:33,b:33,c:28,d:36};
const tau=Math.PI*2;
export async function connect(engine,canvas,signal,initial,build,fail){
  engine.scene.background='#3a474b';
  engine.lighting.direction.set([-2.3,4.2,6.6,2.98]);
  engine.lighting.radiance.set([1,.90,.79,.72]);
  engine.lighting.ambient.set([.78,.91,1]);
  const lighting=Shadows.attach(engine,{resolution:1024,cascades:1,distance:17,filter:'pcf'});
  const machine=bench(engine,lighting),controls=document.querySelector('#controls'),state=document.body.dataset;
  const alternate=document.querySelector('#alternate'),rotation=document.querySelector('#rotation');
  const running=document.querySelector('#running'),ratio=document.querySelector('#ratio'),reduction=document.querySelector('#reduction');
  const rotationLabel=document.querySelector('#rotation-value'),status=document.querySelector('#status');
  const fields=Object.fromEntries(keys.map(id=>[id,document.getElementById(id)]));
  const modes=[...controls.querySelectorAll('[data-mode]')];
  let selected=initial.counts,snapshot=initial,preset=false,target=0,published=0,busy=false,revision=0;
  let mode='all',angle=0,frame=0,last=0,observer,bearing=.20,drag=null;
  running.checked=!matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fence=()=>engine.gpu.queue.onSubmittedWorkDone();
  function report(){
    ratio.textContent=snapshot.ratio.toFixed(4)+'×';
    reduction.textContent=(1/snapshot.ratio).toFixed(2)+' to 1';
    alternate.textContent=preset?'Fit the original ratio':'Fit a closer ratio';
    state.teeth=keys.map(s=>snapshot.counts[s]).join(',');
    state.triangles=String(snapshot.meshes.reduce((sum,p)=>sum+p.indices.length/3,0));
    state.ratio=snapshot.ratio.toFixed(8);state.mode=mode;
    state.revision=String(revision);state.motion=running.checked?'running':'paused';
    for(const button of modes)button.setAttribute('aria-pressed',String(button.dataset.mode===mode));
  }
  function draw(receipt=false){
    const scale=Math.min(devicePixelRatio,2),width=Math.round(canvas.clientWidth*scale),height=Math.round(canvas.clientHeight*scale);
    if(canvas.width!==width)canvas.width=width;
    if(canvas.height!==height)canvas.height=height;
    const radius=Math.max(7.2,10.55*height/width);
    engine.camera.position=[Math.sin(bearing)*radius,2.65,radius*Math.cos(bearing)];
    engine.camera.target=[0,0,-.2];
    machine.isolate(mode);
    const actual=machine.drive(angle);
    const degrees=Math.abs(angle-tau)<1e-8?360:Math.round((angle*180/Math.PI%360+360)%360);
    rotation.value=String(degrees);rotationLabel.value=degrees+'°';
    if(receipt){
      state.inputAngle=angle.toFixed(6);
      state.wheelAngles=keys.map(key=>actual[key].toFixed(6)).join(',');
    }
    engine.render({delta:0});
  }
  function spin(now){
    frame=0;
    if(!running.checked||document.hidden||signal.aborted){last=0;return;}
    angle+=last?Math.min(.058,(now-last)/1000)*.72:0;last=now;
    try{draw();}
    catch(error){fail(error);return;}
    frame=requestAnimationFrame(spin);
  }
  function run(){if(!frame&&running.checked&&!signal.aborted&&!document.hidden)frame=requestAnimationFrame(spin);}
  async function update(){
    if(busy||signal.aborted)return;
    busy=true;const generation=target,counts={...selected};
    status.textContent='Cutting the new involute profiles…';
    try{
      const data=await build(counts);
      if(signal.aborted||target!==generation)return;
      snapshot=data;machine.install(snapshot);draw(true);await fence();
      if(signal.aborted)return;
      revision++;report();
      status.textContent='Both meshes use '+(snapshot.module*1000).toFixed(0)+' mm module at their exact pitch-center spacing.';
      if(!performance.getEntriesByName('gear-control-applied').length)performance.mark('gear-control-applied');
    }catch(error){fail(error);}
    finally{
      published=generation;busy=false;
      if(target!==published)void update();
    }
  }
  function queue(counts){selected=counts;target++;void update();}
  function select(counts){
    for(const key of keys)fields[key].value=String(counts[key]);
    queue(counts);
  }
  machine.install(initial);await lighting.ready;draw(true);await fence();
  state.renderer=engine.gpu.adapterInfo?.vendor==='margo-webgl2'?'webgl2':'webgpu';report();
  const options={signal};
  alternate.addEventListener('click',()=>{preset=!preset;select(preset?close:stock);},options);
  for(const key of keys)fields[key].addEventListener('change',()=>{
    const input=fields[key],value=input.valueAsNumber;
    if(!Number.isInteger(value)||value<Number(input.min)||value>Number(input.max)){
      input.value=String(selected[key]);status.textContent='Use a whole tooth count within the displayed range.';return;
    }
    if(value!==selected[key])queue({...selected,[key]:value});
  },options);
  for(const button of modes)button.addEventListener('click',()=>{
    mode=button.dataset.mode;report();
    try{draw(true);}catch(error){fail(error);}
  },options);
  rotation.addEventListener('input',()=>{
    running.checked=false;angle=Number(rotation.value)*Math.PI/180;report();draw(true);
  },options);
  running.addEventListener('input',()=>{report();run();},options);
  canvas.addEventListener('pointerdown',event=>{
    if(drag)return;
    drag={pointer:event.pointerId,x:event.clientX,start:bearing};
    canvas.setPointerCapture(event.pointerId);
  },options);
  canvas.addEventListener('pointermove',event=>{
    if(drag?.pointer!==event.pointerId)return;
    bearing=Math.max(-.40,Math.min(.46,drag.start+(event.clientX-drag.x)*.0038));
    draw();
  },options);
  for(const type of ['pointerup','pointercancel','lostpointercapture'])canvas.addEventListener(type,event=>{
    if(drag?.pointer===event.pointerId)drag=null;
  },options);
  document.addEventListener('visibilitychange',run,options);
  observer=new ResizeObserver(()=>{
    const scale=Math.min(devicePixelRatio,2);
    if(canvas.width!==Math.round(canvas.clientWidth*scale)||canvas.height!==Math.round(canvas.clientHeight*scale))draw();
  });
  observer.observe(canvas);
  document.querySelector('#loading').hidden=true;controls.disabled=false;state.ready='true';
  performance.mark('margo-first-usable-frame');
  setTimeout(run,350);
  return {dispose(){cancelAnimationFrame(frame);observer?.disconnect();lighting.dispose();machine.dispose();}};
}
