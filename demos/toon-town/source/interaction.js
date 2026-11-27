const descriptions={
  hatch:'Crossed pen strokes gather on the faces turned away from the sun.',
  halftone:'The ink dots grow across darker faces and open up where the sun hits.',
  bands:'Four steps of light give the village the flat shapes of a cel drawing.'
};
export async function pressPlate(engine,canvas,signal,fail,village,renderer){
  const controls=document.querySelector('#controls');
  const angle=document.querySelector('#angle');
  const output=document.querySelector('#angle-value');
  const moving=document.querySelector('#moving');
  const method=document.querySelector('#method');
  const buttons=[...controls.querySelectorAll('[data-mode]')];
  const state=document.body.dataset;
  let animation=0,lastTick=0,time=0,revision=0;
  const idle=()=>!moving.checked||document.hidden||signal.aborted;
  moving.checked=!matchMedia('(prefers-reduced-motion: reduce)').matches;
  function draw(){
    const bounds=canvas.getBoundingClientRect();
    const scale=Math.min(devicePixelRatio,2);
    const width=Math.max(1,Math.round(bounds.width*scale));
    const height=Math.max(1,Math.round(bounds.height*scale));
    if(canvas.width!==width||canvas.height!==height){
      canvas.width=width;canvas.height=height;

    }
    const yaw=+angle.value*Math.PI/180;
    const radius=Math.max(12.35,16.15*height/width);
    const aim=[-.65,1.72,-1.8];
    engine.camera.position=[aim[0]+Math.sin(yaw)*radius,aim[1]+radius*.33,aim[2]+Math.cos(yaw)*radius];
    engine.camera.target=aim;
    village.frame(time);
    engine.render({delta:0});
  }
  function tick(now){
    if(idle()){animation=0;lastTick=0;return;}
    if(!lastTick||now-lastTick>=14){
      time+=lastTick?Math.min(.072,(now-lastTick)/1000):0;
      lastTick=now;
      try{draw();}catch(error){fail(error);return;}
    }
    animation=requestAnimationFrame(tick);
  }
  function run(){if(!animation&&!idle())animation=requestAnimationFrame(tick);}
  const change=async(reason,mode)=>{
    try{
      draw();
      await renderer.fence();
      if(signal.aborted)return;
      state.revision=String(++revision);
      state.motion=moving.checked?'running':'paused';
      if(mode)state.mode=mode;
      if(reason==='style'&&!performance.getEntriesByName('toon-control-applied').length)
        performance.mark('toon-control-applied');
    }catch(error){fail(error);}
  };
  draw();
  await renderer.fence();
  return {
    connect(){
      if(signal.aborted)return;
      state.mode='hatch';state.revision='0';state.motion=moving.checked?'running':'paused';
      state.renderer=engine.gpu.adapterInfo?.vendor==='margo-webgl2'?'webgl2':'webgpu';
      for(const button of buttons)button.addEventListener('click',()=>{
        const mode=button.dataset.mode;
        if(button.getAttribute('aria-pressed')==='true')return;
        renderer.setMode(mode);
        for(const option of buttons)option.setAttribute('aria-pressed',String(button===option));
        method.textContent=descriptions[mode];
        void change('style',mode);
      },{signal});
      angle.addEventListener('input',()=>{
        output.value=angle.value+'°';state.angle=angle.value;void change('view');
      },{signal});
      moving.addEventListener('input',()=>{void change('motion');run();},{signal});
      document.addEventListener('visibilitychange',run,{signal});
      const observer=new ResizeObserver(()=>{try{draw();}catch(error){fail(error);}});
      observer.observe(canvas);
      signal.addEventListener('abort',()=>observer.disconnect(),{once:true});
      document.querySelector('#loading').hidden=true;
      state.ready='true';
      controls.disabled=false;
      performance.mark('margo-first-usable-frame');
      setTimeout(run,350);
    },
    dispose(){cancelAnimationFrame(animation);renderer.dispose();}
  };
}
