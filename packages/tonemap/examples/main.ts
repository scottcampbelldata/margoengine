import {createStage} from 'margoengine';
import {engineRuntime} from '@margoengine/core/extension';
import {Tonemap,type TonemapCurve} from '../dist/index.js';
import {submitPrincipalScene,type PrincipalSceneReadiness} from '../../shared/demo-frame.js';
declare global {interface Window {tonemapDemo?:{stage:Awaited<ReturnType<typeof createStage>>;effect:Tonemap;readiness:PrincipalSceneReadiness;principalObjects:number}}}
const status=document.querySelector<HTMLParagraphElement>('#status')!;
const life=new AbortController();let dispose=()=>{},fileGeneration=0;
window.addEventListener('pagehide',()=>{life.abort();dispose();},{once:true});
try {
  const stage=await createStage('#viewport',{backend:'webgpu',controls:false,autoStart:false,camera:{position:[0,2,8],target:[0,0,0],fov:50},onError:error=>{if(!life.signal.aborted)status.textContent=String(error);}});
  dispose=()=>stage.dispose();if(life.signal.aborted){dispose();life.signal.throwIfAborted();}
  const canvas=document.querySelector<HTMLCanvasElement>('#viewport')!,fit=()=>{if(!life.signal.aborted)stage.engine.camera.fov=Math.max(50,Math.atan(Math.tan(25*Math.PI/180)/(canvas.clientWidth/canvas.clientHeight))*360/Math.PI);};
  const resize=new ResizeObserver(fit);dispose=()=>{resize.disconnect();stage.dispose();};resize.observe(canvas);fit();
  const colors=new Float32Array([1,0.03,0.01,0.04,1,0.06,0.04,0.1,1,1,0.5,0.02,0.7,0.1,1]);
  for(let i=0;i<5;i++)stage.sphere({radius:0.65,position:[(i-2)*1.5,0,0],color:[colors[i*3],colors[i*3+1],colors[i*3+2]],roughness:0.16,metalness:0.3});
  stage.box({size:[14,0.1,10],position:[0,-0.8,0],color:[0.18,0.18,0.18],roughness:0.7});
  engineRuntime(stage.engine).lighting.direction[3]=24;
  const tonemap=Tonemap.attach(stage.engine);
  document.querySelector<HTMLSelectElement>('#curve')!.addEventListener('change',event=>{tonemap.options.curve=(event.target as HTMLSelectElement).value as TonemapCurve;},{signal:life.signal});
  for(const id of ['exposure','contrast'] as const){
    const input=document.querySelector<HTMLInputElement>(`#${id}`)!,output=document.querySelector<HTMLOutputElement>(`#${id}-value`)!;
    input.addEventListener('input',()=>{tonemap.options[id]=input.valueAsNumber;output.value=input.value+(id==='exposure'?' stops':'');},{signal:life.signal});
  }
  const fileInput=document.querySelector<HTMLInputElement>('#lut')!;
  fileInput.addEventListener('change',async()=>{const file=fileInput.files?.[0];if(!file)return;
    const ticket=++fileGeneration;
    try {if(file.size>8*1024*1024)throw new Error('LUT is larger than 8 MiB');const text=await file.text();if(life.signal.aborted||ticket!==fileGeneration)return;tonemap.setLUT(text);status.textContent=`LUT loaded: ${file.name}`;}
    catch(error){if(!life.signal.aborted&&ticket===fileGeneration)status.textContent=`LUT rejected: ${String(error)}`;}
  },{signal:life.signal});
  document.querySelector<HTMLButtonElement>('#clear-lut')!.addEventListener('click',()=>{fileGeneration++;tonemap.setLUT(null);fileInput.value='';status.textContent='LUT cleared';},{signal:life.signal});
  const readiness=await submitPrincipalScene(()=>stage.engine.render(),engineRuntime(stage.engine).gpu!.queue,{signal:life.signal});
  life.signal.throwIfAborted();window.tonemapDemo={stage,effect:tonemap,readiness,principalObjects:6};stage.engine.start();status.textContent='WebGPU ready · AgX, ACES fitted and Khronos PBR Neutral';
} catch(error){dispose();if(!life.signal.aborted)status.textContent=`Unable to start: ${String(error)}`;}
