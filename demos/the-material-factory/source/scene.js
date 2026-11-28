import {Geometry,PbrMaterial} from '@margoengine/core';
import {ContactShadows} from '@margoengine/studio';
import {finishes,firstSeed,mapSize,cameraFor} from './art.js';
import {readPreviews} from './preview.js';
import {specimenSurface} from './surface.js';

const by=id=>document.getElementById(id);
const modes=Object.keys(finishes);
const frame=()=>new Promise(resolve=>requestAnimationFrame(resolve));

export function mount({opening,baking,art,canvas,viewport,loading,status,controls,signal,fail,size}){
  const detail=by('detail'),detailValue=by('detail-value'),light=by('light'),lightValue=by('light-value');
  const seedValue=by('seed'),resolution=by('resolution'),caption=by('caption'),notice=by('bake-status');
  let engine,baker,projection,ringPaint,samplePaint,active,observer,staged,timer=0,paint=0,sequence=0,version=0,cameraDirty=false;
  let drawing=false,ready=false,preset='rust',seed=firstSeed,firstChange=false;
  function camera(){
    const pose=cameraFor(canvas.width,canvas.height);
    engine.camera.position=pose.position;
    engine.camera.target=pose.target;
    engine.camera.fov=pose.fov;
    const key=Number(light.value)*Math.PI/180;
    engine.lighting.direction.set([Math.sin(key)*.86,.507,Math.cos(key)*.86,4.2]);
    lightValue.value=light.value+'°';
  }
  function rendered(){
    viewport.dataset.light=light.value;
    viewport.dataset.frame=String(++paint);
  }
  function commit({mode,seed:serial,detail},set){
    const {depth,heightScale}=finishes[mode],previous=active;
    active={set,release:()=>set.dispose(),heightScale};
    projection.set(set,depth,heightScale);
    ringPaint.set({color:[1,0,1]});
    samplePaint.set({color:[0,1,1]});
    return {previous,state:{mode,serial,detail}};
  }
  function updateControls(state,set){
    caption.textContent=finishes[state.mode].caption;
    for(const mode of modes)by(mode).setAttribute('aria-pressed',String(state.mode===mode));
    seedValue.value=String(state.serial).padStart(3,'0');
    resolution.value=set.width+' × '+set.heightPixels+' · '+set.mipLevelCount+' mips';
    detailValue.value=Math.round(state.detail*100)+'%';
    Object.assign(viewport.dataset,{version:String(++version),mode:state.mode,seed:String(state.serial),
      detail:String(state.detail),mips:String(set.mipLevelCount),width:String(set.width)});
    notice.textContent='';
    by('rebake').textContent='Rebake finish';
    viewport.dataset.stage='generated';
  }
  function showTiles(snapshot,version){
    readPreviews(engine.gpu,snapshot.set,snapshot.heightScale).then(previews=>{
      if(signal.aborted||active!==snapshot)return;
      for(const [key,{image,checksum}] of Object.entries(previews)){
        const tile=by('map-'+key),context=tile.getContext('2d');
        tile.width=image.width;tile.height=image.height;
        context.putImageData(image,0,0);
        tile.dataset.checksum=checksum;
      }
      viewport.dataset.maps=String(version);
      performance.mark('map-preview');
    }).catch(fail);
  }
  function request(action,wait=0){
    if(!ready||signal.aborted)return;
    clearTimeout(timer);
    const finish={mode:preset,seed,detail:Number(detail.value)/100,fingerprint:++sequence,action};
    const use=()=>{staged=finish;notice.textContent='Baking four maps…';schedule();};
    if(wait)timer=setTimeout(use,wait);else use();
  }
  async function bake(values){
    const {label,caption,depth,...options}=finishes[values.mode];
    return baker.bake({...options,pattern:values.mode,width:mapSize,height:mapSize,seed:values.seed,detail:values.detail,signal});
  }
  function schedule(){
    if(drawing||drawRAF||signal.aborted||!engine)return;
    drawRAF=requestAnimationFrame(draw);
  }
  let drawRAF=0;
  async function draw(){
    drawRAF=0;
    if(signal.aborted||status.failed)return;
    drawing=true;
    let prior;
    try{
      const request=baker?staged:undefined;
      if(request)staged=undefined;
      let configured;
      if(request){
        const set=await bake(request);
        if(sequence!==request.fingerprint||signal.aborted){
          set.dispose();
        }else{
          configured=commit(request,set);
          prior=configured.previous;
        }
      }
      if(configured||cameraDirty){
        cameraDirty=false;
        camera();
        engine.render({delta:0});
        await engine.gpu.queue.onSubmittedWorkDone();
        await frame();
        signal.throwIfAborted();
        rendered();
        if(configured){
          updateControls(configured.state,active.set);
          performance.mark('pbr-material-frame');
          if(!firstChange&&request.action==='seed'){
            firstChange=true;performance.mark('first-control-frame');
          }
          showTiles(active,version);
        }
      }
    }catch(reason){fail(reason);}
    finally{
      prior?.release();
      drawing=false;
      if((baker&&staged)||cameraDirty)schedule();
    }
  }
  async function run(){
    engine=await opening;
    signal.throwIfAborted();
    engine.scene.background='#464c4e';
    engine.lighting.radiance.set([1,.891,.773,.43]);
    engine.lighting.ambient.set([.66,.81,.99]);
    for(const {name,geometry,material:paint} of art.enclosure){
      engine.createMesh().setGeometry(geometry).setMaterial(paint).name='SM_MaterialsFixture_'+name;
    }
    projection=specimenSurface(engine);
    ringPaint=new PbrMaterial({color:'#6d675c',roughness:.73,metalness:0,doubleSided:false});
    samplePaint=new PbrMaterial({color:'#726d63',roughness:.76,metalness:0,doubleSided:false});
    function specimen(name,data,paint){
      const geometry=new Geometry(data.positions,data.normals,data.indices);
      const mesh=engine.createMesh().setGeometry(geometry).setMaterial(paint);
      mesh.name=name;
      return mesh;
    }
    const ring=specimen('SM_FinishTest_Ring',art.ring,ringPaint);
    const sample=specimen('SM_FinishTest_FlatWitness',art.witness,samplePaint);
    const shadow=ContactShadows.attach(engine,{position:[0,.019,0],size:[2.18,1.47],height:1.19,opacity:.74,
      blur:.029,static:true,resolution:320,color:[.013,.016,.020],toneMapped:true});
    shadow.add(ring);
    shadow.add(sample);
    camera();
    engine.render({delta:0});
    await engine.gpu.queue.onSubmittedWorkDone();
    await frame();
    signal.throwIfAborted();
    performance.mark('fixture-frame');
    rendered();
    viewport.dataset.stage='fixture';
    by('rebake').addEventListener('click',()=>{
      seed=(seed+1)>>>0;
      performance.mark('rebake-input');
      request('seed');
    },{signal});
    for(const name of modes)by(name).addEventListener('click',()=>{
      preset=name;
      detail.value=String(Math.round(finishes[name].detail*100));
      detailValue.value=detail.value+'%';
      request('material');
    },{signal});
    detail.addEventListener('input',()=>{
      detailValue.value=detail.value+'%';
      request('detail',100);
    },{signal});
    light.addEventListener('input',()=>{
      lightValue.value=light.value+'°';
      cameraDirty=true;schedule();
    },{signal});
    observer=new ResizeObserver(()=>{
      if(size()){cameraDirty=true;schedule();}
    });
    observer.observe(canvas);
    if(status.ready()){
      ready=true;
      for(const id of controls)by(id).disabled=false;
      loading.hidden=true;
      notice.textContent='Preparing GPU maps…';
    }
    baker=await baking;
    signal.throwIfAborted();
    if(!staged)staged={mode:preset,seed:seed,detail:Number(detail.value)/100,fingerprint:sequence,action:'initial'};
    schedule();
  }
  run().catch(fail);
  return ()=>{
    observer?.disconnect();
    clearTimeout(timer);
    if(drawRAF)cancelAnimationFrame(drawRAF);
    active?.release();
    baker?.dispose();
  };
}
