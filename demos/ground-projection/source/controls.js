const read=id=>document.getElementById(id),slider=read('orbit'),state=document.body.dataset;
const choices=[...document.querySelectorAll('[data-mode]')],home=-37;
const explanations={
  ground:'Grounded projection keeps the asphalt anchored beside the tires as the camera moves.',
  sphere:'The same photograph is drawn on an infinite sphere. The pavement moves with the view.'
};

export async function connectProjection(engine,canvas,signal,drawFrame,done,disposeBackend){
  let mode='ground',orbit=home,revision=0,completed=0,request,busy,observer,drag,needsPaint=false;
  function size(){
    const scale=Math.min(1.75,Math.max(1,devicePixelRatio||1));
    return [Math.round(canvas.clientWidth*scale),Math.round(canvas.clientHeight*scale)];
  }
  function draw(){
    const [width,height]=size();
    if(canvas.width!==width)canvas.width=width;
    if(canvas.height!==height)canvas.height=height;
    const phone=canvas.clientWidth<650,yaw=orbit*Math.PI/180,distance=phone?7.98:7.15;
    engine.camera.position=[distance*Math.sin(yaw),phone?2.06:1.92,distance*Math.cos(yaw)];
    engine.camera.target=[0,.64,0];engine.camera.fov=phone?41:36;
    drawFrame(mode);
    for(const button of choices)button.setAttribute('aria-pressed',String(button.dataset.mode===mode));
    const clean=Math.round(orbit);slider.value=String(clean);
    read('orbit-number').value=(clean<0?'−'+(-clean):String(clean))+'°';
    read('method').textContent=explanations[mode];
    state.mode=mode;state.orbit=String(clean);
  }
  function schedule(){
    if(request||busy||signal.aborted)return;
    request=requestAnimationFrame(async ()=>{
      request=undefined;busy=true;
      const next=revision;needsPaint=false;
      try{
        draw();
        await done();
        if(signal.aborted)return;
        completed=next;state.revision=String(completed);
        if(next&&!performance.getEntriesByName('ground-control-applied').length)performance.mark('ground-control-applied');
      }catch(error){engine.onError(error);}
      finally{busy=false;}
      if(needsPaint||revision!==completed)schedule();
    });
  }
  function update(){revision++;needsPaint=true;schedule();}
  function orbitTo(angle){orbit=Math.max(-120,Math.min(68,angle));update();}
  draw();
  performance.mark('ground-submit');
  await done();
  return {
    connect(){
      state.renderer=engine.backend==='webgl2'||engine.gpu?.adapterInfo?.vendor==='margo-webgl2'?'webgl2':'webgpu';
      state.revision='0';state.ready='true';
      read('controls').disabled=false;
      for(const button of choices)button.addEventListener('click',()=>{
        const next=button.dataset.mode;
        if(next!==mode){mode=next;update();}
      },{signal});
      slider.addEventListener('input',()=>orbitTo(+slider.value),{signal});
      read('reset').addEventListener('click',()=>orbitTo(home),{signal});
      canvas.addEventListener('pointerdown',event=>{
        if(drag)return;
        drag={id:event.pointerId,x:event.clientX,orbit};canvas.setPointerCapture(event.pointerId);
      },{signal});
      canvas.addEventListener('pointermove',event=>{
        if(drag?.id===event.pointerId)orbitTo(drag.orbit+(event.clientX-drag.x)*.28);
      },{signal});
      for(const type of ['pointerup','pointercancel','lostpointercapture'])canvas.addEventListener(type,event=>{
        if(drag?.id===event.pointerId)drag=undefined;
      },{signal});
      canvas.addEventListener('keydown',event=>{
        if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();orbitTo(orbit+(event.key==='ArrowLeft'?-5:5));}
      },{signal});
      observer=new ResizeObserver(()=>{
        const [width,height]=size();if(canvas.width===width&&canvas.height===height)return;
        needsPaint=true;schedule();
      });
      observer.observe(canvas);
    },
    dispose(){cancelAnimationFrame(request);observer?.disconnect();disposeBackend();}
  };
}
