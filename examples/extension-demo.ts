import {createStage,CADCameraControls} from 'margoengine';
import {loadGLTF} from '@margoengine/gltf-pro';
const status=document.querySelector<HTMLElement>('#status')!,error=document.querySelector<HTMLElement>('#error')!,robot=document.body.dataset.demo==='robot';
const abort=new AbortController();let dispose:(()=>void)|undefined;
try {
  const stage=await createStage('#viewport',{backend:'webgpu',autoStart:false,controls:false,capacity:2048,
    camera:{position:[3,2,5],target:[0,0,0],near:0.01,far:500},onError:reason=>{error.textContent=String(reason);}});
  dispose=()=>stage.dispose();const controls=new CADCameraControls(stage.engine.camera,stage.canvas);stage.canvas.tabIndex=0;
  stage.use({name:'demo-controls',setup(){},onPreUpdate:delta=>controls.update(delta),dispose:()=>controls.dispose()});
  stage.canvas.addEventListener('keydown',event=>{
    if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','-'].includes(event.key))return;event.preventDefault();
    if(event.key==='+'||event.key==='-')stage.canvas.dispatchEvent(new WheelEvent('wheel',{deltaY:event.key==='+'?-100:100,cancelable:true}));
    else controls.orbit(event.key==='ArrowLeft'?-0.1:event.key==='ArrowRight'?0.1:0,event.key==='ArrowUp'?-0.1:event.key==='ArrowDown'?0.1:0);
  });
  const url=robot?'https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/models/gltf/RobotExpressive/RobotExpressive.glb':'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/DamagedHelmet/glTF-Binary/DamagedHelmet.glb';
  const model=await loadGLTF(stage.engine,url,{signal:abort.signal}),bounds=model.bounds;
  stage.engine.camera.fitToBoundingBox([bounds[0],bounds[1],bounds[2]],[bounds[3],bounds[4],bounds[5]],{aspect:stage.canvas.clientWidth/stage.canvas.clientHeight,duration:0});
  if(robot) {
    const {Animation}=await import('@margoengine/animation'),animation=Animation.attach(model);
    const select=document.querySelector<HTMLSelectElement>('#clip')!,button=document.querySelector<HTMLButtonElement>('#pause')!;
    for(const [id,clip] of animation.clips.entries())select.add(new Option(clip.name,String(id)));
    const walking=animation.clips.findIndex(c=>/walking|running/i.test(c.name));animation.play(Math.max(0,walking));select.value=String(animation.clip);select.disabled=false;
    select.addEventListener('change',()=>{animation.play(select.selectedIndex);update();});
    const reduced=matchMedia('(prefers-reduced-motion: reduce)'),update=()=>{button.textContent=animation.playing?'Pause animation':'Resume animation';button.setAttribute('aria-pressed',String(!animation.playing));};
    animation.playing=!reduced.matches;button.disabled=false;update();
    button.addEventListener('click',()=>{animation.playing=!animation.playing;update();});
    const motion=()=>{animation.playing=!reduced.matches;update();};reduced.addEventListener('change',motion);
    stage.use({name:'demo-motion',setup(){},dispose:()=>reduced.removeEventListener('change',motion)});
    const host=document.querySelector('#morphs')!,seen=new Set<number>();
    for(const p of model.primitives)if(p.weights.length&&!seen.has(p.nodeIndex)) {
      seen.add(p.nodeIndex);
      p.targetNames.forEach((name,i)=>{
        const label=document.createElement('label'),input=document.createElement('input'),output=document.createElement('output');
        input.type='range';input.min='0';input.max='1';input.step='0.01';input.value=String(p.weights[i]);input.id='morph-'+p.nodeIndex+'-'+i;
        label.htmlFor=input.id;label.append(document.createTextNode(name),output);output.htmlFor=input.id;output.value=input.value;
        input.addEventListener('input',()=>{animation.setMorph(p.nodeIndex,i,input.valueAsNumber);output.value=input.value;});host.append(label,input);
      });
    }
  } else {
    const {SSAO}=await import('@margoengine/post'),ssao=SSAO.attach(stage.engine,{radius:0.25,bias:0.01,samples:32});
    ssao.add(model);const toggle=document.querySelector<HTMLInputElement>('#ssao')!;toggle.disabled=false;toggle.addEventListener('change',()=>{ssao.enabled=toggle.checked;});
  }
  stage.engine.render();stage.engine.start();document.querySelector<HTMLElement>('#viewport')!.dataset.ready='true';status.textContent='Ready';
} catch(reason) {dispose?.();if(!abort.signal.aborted){status.textContent='Unable to load scene';error.textContent=String(reason);}}
addEventListener('pagehide',()=>{abort.abort();dispose?.();},{once:true});
