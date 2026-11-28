import {Environment,EnvironmentLighting} from '@margoengine/environment';
import {studio} from '@margoengine/environment/studio';
import {AccumulatedShadows} from '@margoengine/studio/accumulate';
import {Backdrop} from '@margoengine/studio/backdrop';
import {Tonemap} from '@margoengine/tonemap';
import {cameraFor,key} from './art.js';

const by=id=>document.getElementById(id);
const sampleTarget=128,viewSamples=12;

const stageImage=studio({
  width:128, floor:[.132,.121,.110],walls:[.242,.279,.320],ceiling:[.314,.331,.341],horizon:.17,
  lights:[
    {direction:key,width:.86,height:1.09,intensity:4.4,color:[1,.87,.69],softness:.3},
    {direction:[1.24,.74,1.53],width:.95,height:1.31,intensity:2.16,color:[.64,.79,1],softness:.3},
    {direction:[.27,1.0,-.97],width:.72,height:1.37,intensity:4.7,color:[.77,.92,1],softness:.27},
    {direction:[-.35,.12,1],width:.90,height:.46,intensity:.84,color:[1,.96,.88],softness:.38},
  ],
});

export function mount({opening,geometry,canvas,viewport,loading,status,signal,fail,resize}){
  const capture=by('capture'),preview=by('preview'),angle=by('angle'),angleValue=by('angle-value');
  const save=by('save'),samples=by('sample-count'),meter=by('meter'),state=by('take-status');
  let engine,shadow,catcher,catcherRequest,product,observer,raf=0,version=0,stillURL,frameMode='preview';
  let working=false,dirty=true,caption='Opening the set',captureId=0,firstTake=false,usingCatcher=false;
  const setCaption=text=>{if(caption!==text){caption=text;state.textContent=text;}};

  function releaseStill(){
    save.disabled=true;
    delete viewport.dataset.png;
    if(stillURL){URL.revokeObjectURL(stillURL);stillURL=undefined;}
  }
  function updateButtons(){
    preview.disabled=frameMode==='preview';
    capture.disabled=frameMode==='sampling';
    angle.disabled=frameMode==='sampling';
  }
  function camera(){
    const pose=cameraFor(canvas.width,canvas.height,Number(angle.value));
    engine.camera.position=pose.position;
    engine.camera.target=pose.target;
    engine.camera.fov=pose.fov;
    angleValue.value=angle.value+'°';
  }
  function stateData(){
    viewport.dataset.mode=frameMode;
    viewport.dataset.compare=usingCatcher?'shadow-map':'disk-light';
    viewport.dataset.samples=samples.value;
    viewport.dataset.version=String(version);
    viewport.dataset.angle=angle.value;
  }
  function schedule(){
    if(!engine||signal.aborted||raf||working)return;
    raf=requestAnimationFrame(draw);
  }
  function startStill(){
    releaseStill();
    captureId++;
    frameMode='sampling';
    Object.assign(shadow.options,{opacity:.72,frames:sampleTarget,samples:4});
    shadow.invalidate();
    if(catcher)catcher.opacity=0;
    usingCatcher=false;
    samples.value='0';
    meter.value=0;
    setCaption('Sampling the light');
    updateButtons();
    performance.mark('capture-input');
    schedule();
  }
  function openPreview(compare=false){
    captureId++;
    releaseStill();
    frameMode='preview';
    usingCatcher=!!catcher&&compare;
    if(catcher)catcher.opacity=usingCatcher?.69:0;
    Object.assign(shadow.options,{opacity:usingCatcher?0:.72,frames:viewSamples,samples:4});
    if(!usingCatcher)shadow.invalidate();
    samples.value='0';
    meter.value=0;
    setCaption('Preview exposure');
    updateButtons();
    dirty=true;
    schedule();
    if(compare&&!catcher){
      catcherRequest??=import('./receiver.js').then(({previewCatcher})=>{
        signal.throwIfAborted();
        catcher=previewCatcher(engine,product);
      });
      const take=captureId;
      catcherRequest.then(()=>{
        if(take!==captureId||signal.aborted||frameMode!=='preview')return;
        openPreview(true);
      }).catch(fail);
    }
  }
  function rememberStill(take){
    canvas.toBlob(blob=>{
      if(!blob||signal.aborted||take!==captureId||frameMode!=='still')return;
      stillURL=URL.createObjectURL(blob);
      save.disabled=false;
      viewport.dataset.png=String(blob.size);
    },'image/png');
  }
  async function draw(){
    raf=0;
    if(signal.aborted||status.failed)return;
    working=true;
    try{
      camera();
      const take=captureId,active=frameMode==='sampling',publish=dirty||active;
      dirty=false;
      engine.render({delta:0});
      if(active&&shadow.samples===sampleTarget){
        frameMode='still';
        rememberStill(take);
      }
      if(publish){
        await engine.gpu.queue.onSubmittedWorkDone();
        await new Promise(resolve=>requestAnimationFrame(resolve));
        signal.throwIfAborted();
        if(take===captureId&&active){
          samples.value=String(shadow.samples);
          meter.value=shadow.samples;
          if(!firstTake&&shadow.samples>0){
            firstTake=true;
            performance.mark('first-control-frame');
          }
          if(frameMode==='still'){
            updateButtons();
            setCaption('Still ready');
            performance.mark('still-frame');
          }
        }
        version++;
        stateData();
      }
    }catch(reason){fail(reason);}
    finally{
      working=false;
      if(dirty||frameMode==='sampling'||frameMode==='preview'&&!usingCatcher&&shadow.samples<viewSamples)schedule();
    }
  }
  async function run(){
    engine=await opening;
    signal.throwIfAborted();
    engine.scene.background='#617381';
    engine.lighting.direction.set([...key,2.2]);
    engine.lighting.radiance.set([1,.91,.81,.47]);
    engine.lighting.ambient.set([.83,.91,1.0]);
    const env=await Environment.attach(engine,stageImage,{
      size:64,specularSize:32,specularMips:5,samples:32,brdfSize:32,brdfSamples:32,shSize:16,
      float32:false,keepEquirect:false,intensity:.8,
    });
    signal.throwIfAborted();
    EnvironmentLighting.attach(engine,env);
    performance.mark('softboxes-ready');
    Backdrop.attach(engine,{width:18,depth:12,height:6,radius:4.4,segments:42,material:{color:'#9aa7ac',roughness:.93}});
    Tonemap.attach(engine,{curve:'neutral',exposure:.02,contrast:1.05,vignette:.075,vignetteRadius:.31,vignetteSoftness:.56});
    product=geometry.map(({name,geometry,material})=>{
      const mesh=engine.createMesh().setGeometry(geometry).setMaterial(material);
      mesh.name='SM_RelayB07_'+name;
      return mesh;
    });
    shadow=AccumulatedShadows.attach(engine,{position:[.25,.002,-.28],size:[4.74,4.24],
      height:1.70,opacity:.72,color:[.009,.010,.014],lightPosition:key,lightRadius:1.34,frames:viewSamples,
      samples:4,resolution:384});
    for(const mesh of product)shadow.add(mesh);
    camera();
    engine.render({delta:0});
    await engine.gpu.queue.onSubmittedWorkDone();
    await new Promise(resolve=>requestAnimationFrame(resolve));
    signal.throwIfAborted();
    performance.mark('studio-frame');
    capture.addEventListener('click',startStill,{signal});
    preview.addEventListener('click',()=>openPreview(true),{signal});
    angle.addEventListener('input',()=>{
      if(frameMode==='still')openPreview();
      dirty=true;
      schedule();
    },{signal});
    save.addEventListener('click',()=>{
      if(!stillURL)return;
      const a=Object.assign(document.createElement('a'),{href:stillURL,download:'relay-b07-studio.png'});
      a.click();
    },{signal});
    observer=new ResizeObserver(()=>{
      if(!resize())return;
      if(frameMode==='still')openPreview();
      dirty=true;
      schedule();
    });
    observer.observe(canvas);
    setCaption('Preview exposure');
    stateData();
    if(status.ready()){
      updateButtons();
      loading.hidden=true;
      schedule();
    }
  }
  run().catch(fail);
  return ()=>{
    observer?.disconnect();
    if(raf)cancelAnimationFrame(raf);
    releaseStill();
  };
}
