import {createStage} from 'margoengine';
import {DOF} from '../src/index.js';
const status=document.querySelector<HTMLParagraphElement>('#status')!;
try {
  const stage=await createStage('#viewport',{backend:'webgpu',controls:false,autoStart:false,camera:{position:[0,1,8],target:[0,0,0],fov:55},onError:error=>{status.textContent=String(error);}});
  for(let row=0;row<3;row++)for(let col=0;col<5;col++)stage.sphere({radius:0.32,segments:24,position:[(col-2)*1.15,0,4-row*4],color:[0.15+col*0.17,0.2+row*0.25,1-col*0.17],roughness:0.12,metalness:0.3});
  stage.box({size:[15,0.1,20],position:[0,-0.5,-2],color:[0.08,0.1,0.16],roughness:0.8});
  const dof=DOF.attach(stage.engine,{focalDistance:8.1,focalLength:0.16,aperture:0.7});
  for(const [id,key,scale,unit] of [['focus','focalDistance',1,' m'],['length','focalLength',0.001,' mm'],['aperture','aperture',1,'']] as const){
    const input=document.querySelector<HTMLInputElement>(`#${id}`)!,output=document.querySelector<HTMLOutputElement>(`#${id}-value`)!;
    input.addEventListener('input',()=>{dof.options[key]=input.valueAsNumber*scale;output.value=(id==='aperture'?'f/':'')+input.value+unit;});
  }
  document.querySelector<HTMLInputElement>('#enabled')!.addEventListener('change',event=>{dof.enabled=(event.target as HTMLInputElement).checked;});
  stage.engine.render();stage.engine.start();status.textContent='WebGPU ready · foreground, focus plane, background';
  window.addEventListener('pagehide',()=>stage.dispose(),{once:true});
} catch(error){status.textContent=`Unable to start: ${String(error)}`;}
