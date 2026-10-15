import {createStage} from 'margoengine';
import {engineRuntime} from '@margoengine/core/extension';
import {applyQualityTier,paceEngine,watchQuality} from '@margoengine/quality';
import {DOF} from '../dist/index.js';
import {submitPrincipalScene,type PrincipalSceneReadiness} from '../../shared/demo-frame.js';
declare global {interface Window {dofDemo?:{stage:Awaited<ReturnType<typeof createStage>>;effect:DOF;readiness:PrincipalSceneReadiness;principalObjects:number}}}
// Before the stage exists: core reads the tier when it sizes the canvas; DOF reads the tier preset when it is attached.
applyQualityTier();
const status=document.querySelector<HTMLParagraphElement>('#status')!;
const life=new AbortController();let dispose=()=>{};
window.addEventListener('pagehide',()=>{life.abort();dispose();},{once:true});
try {
  const stage=await createStage('#viewport',{backend:'webgpu',controls:false,autoStart:false,camera:{position:[0,1,8],target:[0,0,0],fov:55},onError:error=>{if(!life.signal.aborted)status.textContent=String(error);}});
  dispose=()=>stage.dispose();if(life.signal.aborted){dispose();life.signal.throwIfAborted();}paceEngine(stage.engine);
  const canvas=document.querySelector<HTMLCanvasElement>('#viewport')!,fit=()=>{if(!life.signal.aborted)stage.engine.camera.fov=Math.max(55,Math.atan(Math.tan(35*Math.PI/180)/(canvas.clientWidth/canvas.clientHeight))*360/Math.PI);};
  const resize=new ResizeObserver(fit);dispose=()=>{resize.disconnect();stage.dispose();};resize.observe(canvas);fit();
  for(let row=0;row<3;row++)for(let col=0;col<5;col++)stage.sphere({radius:0.32,segments:24,position:[(col-2)*1.15,0,4-row*4],color:[0.15+col*0.17,0.2+row*0.25,1-col*0.17],roughness:0.12,metalness:0.3});
  stage.box({size:[15,0.1,20],position:[0,-0.5,-2],color:[0.08,0.1,0.16],roughness:0.8});
  const dof=DOF.attach(stage.engine,{focalDistance:8.1,focalLength:0.16,aperture:0.7});
  for(const [id,key,scale,unit] of [['focus','focalDistance',1,' m'],['length','focalLength',0.001,' mm'],['aperture','aperture',1,'']] as const){
    const input=document.querySelector<HTMLInputElement>(`#${id}`)!,output=document.querySelector<HTMLOutputElement>(`#${id}-value`)!;
    input.addEventListener('input',()=>{dof.options[key]=input.valueAsNumber*scale;output.value=(id==='aperture'?'f/':'')+input.value+unit;},{signal:life.signal});
  }
  document.querySelector<HTMLInputElement>('#enabled')!.addEventListener('change',event=>{dof.enabled=(event.target as HTMLInputElement).checked;},{signal:life.signal});
  const readiness=await submitPrincipalScene(()=>stage.engine.render(),engineRuntime(stage.engine).gpu!.queue,{signal:life.signal});
  life.signal.throwIfAborted();window.dofDemo={stage,effect:dof,readiness,principalObjects:16};stage.engine.start();watchQuality();status.textContent='WebGPU ready · foreground, focus plane, background';
} catch(error){dispose();if(!life.signal.aborted)status.textContent=`Unable to start: ${String(error)}`;}
