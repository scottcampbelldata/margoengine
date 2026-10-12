import {createStage} from 'margoengine';
import {parseMargo} from '@margoengine/blender';
import type {PBRModel} from '@margoengine/gltf-pro';

const status=document.querySelector<HTMLParagraphElement>('#status')!,input=document.querySelector<HTMLInputElement>('#file')!;
let model:PBRModel|undefined;
try{
  const stage=await createStage('#viewport',{backend:'webgpu',capacity:4096});
  input.addEventListener('change',async()=>{
    const file=input.files?.[0];if(!file)return;
    input.disabled=true;
    try{
      if(file.size>64*1024*1024)throw new RangeError('Scene exceeds the 64 MiB limit');
      const next=await parseMargo(stage.engine,await file.arrayBuffer());
      try{const b=next.bounds;stage.engine.camera.fitToBoundingBox([b[0],b[1],b[2]],[b[3],b[4],b[5]],{duration:0});}
      catch(error){next.destroy();throw error;}
      model?.destroy();model=next;
      status.textContent=`${file.name}: ${model.nodes.length} objects, ${model.primitives.length} primitives`;
    }catch(error){status.textContent=error instanceof Error?error.message:String(error);}
    finally{input.disabled=false;}
  });
  input.disabled=false;
  window.addEventListener('pagehide',()=>stage.dispose(),{once:true});
}catch(error){status.textContent=error instanceof Error?error.message:String(error);input.disabled=true;}
