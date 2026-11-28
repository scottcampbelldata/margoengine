import {prepare} from './model.js';
import {paintTarget,paintLayer} from './paint.js';
import {productView} from './view.js';

export {prepare};
const frame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
const range=(value,min,max)=>Math.max(min,Math.min(max,value));

export async function show({engine,kit,canvas,notice,status,size,signal,fail}){
  const erase=document.querySelector('#erase'), undo=document.querySelector('#undo'),reset=document.querySelector('#reset');
  const diameter=document.querySelector('#diameter'), rotation=document.querySelector('#rotation');
  const diameterValue=document.querySelector('#diameter-value'), rotationValue=document.querySelector('#rotation-value');
  const pigments=[...document.querySelectorAll('[name="pigment"]')], guide=document.querySelector('#guide');
  const cursor=document.querySelector('#cursor'), phone=matchMedia('(max-width:650px)');
  const compat=engine.gpu.adapterInfo?.vendor==='margo-webgl2';
  const paint=paintLayer(kit.source),pick=paintTarget(kit);
  const instructions='Paint the shell. Turn the model to reach the back. Keyboard: arrows to aim, Space to paint.';
  let pointer=null, pencilX=.53,pencilY=.34, erasing=false, pigment='blue';
  let active=false,dirty=false,requested=0,first=true,pressedPaint=false;
  const state=canvas.dataset;

  document.querySelector('#route').textContent=compat?'Margo WebGL2':'Margo WebGPU';
  state.renderer=compat?'compatibility':'webgpu';
  state.triangles=String(kit.indices.length/3);
  engine.scene.background='#343d38';
  engine.use(productView(kit,paint));
  signal.addEventListener('abort',()=>paint.texture.dispose(),{once:true});

  function camera(){
    const yaw=(34+ +rotation.value)*Math.PI/180, distance=phone.matches?.742:.762;
    engine.camera.position=[Math.sin(yaw)*distance,.270,Math.cos(yaw)*distance];
    engine.camera.target=[0,.146,0];
    engine.camera.fov=phone.matches?32:31;
  }
  function labels(){
    diameterValue.value=diameter.value+' px';
    rotationValue.value=rotation.value+'°';
    undo.disabled=!paint.hasUndo;
    reset.disabled=!paint.edited;
    erase.setAttribute('aria-pressed',String(erasing));
    state.eraser=String(erasing);
    state.pigment=pigment;
  }
  function stamp(event,x,y){
    const uv=pick(engine.camera,x,y,canvas.width/canvas.height);
    paint.at(uv,+diameter.value/2,erasing?'eraser':pigment);
    if(uv){
      pressedPaint||=event.isTrusted;
      state.pick=uv.map(value=>value.toFixed(4)).join(',');
      update();
    }
    return uv;
  }
  function screen(event){
    const rect=canvas.getBoundingClientRect();
    return [(event.clientX-rect.left)/rect.width,(event.clientY-rect.top)/rect.height];
  }
  function draw(){
    const patched=paint.upload();
    const used=pressedPaint&&patched;
    if(patched)pressedPaint=false;
    engine.render(0);
    state.textureRevision=String(paint.revision);
    state.angle=rotation.value;
    state.patch=paint.region?Object.values(paint.region).join(','):'';
    return used;
  }
  function schedule(){
    if(requested||active||signal.aborted)return;
    requested=requestAnimationFrame(async()=>{
      requested=0;
      if(signal.aborted)return;
      active=true;
      dirty=false;
      try{
        const used=draw();
        await engine.gpu.queue.onSubmittedWorkDone();
        if(signal.aborted)return;
        if(used){
          await frame();
          if(signal.aborted)return;
          performance.mark('model-paint-stroke-rendered');
          if(first){
            first=false;
            performance.mark('model-paint-first-input');
          }
        }
        performance.mark('model-paint-view-rendered');
      }catch(reason){
        fail(reason);
      }finally{
        active=false;
        if(dirty)schedule();
      }
    });
  }
  function update(){
    dirty=true;
    schedule();
  }
  function end(){
    if(pointer===null)return;
    pointer=null;
    paint.finish();
    labels();
  }
  canvas.addEventListener('pointerdown',event=>{
    if(!state.ready||pointer!==null||event.button!==0)return;
    event.preventDefault();
    cursor.hidden=true;
    const [x,y]=screen(event);
    if(!pick(engine.camera,x,y,canvas.width/canvas.height)){
      guide.textContent='The enamel takes pigment. The visor, hardware and plinth stay clear.';
      return;
    }
    paint.stroke();
    pointer=event.pointerId;
    canvas.setPointerCapture(pointer);
    stamp(event,x,y);
    guide.textContent=instructions;
  },{signal});
  canvas.addEventListener('pointermove',event=>{
    if(event.pointerId!==pointer)return;
    const samples=event.getCoalescedEvents?.();
    for(const sample of samples?.length?samples:[event])stamp(event,...screen(sample));
  },{signal});
  for(const event of ['pointerup','pointercancel','lostpointercapture']){
    canvas.addEventListener(event,ending=>{if(ending.pointerId===pointer)end();},{signal});
  }
  canvas.addEventListener('keydown',event=>{
    if(!state.ready||pointer!==null)return;
    const movement={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[event.key];
    if(!movement&&event.key!==' ')return;
    event.preventDefault();
    if(movement){
      const step=event.shiftKey?.044:.014;
      pencilX=range(pencilX+movement[0]*step,.03,.97);
      pencilY=range(pencilY+movement[1]*step,.03,.97);
    }else{
      paint.stroke();
      stamp(event,pencilX,pencilY);
      paint.finish();
      labels();
    }
    cursor.hidden=false;
    cursor.style.left=pencilX*100+'%';
    cursor.style.top=pencilY*100+'%';
  },{signal});
  canvas.addEventListener('blur',()=>{cursor.hidden=true;},{signal});
  for(const swatch of pigments)swatch.addEventListener('change',()=>{
    if(!swatch.checked)return;
    pigment=swatch.value;
    erasing=false;
    labels();
  },{signal});
  erase.addEventListener('click',()=>{end();erasing=!erasing;labels();},{signal});
  undo.addEventListener('click',()=>{end();if(paint.undo()){labels();update();}},{signal});
  reset.addEventListener('click',()=>{end();if(paint.reset()){labels();update();}},{signal});
  diameter.addEventListener('input',labels,{signal});
  rotation.addEventListener('input',()=>{end();camera();labels();update();},{signal});

  camera();
  draw();
  performance.mark('model-paint-submitted');
  await engine.gpu.queue.onSubmittedWorkDone();
  signal.throwIfAborted();
  await frame();
  if(status.ready()){
    notice.hidden=true;
    for(const control of [erase,...pigments,diameter,rotation])control.disabled=false;
    guide.textContent=instructions;
    labels();
    performance.mark('model-paint-ready');
  }
  const observer=new ResizeObserver(()=>{
    if(!size())return;
    end();
    camera();
    update();
  });
  observer.observe(canvas);
  signal.addEventListener('abort',()=>{observer.disconnect();cancelAnimationFrame(requested);},{once:true});
}
