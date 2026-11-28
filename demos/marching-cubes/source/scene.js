import {Geometry,PbrMaterial} from '@margoengine/core';
import {cameraFor} from './art.js';
import {lampOptics} from './render-effects.js';

const by=id=>document.getElementById(id);
const waitFrame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
const counter=new Intl.NumberFormat('en-US');

export function mount({opening,initial,extract,art,canvas,viewport,loading,status,controls,signal,fail,size}){
  const slider=by('threshold'),readLevel=by('threshold-value'),surfaceCount=by('components');
  const triangles=by('triangles'),pause=by('pause'),wireButton=by('wire');
  let engine,optics,wax,observer,raf=0,lastSubmit=0,revision=0,solvedRevision=0,form=0;
  let working=false,layoutDirty=true,ready=false,playing=true,wire=false;
  let time=0,started=0,level=.71,firstControl=false,thresholdChange=-1;
  let ambientStart=0,shadowTimer=0,shadowSubmit=false;
  const casters=[];
  function current(now){
    return time+(playing&&started?Math.max(0,now-started)*.00066:0);
  }
  function camera(){
    const pose=cameraFor(canvas.width,canvas.height);
    engine.camera.position=pose.position;engine.camera.target=pose.target;engine.camera.fov=pose.fov;
  }
  function prepare(data){
    wax.setGeometry(new Geometry(data.positions,data.normals,data.indices));
    optics.setWire(data.wire?data:null);
  }
  function show(data){
    const faces=counter.format(data.indices.length/3),regions=String(data.components);
    if(triangles.value!==faces)triangles.value=faces;
    if(surfaceCount.value!==regions)surfaceCount.value=regions;
    form++;
    Object.assign(viewport.dataset,{version:String(form),time:data.time.toFixed(3),threshold:data.level.toFixed(2),
      components:regions,triangles:String(data.indices.length/3),wire:String(data.wire),playing:String(playing),
      extraction:data.milliseconds.toFixed(1)});
  }
  function schedule(){
    if(working||raf||!ready||signal.aborted||status.failed)return;
    raf=requestAnimationFrame(update);
  }
  async function update(now){
    raf=0;
    if(signal.aborted||status.failed)return;
    const animated=playing&&now>=ambientStart;
    const remesh=revision!==solvedRevision||animated&&now-lastSubmit>=32;
    if(!remesh&&!layoutDirty&&!shadowSubmit){if(playing)schedule();return;}
    working=true;
    try{
      if(remesh){
        lastSubmit=now;
        const data=await extract({revision,time:current(now),level,wire});
        signal.throwIfAborted();
        if(data.revision===revision){
          prepare(data);
          camera();
          layoutDirty=false;
          engine.render({delta:0});
          shadowPainted();
          if(data.revision===thresholdChange&&!firstControl){
            await engine.gpu.queue.onSubmittedWorkDone();
            await waitFrame();
            signal.throwIfAborted();
            if(data.revision===revision){
              firstControl=true;
              performance.mark('first-control-frame');
            }
          }
          show(data);
          solvedRevision=data.revision;
        }
      }else{
        layoutDirty=false;
        camera();
        engine.render({delta:0});
        shadowPainted();
      }
    }catch(reason){fail(reason);}
    finally{
      working=false;
      if(playing||revision!==solvedRevision||layoutDirty||shadowSubmit)schedule();
    }
  }
  function pauseMotion(){
    if(playing)time=current(performance.now());
    playing=!playing;
    if(playing)started=performance.now();
    else started=0;
    pause.textContent=playing?'Pause motion':'Resume motion';
    pause.setAttribute('aria-pressed',String(!playing));
    revision++;
    schedule();
  }
  function shadowPainted(){
    if(!shadowSubmit)return;
    shadowSubmit=false;
    engine.gpu.queue.onSubmittedWorkDone().then(()=>{
      if(signal.aborted)return;
      viewport.dataset.contactShadow='true';
      performance.mark('contact-shadow-ready');
    }).catch(fail);
  }
  async function addContactShadow(){
    const {ContactShadows}=await import('@margoengine/studio');
    signal.throwIfAborted();
    const shadow=ContactShadows.attach(engine,{position:[0,.001,0],size:[.85,.74],height:.23,blur:.023,
      opacity:.68,resolution:224,static:true,color:[.022,.012,.017],toneMapped:true});
    for(const mesh of casters)shadow.add(mesh);
    shadowSubmit=true;
    schedule();
  }
  async function run(){
    const [owner,first]=await Promise.all([opening,initial]);
    performance.mark('lamp-assets-ready');
    signal.throwIfAborted();
    engine=owner;
    engine.scene.background='#3b3240';
    engine.lighting.direction.set([-.48,.79,.56,3.2]);
    engine.lighting.radiance.set([1,.884,.761,.53]);
    engine.lighting.ambient.set([.83,.87,1]);
    for(const piece of art.room){
      const mesh=engine.createMesh().setGeometry(piece.geometry).setMaterial(piece.material);
      if(piece.position)mesh.setPosition(piece.position);
      mesh.name='SM_Lumen_'+piece.name;
      if(piece.name==='stone'||piece.name==='ink')casters.push(mesh);
    }
    wax=engine.createMesh().setMaterial(new PbrMaterial({color:[1,0,1],roughness:.35,doubleSided:false}));
    wax.name='SM_Lumen_MarchingCubes';
    optics=lampOptics(engine,art.vessel);
    prepare(first);
    camera();
    layoutDirty=false;
    performance.mark('lamp-submit');
    engine.render({delta:0});
    await engine.gpu.queue.onSubmittedWorkDone();
    await waitFrame();
    signal.throwIfAborted();
    show(first);
    performance.mark('lamp-frame');
    slider.addEventListener('input',()=>{
      level=Number(slider.value);
      readLevel.value=level.toFixed(2);
      thresholdChange=++revision;
      performance.mark('threshold-input');
      schedule();
    },{signal});
    pause.addEventListener('click',pauseMotion,{signal});
    wireButton.addEventListener('click',()=>{
      wire=!wire;
      wireButton.setAttribute('aria-pressed',String(wire));
      revision++;
      schedule();
    },{signal});
    observer=new ResizeObserver(()=>{
      if(size()){layoutDirty=true;schedule();}
    });
    observer.observe(canvas);
    if(status.ready()){
      ready=true;ambientStart=performance.now()+240;started=ambientStart;
      shadowTimer=setTimeout(()=>addContactShadow().catch(fail),575);
      for(const id of controls)by(id).disabled=false;
      loading.hidden=true;
      schedule();
    }
  }
  run().catch(fail);
  return ()=>{
    clearTimeout(shadowTimer);
    observer?.disconnect();
    if(raf)cancelAnimationFrame(raf);
  };
}
