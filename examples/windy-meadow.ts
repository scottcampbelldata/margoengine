import {createStage,CADCameraControls} from 'margoengine';
import {GrassField,PostProcessing} from '@margoengine/creative';

const error=document.querySelector<HTMLElement>('#error')!;
let dispose: (()=>void) | undefined;
try {
  const stage=await createStage('#viewport',{backend:'webgpu',controls:false,autoStart:false,label:'Wind-blown grass with floating dandelion seeds',camera:{position:[18,6,22],target:[0,1,0],far:300},onError:value=>{error.textContent=String(value);}});
  dispose=()=>stage.dispose();
  const controls=new CADCameraControls(stage.engine.camera,stage.canvas);
  stage.use({name:'meadow-controls',setup(){},onPreUpdate:delta=>controls.update(delta),dispose:()=>controls.dispose()});
  stage.engine.use(new PostProcessing({bloom:0.12,threshold:1.2,atmosphere:{sky:true,density:0.007,heightFalloff:0.08,color:[0.58,0.69,0.75],sun:[0.6,0.5,-0.5]}}));
  stage.box({size:[60,0.12,60],position:[0,-0.07,0],color:'#34451f',roughness:1});
  const meadow=new GrassField(stage,{blades:100_000,area:[60,60],bladeHeight:1.2,windSpeed:1.2,drawDistance:90,spores:true});
  for (const [id,property] of [['speed','windSpeed'],['strength','windStrength']] as const) {
    const input=document.querySelector<HTMLInputElement>('#'+id)!,output=document.querySelector<HTMLOutputElement>('#'+id+'-value')!;
    input.addEventListener('input',()=>{meadow[property]=input.valueAsNumber;output.value=input.value;stage.engine.render();});
  }
  const reduced=matchMedia('(prefers-reduced-motion: reduce)'),button=document.querySelector<HTMLButtonElement>('#pause')!;
  let paused=reduced.matches;
  const motion=()=>{button.textContent=paused?'Resume motion':'Pause motion';button.setAttribute('aria-pressed',String(paused));if(paused){stage.engine.stop();stage.engine.render();}else stage.engine.start();};
  button.addEventListener('click',()=>{paused=!paused;motion();});
  reduced.addEventListener('change',()=>{paused=reduced.matches;motion();});
  stage.canvas.addEventListener('pointermove',()=>{if(paused)stage.engine.render();});
  stage.canvas.addEventListener('wheel',()=>{if(paused){controls.update(1);stage.engine.render();}});
  stage.canvas.addEventListener('keydown',event=>{
    if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','-'].includes(event.key))return;
    event.preventDefault();
    if(event.key==='+'||event.key==='-')stage.canvas.dispatchEvent(new WheelEvent('wheel',{deltaY:event.key==='+'?-100:100,cancelable:true}));
    else controls.orbit(event.key==='ArrowLeft'?-0.1:event.key==='ArrowRight'?0.1:0,event.key==='ArrowUp'?-0.1:event.key==='ArrowDown'?0.1:0);
    stage.engine.render();
  });
  document.querySelector<HTMLElement>('#status')!.textContent='WebGPU · 100,000 blades · 240 seeds';
  stage.canvas.tabIndex=0;
  stage.canvas.setAttribute('aria-describedby','navigation-help');
  motion();
  window.addEventListener('pagehide',()=>stage.dispose(),{once:true});
} catch (value) {
  dispose?.();
  document.querySelector<HTMLElement>('#status')!.textContent='Unable to start the meadow';
  error.textContent=String(value);
}
