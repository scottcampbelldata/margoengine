import {createStage} from 'margoengine';
import {loadGLTF} from '@margoengine/gltf-pro';
import {OrbitControls} from '@margoengine/controls';
import {sceneSamples} from '../packages/shared/quality.js';
import {applyQualityTier, paceEngine, watchQuality} from '@margoengine/quality';
applyQualityTier();
import {engineRuntime} from '@margoengine/core/extension';
import {submitPrincipalScene} from '../packages/shared/demo-frame.js';
const status=document.querySelector<HTMLElement>('#status')!,error=document.querySelector<HTMLElement>('#error')!,robot=document.body.dataset.demo==='robot';
const abort=new AbortController();let dispose:(()=>void)|undefined;
addEventListener('pagehide',()=>{abort.abort();dispose?.();},{once:true});
try {
  const extras=robot?Promise.all([import('@margoengine/animation'),import('@margoengine/shadows'),import('@margoengine/tonemap'),import('@margoengine/core/extension')]):import('@margoengine/post/ssao').then(({SSAO})=>({SSAO}));
  // Imports overlap engine startup; the scene's catch reports a later import failure.
  extras.catch(()=>{});
  const stage=await createStage('#viewport',{backend:'webgpu',autoStart:false,controls:false,capacity:2048,
    label:robot?'Animated robot with adjustable facial expressions':'Interactive damaged helmet',
    camera:{position:robot?[2,1.5,7]:[3,2,5],target:[0,0,0],near:0.01,far:500},onError:reason=>{error.textContent=String(reason);}});
  dispose=()=>stage.dispose();if(abort.signal.aborted){stage.dispose();abort.signal.throwIfAborted();}paceEngine(stage.engine);const controls=new OrbitControls(stage.engine);controls.enableDamping=true;stage.canvas.tabIndex=0;
  stage.canvas.addEventListener('keydown',event=>{
    if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','-'].includes(event.key))return;event.preventDefault();
    if(event.key==='+'||event.key==='-')stage.canvas.dispatchEvent(new WheelEvent('wheel',{deltaY:event.key==='+'?-100:100,cancelable:true}));
    else {controls.rotateLeft(event.key==='ArrowLeft'?0.1:event.key==='ArrowRight'?-0.1:0);controls.rotateUp(event.key==='ArrowUp'?0.1:event.key==='ArrowDown'?-0.1:0);}
  });
  const url=robot?new URL('./assets/robot-expressive.glb',import.meta.url):new URL('./assets/damaged-helmet-mobile.glb',import.meta.url);
  let model=await loadGLTF(stage.engine,url,{signal:abort.signal}),upgrade:(()=>Promise<void>)|undefined;
  const bounds=model.bounds,demo={stage,get model(){return model;},initialModel:model,quality:robot?'full':sceneSamples()===1?'mobile':'preview',readiness:{}};
  Object.assign(window,{extensionDemo:demo});
  stage.engine.camera.fitToBoundingBox([bounds[0],bounds[1],bounds[2]],[bounds[3],bounds[4],bounds[5]],{aspect:stage.canvas.clientWidth/stage.canvas.clientHeight,duration:0});
  controls.saveState();
  if(robot) {
    const [{Animation},{Shadows},{Tonemap},{engineRuntime}]=await extras as [typeof import('@margoengine/animation'),typeof import('@margoengine/shadows'),typeof import('@margoengine/tonemap'),typeof import('@margoengine/core/extension')],animation=Animation.attach(model);
    // The sample's clips also key the face; the expression controls own those weights here.
    for(const clip of animation.clips)clip.tracks=clip.tracks.filter(track=>track.path!=='weights');
    const runtime=engineRuntime(stage.engine),span=Math.max(bounds[3]-bounds[0],bounds[4]-bounds[1],bounds[5]-bounds[2]);
    runtime.lighting.direction.set([-3,8,5,4]);runtime.lighting.radiance.set([1,0.93,0.84,0.4]);
    const floor=stage.box({size:[span*3,0.12,span*3],position:[(bounds[0]+bounds[3])/2,bounds[1]-0.07,(bounds[2]+bounds[5])/2],color:'#394b60',roughness:1});
    const shadows=Shadows.attach(stage.engine,{resolution:1024,distance:span*6,casterMargin:span*2,lightSize:0.06,normalBias:0.015});shadows.add(floor,{static:true});shadows.add(model);
    Tonemap.attach(stage.engine,{curve:'agx',exposure:0.35});
    const select=document.querySelector<HTMLSelectElement>('#clip')!,button=document.querySelector<HTMLButtonElement>('#pause')!;
    for(const [id,clip] of animation.clips.entries())select.add(new Option(clip.name,String(id)));
    const walking=animation.clips.findIndex(c=>/walking/i.test(c.name));animation.play(Math.max(0,walking));select.value=String(animation.clip);select.disabled=false;
    select.addEventListener('change',()=>{const playing=animation.playing;animation.play(select.selectedIndex);animation.playing=playing;update();});
    const reduced=matchMedia('(prefers-reduced-motion: reduce)'),update=()=>{button.textContent=animation.playing?'Pause animation':'Resume animation';button.setAttribute('aria-pressed',String(!animation.playing));};
    animation.playing=!reduced.matches;button.disabled=false;update();
    button.addEventListener('click',()=>{animation.playing=!animation.playing;update();});
    const motion=()=>{animation.playing=!reduced.matches;update();};reduced.addEventListener('change',motion);
    stage.use({name:'demo-motion',setup(){},dispose:()=>reduced.removeEventListener('change',motion)});
    const speed=document.querySelector<HTMLInputElement>('#speed')!,speedValue=document.querySelector<HTMLOutputElement>('#speed-value')!;speed.disabled=false;
    speed.addEventListener('input',()=>{animation.options.speed=speed.valueAsNumber;speedValue.value=speed.value+'×';});
    const reset=document.querySelector<HTMLButtonElement>('#reset-view')!;reset.disabled=false;reset.addEventListener('click',()=>controls.reset());
    const host=document.querySelector('#morphs')!,preset=document.querySelector<HTMLSelectElement>('#expression')!,inputs:HTMLInputElement[]=[],seen=new Set<number>();
    for(const p of model.primitives)if(p.weights.length&&!seen.has(p.nodeIndex)) {
      seen.add(p.nodeIndex);
      p.targetNames.forEach((name,i)=>{
        const label=document.createElement('label'),input=document.createElement('input'),output=document.createElement('output');
        input.type='range';input.min='0';input.max='1';input.step='0.01';input.value=String(p.weights[i]);input.id='morph-'+p.nodeIndex+'-'+i;
        label.htmlFor=input.id;label.append(document.createTextNode(name),output);output.htmlFor=input.id;output.value=input.value;
        inputs.push(input);preset.add(new Option(name,input.id));
        input.addEventListener('input',()=>{animation.setMorph(p.nodeIndex,i,input.valueAsNumber);output.value=input.value;preset.value=inputs.every(input=>input.valueAsNumber===0)?'neutral':'custom';});host.append(label,input);
      });
    }
    preset.disabled=false;preset.addEventListener('change',()=>{const value=preset.value;for(const input of inputs){input.value=input.id===value?'1':'0';input.dispatchEvent(new Event('input'));}preset.value=value;});
  } else {
    demo.readiness=await submitPrincipalScene(()=>stage.engine.render(),engineRuntime(stage.engine).gpu!.queue,{signal:abort.signal});
    const {SSAO}=await extras as typeof import('@margoengine/post/ssao'),ssao=SSAO.attach(stage.engine,{radius:0.25,bias:0.01,samples:32});
    model.onDispose(ssao.add(model));const toggle=document.querySelector<HTMLInputElement>('#ssao')!;toggle.disabled=false;toggle.addEventListener('change',()=>{ssao.enabled=toggle.checked;});
    if(sceneSamples()===4)upgrade=async()=>{
      const full=await loadGLTF(stage.engine,new URL('./assets/damaged-helmet.glb',import.meta.url),{signal:abort.signal});
      if(abort.signal.aborted){full.destroy();return;}
      full.onDispose(ssao.add(full));model.destroy();model=full;demo.quality='full';status.textContent='Ready';
    };
  }
  if(robot)demo.readiness=await submitPrincipalScene(()=>stage.engine.render(),engineRuntime(stage.engine).gpu!.queue,{signal:abort.signal});else stage.engine.render();
  stage.engine.start();watchQuality();document.querySelector<HTMLElement>('#viewport')!.dataset.ready='true';status.textContent=upgrade?'Ready. Full detail is loading.':'Ready';
  if(upgrade)void upgrade().catch(reason=>{if(!abort.signal.aborted){status.textContent='Ready. Full detail could not load.';error.textContent=String(reason);}});
} catch(reason) {dispose?.();if(!abort.signal.aborted){status.textContent='Unable to load scene';error.textContent=String(reason);}}
