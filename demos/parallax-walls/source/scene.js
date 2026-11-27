import {createVault} from './vault.js';

export async function install(engine,canvas,assets,signal,fail){
  const model=createVault(engine,assets);
  engine.scene.background='#4a4135';
  engine.lighting.direction.set([-4.12,3.85,4.05,2.23]);
  engine.lighting.radiance.set([1,.9,.75,.55]);
  engine.lighting.ambient.set([.88,.95,1]);
  const controls=document.querySelector('#controls'),status=document.body.dataset;
  const yaw=document.querySelector('#yaw'),depth=document.querySelector('#depth');
  const projection=document.querySelector('#projection'),note=document.querySelector('#surface');
  const angle=document.querySelector('#yaw-value'),depthLabel=document.querySelector('#depth-value');
  const buttons=[...controls.querySelectorAll('[data-mode]')];
  let mode='relief',revision=0,lastDrawn=0,frame=0,observer,rendering=false,changedMode=false;

  function draw(){
    const factor=Math.min(devicePixelRatio,2);
    const width=Math.round(canvas.clientWidth*factor),height=Math.round(canvas.clientHeight*factor);
    if(canvas.width!==width)canvas.width=width;
    if(canvas.height!==height)canvas.height=height;
    const radians=Number(yaw.value)*Math.PI/180;
    const distance=Math.max(5.1,7.05*height/width);
    const aim=[.31,1.38,.05];
    engine.camera.position=[aim[0]+Math.sin(radians)*distance,2.34,aim[2]+Math.cos(radians)*distance];
    engine.camera.target=aim;
    const setting=Number(depth.value);
    model.relief(mode==='relief'?setting/100:0);
    model.projection(projection.checked);
    angle.value=yaw.value.replace('-','−')+'°';
    depthLabel.value=(mode==='relief'?Math.round(35*setting/100):0)+' mm';
    note.textContent=mode==='relief'?'Relief moves the apparent mortar joints as your view changes.':'Flat keeps the joints on the modeled surface.';
    for(const button of buttons)button.setAttribute('aria-pressed',String(button.dataset.mode===mode));
    engine.render({delta:0});
  }
  function schedule(){
    if(frame||rendering||signal.aborted)return;
    frame=requestAnimationFrame(async()=>{
      frame=0;rendering=true;
      const use=revision,tracked=changedMode;
      changedMode=false;
      try{
        draw();
        await engine.gpu.queue.onSubmittedWorkDone();
        if(signal.aborted)return;
        lastDrawn=use;status.revision=String(lastDrawn);
        status.mode=mode;status.projection=String(projection.checked);status.angle=yaw.value;
        if(tracked&&!performance.getEntriesByName('walls-control-applied').length)performance.mark('walls-control-applied');
      }catch(error){fail(error);return;}
      finally{rendering=false;}
      if(revision!==lastDrawn)schedule();
    });
  }
  function update(){revision++;schedule();}
  draw();
  await engine.gpu.queue.onSubmittedWorkDone();
  return {
    connect(){
      status.renderer=engine.gpu.adapterInfo?.vendor==='margo-webgl2'?'webgl2':'webgpu';
      status.mode=mode;status.projection=String(projection.checked);status.angle=yaw.value;status.revision='0';
      for(const button of buttons)button.addEventListener('click',()=>{
        if(mode===button.dataset.mode)return;
        mode=button.dataset.mode;changedMode=true;update();
      },{signal});
      for(const field of [yaw,depth,projection])field.addEventListener('input',update,{signal});
      observer=new ResizeObserver(()=>{
        const factor=Math.min(devicePixelRatio,2);
        if(canvas.width!==Math.round(canvas.clientWidth*factor)||canvas.height!==Math.round(canvas.clientHeight*factor))update();
      });
      observer.observe(canvas);
      controls.disabled=false;
      document.querySelector('#loading').hidden=true;
      status.ready='true';
      performance.mark('margo-first-usable-frame');
    },
    dispose(){observer?.disconnect();cancelAnimationFrame(frame);model.dispose();}
  };
}
